# Phase 0 – Fundament

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (Navigation, Feature-Keys, Leitplanken), `docs/decisions/` (001 Stack, 002 Mandanten-Modell).

## Ziel

Ein deploytes Grundgerüst mit folgendem Stand:
- Login funktioniert.
- Ein Amazon-Ads-Account ist per OAuth verbunden.
- Seine Profile werden täglich synchronisiert, einem Client zugeordnet und in der UI angezeigt.
- Alle weiteren Phasen bauen darauf auf, ohne das Fundament umzubauen.

## Definition of Done

- [ ] `pnpm dev` startet api, worker und web lokal (lokales Postgres 17 über Homebrew); `pnpm test`, `pnpm typecheck` und `pnpm lint` sind grün.
- [ ] CI (GitHub Actions) läuft bei jedem Push auf `main` und bei Pull Requests: Schema-/Migrations-Check, typecheck, lint, test, build.
- [ ] Railway-Service `app` (API + Web auf einer Origin, `WORKER_MODE=inline`, `NODE_ENV=production`) ist erreichbar und nutzt Railway-Postgres mit Backups.
- [ ] Login mit E-Mail/Passwort. Der Seed legt einen Admin an (Org-Admin von „Muuv" und Plattform-Superadmin). Öffentliche Registrierung ist deaktiviert.
- [ ] Die App-Shell zeigt die komplette Sidebar aus `docs/plan.md` §3. Menüpunkte späterer Phasen öffnen eine Platzhalterseite „Kommt in Phase N".
- [ ] Unter *Admin → Clients & Connections* lässt sich ein Amazon-Ads-Account verbinden (OAuth, Region EU). Bis zur API-Freigabe mit dem Mock-Anbieter (`AMAZON_ADS_USE_MOCK=true`), danach einmal echt.
  - Die Profile erscheinen mit Land, Währung, Zeitzone und Typ.
  - Jedem Profil lässt sich ein **Client** zuordnen (auswählen oder neu anlegen).
  - Profile lassen sich ausblenden. Profile, die Amazon nicht mehr liefert, sind als „entfernt" markiert.
  - Erneutes Verbinden desselben Amazon-Kontos aktualisiert die bestehende Connection, statt eine zweite anzulegen.
- [ ] Die Jobs `token-refresh` und `profiles-sync` laufen über pg-boss, schreiben `job_runs` und pingen Healthchecks.io.
- [ ] *Betrieb → Sync-Status* zeigt die letzten Jobläufe mit Status und Fehlertext.
- [ ] Die Settings-Seite speichert Locale (Zahlenformat) und Theme serverseitig.
- [ ] Die UI nutzt die Design-Tokens aus `design/theme.js` (Login und Shell im Kinetic-Bento-Look).
- [ ] ADRs `docs/decisions/001-stack.md` und `002-tenancy.md` sind aktuell.

## Voraussetzungen (manuell, Dominik)

- [x] **0.0a Projektordner umbenennen.** Der aktuelle Pfad enthält Doppelpunkte (`Profit Dash Amazon : Otto : etc`).
  Doppelpunkte sind das Trennzeichen in `PATH`, dadurch finden pnpm-Skripte ihre Tools (`tsc`, `vitest` …) nicht.
  Vorschlag: `~/Projects/profitbash`.
- [ ] **0.0b Amazon Developer / LWA Security Profile anlegen**
  - Client-ID und Client-Secret notieren.
  - Allowed Return URLs: `http://localhost:5173/api/amazon/oauth/callback` (über den Vite-Proxy) und `https://<app>.up.railway.app/api/amazon/oauth/callback`.
  - Prüfen, ob LWA die `http://localhost`-URL akzeptiert. Falls nicht: den OAuth-Test über die Railway-URL oder einen HTTPS-Tunnel (z. B. `cloudflared`) fahren.
- [ ] **0.0c Ads-API-Zugang im Amazon Ads Partner Network beantragen**
  - Mit derselben E-Mail wie das Security Profile, als Agentur.
  - Nach der Freigabe die Security-Profile-ID in der Partner-Network-Konsole verknüpfen.
  - Die Freigabe kann mehrere Wochen dauern. Bis dahin arbeitet Claude Code gegen Mocks, der echte OAuth-Test kommt zuletzt.
- [ ] **0.0d Zugriff auf die Kunden-Werbekonten sicherstellen**
  - Das Amazon-Konto, mit dem später der OAuth-Login läuft, muss als User in den Werbekonten von Soapi, Aliseo und Evertag eingeladen sein.
  - Dann deckt eine Connection alle Profile ab.
- [ ] **0.0e SP-API-Registrierung anstoßen** (wird erst in Phase 7 gebraucht, die Freigabe dauert aber).
- [ ] **0.0f Accounts anlegen:** Railway, Healthchecks.io (Free), GitHub-Repo `profitbash` (privat). Neon (Free) nur bei Bedarf für geteilte Dev-/Preview-Datenbanken; lokal reicht Homebrew-Postgres.
  - Railway-Hobby erst starten, wenn der erste echte Deploy ansteht (das Trial-Guthaben ist zeitlich begrenzt, die Amazon-Freigabe kann Wochen dauern).
  - Prüfen, ob Backups für Railway-Postgres im Hobby-Plan enthalten sind. Falls nicht: nächtlicher `pg_dump` per GitHub Action (siehe 0.9).
- [ ] **0.0g Secrets bereitstellen** (siehe `.env.example` unten).

## Aufgaben

### 0.1 Monorepo & Tooling
- [x] pnpm-Workspace mit `apps/{api,worker,web}` und `packages/{db,amazon-ads,engine,shared}`. Package-Scope `@profitbash/*`.
- [x] Gemeinsame `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`), ESLint + Prettier, Vitest.
- [x] Lokale DB ist eingerichtet: Postgres 17 (Homebrew), Rolle `profitbash`, Datenbanken `profitbash` und `profitbash_test`. Tests nutzen `DATABASE_URL_TEST`. CI nutzt einen Postgres-17-Service-Container.
- [x] Root-Skripte: `dev`, `build`, `test`, `typecheck`, `lint`, `db:generate`, `db:migrate`, `db:seed`.
- [x] GitHub-Actions-Workflow; Postgres für Tests als Service-Container. (Lokal verifiziert; erster echter Lauf nach dem Push ins GitHub-Repo, siehe 0.0f.)
- [x] `.env.example` mit allen Variablen (siehe unten); Env-Validierung per zod beim Start jeder App (`loadEnv` in `packages/shared`; das Web ist eine statische SPA und bekommt nur `VITE_*`-Variablen).
- [x] Vite-Dev-Server leitet `/api` an `http://localhost:8787` weiter. So laufen alle Browser-Requests über eine Origin.

