# Phase 0 – Fundament

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (Navigation, Feature-Keys, Leitplanken), `docs/decisions/001-stack.md`.

## Ziel

Ein deploytes Grundgerüst mit folgendem Stand:
- Login funktioniert.
- Ein Amazon-Ads-Account ist per OAuth verbunden.
- Seine Profile werden täglich synchronisiert, einem Client zugeordnet und in der UI angezeigt.
- Alle weiteren Phasen bauen darauf auf, ohne das Fundament umzubauen.

## Definition of Done

- [ ] `pnpm dev` startet api, worker und web lokal (Postgres per `docker compose`); `pnpm test`, `pnpm typecheck` und `pnpm lint` sind grün.
- [ ] CI (GitHub Actions) läuft bei jedem Push: typecheck, lint, test, build.
- [ ] Railway-Service `app` (API + Web auf einer Origin, `WORKER_MODE=inline`) ist erreichbar und nutzt Railway-Postgres. Neon-Projekt mit Branch `dev` existiert für Entwicklung.
- [ ] Login mit E-Mail/Passwort. Der Seed legt einen Admin an (Org-Admin von „Muuv" und Plattform-Superadmin). Öffentliche Registrierung ist deaktiviert.
- [ ] Die App-Shell zeigt die komplette Sidebar aus `docs/plan.md` §3. Menüpunkte späterer Phasen öffnen eine Platzhalterseite „Kommt in Phase N".
- [ ] Unter *Admin → Clients & Connections* lässt sich ein Amazon-Ads-Account verbinden (OAuth, Region EU).
  - Die Profile erscheinen mit Land, Währung, Zeitzone und Typ.
  - Jedem Profil lässt sich ein **Client** zuordnen (auswählen oder neu anlegen).
  - Profile lassen sich ausblenden. Profile, die Amazon nicht mehr liefert, sind als „entfernt" markiert.
- [ ] Die Jobs `token-refresh` und `profiles-sync` laufen über pg-boss, schreiben `job_runs` und pingen Healthchecks.io.
- [ ] *Betrieb → Sync-Status* zeigt die letzten Jobläufe mit Status und Fehlertext.
- [ ] Die Settings-Seite speichert Locale (Zahlenformat) und Theme serverseitig.
- [ ] Die UI nutzt die Design-Tokens aus `design/theme.js` (Login und Shell im Kinetic-Bento-Look).
- [ ] ADR `docs/decisions/001-stack.md` ist aktuell.

## Voraussetzungen (manuell, Dominik)

- [ ] **0.0a Projektordner umbenennen.** Der aktuelle Pfad enthält Doppelpunkte (`Profit Dash Amazon : Otto : etc`).
  Doppelpunkte sind das Trennzeichen in `PATH`, dadurch finden pnpm-Skripte ihre Tools (`tsc`, `vitest` …) nicht.
  Vorschlag: `~/Projects/profitbash`.
- [ ] **0.0b Amazon Developer / LWA Security Profile anlegen**
  - Client-ID und Client-Secret notieren.
  - Allowed Return URLs: `http://localhost:8787/api/amazon/oauth/callback` und `https://<app>.up.railway.app/api/amazon/oauth/callback`.
  - Prüfen, ob LWA die `http://localhost`-URL akzeptiert. Falls nicht: den OAuth-Test über die Railway-URL oder einen HTTPS-Tunnel (z. B. `cloudflared`) fahren.
- [ ] **0.0c Ads-API-Zugang im Amazon Ads Partner Network beantragen**
  - Mit derselben E-Mail wie das Security Profile, als Agentur.
  - Nach der Freigabe die Security-Profile-ID in der Partner-Network-Konsole verknüpfen.
  - Die Freigabe kann mehrere Wochen dauern. Bis dahin arbeitet Claude Code gegen Mocks, der echte OAuth-Test kommt zuletzt.
- [ ] **0.0d Zugriff auf die Kunden-Werbekonten sicherstellen**
  - Das Amazon-Konto, mit dem später der OAuth-Login läuft, muss als User in den Werbekonten von Soapi, Aliseo und Evertag eingeladen sein.
  - Dann deckt eine Connection alle Profile ab.
- [ ] **0.0e SP-API-Registrierung anstoßen** (wird erst in Phase 7 gebraucht, die Freigabe dauert aber).
- [ ] **0.0f Accounts anlegen:** Railway (Trial reicht für Phase 0), Neon (Free), Healthchecks.io (Free), GitHub-Repo `profitbash` (privat).
- [ ] **0.0g Secrets bereitstellen** (siehe `.env.example` unten).

## Aufgaben

### 0.1 Monorepo & Tooling
- [ ] pnpm-Workspace mit `apps/{api,worker,web}` und `packages/{db,amazon-ads,engine,shared}`. Package-Scope `@profitbash/*`.
- [ ] Gemeinsame `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`), ESLint + Prettier, Vitest.
- [ ] `docker-compose.yml` mit Postgres 16 für die lokale Entwicklung.
- [ ] Root-Skripte: `dev`, `build`, `test`, `typecheck`, `lint`, `db:generate`, `db:migrate`, `db:seed`.
- [ ] GitHub-Actions-Workflow; Postgres für Tests als Service-Container.
- [ ] `.env.example` mit allen Variablen (siehe unten); Env-Validierung per zod beim Start jeder App.
- [ ] Vite-Dev-Server leitet `/api` an `http://localhost:8787` weiter. So laufen alle Browser-Requests über eine Origin.

