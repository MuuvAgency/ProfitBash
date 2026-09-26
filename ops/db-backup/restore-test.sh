#!/usr/bin/env bash
# Monatlicher Test-Restore (Anleitung in docs/deploy.md): entschlüsselt ein Backup aus backup.sh, spielt es in eine
# leere Datenbank ein und prüft Stichproben. Pingt einen eigenen Healthchecks-Check, damit ein vergessener
# Test-Restore auffällt.
#
#   BACKUP_AGE_IDENTITY_FILE=~/…/profitbash-backup.key \
#   RESTORE_DATABASE_URL=postgres://…/profitbash_restore ops/db-backup/restore-test.sh profitbash-….dump.age
#
# Die Zieldatenbank muss existieren und auf `_restore` enden. Sie wird vor dem Einspielen **geleert**
# (alle Schemas gelöscht). Optional: HEALTHCHECKS_DB_RESTORE_URL.
set -euo pipefail

hc_url="${HEALTHCHECKS_DB_RESTORE_URL:-}"
work=""
finished=false

ping_healthchecks() {
  if [ -z "$hc_url" ]; then return 0; fi
  curl -fs -m 10 --retry 3 -o /dev/null "$hc_url$1" || echo "Warnung: Healthchecks-Ping fehlgeschlagen." >&2
}

on_exit() {
  local status=$?
  if [ "$finished" != true ]; then
    echo "Test-Restore fehlgeschlagen (Exit-Code $status)." >&2
    ping_healthchecks /fail
  fi
  if [ -n "$work" ]; then rm -rf "$work"; fi
}
trap on_exit EXIT

fail() {
  echo "Fehler: $*" >&2
  exit 1
}

if [ -n "$hc_url" ] && ! [[ "$hc_url" =~ ^https:// || "$hc_url" =~ ^http://(localhost|127\.0\.0\.1)(:[0-9]+)?(/|$) ]]; then
  hc_url=""
  fail "HEALTHCHECKS_DB_RESTORE_URL muss mit https:// beginnen."
fi
ping_healthchecks /start

backup="${1:-}"
[ -n "$backup" ] || fail "Aufruf: restore-test.sh <backup.dump.age>"
[ -f "$backup" ] || fail "Datei nicht gefunden: $backup"
: "${BACKUP_AGE_IDENTITY_FILE:?BACKUP_AGE_IDENTITY_FILE fehlt (privater age-Schlüssel)}"
: "${RESTORE_DATABASE_URL:?RESTORE_DATABASE_URL fehlt}"

sql() { PGOPTIONS="-c client_min_messages=warning" psql "$RESTORE_DATABASE_URL" -X -v ON_ERROR_STOP=1 -q -tA -c "$1"; }

database="$(sql 'select current_database()')"
[[ "$database" == *_restore ]] || fail "Die Zieldatenbank $database endet nicht auf _restore. Abbruch."

work="$(mktemp -d)"
dump="$work/profitbash.dump"

echo "→ Entschlüsseln"
age --decrypt --identity "$BACKUP_AGE_IDENTITY_FILE" --output "$dump" "$backup"
pg_restore --list "$dump" >/dev/null

echo "→ $database leeren"
sql "do \$\$
declare s text;
begin
  for s in select nspname from pg_namespace
    where nspname not in ('pg_catalog', 'information_schema') and nspname not like 'pg\_%'
  loop
    execute format('drop schema %I cascade', s);
  end loop;
  create schema public;
end \$\$;"

echo "→ Einspielen"
pg_restore --no-owner --no-privileges --exit-on-error --single-transaction --dbname="$RESTORE_DATABASE_URL" "$dump"

echo "→ Stichproben"
migrations="$(sql 'select count(*) from drizzle.__drizzle_migrations')"
organizations="$(sql 'select count(*) from organizations')"
users="$(sql 'select count(*) from users')"
connections="$(sql 'select count(*) from connections')"
profiles="$(sql 'select count(*) from amazon_ads_profiles')"
job_runs="$(sql 'select count(*) from job_runs')"
# Jüngster Zeitstempel im Backup: zeigt, ob der Dump aktuell ist.
newest="$(sql "select coalesce(to_char(greatest((select max(created_at) from audit_events),
  (select max(started_at) from job_runs)) at time zone 'UTC', 'YYYY-MM-DD HH24:MI \"UTC\"'), '–')")"
[ "$migrations" -gt 0 ] || fail "Keine Migrationen im Backup."
[ "$organizations" -gt 0 ] || fail "Keine Organisationen im Backup."
[ "$users" -gt 0 ] || fail "Keine Nutzer im Backup."

finished=true
echo "Test-Restore ok: $migrations Migrationen, $organizations Organisationen, $users Nutzer, $connections Connections, $profiles Profile, $job_runs Jobläufe, jüngster Eintrag $newest."
ping_healthchecks ""
