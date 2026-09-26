# Deployment (Railway)

> Stand 2026-09-26. Topologie und Kosten-Stufen: ADR 001. Aufgaben und Häkchen: `docs/tasks/phase-0.md` (0.9).
> Railway-Angaben aus der Railway-Doku vom selben Tag. Beim Einrichten gegen die aktuelle Oberfläche prüfen.

## Überblick

- **Ein Service `app`** (Stufe B): Hono liefert `/api/*` und das gebaute Web (`apps/web/dist`) auf **einer Origin**.
  Der Worker läuft im selben Prozess (`WORKER_MODE=inline`).
- **Railway-Postgres** im selben Projekt, erreichbar über das private Netz.
- **Produktions-Einstiegspunkte** (nur `node`, kein tsx), gebaut von `pnpm build` mit tsup:

  | Datei | Zweck |
  |---|---|
  | `apps/api/dist/index.js` | Server (API + Web, Worker bei `inline`) |
  | `apps/api/dist/migrate.js` | Migrationen, als Pre-Deploy-Command |
  | `apps/api/dist/seed.js` | Seed (Admin + Org „Muuv“), einmalig |
  | `apps/worker/dist/main.js` | eigenständiger Worker, nur bei `WORKER_MODE=separate` |

  Die Migrationen liegen als Kopie in `apps/api/dist/drizzle/` (tsup `onSuccess`). `MIGRATIONS_DIR` überschreibt den Ort.
- **Lokal prüfen**, wie Railway startet (migrate, seed, Server, Healthcheck, Web, SIGTERM):

  ```bash
  pnpm build && SMOKE_DATABASE_URL=postgres://profitbash:profitbash@localhost:5432/profitbash_smoke scripts/smoke-bundles.sh
  ```

  Dieselbe Prüfung läuft in der CI nach `pnpm build`.

## Build und Start

Railway baut mit **Railpack**. Im Repo liegt `railpack.json`:

- Node **22** fest (ohne die Angabe nähme Railpack die neueste Version, die zu `engines.node` `>=22.13` passt).
- Start mit `node apps/api/dist/index.js`, nicht über `pnpm start`: So erreicht SIGTERM direkt den Node-Prozess
  (Graceful Shutdown, siehe unten).

Railpack installiert mit `pnpm install --frozen-lockfile` **inklusive Dev-Abhängigkeiten** (tsup, vite) und führt
das Root-Skript `build` aus. Zur Laufzeit setzt Railpack selbst `NODE_ENV=production`.

> **`NODE_ENV` nicht als Railway-Variable setzen.** Railway-Variablen gelten auch beim Build. Mit
> `NODE_ENV=production` überspringt pnpm die Dev-Abhängigkeiten, dann fehlen tsup und vite und der Build bricht ab.
> Der Server nennt `NODE_ENV` in seiner Startzeile (`API läuft auf … (production, …)`). Steht dort nicht `production`,
> ist u. a. das Rate-Limit von better-auth aus.

**Offen (Dominik):** Railway liest `railway.json`/`railway.toml` (Config as Code) für **neue** Services nicht mehr
(abgekündigt, endgültig ab 2026-12-01). Nachfolger ist „Infrastructure as Code“ (`.railway/railway.ts`, npm-Paket
`railway`, Railway-CLI, optional GitHub Action mit `RAILWAY_TOKEN`). Bis zur Entscheidung gelten die
Dashboard-Einstellungen unten; sie stehen nur hier im Repo.

## Railway einrichten (einmalig)

Voraussetzung: Railway-Konto (0.0f), Hobby-Plan erst zum ersten echten Deploy.

