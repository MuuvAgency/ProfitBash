#!/usr/bin/env bash
# Startet die gebündelten Produktions-Einstiegspunkte wie auf Railway: nur `node`, kein tsx,
# NODE_ENV=production, anderes Arbeitsverzeichnis. Voraussetzung: `pnpm build`.
#
#   SMOKE_DATABASE_URL=postgres://…/profitbash_smoke scripts/smoke-bundles.sh
#
# Die Datenbank wird migriert und geseedet (beides idempotent). Nie gegen Produktion laufen lassen.
set -euo pipefail

: "${SMOKE_DATABASE_URL:?SMOKE_DATABASE_URL fehlt (eigene Datenbank, wird migriert und geseedet)}"

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
dist="$repo_root/apps/api/dist"

for file in index.js migrate.js seed.js drizzle/meta/_journal.json; do
  if [ ! -f "$dist/$file" ]; then
    echo "::error::$dist/$file fehlt. Erst 'pnpm build' ausführen." >&2
    exit 1
  fi
done

if grep -lE "from ['\"]tsx|require\(['\"]tsx" "$dist"/*.js >/dev/null; then
  echo "::error::Ein Bundle importiert tsx." >&2
  exit 1
fi

port="${SMOKE_PORT:-18787}"
secret() { openssl rand -base64 32; }

# Wegwerf-Secrets nur für diesen Lauf; werden nie ausgegeben.
export NODE_ENV=production
export DATABASE_URL="$SMOKE_DATABASE_URL"
export DATABASE_URL_DIRECT="$SMOKE_DATABASE_URL"
export APP_URL="http://localhost:$port"
export API_PORT="$port"
export WORKER_MODE=inline
BETTER_AUTH_SECRET="$(secret)"
ENCRYPTION_KEY="$(secret)"
OAUTH_STATE_SECRET="$(secret)"
export BETTER_AUTH_SECRET ENCRYPTION_KEY OAUTH_STATE_SECRET
export ENCRYPTION_KEY_ID=smoke
export AMAZON_ADS_USE_MOCK=true
export AMAZON_ADS_REDIRECT_URI="$APP_URL/api/amazon/oauth/callback"
export SEED_ADMIN_EMAIL=smoke-admin@example.com
SEED_ADMIN_PASSWORD="$(secret)"
export SEED_ADMIN_PASSWORD

# Aus einem fremden Ordner starten: Pfade dürfen nicht vom Arbeitsverzeichnis abhängen.
workdir="$(mktemp -d)"
cd "$workdir"

echo "→ migrate"
node "$dist/migrate.js"
echo "→ seed"
node "$dist/seed.js"

echo "→ server"
node "$dist/index.js" &
server_pid=$!
trap 'kill "$server_pid" 2>/dev/null || true; rm -rf "$workdir"' EXIT

healthy=false
for _ in $(seq 1 60); do
  if curl -fsS "http://localhost:$port/api/health" >/dev/null 2>&1; then
    healthy=true
    break
  fi
  if ! kill -0 "$server_pid" 2>/dev/null; then break; fi
  sleep 0.5
done
if [ "$healthy" != true ]; then
  echo "::error::GET /api/health antwortet nicht mit 200." >&2
  exit 1
fi
echo "  /api/health ok"

echo "→ Herunterfahren (SIGTERM)"
kill -TERM "$server_pid"
if wait "$server_pid"; then
  echo "Smoke-Test der Bundles bestanden."
else
  echo "::error::Der Server hat sich nach SIGTERM nicht sauber beendet." >&2
  exit 1
fi