### 0.2 Datenbank-Basis (`packages/db`)
- [x] Drizzle + drizzle-kit, Migrationsordner `packages/db/drizzle`, Treiber `postgres` (postgres.js) für App und Migrationen.
  pg-boss nutzt `DATABASE_URL_DIRECT` (nie einen Transaction-Pooler).
- [x] better-auth-Tabellen (Plural, UUID-IDs), **erzeugt mit dem better-auth-CLI** aus `apps/api/src/auth.ts`
  (`pnpm --filter @profitbash/api auth:schema`, danach `pnpm db:generate`):
  - `users` (inkl. `role` aus dem Admin-Plugin: `user` | `superadmin`), `sessions`, `accounts`, `verifications`
  - Organization-Plugin: `organizations` (Zusatzfeld `type`: `internal` | `client`), `members` (Rolle `admin` | `editor` | `viewer`), `invitations`
  - **Keine** eigenen Organisations-/Mitgliedschafts-Tabellen. Die Plugin-Tabellen sind die einzige Quelle.
- [x] Eigene Tabellen (alle mit `id` uuid, `created_at`, `updated_at`, Zeitstempel mit Zeitzone):
  - `org_entitlements`: `organization_id`, `feature` (text, Keys aus `docs/plan.md` §3), `enabled`; unique (`organization_id`, `feature`)
  - `clients`: `organization_id`, `name`, `slug`; unique (`organization_id`, `slug`)
  - `connections` (provider-neutral):
    - `organization_id`, `provider` (`amazon_ads`), `region` (`eu` | `na` | `fe`, nullable für Anbieter ohne Regionen)
    - `external_account_id` (Amazon: LWA-User-ID), `external_account_email`
    - `refresh_token_encrypted`, `status` (`active` | `reauth_required` | `error`), `last_refreshed_at`, `created_by`
    - unique (`organization_id`, `provider`, `region`, `external_account_id`) → erneutes Verbinden = Update statt Duplikat
  - `amazon_ads_profiles`:
    - `organization_id`, `connection_id` (aktueller Zugriffsweg), `client_id` (nullable)
    - `amazon_profile_id` (text), `amazon_account_id` (`accountInfo.id`), `account_name`, `country_code`, `currency_code`, `timezone`, `marketplace_id`, `account_type` (Text: `seller` | `vendor` | `agency`, damit neue Amazon-Werte den Sync nicht brechen)
    - `is_hidden` (vom Nutzer ausgeblendet), `removed_at` (Amazon liefert das Profil nicht mehr), `synced_at`
    - unique (`organization_id`, `amazon_profile_id`): ein Profil pro Organisation, auch wenn mehrere Connections es sehen
    - zusammengesetzte Fremdschlüssel (`connection_id`, `organization_id`) und (`client_id`, `organization_id`): keine Verknüpfungen über Org-Grenzen
  - `job_runs`: `organization_id` (null = plattformweit), `job`, `scope`, `status` (`running` | `success` | `failed`), `started_at`, `finished_at`, `error`, `counters` (jsonb)
  - `audit_events`: `organization_id`, `actor_user_id`, `action`, `target` (jsonb), `created_at`
  - `user_preferences`: `user_id` (unique), `theme`, `locale`, `density`
  - `ui_state`: `user_id`, `scope`, `key`, `value` (jsonb); unique (`user_id`, `scope`, `key`)