### 0.2 Datenbank-Basis (`packages/db`)
- [ ] Drizzle + drizzle-kit, Migrationsordner, Treiber `postgres` (postgres.js) für App und Migrationen.
  pg-boss nutzt `DATABASE_URL_DIRECT` (nie einen Transaction-Pooler).
- [ ] better-auth-Tabellen:
  - `user` (inkl. `role` aus dem Admin-Plugin: `user` | `superadmin`), `session`, `account`, `verification`
  - Organization-Plugin: `organization` (Zusatzfeld `type`: `internal` | `client`), `member` (Rolle `admin` | `editor` | `viewer`), `invitation`
  - **Keine** eigenen `organizations`-/`memberships`-Tabellen. Die Plugin-Tabellen sind die einzige Quelle.
- [ ] Eigene Tabellen (alle mit `id` uuid, `created_at`, `updated_at`):
  - `org_entitlements`: `organization_id`, `feature` (text, Keys aus `docs/plan.md` §3), `enabled`; unique (`organization_id`, `feature`)
  - `clients`: `organization_id`, `name`, `slug`; unique (`organization_id`, `slug`)
  - `connections`:
    - `organization_id`, `provider` (`amazon_ads`), `region` (`eu` | `na` | `fe`), `amazon_account_email`
    - `refresh_token_encrypted`, `status` (`active` | `reauth_required` | `error`), `last_refreshed_at`, `created_by`
  - `amazon_ads_profiles`:
    - `organization_id`, `connection_id`, `client_id` (nullable)
    - `profile_id` (text), `account_name`, `country_code`, `currency_code`, `timezone`, `marketplace_id`, `account_type` (`seller` | `vendor` | `agency`)
    - `is_hidden` (vom Nutzer ausgeblendet), `removed_at` (Amazon liefert das Profil nicht mehr), `synced_at`
    - unique (`connection_id`, `profile_id`)
  - `job_runs`: `job`, `scope`, `status` (`running` | `success` | `failed`), `started_at`, `finished_at`, `error`, `counters` (jsonb)
  - `audit_events`: `organization_id`, `actor_user_id`, `action`, `target` (jsonb), `created_at`
  - `user_preferences`: `user_id`, `theme`, `locale`, `density`
  - `ui_state`: `user_id`, `scope`, `key`, `value` (jsonb); unique (`user_id`, `scope`, `key`)
- [ ] Access-Layer `access.ts`: `visibleProfileIds({ userId, orgId, includeHidden? })`. Alle Profil-Queries laufen darüber.
  - Regel Phase 0: alle Profile der Org mit `removed_at IS NULL`, ausgeblendete nur mit `includeHidden` (nur für Admins).
  - Profil-Freigaben pro Mitglied kommen in Phase 6 hinzu, ohne die Signatur zu ändern.
- [ ] Seed (idempotent): Org „Muuv" (`type = internal`), Admin-User aus `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
  (serverseitig über die better-auth-API, nicht über den deaktivierten Signup), Rolle `admin` + Plattform-Rolle `superadmin`,
  alle Entitlements aktiv.

### 0.3 Verschlüsselung (`packages/shared`)
- [ ] `encrypt()` / `decrypt()` mit AES-256-GCM, Key aus `ENCRYPTION_KEY` (32 Byte, base64), Format `v1:<iv>:<tag>:<cipher>`.
- [ ] Tests: Roundtrip, falscher Key schlägt fehl, manipulierter Ciphertext schlägt fehl.

### 0.4 Auth & `/api/me` (`apps/api`)
- [ ] Hono-Server, better-auth gemountet unter `/api/auth/*`, E-Mail/Passwort, Organization-Plugin mit eigenen Rollen, Admin-Plugin, Signup deaktiviert.
- [ ] Middleware: Session prüfen, aktive Org setzen, `requireRole('admin')`, `requireSuperadmin()`.
- [ ] `GET /api/me`: User, Orgs, aktive Org, `features` (`{view, write, entitled}` je Feature-Key), Preferences.
  - `entitled` aus `org_entitlements`, `view`/`write` aus der Org-Rolle (`viewer` = nur view).
