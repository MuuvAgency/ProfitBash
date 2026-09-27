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
  | `apps/api/dist/rotate-keys.js` | Schlüsselrotation, nur bei Bedarf (siehe unten) |
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

**Entschieden (Dominik, 2026-09-26): Dashboard-Einstellungen.** Railway liest `railway.json`/`railway.toml` (Config as
Code) für **neue** Services nicht mehr (abgekündigt, endgültig ab 2026-12-01). Der Nachfolger „Infrastructure as Code“
(`.railway/railway.ts`, npm-Paket `railway`, Railway-CLI) lohnt sich für den Pilot mit einem Service nicht. Die
Einstellungen unten werden im Dashboard gesetzt; dieses Dokument ist ihre Quelle im Repo. Bei Änderungen im Dashboard
hier nachziehen. Wiedervorlage bei Stufe C (zweiter Service).

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
6. **Backup-Service `db-backup`** (Cron) einrichten, siehe „Backups“.

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
| `AMAZON_ADS_REQUESTS_PER_SECOND` | optional, Anfrage-Budget je Profil (Standard 2, mindestens 0.2); erst nach beobachteten 429-Quoten ändern |
| `HEALTHCHECKS_TOKEN_REFRESH_URL`, `HEALTHCHECKS_PROFILES_SYNC_URL`, `HEALTHCHECKS_ENTITIES_SYNC_URL`, `HEALTHCHECKS_REPORTS_SYNC_URL` | Ping-URLs (siehe Healthchecks.io) |
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

Sechs Checks anlegen, Ping-URLs als Variablen eintragen (nur https). Die Ping-URLs sind geheim (wer sie kennt, kann
falsche Erfolge melden):

| Check | Periode | Karenzzeit | Variable |
|---|---|---|---|
| token-refresh | 1 Stunde | großzügig (z. B. 30 Min.) | `HEALTHCHECKS_TOKEN_REFRESH_URL` |
| profiles-sync | 1 Tag | großzügig (z. B. 2 Std.) | `HEALTHCHECKS_PROFILES_SYNC_URL` |
| entities-sync | 1 Tag | großzügig (z. B. 2 Std.) | `HEALTHCHECKS_ENTITIES_SYNC_URL` |
| reports-sync | 1 Tag | großzügig (z. B. 2 Std.) | `HEALTHCHECKS_REPORTS_SYNC_URL` |
| db-backup | 1 Tag | 2 Std. | `HEALTHCHECKS_DB_BACKUP_URL` (Service `db-backup`) |
| db-restore-test | 31 Tage | 3 Tage | `HEALTHCHECKS_DB_RESTORE_URL` (lokal beim Test-Restore) |

Auslöser und Connection-Jobs pingen dieselbe URL (Details in `phase-0.md`, 0.7). `amazon-requests-poll` pingt nicht
(läuft oft und kurz); gescheiterte Amazon-Aufträge zeigt `reports-sync` im Zähler `failedSinceLastRun` (Phase 1, 1.7). Backup und Test-Restore pingen `/start`,
Erfolg und `/fail`. Bleibt der monatliche Test-Restore aus, meldet sich „db-restore-test“.

## Graceful Shutdown

Bei SIGTERM schließt der Server erst HTTP, wartet dann bis zu **30 s** auf laufende Jobs und schließt zuletzt die
Datenbank. Railways Draining Time muss deshalb **mindestens 35 s** betragen, sonst beendet SIGKILL laufende Jobs.

## Backups

Laut Railway-Preisübersicht (Stand 2026-09-26) sind die eingebauten Datenbank-/Volume-Backups erst ab dem
**Pro-Plan** enthalten, nicht im Hobby-Plan. Deshalb ist ein nächtlicher `pg_dump` nötig (Aufgabe in 0.9).

**Entschieden (Dominik, 2026-09-26):** Railway-Cron-Service `db-backup` im privaten Netz (kein öffentlicher
DB-Zugang), Dump mit `age` für einen öffentlichen Schlüssel verschlüsselt (privater Schlüssel nur offline bei Dominik),
Upload nach Cloudflare R2 (Lifecycle-Regel 14 Tage), Healthchecks.io-Check „db-backup“, monatlicher Test-Restore.
R2-Konto und Bucket legt Dominik an.

Umsetzung in `ops/db-backup/` (Stand 2026-09-26: Code und Smoke-Test fertig; **offen:** erster echter Lauf gegen R2
auf Railway, erst mit Dominiks Konten prüfbar. Die SigV4-Signatur rechnet curl, der Fake-S3 im Test prüft nur Form und
Prüfsumme):

