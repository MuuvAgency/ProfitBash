#!/usr/bin/env bash
# Nächtliches Datenbank-Backup (Railway-Cron-Service `db-backup`, Einrichtung in docs/deploy.md):
# pg_dump (Custom-Format) → Lesbarkeitsprüfung → age-Verschlüsselung → Upload in einen S3-kompatiblen Bucket
# (Cloudflare R2) unter db/profitbash-<UTC>.dump.age. Pingt Healthchecks.io (/start, Erfolg, /fail).
#
# Variablen: DATABASE_URL, BACKUP_AGE_RECIPIENT (öffentlicher age-Schlüssel), BACKUP_S3_ENDPOINT (https),
# BACKUP_S3_BUCKET, BACKUP_S3_ACCESS_KEY_ID, BACKUP_S3_SECRET_ACCESS_KEY, optional BACKUP_S3_REGION (auto)
# und HEALTHCHECKS_DB_BACKUP_URL. Verbindungsdaten, Schlüssel und Ping-URL erscheinen nie in der Ausgabe.
set -euo pipefail

hc_url="${HEALTHCHECKS_DB_BACKUP_URL:-}"
work=""
finished=false

ping_healthchecks() {
  if [ -z "$hc_url" ]; then return 0; fi
  # Ein fehlgeschlagener Ping lässt das Backup nicht scheitern; die URL wird nie ausgegeben.
  curl -fs -m 10 --retry 3 -o /dev/null "$hc_url$1" || echo "Warnung: Healthchecks-Ping fehlgeschlagen." >&2
}

on_exit() {
  local status=$?
  if [ "$finished" != true ]; then
    echo "Backup fehlgeschlagen (Exit-Code $status)." >&2
    ping_healthchecks /fail
  fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap on_exit EXIT

fail() {
  echo "Fehler: $*" >&2
  exit 1
}

# https Pflicht; http nur für lokale Tests.
is_allowed_url() {
  [[ "$1" =~ ^https:// || "$1" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]]
}

sha256_of() {
  local line
  if command -v sha256sum >/dev/null; then line="$(sha256sum "$1")"; else line="$(shasum -a 256 "$1")"; fi
  echo "${line%% *}"
}

if [ -n "$hc_url" ] && ! is_allowed_url "$hc_url"; then
  hc_url=""
  fail "HEALTHCHECKS_DB_BACKUP_URL muss mit https:// beginnen."
fi
ping_healthchecks /start

for name in DATABASE_URL BACKUP_AGE_RECIPIENT BACKUP_S3_ENDPOINT BACKUP_S3_BUCKET BACKUP_S3_ACCESS_KEY_ID \
  BACKUP_S3_SECRET_ACCESS_KEY; do
  if [ -z "${!name:-}" ]; then fail "$name fehlt."; fi
done
is_allowed_url "$BACKUP_S3_ENDPOINT" || fail "BACKUP_S3_ENDPOINT muss mit https:// beginnen."
[[ "$BACKUP_S3_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]] || fail "BACKUP_S3_BUCKET ist kein gültiger Bucket-Name."
[[ "$BACKUP_AGE_RECIPIENT" =~ ^age1[0-9a-z]{58}$ ]] || fail "BACKUP_AGE_RECIPIENT ist kein öffentlicher age-Schlüssel (age1…)."
region="${BACKUP_S3_REGION:-auto}"
[[ "$region" =~ ^[a-z0-9-]+$ ]] || fail "BACKUP_S3_REGION ist ungültig."

work="$(mktemp -d)"
dump="$work/profitbash.dump"
encrypted="$work/profitbash.dump.age"
key="db/profitbash-$(date -u +%Y%m%dT%H%M%SZ).dump.age"

echo "→ pg_dump"
# Eigentümer und Rechte bleiben im Archiv; ob sie gelten, entscheidet erst pg_restore. Wartet pg_dump länger als
# 5 Min. auf eine Sperre (z. B. Migration), bricht es ab, statt den nächsten Cron-Lauf zu blockieren.
pg_dump --format=custom --lock-wait-timeout=5min --dbname="$DATABASE_URL" --file="$dump"

# Lesbarkeit prüfen, bevor verschlüsselt wird: Das Inhaltsverzeichnis muss Tabellendaten enthalten.
pg_restore --list "$dump" >"$work/toc.txt"
grep -q 'TABLE DATA' "$work/toc.txt" || fail "Der Dump enthält keine Tabellendaten."

echo "→ age"
age --encrypt --recipient "$BACKUP_AGE_RECIPIENT" --output "$encrypted" "$dump"
rm -f "$dump"

echo "→ Upload"
size="$(wc -c <"$encrypted" | tr -d ' ')"
hash="$(sha256_of "$encrypted")"
endpoint="${BACKUP_S3_ENDPOINT%/}"
# Zugangsdaten über --config auf stdin, damit sie nicht in der Prozessliste stehen.
escape_config() { local value="${1//\\/\\\\}"; echo "${value//\"/\\\"}"; }
status="$(
  printf 'user = "%s:%s"\n' "$(escape_config "$BACKUP_S3_ACCESS_KEY_ID")" \
    "$(escape_config "$BACKUP_S3_SECRET_ACCESS_KEY")" |
    curl -sS --config - --aws-sigv4 "aws:amz:$region:s3" --retry 3 -m 600 \
      -H "x-amz-content-sha256: $hash" -T "$encrypted" -o "$work/response.txt" -w '%{http_code}' \
      "$endpoint/$BACKUP_S3_BUCKET/$key"
)" || fail "Upload nicht möglich (Netzwerk)."
if [ "$status" != 200 ]; then
  echo "Antwort des Speichers:" >&2
  cat "$work/response.txt" >&2
  echo >&2
  fail "Upload fehlgeschlagen (HTTP $status)."
fi

finished=true
echo "Backup hochgeladen: $key ($size Bytes)."
ping_healthchecks ""
