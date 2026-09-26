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
web_dist="$repo_root/apps/web/dist"

for file in "$dist/index.js" "$dist/migrate.js" "$dist/seed.js" "$dist/drizzle/meta/_journal.json" \
  "$web_dist/index.html"; do
  if [ ! -f "$file" ]; then
    echo "::error::$file fehlt. Erst 'pnpm build' ausführen." >&2
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
export PORT="$port" # wie auf Railway; API_PORT bleibt ungesetzt
unset API_PORT
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

# Web auf derselben Origin: Startseite, Client-Route (SPA-Fallback) und ein gehashtes Asset.
base="http://localhost:$port"
for path in / /admin/connections; do
  body="$(curl -fsS "$base$path" || true)"
  if [[ "$body" != *'<div id="app"'* ]]; then
    echo "::error::GET $path liefert nicht index.html." >&2
    exit 1
  fi
done
asset="$(cd "$web_dist" && find assets -name '*.js' | head -n 1)"
if ! curl -fsS -o /dev/null "$base/$asset"; then
  echo "::error::GET /$asset liefert das Asset nicht." >&2
  exit 1
fi
echo "  Web ok (/, SPA-Fallback, /$asset)"

echo "→ Herunterfahren (SIGTERM)"
kill -TERM "$server_pid"
if wait "$server_pid"; then
  echo "Smoke-Test der Bundles bestanden."
else
  echo "::error::Der Server hat sich nach SIGTERM nicht sauber beendet." >&2
  exit 1
fi