1. **Projekt** anlegen, **Postgres** hinzufügen (Version 17 prüfen).
2. **Service `app`** aus dem GitHub-Repo `MuuvAgency/ProfitBash`, Branch `main`. Root Directory leer (Repo-Root).
3. Einstellungen des Service `app`:

   | Einstellung | Wert |
   |---|---|
   | Builder | Railpack (liest `railpack.json`) |
   | Build Command | leer (Railpack nutzt das Root-Skript `build`) |
   | Start Command | leer (kommt aus `railpack.json`) |
   | Pre-Deploy Command | `node apps/api/dist/migrate.js` |
   | Pre-Deploy Timeout | 300 s |
   | Healthcheck Path | `/api/health` (200 nur mit erreichbarer DB) |
   | Restart Policy | On Failure |
   | Draining Time | 35 s (oder Variable `RAILWAY_DEPLOYMENT_DRAINING_SECONDS=35`), siehe Graceful Shutdown |
   | Networking | Railway-Domain erzeugen (`<app>.up.railway.app`) |

4. **Variablen** setzen (nächster Abschnitt), dann deployen.
5. **Seed** einmalig (siehe „Erster Deploy“).

## Variablen (Service `app`)

Secrets nur in Railway eintragen, nie ins Repo, nie in Actions-Logs. Werte mit `openssl rand -base64 32` erzeugen.

| Variable | Wert |
|---|---|
| `APP_URL` | `https://<app>.up.railway.app` |
| `WORKER_MODE` | `inline` |
| `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (privates Netz) |
| `DATABASE_URL_DIRECT` | `${{Postgres.DATABASE_URL}}` (Railway-Postgres hat keinen Pooler davor; pg-boss und Migrationen brauchen die direkte Verbindung) |
| `BETTER_AUTH_SECRET` | Zufallswert (≥ 32 Zeichen) |
| `ENCRYPTION_KEY` | Zufallswert, genau 32 Byte base64 |
| `ENCRYPTION_KEY_ID` | `k1` (jeder neue Schlüssel bekommt eine **neue** ID, siehe Schlüsselrotation) |
| `ENCRYPTION_KEYS_PREVIOUS` | leer (nur während einer Rotation) |
| `OAUTH_STATE_SECRET` | Zufallswert (≥ 32 Zeichen) |
| `AMAZON_ADS_REDIRECT_URI` | `https://<app>.up.railway.app/api/amazon/oauth/callback` (auch im LWA Security Profile eintragen, 0.0b) |
| `AMAZON_ADS_USE_MOCK` | `true` bis zur Ads-API-Freigabe, dann `false` |
| `AMAZON_ADS_CLIENT_ID`, `AMAZON_ADS_CLIENT_SECRET` | aus dem Security Profile (Pflicht ohne Mock) |
| `HEALTHCHECKS_TOKEN_REFRESH_URL`, `HEALTHCHECKS_PROFILES_SYNC_URL` | Ping-URLs (siehe Healthchecks.io) |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `35` (falls nicht in den Einstellungen gesetzt) |

Nicht setzen: `NODE_ENV` (siehe oben), `PORT` (setzt Railway; hat in Produktion Vorrang vor `API_PORT`), `MIGRATIONS_DIR`,
`DATABASE_URL_TEST`. `RAILWAY_GIT_COMMIT_SHA` setzt Railway, `/api/health` zeigt davon die ersten 12 Zeichen als Version.

## Erster Deploy

1. Deploy abwarten: Build → Pre-Deploy (`Migrationen eingespielt (…/apps/api/dist/drizzle).`) → Healthcheck grün.
2. **Seed** einmalig: `SEED_ADMIN_EMAIL` und `SEED_ADMIN_PASSWORD` (≥ 12 Zeichen) als Variablen setzen, dann im
   Service `node apps/api/dist/seed.js` ausführen (z. B. vorübergehend als Pre-Deploy-Command
   `node apps/api/dist/migrate.js && node apps/api/dist/seed.js` und neu deployen). Der Seed ist idempotent.
   Danach beide Variablen **entfernen** und den Pre-Deploy-Command zurücksetzen.
3. Prüfen: `https://<app>.up.railway.app/api/health` → `{"status":"ok","db":"ok",…}`, Login mit dem Seed-Admin,
   *Betrieb → Sync-Status* zeigt die ersten Läufe.

## Healthchecks.io

Zwei Checks anlegen, Ping-URLs als Variablen eintragen (nur https):

