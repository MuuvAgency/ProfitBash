#!/usr/bin/env bash
# Prüft Backup und Test-Restore (ops/db-backup) Ende zu Ende gegen einen Fake-S3 (scripts/fake-s3.mjs):
# Dump → Verschlüsselung → Upload → Pings → Entschlüsseln → Einspielen → Zählvergleich mit der Quelle,
# dazu Fehlerfälle (falscher Bucket → /fail, http-Endpunkt, Restore-Ziel ohne `_restore`).
#
#   SMOKE_DATABASE_URL=postgres://…/profitbash_smoke \
#   SMOKE_RESTORE_DATABASE_URL=postgres://…/profitbash_smoke_restore scripts/smoke-db-backup.sh
#
# Die Quelle muss migriert und geseedet sein (vorher scripts/smoke-bundles.sh). Die Restore-Datenbank wird bei
# Bedarf angelegt und bei jedem Lauf geleert. Lokal nutzt der Test pg_dump/age vom PATH; mit
# SMOKE_BACKUP_IMAGE=<image> laufen Skripte und Werkzeuge im gebauten Image (CI, Docker mit --network host).
set -euo pipefail

: "${SMOKE_DATABASE_URL:?SMOKE_DATABASE_URL fehlt (migrierte und geseedete Quelle)}"
: "${SMOKE_RESTORE_DATABASE_URL:?SMOKE_RESTORE_DATABASE_URL fehlt (Name endet auf _restore)}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
image="${SMOKE_BACKUP_IMAGE:-}"
port="${SMOKE_S3_PORT:-18790}"
work="$(mktemp -d)"
fake_pid=""
cleanup() {
  if [ -n "$fake_pid" ]; then kill "$fake_pid" 2>/dev/null || true; fi
  rm -rf "$work"
}
trap cleanup EXIT

fail() {
  echo "::error::$*" >&2
  exit 1
}

# Führt einen Befehl lokal oder im Image aus. Variablen gehen per Name an Docker (Werte nie in der Kommandozeile).
run() {
  if [ -n "$image" ]; then
    local env_args=()
    local name
    for name in DATABASE_URL BACKUP_AGE_RECIPIENT BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID \
      BACKUP_S3_SECRET_ACCESS_KEY BACKUP_S3_REGION HEALTHCHECKS_DB_BACKUP_URL BACKUP_AGE_IDENTITY_FILE \
      RESTORE_DATABASE_URL HEALTHCHECKS_DB_RESTORE_URL; do
      if [ -n "${!name+x}" ]; then env_args+=(-e "$name"); fi
    done
    docker run --rm --network host --user "$(id -u):$(id -g)" -v "$work:$work" "${env_args[@]}" "$image" "$@"
  else
    "$@"
  fi
}
if [ -n "$image" ]; then
  backup_cmd=(backup.sh)
  restore_cmd=(restore-test.sh)
else
  backup_cmd=("$repo_root/ops/db-backup/backup.sh")
  restore_cmd=("$repo_root/ops/db-backup/restore-test.sh")
fi

query() { run psql "$1" -v ON_ERROR_STOP=1 -tA -c "$2"; }

# Restore-Datenbank bei Bedarf anlegen (nur Test-Komfort; das Restore-Skript legt nie Datenbanken an).
restore_db="${SMOKE_RESTORE_DATABASE_URL##*/}"
restore_db="${restore_db%%\?*}"
[[ "$restore_db" == *_restore ]] || fail "SMOKE_RESTORE_DATABASE_URL muss auf eine Datenbank *_restore zeigen."
if [ "$(query "$SMOKE_DATABASE_URL" "select count(*) from pg_database where datname = '$restore_db'")" = 0 ]; then
  query "$SMOKE_DATABASE_URL" "create database \"$restore_db\"" >/dev/null
fi

# Wegwerf-Werte nur für diesen Lauf.
bucket=smoke-backups
access_key_id="smoke-key-$RANDOM$RANDOM"
secret_access_key="smoke-secret-$(openssl rand -hex 16)"
hc_backup_token="backup-$(openssl rand -hex 8)"
hc_restore_token="restore-$(openssl rand -hex 8)"
base="http://127.0.0.1:$port"

if curl -s -o /dev/null "$base/"; then fail "Port $port ist belegt. Anderen Port über SMOKE_S3_PORT wählen."; fi
FAKE_S3_PORT="$port" FAKE_S3_DIR="$work" FAKE_S3_BUCKET="$bucket" FAKE_S3_ACCESS_KEY_ID="$access_key_id" \
  node "$repo_root/scripts/fake-s3.mjs" >"$work/fake-s3.log" 2>&1 &
fake_pid=$!
for _ in $(seq 1 40); do
  if curl -s -o /dev/null "$base/hc/ready"; then break; fi
  sleep 0.25
done
kill -0 "$fake_pid" 2>/dev/null || fail "Fake-S3 startet nicht: $(cat "$work/fake-s3.log")"
: >"$work/pings.log"

run age-keygen -o "$work/identity.txt" 2>/dev/null
recipient="$(run age-keygen -y "$work/identity.txt")"

export DATABASE_URL="$SMOKE_DATABASE_URL"
export BACKUP_AGE_RECIPIENT="$recipient"
export BACKUP_S3_ENDPOINT="$base"
export BACKUP_S3_BUCKET="$bucket"
export BACKUP_S3_ACCESS_KEY_ID="$access_key_id"
export BACKUP_S3_SECRET_ACCESS_KEY="$secret_access_key"
export HEALTHCHECKS_DB_BACKUP_URL="$base/hc/$hc_backup_token"