- [ ] `GET /api/settings` und `PUT /api/settings`; `GET` und `PUT /api/settings/ui-state/:scope/:key`.
- [ ] `GET /api/health` (DB erreichbar, Version).
- [ ] zod-Schemas in `packages/shared`; OpenAPI-Dokument unter `/api/openapi.json`.
- [ ] Einheitliches Fehlerformat `{error: {code, message}}`; Logging mit Request-ID.
- [ ] Listen-Endpunkte nehmen viele IDs nie im Query-String entgegen, sondern per POST-Body oder serverseitigem Default.

### 0.5 Amazon-Client (`packages/amazon-ads`)
- [ ] Konfiguration je Region als Konstanten mit Quellen-Kommentar (gegen die aktuelle Amazon-Ads-Doku verifizieren):

  | Region | Authorize | Token | API-Host |
  |---|---|---|---|
  | eu | `https://eu.account.amazon.com/ap/oa` | `https://api.amazon.co.uk/auth/o2/token` | `https://advertising-api-eu.amazon.com` |
  | na | `https://www.amazon.com/ap/oa` | `https://api.amazon.com/auth/o2/token` | `https://advertising-api.amazon.com` |
  | fe | `https://apac.account.amazon.com/ap/oa` | `https://api.amazon.co.jp/auth/o2/token` | `https://advertising-api-fe.amazon.com` |

- [ ] `buildAuthorizeUrl(state)` mit Scope `advertising::campaign_management`.
- [ ] `exchangeCode(code)` → Refresh-Token; `getAccessToken(connection)` mit In-Memory-Cache bis kurz vor Ablauf.
- [ ] Refresh-Token-Rotation: Liefert Amazon beim Refresh einen neuen Refresh-Token, wird dieser sofort verschlüsselt gespeichert und ersetzt den alten.
- [ ] Zentraler `request()`:
  - setzt die Header `Authorization`, `Amazon-Advertising-API-ClientId` und bei Bedarf `Amazon-Advertising-API-Scope`
  - Retry bei 429/5xx mit exponentiellem Backoff und Jitter, `Retry-After` respektieren
  - Timeout
  - Logging ohne Tokens
  - **Verlustfreies JSON-Parsing:** Große Zahlen (Profil-, Kampagnen-IDs) werden als String gelesen, nie als `number`.
- [ ] `listProfiles(connection)` → normalisierte Profile (`profileId` als String).
- [ ] Tests mit msw: 429-Retry, Token-Rotation, und eine Profil-ID größer als `Number.MAX_SAFE_INTEGER` kommt unverändert an.

### 0.6 OAuth-Flow & Connections-API (`apps/api`)
- [ ] `POST /api/amazon/oauth/start` (nur Admin) → Redirect-URL mit signiertem `state` (HMAC; Org, User, Ablaufzeit 10 Min.).
- [ ] `GET /api/amazon/oauth/callback` → `state` prüfen, Code tauschen, Connection anlegen (Token verschlüsselt), `profiles-sync` sofort enqueuen, Redirect auf `/admin/connections`. Fehler landen als Hinweis auf der Seite.
- [ ] Connections und Clients:
  - `GET /api/connections`, `POST /api/connections/:id/sync`
  - `GET /api/connections/:id/profiles`
  - `PATCH /api/profiles/:id` (`client_id`, `is_hidden`)
  - `GET /api/clients`, `POST /api/clients`, `PATCH /api/clients/:id`
- [ ] Jede schreibende Aktion erzeugt ein `audit_event`.

### 0.7 Worker & Jobs (`apps/worker`)
- [ ] pg-boss-Setup, Job-Wrapper `runJob(name, scope, fn)`:
  - schreibt `job_runs` (running → success/failed)
  - fängt Fehler ab
  - pingt Healthchecks (Start/Erfolg/Fehler), wenn eine URL konfiguriert ist
- [ ] Worker exportiert `startWorker()`. `WORKER_MODE=inline` startet ihn im API-Prozess, `separate` als eigenen Prozess.
- [ ] `token-refresh`: stündlich; markiert Connections mit ungültigem Token als `status = 'reauth_required'`.
- [ ] `profiles-sync`: täglich 05:00 Europe/Berlin und on demand.
  - Profile upserten (über den Unique-Key `connection_id` + `profile_id`), `removed_at` zurücksetzen, wenn ein Profil wieder auftaucht.
  - Profile, die Amazon nicht mehr liefert, bekommen `removed_at = now()`. Nichts wird gelöscht, `is_hidden` bleibt unberührt.