- [x] Access-Layer `packages/db/src/access.ts`. Alle Profil-Queries laufen darüber:
  - `visibleProfileIds(db, { userId, orgId, includeHidden? })` (Liste), `visibleProfilesScope(...)` (Unterabfrage für große Mengen), `canSeeProfile(...)`, `getOrgRole(...)`
  - Regel Phase 0: alle Profile der Org mit `removed_at IS NULL`, ausgeblendete nur mit `includeHidden` (nur für Admins, sonst `AccessDeniedError`). Nicht-Mitglieder sehen nichts.
  - Profil-Freigaben pro Mitglied kommen in Phase 6 hinzu, ohne die Signaturen zu ändern.
- [x] Seed (idempotent) in **`apps/api/src/seed.ts`** (braucht die Auth-Konfiguration der API), Aufruf `pnpm db:seed`:
  Org „Muuv" (`type = internal`), Admin-User aus `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`
  (serverseitig über die better-auth-API, nicht über den deaktivierten Signup), Rolle `admin` + Plattform-Rolle `superadmin`,
  alle Entitlements aktiv.
- [x] Test-Datenbanken: Die globale Test-Einrichtung baut aus `DATABASE_URL_TEST` eine migrierte Template-DB,
  jede Testdatei arbeitet auf einem eigenen Klon (`createTestDatabase()` aus `@profitbash/db/testing`).
  Schutz: `DATABASE_URL_TEST` muss auf `_test` enden und darf nicht `DATABASE_URL(_DIRECT)` sein.