# Ausgabe darf weder Secret noch Verbindungsdaten noch Ping-URL enthalten.
assert_clean_output() {
  local file="$1" secret
  for secret in "$secret_access_key" "$SMOKE_DATABASE_URL" "$SMOKE_RESTORE_DATABASE_URL" "$hc_backup_token" \
    "$hc_restore_token"; do
    if grep -qF -- "$secret" "$file"; then fail "Die Ausgabe von $2 enthält ein Secret oder Verbindungsdaten."; fi
  done
}

echo "→ backup.sh"
if ! run "${backup_cmd[@]}" >"$work/backup.out" 2>&1; then
  cat "$work/backup.out" >&2
  fail "backup.sh ist fehlgeschlagen."
fi
cat "$work/backup.out"
assert_clean_output "$work/backup.out" backup.sh

objects=()
while IFS= read -r file; do objects+=("$file"); done < <(find "$work/objects" -type f -name '*.dump.age' 2>/dev/null)
[ "${#objects[@]}" = 1 ] || fail "Erwartet genau ein hochgeladenes Backup, gefunden: ${#objects[@]}."
backup="${objects[0]}"
[[ "$backup" =~ /objects/$bucket/db/profitbash-[0-9]{8}T[0-9]{6}Z\.dump\.age$ ]] ||
  fail "Unerwarteter Objektschlüssel: ${backup#"$work"/objects/}"
[ "$(head -c 21 "$backup")" = "age-encryption.org/v1" ] || fail "Das Backup ist nicht mit age verschlüsselt."
if grep -q PGDMP "$backup"; then fail "Das Backup enthält einen unverschlüsselten Dump."; fi
[ "$(cat "$work/pings.log")" = "$(printf 'GET /hc/%s/start\nGET /hc/%s' "$hc_backup_token" "$hc_backup_token")" ] ||
  fail "Backup-Pings falsch: $(cat "$work/pings.log")"
echo "  Upload ok (${backup#"$work"/objects/}), verschlüsselt, Pings /start + Erfolg"

echo "→ restore-test.sh (zweimal: die Datenbank wird jedes Mal geleert)"
export BACKUP_AGE_IDENTITY_FILE="$work/identity.txt"
export RESTORE_DATABASE_URL="$SMOKE_RESTORE_DATABASE_URL"
export HEALTHCHECKS_DB_RESTORE_URL="$base/hc/$hc_restore_token"
: >"$work/pings.log"
for attempt in 1 2; do
  if ! run "${restore_cmd[@]}" "$backup" >"$work/restore.out" 2>&1; then
    cat "$work/restore.out" >&2
    fail "restore-test.sh ist fehlgeschlagen (Lauf $attempt)."
  fi
done
cat "$work/restore.out"
assert_clean_output "$work/restore.out" restore-test.sh
[ "$(cat "$work/pings.log")" = "$(printf 'GET /hc/%s/start\nGET /hc/%s\nGET /hc/%s/start\nGET /hc/%s' \
  "$hc_restore_token" "$hc_restore_token" "$hc_restore_token" "$hc_restore_token")" ] ||
  fail "Restore-Pings falsch: $(cat "$work/pings.log")"

for table in drizzle.__drizzle_migrations organizations users members org_entitlements pgboss.queue; do
  source_count="$(query "$SMOKE_DATABASE_URL" "select count(*) from $table")"
  restore_count="$(query "$SMOKE_RESTORE_DATABASE_URL" "select count(*) from $table")"
  [ "$source_count" = "$restore_count" ] ||
    fail "$table: Quelle $source_count Zeilen, Restore $restore_count."
done
echo "  Restore ok, Zeilenzahlen wie in der Quelle, Pings /start + Erfolg"

echo "→ Fehlerfälle"
: >"$work/pings.log"
if BACKUP_S3_BUCKET=missing-bucket run "${backup_cmd[@]}" >"$work/fail.out" 2>&1; then
  fail "backup.sh meldet Erfolg trotz fehlendem Bucket."
fi
assert_clean_output "$work/fail.out" "backup.sh (Fehlerfall)"
[ "$(cat "$work/pings.log")" = "$(printf 'GET /hc/%s/start\nGET /hc/%s/fail' "$hc_backup_token" "$hc_backup_token")" ] ||
  fail "Fehlerfall-Pings falsch: $(cat "$work/pings.log")"
[ "$(find "$work/objects" -type f | wc -l | tr -d ' ')" = 1 ] || fail "Der Fehlerfall hat ein Objekt hinterlassen."
echo "  fehlender Bucket → Exit ≠ 0, Ping /fail"

if BACKUP_S3_ENDPOINT=http://example.com run "${backup_cmd[@]}" >"$work/http.out" 2>&1; then
  fail "backup.sh akzeptiert einen http-Endpunkt außerhalb von localhost."
fi
echo "  http-Endpunkt abgelehnt"

if RESTORE_DATABASE_URL="$SMOKE_DATABASE_URL" run "${restore_cmd[@]}" "$backup" >"$work/guard.out" 2>&1; then
  fail "restore-test.sh spielt in eine Datenbank ohne _restore ein."
fi
[ "$(query "$SMOKE_DATABASE_URL" "select count(*) from organizations")" != 0 ] || fail "Die Quelle wurde verändert."
echo "  Restore-Ziel ohne _restore abgelehnt"

echo "Smoke-Test Backup/Restore bestanden."