- [ ] Graceful Shutdown.

### 0.8 Frontend-Grundgerüst (`apps/web`)
- [ ] Vue 3 + Vite + PrimeVue (Styled Mode, eigenes Preset in `src/theme/` aus `design/theme.js`, Light/Dark), Tailwind v4 für Layout,
  Pinia, Vue Router, TanStack Query, vue-i18n (Default `de`), generierter API-Client aus `/api/openapi.json`.
- [ ] Fonts self-hosted (Space Grotesk, JetBrains Mono für alle Zahlen), keine Google-Fonts-Links.
- [ ] Visuelle Referenz: `design/PROFITBASH-claude-design.html` (Screens `login`, Sidebar/Shell). Nur als Vorlage, kein Copy-Paste des Stitch-HTML.
- [ ] Login-Seite; Router-Guards für `requiresAuth`, `feature`, `requiresOrgAdmin`, `requiresSuperadmin`.
- [ ] App-Shell:
  - einklappbare Sidebar mit der Menüstruktur aus `docs/plan.md` §3 (Sichtbarkeit über `features`)
  - Account-Menü: Dark Mode, Settings, Shortcuts, Logout
  - Quick-Tools-Popover (nur Platzhalter)
- [ ] Platzhalterseite je späterem Menüpunkt mit Phasenhinweis.
- [ ] **Clients & Connections:**
  - Button „Amazon-Account verbinden", Liste der Connections mit Status (inkl. „Neu verbinden" bei `reauth_required`)
  - Profiltabelle (AG Grid Community): Flagge, Land, Account-Name, Typ, Währung, Zeitzone, Client (Auswahl oder neu anlegen), Ausblenden-Toggle, Filter „entfernte anzeigen"
  - Button „Jetzt synchronisieren"
- [ ] **Sync-Status:** letzte 100 `job_runs`, filterbar nach Job und Status, Fehlertext aufklappbar.
- [ ] **Settings:** Locale mit Formatvorschau (Zahl, Währung, Prozent), Theme.
- [ ] Gemeinsame Komponenten: `EmptyState`, `InlineError`, `PageHeader`, `SkeletonBlock`; Formatierungs-Helper (Zahl, Währung, Prozent) aus `packages/shared`.

### 0.9 Deployment
- [ ] Railway-Service `app`:
  - Build von api und web; Hono liefert `apps/web/dist` aus, `/api/*` bleibt API (gleiche Origin)
  - Pre-Deploy-Command: `pnpm db:migrate`
  - Healthcheck `GET /api/health`
  - `WORKER_MODE=inline`
- [ ] Railway-Postgres mit aktivierten Backups.
- [ ] Doku in `docs/deploy.md`: Umstellung auf `WORKER_MODE=separate` mit zweitem Service.

## `.env.example`

```
# Öffentliche Origin der App (Dev: Vite-Server, Prod: Railway-URL)
APP_URL=http://localhost:5173
API_PORT=8787
WORKER_MODE=inline                 # inline | separate

DATABASE_URL=postgres://profitbash:profitbash@localhost:5432/profitbash
DATABASE_URL_DIRECT=postgres://profitbash:profitbash@localhost:5432/profitbash   # für pg-boss und Migrationen

BETTER_AUTH_SECRET=                # openssl rand -base64 32
ENCRYPTION_KEY=                    # openssl rand -base64 32  (genau 32 Byte)
OAUTH_STATE_SECRET=                # openssl rand -base64 32

AMAZON_ADS_CLIENT_ID=
AMAZON_ADS_CLIENT_SECRET=
AMAZON_ADS_REDIRECT_URI=http://localhost:8787/api/amazon/oauth/callback
AMAZON_ADS_USE_MOCK=true           # true bis zur API-Freigabe

HEALTHCHECKS_TOKEN_REFRESH_URL=
HEALTHCHECKS_PROFILES_SYNC_URL=

SEED_ADMIN_EMAIL=
SEED_ADMIN_PASSWORD=
```

## Bewusst nicht in Phase 0

- Keine Entity- oder Report-Daten (Phase 1)
- Kein Explorer, kein Dashboard (Phase 2)
- Keine Mitgliederverwaltung über den Seed-Admin hinaus (Phase 2)
- Keine Writes an Amazon (Phase 3)
- Keine Profit-/SP-API-Daten (Phase 7), nichts zu Otto/eBay/Shopify (pausiert)

## Reihenfolge für Claude Code

0.1 → 0.2 → 0.3 → 0.4 → 0.8 (Login + Shell) → 0.5 → 0.6 → 0.7 → 0.8 (Connections, Sync-Status, Settings) → 0.9.

Nach jedem Schritt: Tests grün, kurzer Commit, Häkchen in dieser Datei setzen.