| Datei | Zweck |
|---|---|
| `Dockerfile` | `postgres:17.10-alpine3.24` (per Digest gepinnt) + `bash`, `curl`, `age` 1.3. Start: `backup.sh` |
| `backup.sh` | `pg_dump --format=custom` → `pg_restore --list` (Lesbarkeit) → `age` für den öffentlichen Schlüssel → Upload `db/profitbash-<UTC>.dump.age` |
| `restore-test.sh` | Test-Restore: entschlüsseln, in eine `*_restore`-Datenbank einspielen (vorher geleert), Stichproben |

- Upload per `curl --aws-sigv4 "aws:amz:auto:s3"` mit `x-amz-content-sha256` = SHA-256 der Datei (R2 verlangt den Header und
  prüft damit die Unversehrtheit). Zugangsdaten gehen per `--config -` an curl, nicht über die Kommandozeile.
- Die Skripte geben Verbindungsdaten, Schlüssel und Ping-URLs nie aus. Der Smoke-Test prüft das für die Verbindungs-URLs,
  den Secret Key und die Ping-URLs. Ein fehlgeschlagener Ping lässt das Backup nicht scheitern.
- `pg_dump` wartet höchstens 5 Min. auf Sperren (`--lock-wait-timeout`), sonst Abbruch und `/fail`. Eigentümer und Rechte
  bleiben im Archiv; `restore-test.sh` spielt ohne sie ein (`--no-owner --no-privileges`).
- **Smoke-Test** `scripts/smoke-db-backup.sh` gegen einen Fake-S3 (`scripts/fake-s3.mjs`): Upload, Verschlüsselung, Pings,
  zweimaliger Restore mit Zeilenvergleich zur Quelle, Fehlerfälle (fehlender Bucket → `/fail`, http-Endpunkt, Ziel ohne
  `_restore`). In der CI gegen das gebaute Image, lokal mit `pg_dump`/`age` vom PATH (`brew install age`):

  ```bash
  SMOKE_DATABASE_URL=postgres://profitbash:profitbash@localhost:5432/profitbash_smoke \
  SMOKE_RESTORE_DATABASE_URL=postgres://profitbash:profitbash@localhost:5432/profitbash_smoke_restore \
  scripts/smoke-db-backup.sh
  ```

  Die Quelle muss migriert und geseedet sein (vorher `scripts/smoke-bundles.sh`).

### Einrichten (einmalig, Dominik)

1. **age-Schlüsselpaar** lokal erzeugen: `age-keygen -o profitbash-backup.key`. Die Datei ist der **private** Schlüssel:
   in den Passwort-Manager und an einen zweiten Ort offline, nie auf Railway oder ins Repo. Ohne ihn ist jedes Backup
   wertlos. Der öffentliche Schlüssel (`age1…`, steht in der Datei und kommt aus `age-keygen -y profitbash-backup.key`)
   wird zu `BACKUP_AGE_RECIPIENT`.
2. **Cloudflare R2:** Bucket `profitbash-backups` anlegen, Standort **EU-Jurisdiktion** (die Dumps enthalten Nutzerdaten;
   die Jurisdiktion lässt sich später nicht ändern). Unter *Settings → Object Lifecycle Rules* eine Regel: Präfix `db/`,
   Objekte nach **14 Tagen** löschen (R2 löscht meist innerhalb von 24 h nach Ablauf).
   API-Token unter *R2 → API Tokens → Manage*: Berechtigung **Object Read & Write**, nur für diesen Bucket. Access Key ID
   und Secret Access Key erscheinen nur einmal.
   Endpunkt: `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com` (ohne EU-Jurisdiktion ohne `.eu`).
   Empfohlen: unter *Settings → Bucket lock rules → Add rule* eine Sperre für Präfix `db/` über **7 Tage** (kürzer als die
   Lifecycle-Regel). Der Token auf Railway darf Objekte schreiben und löschen; mit der Sperre kann auch ein kompromittierter
   Railway-Zugang die Backups der letzten Woche nicht löschen. (Solange eine Sperre besteht, lässt sich der Bucket nicht
   leeren.)