| Check | Periode | Karenzzeit | Variable |
|---|---|---|---|
| token-refresh | 1 Stunde | großzügig (z. B. 30 Min.) | `HEALTHCHECKS_TOKEN_REFRESH_URL` |
| profiles-sync | 1 Tag | großzügig (z. B. 2 Std.) | `HEALTHCHECKS_PROFILES_SYNC_URL` |

Auslöser und Connection-Jobs pingen dieselbe URL (Details in `phase-0.md`, 0.7).

## Graceful Shutdown

Bei SIGTERM schließt der Server erst HTTP, wartet dann bis zu **30 s** auf laufende Jobs und schließt zuletzt die
Datenbank. Railways Draining Time muss deshalb **mindestens 35 s** betragen, sonst beendet SIGKILL laufende Jobs.

## Backups

Laut Railway-Preisübersicht (Stand 2026-09-26) sind die eingebauten Datenbank-/Volume-Backups erst ab dem
**Pro-Plan** enthalten, nicht im Hobby-Plan. Deshalb ist ein nächtlicher `pg_dump` nötig (Aufgabe in 0.9).

**Offen (Dominik), vor der Umsetzung zu entscheiden:**

- **Ziel-Speicher** (privat, außerhalb der öffentlichen Actions-Artefakte), z. B. ein S3-kompatibler Bucket
  (Cloudflare R2, Backblaze B2 oder ein Railway-Bucket).
- **Wo der Dump läuft:** GitHub Action (braucht einen öffentlichen TCP-Proxy auf die Datenbank) oder ein Railway-Cron-Service
  im privaten Netz (kein öffentlicher DB-Zugang).
- Das Repo ist öffentlich: Der Dump wird **vor** dem Upload verschlüsselt, Logs enthalten keine Verbindungsdaten.

## Umstellung auf `WORKER_MODE=separate` (Stufe C)

Reine Konfiguration, kein Code-Umbau:

1. Zweiter Service `worker` aus demselben Repo. Start Command `node apps/worker/dist/main.js` (überschreibt den Start aus
   `railpack.json`), kein Pre-Deploy-Command,
   kein Healthcheck-Pfad (der Worker hat keinen HTTP-Server), Draining Time ebenfalls ≥ 35 s.
2. Variablen wie `app`, aber **ohne** `BETTER_AUTH_SECRET` und `OAUTH_STATE_SECRET`. `APP_URL` und
   `AMAZON_ADS_REDIRECT_URI` braucht der Worker weiterhin (Amazon-Client, Mock-Einwilligungsseite).
3. In **beiden** Services `WORKER_MODE=separate`. Die API plant dann nur noch ein; der Worker führt aus und betreibt
   Wartung und Zeitpläne von pg-boss. Bei `inline` beendet sich der Worker-Prozess mit einem Hinweis.
4. Geänderte Queue-Optionen erreichen bestehende Queues nur über `boss.updateQueue` (siehe `createQueues` in
   `apps/worker/src/queues.ts`).

## Schlüsselrotation (`ENCRYPTION_KEY`)

Betriebsregel: Ein neuer Schlüssel bekommt **immer eine neue `ENCRYPTION_KEY_ID`**. Dieselbe ID mit neuem Schlüssel
macht alle alten Werte unlesbar, und der Code kann das nicht erkennen.

1. Neuen Schlüssel erzeugen. `ENCRYPTION_KEYS_PREVIOUS` = `<alte-id>:<alter-schlüssel>` (bei mehreren kommagetrennt),
   `ENCRYPTION_KEY` = neuer Schlüssel, `ENCRYPTION_KEY_ID` = neue ID. Deployen: Neue Werte werden mit dem neuen
   Schlüssel geschrieben, alte bleiben lesbar.
2. Bestehende Tokens neu verschlüsseln. Das Rotations-Skript folgt als eigene Aufgabe in 0.9; die Anleitung dazu
   ergänzt dieser Abschnitt dann.
3. Erst danach den alten Schlüssel aus `ENCRYPTION_KEYS_PREVIOUS` entfernen.