- [x] Nach Review angepasst (siehe Commit „package A"): `members` eindeutig pro Org/Nutzer mit Rollen-Check (Migration `0001`),
  DB-Sessions in UTC, Org-`type` für Clients schreibgeschützt, Seed lässt abgeschaltete Entitlements aus.
  Die Migrationen wurden vor dem ersten Deploy zu `0000_init` zusammengefasst. Ab dem ersten Deploy werden Migrationen nie mehr geändert.

### 0.3 Verschlüsselung (`@profitbash/shared/crypto`, nur Server)
- [x] Eigener Einstiegspunkt `@profitbash/shared/crypto` (nutzt `node:crypto`, nicht in der Browser-Wurzel exportiert).
- [x] `encrypt(plaintext, { keyring, aad })` / `decrypt(ciphertext, { keyring, aad })` mit AES-256-GCM.
  - Format `v1:<keyId>:<iv>:<tag>:<cipher>` (base64url). Aktueller Schlüssel aus `ENCRYPTION_KEY` (32 Byte, base64) mit `ENCRYPTION_KEY_ID`, geprüft über `parseKeyring()`.
  - Schlüsselrotation: `ENCRYPTION_KEYS_PREVIOUS` (`id:key,id:key`) nur zum Entschlüsseln; `needsReencryption()` erkennt alte Werte.
    Das Rotations-Skript über alle Connections folgt mit 0.9 (`docs/deploy.md`).
  - **AAD** = `connectionTokenAad({ organizationId, provider, region, externalAccountId })` →
    `connection:<org>:<provider>:<region|->:<externalAccountId>`. Gebunden an den **natürlichen Schlüssel** statt an die Zeilen-ID:
    Die ID vergibt die DB erst beim Einfügen, und beim Neu-Verbinden landet der Token per Upsert auf der bestehenden Zeile (Review-Befund).
  - Strenge Eingabeprüfung: kanonisches Base64 für Schlüssel und Ciphertext, feste Längen für IV und Tag (Schutz vor GCM-Truncation),
    keine ungeprüften Werte aus dem Ciphertext in Fehlermeldungen, keine leeren Werte.
  - Fehlerarten: `KeyringError` (Konfiguration), `DecryptionError` (Daten), `TypeError` (Programmierfehler).
- [x] Tests (TDD, 26): Roundtrip, zufällige IV, Format ohne Klartext, falscher Key, manipulierter und abgeschnittener Tag,
  manipulierter Ciphertext, falsche und leere AAD, unbekannte `keyId`, kaputte Formate, Log-Injection, Rotation,
  strenge Schlüsselprüfung ohne Schlüssel in Fehlermeldungen. Der Tag-Längen-Test ist per Mutation geprüft.
- [ ] Einbindung in die Env-Validierung der Apps mit dem ersten Nutzer (0.6: Connection anlegen).

### 0.4 Auth & `/api/me` (`apps/api`)
- [x] Hono-Server, better-auth gemountet unter `/api/auth/*`, E-Mail/Passwort, Organization-Plugin mit eigenen Rollen, Admin-Plugin, Signup deaktiviert, `trustedOrigins` = `APP_URL`.
  - `createApp({ db, auth, appUrl, version, logger })` bekommt alle Abhängigkeiten übergeben (Tests ohne Port und ohne globale Imports).
  - Neue Sessions starten in der ältesten Organisation des Nutzers (`databaseHooks.session.create`).
  - **better-auth per HTTP nur über eine Allowlist:** `/sign-in/email`, `/sign-out`, `/get-session`, `/ok`, `/error`, `/organization/*`.
    Alles andere (Admin-Plugin, Passwort ändern, Profil, Sessions widerrufen) liefert `404`, bis es mit Audit und UI gebraucht wird
    (Plattform-Admin in Phase 6). Serverseitige Aufrufe (`auth.api.*`, z. B. im Seed) sind nicht betroffen.
  - `/api/auth/*` antwortet im Fehlerformat von better-auth (`{ code, message }`), die eigenen Endpunkte mit `{ error: { code, message } }`.
  - Request-Bodies über 64 KB: `413 PAYLOAD_TOO_LARGE` (vor dem Parsen).
- [x] Middleware: Session prüfen, aktive Org setzen, `requireRole('admin')`, `requireSuperadmin()`.
  - `requireSession` liest Rolle und Mitgliedschaften bei jeder Anfrage frisch aus der DB (entzogene Rechte gelten sofort).
    Aktive Org = Org aus der Session, falls der Nutzer dort noch Mitglied ist, sonst die älteste Mitgliedschaft.
    Der Fallback wird in die Session zurückgeschrieben, damit better-auth-Endpunkte dieselbe Org verwenden.
  - Verlängert better-auth die Session beim Prüfen, reicht die Middleware den neuen Cookie an den Browser weiter.
  - `requireRole(min)` mit Rangfolge `admin` ⊃ `editor` ⊃ `viewer`; ohne aktive Org `403 NO_ACTIVE_ORGANIZATION`.
- [x] CSRF-Schutz für eigene schreibende Endpunkte (Hono `csrf()` mit `APP_URL` als Origin), zusätzlich zu SameSite-Cookies.
  Hono prüft nur formularartige Requests; JSON-Requests fremder Origins scheitern am CORS-Preflight (die API erlaubt kein CORS).
  `/api/auth/*` nutzt die Origin-Prüfung von better-auth.
- [x] Audit: Schreibvorgänge über better-auth (Mitglieder, Rollen, Organisation) erzeugen über better-auth-Hooks ebenfalls `audit_events`.
  - `organizationHooks` für Organisation anlegen/ändern, Mitglied hinzufügen/entfernen, Rollenwechsel (mit vorheriger Rolle), Einladungen.
    Der Handelnde kommt aus dem better-auth-Endpoint-Kontext (`@better-auth/core/context`, gleiche Version wie better-auth), `null` bei Server-Aufrufen wie dem Seed.
  - `/organization/leave` löst keinen Organization-Hook aus und wird über `hooks.after` erfasst.
  - Org-Admins können ihre Organisation nicht löschen (Rolle `admin` hat kein `organization:delete`, per Test abgesichert).
  - Die Hooks laufen nach der Änderung, nicht in derselben Transaktion. Scheitert das Audit-Insert, bleibt die Änderung
    bestehen und die Anfrage endet mit 500 (bewusst akzeptiert).
  - Offen für Phase 6 (Plattform-Admin): Audit für Admin-Plugin-Aktionen, bevor diese Endpunkte freigegeben werden.
- [x] `GET /api/me`: User, Orgs, aktive Org, `features` (`{view, write, entitled}` je Feature-Key), Preferences.
  - `entitled` aus `org_entitlements`, `view`/`write` aus der Org-Rolle (`viewer` = nur view).
  - Nicht gebuchte Features: `view = write = false` (`resolveFeatureAccess` in `packages/shared`).
- [x] `GET /api/settings` und `PUT /api/settings`; `GET` und `PUT /api/settings/ui-state/:scope/:key`.
  - `PUT /api/settings` ersetzt Theme, Locale (`de-DE`, `en-GB`, `en-US`) und Dichte vollständig und schreibt `settings.update`
    (mit `before` und `after`) in derselben Transaktion ins Audit-Log.
  - UI-State (max. 16 KB je Key) bewusst **ohne** Audit-Event: reiner Darstellungszustand des eigenen Nutzers, sehr häufige Writes.
- [x] `GET /api/health` (DB erreichbar, Version). `503`, wenn die DB nicht oder nicht binnen 3 s antwortet. Version = `RAILWAY_GIT_COMMIT_SHA` (gekürzt) oder `dev`.
- [x] zod-Schemas in `packages/shared`; OpenAPI-Dokument unter `/api/openapi.json`.
  JSON-Werte als `z.unknown()`: Das rekursive `z.json()` lässt sich nicht nach OpenAPI übersetzen.
- [x] Einheitliches Fehlerformat `{error: {code, message}}`; Logging mit Request-ID.
  JSON-Zeilen mit `requestId`, Methode, Pfad (ohne Query-String), Status, Dauer; Header `X-Request-Id`. Unerwartete Fehler: `500 INTERNAL_ERROR` ohne interne Details.
- [x] Listen-Endpunkte nehmen viele IDs nie im Query-String entgegen, sondern per POST-Body oder serverseitigem Default.
  (Regel steht; in 0.4 gibt es noch keine Listen-Endpunkte. Gilt ab 0.6.)
- [x] Typisierte ESLint-Regeln aktivieren (`@typescript-eslint/no-floating-promises`, `no-misused-promises`), bevor Job- und Request-Code wächst.

### 0.5 Amazon-Client (`packages/amazon-ads`)
- [ ] Konfiguration je Region als Konstanten mit Quellen-Kommentar (gegen die aktuelle Amazon-Ads-Doku verifizieren):

  | Region | Authorize | Token | LWA-Profil | API-Host |
  |---|---|---|---|---|
  | eu | `https://eu.account.amazon.com/ap/oa` | `https://api.amazon.co.uk/auth/o2/token` | `https://api.amazon.co.uk/user/profile` | `https://advertising-api-eu.amazon.com` |
  | na | `https://www.amazon.com/ap/oa` | `https://api.amazon.com/auth/o2/token` | `https://api.amazon.com/user/profile` | `https://advertising-api.amazon.com` |
  | fe | `https://apac.account.amazon.com/ap/oa` | `https://api.amazon.co.jp/auth/o2/token` | `https://api.amazon.co.jp/user/profile` | `https://advertising-api-fe.amazon.com` |

- [ ] `buildAuthorizeUrl(state)` mit den Scopes `advertising::campaign_management profile`.
- [ ] `exchangeCode(code)` → Refresh-Token; `getAccountIdentity(accessToken)` → LWA `user_id` (→ `external_account_id`) und E-Mail.
- [ ] `getAccessToken(connection)` mit In-Memory-Cache bis kurz vor Ablauf.
- [ ] Refresh-Token-Rotation: Liefert Amazon beim Refresh einen neuen Refresh-Token, wird dieser sofort verschlüsselt gespeichert und ersetzt den alten.
  Der Refresh einer Connection läuft unter einer Sperre (Advisory-Lock bzw. `SELECT … FOR UPDATE`), damit API und Worker sich nicht gegenseitig einen rotierten Token überschreiben.
- [ ] Zentraler `request()`:
  - setzt die Header `Authorization`, `Amazon-Advertising-API-ClientId` und bei Bedarf `Amazon-Advertising-API-Scope`
  - Retry bei 429/5xx mit exponentiellem Backoff und Jitter, `Retry-After` respektieren
  - Timeout
  - Logging ohne Tokens
  - **Verlustfreies JSON-Parsing:** Große Zahlen (Profil-, Kampagnen-IDs) werden als String gelesen, nie als `number`.
  - Alle Antworten werden mit zod validiert; unbekannte Enum-Werte (z. B. neuer `accountType`) werden durchgereicht und geloggt, nicht verworfen.
- [ ] `listProfiles(connection)` → normalisierte Profile (`amazonProfileId`, `amazonAccountId` als String).
- [ ] **Mock-Anbieter** hinter derselben Schnittstelle (`AMAZON_ADS_USE_MOCK=true`): simulierte Einwilligungsseite → Callback mit Test-Code,
  feste Test-Identität und Test-Profile (inkl. einer Profil-ID > `Number.MAX_SAFE_INTEGER`). Damit ist Phase 0 ohne API-Freigabe vorführbar.
- [ ] Tests mit msw: 429-Retry, Token-Rotation, Identität, und eine Profil-ID größer als `Number.MAX_SAFE_INTEGER` kommt unverändert an.

### 0.6 OAuth-Flow & Connections-API (`apps/api`)
- [ ] `POST /api/amazon/oauth/start` (nur Admin, optional `connectionId` für „Neu verbinden") → Redirect-URL mit `state`:
  - signiert (HMAC mit `OAUTH_STATE_SECRET`), enthält Org, User, optional Connection, Ablaufzeit 10 Min. und eine Nonce
  - die Nonce ist **einmal verwendbar** (in `verifications` gespeichert und beim Callback gelöscht)
- [ ] `GET /api/amazon/oauth/callback`:
  - verlangt eine Session: `session.userId == state.userId`, und der Nutzer ist weiterhin Admin von `state.orgId`
  - Code tauschen, Identität holen, Connection per **Upsert** auf (`organization_id`, `provider`, `region`, `external_account_id`) anlegen bzw. aktualisieren
    (Token verschlüsselt mit `connectionTokenAad` über genau diesen natürlichen Schlüssel, `status = active`)
  - `profiles-sync` sofort enqueuen, Redirect auf `${APP_URL}/admin/connections`. Fehler landen als Hinweis auf der Seite.
- [ ] Connections und Clients:
  - `GET /api/connections`, `POST /api/connections/:id/sync`
  - `GET /api/connections/:id/profiles`
  - `PATCH /api/profiles/:id` (`client_id`, `is_hidden`); `client_id` muss zur selben Organisation gehören (die DB erzwingt es zusätzlich)
  - `GET /api/clients`, `POST /api/clients`, `PATCH /api/clients/:id`
- [ ] Jede schreibende Aktion erzeugt ein `audit_event`.
- [ ] Tests: fremde Session am Callback, abgelaufener und wiederverwendeter `state`, Neu-Verbinden aktualisiert statt dupliziert
  **und der gespeicherte Token lässt sich danach entschlüsseln**.

### 0.7 Worker & Jobs (`apps/worker`)
- [ ] pg-boss-Setup, Job-Wrapper `runJob(name, scope, fn)`:
  - schreibt `job_runs` (running → success/failed, mit `organization_id`)
  - fängt Fehler ab
  - pingt Healthchecks (Start/Erfolg/Fehler), wenn eine URL konfiguriert ist
- [ ] Worker exportiert `startWorker()`. `WORKER_MODE=inline` startet ihn im API-Prozess, `separate` als eigenen Prozess.
  Der eigenständige Worker-Prozess beendet sich bei `WORKER_MODE=inline` mit einem Hinweis (sonst liefe er in `pnpm dev` doppelt).
- [ ] Jobs je Connection laufen nicht parallel (pg-boss `singletonKey` = Connection-ID).
- [ ] `token-refresh`: stündlich; markiert Connections mit ungültigem Token als `status = 'reauth_required'`.
- [ ] `profiles-sync`: täglich 05:00 Europe/Berlin und on demand.
  - Profile upserten über (`organization_id`, `amazon_profile_id`); `connection_id` auf die synchronisierende Connection setzen; `removed_at` zurücksetzen, wenn ein Profil wieder auftaucht.
  - Profile, die Amazon über keine Connection der Org mehr liefert, bekommen `removed_at = now()`. Nichts wird gelöscht, `is_hidden` bleibt unberührt.
- [ ] `job-runs-cleanup`: täglich, löscht `job_runs` älter als 90 Tage.
- [ ] Graceful Shutdown.

### 0.8 Frontend-Grundgerüst (`apps/web`)
- [ ] Vue 3 + Vite + PrimeVue (Styled Mode, eigenes Preset in `src/theme/` aus `design/theme.js`, Light/Dark), Tailwind v4 für Layout,
  Pinia, Vue Router, TanStack Query, vue-i18n (Default `de`), generierter API-Client aus `/api/openapi.json`.
- [ ] Das Web importiert aus `@profitbash/shared` nur die browserfähige Wurzel und `/access-control`, nie `/env` oder `/crypto`.
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
- [ ] Produktionsfähige Einstiegspunkte mit tsup bündeln: `apps/api` (Server), `migrate` und `seed` als eigene Bundles.
  Kein `tsx` in Produktion. Der Migrationsordner ist konfigurierbar (`MIGRATIONS_DIR`) bzw. wird neben das Bundle kopiert
  (der Pfad über `import.meta.url` stimmt nach dem Bündeln nicht mehr).
- [ ] Build installiert inklusive Dev-Abhängigkeiten (tsup, vite); zur Laufzeit gilt `NODE_ENV=production` (aktiviert u. a. das Rate-Limit von better-auth).
- [ ] Railway-Service `app`:
  - Hono liefert `apps/web/dist` aus, `/api/*` bleibt API (gleiche Origin), SPA-Fallback auf `index.html` für alle übrigen Pfade
  - Port aus `PORT` (von Railway gesetzt), Fallback `API_PORT`
  - Pre-Deploy-Command: gebündelte Migration
  - Healthcheck `GET /api/health`
  - `WORKER_MODE=inline`
- [ ] Seed einmalig in Produktion ausführen (gebündelter `seed`, Admin-Daten aus Railway-Variablen, danach entfernen).
- [ ] Railway-Postgres mit Backups; falls der Hobby-Plan keine enthält: nächtlicher `pg_dump` per GitHub Action in einen privaten Speicher.
- [ ] Doku in `docs/deploy.md`: Umstellung auf `WORKER_MODE=separate` mit zweitem Service, Secrets, Schlüsselrotation.
- [ ] Rotations-Skript: verschlüsselt alle Tokens, bei denen `needsReencryption()` greift, mit dem aktuellen Schlüssel neu;
  Zeilen mit kaputtem Wert (`DecryptionError`) melden und überspringen, nicht abbrechen.
  Betriebsregel: Ein neuer Schlüssel bekommt immer eine **neue** `ENCRYPTION_KEY_ID`. Dieselbe ID mit neuem Schlüssel macht alle alten Werte unlesbar, und der Code kann das nicht erkennen.

## `.env.example`

Die Datei `.env.example` im Repo-Root ist die Quelle. Neue Variablen in den Aufgaben oben:
`ENCRYPTION_KEY_ID`, `ENCRYPTION_KEYS_PREVIOUS` (0.3), `PORT` (0.9, von Railway gesetzt).
`AMAZON_ADS_REDIRECT_URI` zeigt über den Vite-Proxy auf `APP_URL`, damit Callback und Session auf derselben Origin liegen.

## Bewusst nicht in Phase 0

- Keine Entity- oder Report-Daten (Phase 1)
- Kein Explorer, kein Dashboard (Phase 2)
- Keine Mitgliederverwaltung über den Seed-Admin hinaus (Phase 2)
- Keine Writes an Amazon (Phase 3)
- Keine Profit-/SP-API-Daten (Phase 7), nichts zu Otto/eBay/Shopify (pausiert)

## Reihenfolge für Claude Code

0.1 → 0.2 → 0.3 → 0.4 → 0.8 (Login + Shell) → 0.5 → 0.6 → 0.7 → 0.8 (Connections, Sync-Status, Settings) → 0.9.

Nach jedem Schritt: Tests grün, kurzer Commit, Häkchen in dieser Datei setzen.