3. **Healthchecks.io:** Checks „db-backup“ und „db-restore-test“ (siehe Abschnitt Healthchecks.io).
4. **Railway-Service `db-backup`** im selben Projekt, aus dem Repo `MuuvAgency/ProfitBash`, Branch `main`:

   | Einstellung | Wert |
   |---|---|
   | Root Directory | `ops/db-backup` (Build-Kontext; Railway nimmt das `Dockerfile` dort) |
   | Watch Paths | `/ops/db-backup/**` (Muster gelten ab Repo-Root, auch mit Root Directory) |
   | Cron Schedule | `0 1 * * *` (**UTC**, also 02:00 Winter- bzw. 03:00 Sommerzeit in Berlin, vor `job-runs-cleanup` 03:30 und `profiles-sync` 05:00) |
   | Start/Pre-Deploy Command, Healthcheck Path, Domain | leer bzw. keine |
   | Restart Policy | Never (ein fehlgeschlagener Lauf meldet sich über Healthchecks, der nächste kommt per Cron) |

   Railway startet Cron-Services in UTC, frühestens alle 5 Minuten, und überspringt einen Lauf, solange der vorige noch
   aktiv ist. Das Skript beendet sich nach dem Upload.

   Variablen:

   | Variable | Wert |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` (privates Netz) |
   | `BACKUP_AGE_RECIPIENT` | öffentlicher age-Schlüssel (`age1…`) |
   | `BACKUP_S3_ENDPOINT` | `https://<ACCOUNT_ID>.eu.r2.cloudflarestorage.com` |
   | `BACKUP_S3_BUCKET` | `profitbash-backups` |
   | `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | aus dem R2-API-Token |
   | `BACKUP_S3_REGION` | nicht setzen (Standard `auto`, für R2 richtig) |
   | `HEALTHCHECKS_DB_BACKUP_URL` | Ping-URL des Checks „db-backup“ |

5. **Postgres-Version prüfen:** `pg_dump` im Image ist 17. Ist das Railway-Postgres neuer, bricht `pg_dump` ab (Versionskonflikt):
   dann das Basis-Image auf dieselbe Hauptversion heben (Tag und Digest im `Dockerfile`) und die lokalen Werkzeuge für den
   Test-Restore ebenso (Homebrew-`postgresql@<version>`): Ein älteres `pg_restore` liest neuere Archive nicht.
6. **Erster Lauf:** im Service *Deploy* auslösen (bzw. Cron abwarten). Log: `Backup hochgeladen: db/profitbash-….dump.age (… Bytes).`,
   das Objekt liegt im Bucket, Healthchecks zeigt „up“. Danach gleich den ersten Test-Restore (unten).

### Test-Restore (monatlich)

Lokal mit Homebrew-Postgres 17 und `age`:

1. Neuestes Objekt unter `db/` im R2-Dashboard herunterladen.
2. Einmalig `createdb profitbash_restore`. Das Skript leert diese Datenbank bei jedem Lauf und verweigert Namen ohne
   `_restore`.
3. Ausführen:

   ```bash
   BACKUP_AGE_IDENTITY_FILE=~/pfad/zu/profitbash-backup.key \
   RESTORE_DATABASE_URL=postgres://profitbash:profitbash@localhost:5432/profitbash_restore \
   HEALTHCHECKS_DB_RESTORE_URL=<Ping-URL db-restore-test> \
   ops/db-backup/restore-test.sh ~/Downloads/profitbash-<UTC>.dump.age
   ```

   Ergebnis: `Test-Restore ok: N Migrationen, N Organisationen, …, jüngster Eintrag <Zeitpunkt>`. Die Zahlen grob mit
   der App vergleichen; der jüngste Eintrag (Audit-Log oder Joblauf) sollte kurz vor dem Backup liegen.
4. Den Dump und die Restore-Datenbank danach nicht herumliegen lassen (`dropdb profitbash_restore` oder beim nächsten
   Lauf überschreiben), sie enthalten Produktionsdaten.

### Ernstfall-Restore (Produktion)

Noch nie geübt (Stand 2026-09-26). Beim ersten echten Deploy einmal gegen eine Wegwerf-Datenbank auf Railway
durchspielen und diese Anleitung dann nachziehen.

1. **Ursache klären und entscheiden,** welches Backup gilt (R2, Präfix `db/`, Zeitstempel in UTC). Alles nach dem
   Backup geht verloren.
2. **App anhalten:** Service `app` herunterskalieren bzw. Deployment entfernen, damit weder API noch Worker schreiben.
   Beim Cron-Service `db-backup` den Zeitplan vorübergehend leeren: Ein Lauf während des Restores sichert einen halben
   Stand (überschrieben wird nichts, jedes Backup hat einen eigenen Namen).
3. **Zugang zur Datenbank:** vorübergehend den öffentlichen TCP-Proxy des Postgres-Service aktivieren
   (Verbindungs-URL `DATABASE_PUBLIC_URL`), oder per `railway ssh` in einen Service mit `pg_restore` 17.
4. **Einspielen** (lokal, mit dem Backup und dem privaten age-Schlüssel):

   ```bash
   age --decrypt --identity ~/pfad/zu/profitbash-backup.key --output profitbash.dump profitbash-<UTC>.dump.age
   pg_restore --clean --if-exists --no-owner --no-privileges --exit-on-error --single-transaction \
     --dbname="$DATABASE_PUBLIC_URL" profitbash.dump
   ```

   `--clean --if-exists` ersetzt die vorhandenen Objekte einschließlich `drizzle` (Migrationsstand) und `pgboss`
   (Warteschlangen, Zeitpläne). Wartende Jobs aus dem Backup laufen danach erneut; das ist unkritisch, weil
   Token-Refresh und Profil-Sync wiederholbar sind.
5. **Schlüssel prüfen:** Das Backup enthält Refresh-Tokens, verschlüsselt mit dem damals gültigen `ENCRYPTION_KEY`.
   Wurde der Schlüssel seitdem gewechselt, den alten Schlüssel wieder in `ENCRYPTION_KEYS_PREVIOUS` eintragen
   (siehe Schlüsselrotation, alte Schlüssel werden aufbewahrt), sonst sind alle Connections unlesbar.
6. **App wieder starten** (der Pre-Deploy-Command spielt fehlende Migrationen ein), Healthcheck, Login und
   *Betrieb → Sync-Status* prüfen. Bei geändertem Schlüssel danach das Rotations-Skript laufen lassen.
7. **Aufräumen:** TCP-Proxy wieder abschalten, `db-backup` fortsetzen, lokalen Dump (`profitbash.dump`) löschen.

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

1. Neuen Schlüssel erzeugen (`openssl rand -base64 32`). `ENCRYPTION_KEYS_PREVIOUS` = `<alte-id>:<alter-schlüssel>`
   (bei mehreren kommagetrennt), `ENCRYPTION_KEY` = neuer Schlüssel, `ENCRYPTION_KEY_ID` = neue ID (z. B. `k2`).
   Bei `WORKER_MODE=separate` in **beiden** Services gleich setzen. Deployen: Neue Werte werden mit dem neuen
   Schlüssel geschrieben, alte bleiben lesbar.
2. Bestehende Tokens mit dem Rotations-Skript neu verschlüsseln, **im Service `app`** (dort stehen die Variablen und
   das private Netz zur Datenbank). **Erst wenn der Deploy aus Schritt 1 in allen Services (`app`, ggf. `worker`) live
   und gesund ist**, nie im selben Deploy wie der Schlüsselwechsel: Ein Prozess, der nur den alten Schlüssel kennt,
   kann neu verschlüsselte Tokens nicht lesen, und jeder Refresh scheitert.

   ```bash
   node apps/api/dist/rotate-keys.js
   ```

   Weg auf Railway (beim ersten Einsatz prüfen und hier nachziehen): per `railway ssh` in den laufenden Service, oder
   vorübergehend als Pre-Deploy-Command `node apps/api/dist/migrate.js && node apps/api/dist/rotate-keys.js` und neu
   deployen (danach zurücksetzen, wie beim Seed). Die App darf dabei weiterlaufen: Das Skript sperrt jede Connection
   einzeln wie ein Token-Refresh und überschreibt keinen gerade rotierten Token.

   Ausgabe: `Schlüsselrotation (aktueller Schlüssel k2): N Connections geprüft, M neu verschlüsselt, F nicht lesbar.`
   - Jede neu verschlüsselte Connection bekommt ein Audit-Event `connection.token_reencrypt` (von/nach Schlüssel-ID).
   - **Nicht lesbare** Werte werden mit Connection- und Organisations-ID gemeldet, übersprungen und nicht verändert;
     der Exit-Code ist dann 1 (als Pre-Deploy-Command schlägt der Deploy fehl, die laufende Version bleibt).
     „Unbekannte Schlüssel-ID“: Ein früherer Schlüssel fehlt in `ENCRYPTION_KEYS_PREVIOUS`, wieder eintragen.
     Andere Meldungen: Der Wert ist verloren; die Connection neu verbinden (überschreibt den Token) oder löschen.
   - Bricht das Skript mit einem anderen Fehler ab (z. B. Datenbank, Sperre länger als 30 s), einfach erneut starten:
     Es ist wiederholbar und überspringt bereits neu verschlüsselte Werte.
3. Das Skript erneut ausführen. Erst wenn es `0 neu verschlüsselt, 0 nicht lesbar` meldet (Exit-Code 0), den alten
   Schlüssel aus `ENCRYPTION_KEYS_PREVIOUS` entfernen und deployen.
4. **Den alten Schlüssel nicht wegwerfen:** mit ID offline neben dem privaten age-Schlüssel aufbewahren, mindestens so
   lange wie die Backups (14 Tage, besser dauerhaft). Backups aus der Zeit davor enthalten Tokens mit dem alten
   Schlüssel; ohne ihn sind die Connections nach einem Restore unlesbar (siehe Ernstfall-Restore).
