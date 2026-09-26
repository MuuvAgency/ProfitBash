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
- [x] CI (GitHub Actions) läuft bei jedem Push auf `main` und bei Pull Requests: Schema-/Migrations-Check, typecheck, lint, test, build.
- [ ] Railway-Service `app` (API + Web auf einer Origin, `WORKER_MODE=inline`, `NODE_ENV=production`) ist erreichbar und nutzt Railway-Postgres mit Backups.
- [x] Login mit E-Mail/Passwort. Der Seed legt einen Admin an (Org-Admin von „Muuv" und Plattform-Superadmin). Öffentliche Registrierung ist deaktiviert.
- [x] Die App-Shell zeigt die komplette Sidebar aus `docs/plan.md` §3. Menüpunkte späterer Phasen öffnen eine Platzhalterseite „Kommt in Phase N".
- [ ] Unter *Admin → Clients & Connections* lässt sich ein Amazon-Ads-Account verbinden (OAuth, Region EU). Bis zur API-Freigabe mit dem Mock-Anbieter (`AMAZON_ADS_USE_MOCK=true`), danach einmal echt.
  - Die Profile erscheinen mit Land, Währung, Zeitzone und Typ.
  - Jedem Profil lässt sich ein **Client** zuordnen (auswählen oder neu anlegen).
  - Profile lassen sich ausblenden. Profile, die Amazon nicht mehr liefert, sind als „entfernt" markiert.
  - Erneutes Verbinden desselben Amazon-Kontos aktualisiert die bestehende Connection, statt eine zweite anzulegen.
- [x] Die Jobs `token-refresh` und `profiles-sync` laufen über pg-boss, schreiben `job_runs` und pingen Healthchecks.io.
- [x] *Betrieb → Sync-Status* zeigt die letzten Jobläufe mit Status und Fehlertext.
- [ ] Die Settings-Seite speichert Locale (Zahlenformat) und Theme serverseitig.
- [x] Die UI nutzt die Design-Tokens aus `design/theme.js` (Login und Shell im Kinetic-Bento-Look).
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
  - Stand 2026-09-26: GitHub-Repo erledigt (`MuuvAgency/ProfitBash`), erster echter CI-Lauf grün (PR #1). Railway und Healthchecks.io fehlen noch.
  - Abweichung von ADR 001: Das Repo ist **öffentlich**, weil Auto-Merge für private Repos im aktuellen GitHub-Plan nicht verfügbar ist.
    Folgen: Keine Secrets ins Repo. Nichts Sensibles in öffentliche Actions-Logs oder -Artefakte (gilt besonders für den `pg_dump` aus 0.9).
    `main` ist per Ruleset geschützt: Merge nur mit grünem `ci`-Check, kein Force-Push, kein Löschen. Auto-Merge wartet auf die CI. Offen: ADR 001 anpassen oder später zurück auf privat.
- [ ] **0.0g Secrets bereitstellen** (siehe `.env.example` unten).

## Aufgaben

### 0.1 Monorepo & Tooling
- [x] pnpm-Workspace mit `apps/{api,worker,web}` und `packages/{db,amazon-ads,engine,shared}`. Package-Scope `@profitbash/*`.
- [x] Gemeinsame `tsconfig.base.json` (`strict`, `noUncheckedIndexedAccess`), ESLint + Prettier, Vitest.
- [x] Lokale DB ist eingerichtet: Postgres 17 (Homebrew), Rolle `profitbash`, Datenbanken `profitbash` und `profitbash_test`. Tests nutzen `DATABASE_URL_TEST`. CI nutzt einen Postgres-17-Service-Container.
- [x] Root-Skripte: `dev`, `build`, `test`, `typecheck`, `lint`, `db:generate`, `db:migrate`, `db:seed`.
- [x] GitHub-Actions-Workflow; Postgres für Tests als Service-Container. (Erster echter Lauf auf GitHub grün, siehe 0.0f.)
  App-URLs in CI zeigen auf `profitbash`, nur `DATABASE_URL_TEST` auf `profitbash_test` (sonst greift die Schutzprüfung aus 0.2).
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
- [x] Einbindung in die Env-Validierung der Apps mit dem ersten Nutzer (0.6: Connection anlegen). API und Worker (0.7) prüfen den Keyring beim Start (`refineKeyring`).

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
- [x] Konfiguration je Region als Konstanten mit Quellen-Kommentar (gegen die aktuelle Amazon-Ads-Doku verifizieren):

  | Region | Authorize | Token | LWA-Profil | API-Host |
  |---|---|---|---|---|
  | eu | `https://eu.account.amazon.com/ap/oa` | `https://api.amazon.co.uk/auth/o2/token` | `https://api.amazon.co.uk/user/profile` | `https://advertising-api-eu.amazon.com` |
  | na | `https://www.amazon.com/ap/oa` | `https://api.amazon.com/auth/o2/token` | `https://api.amazon.com/user/profile` | `https://advertising-api.amazon.com` |
  | fe | `https://apac.account.amazon.com/ap/oa` | `https://api.amazon.co.jp/auth/o2/token` | `https://api.amazon.co.jp/user/profile` | `https://advertising-api-fe.amazon.com` |

- [x] `buildAuthorizeUrl(state)` mit den Scopes `advertising::campaign_management profile`.
- [x] `exchangeCode(code)` → Refresh-Token; `getAccountIdentity(accessToken)` → LWA `user_id` (→ `external_account_id`) und E-Mail.
- [x] `getAccessToken(connection)` mit In-Memory-Cache bis kurz vor Ablauf.
- [x] Refresh-Token-Rotation: Liefert Amazon beim Refresh einen neuen Refresh-Token, wird dieser sofort verschlüsselt gespeichert und ersetzt den alten.
  Der Refresh einer Connection läuft unter einer Sperre (Advisory-Lock bzw. `SELECT … FOR UPDATE`), damit API und Worker sich nicht gegenseitig einen rotierten Token überschreiben.
- [x] Zentraler `request()`:
  - setzt die Header `Authorization`, `Amazon-Advertising-API-ClientId` und bei Bedarf `Amazon-Advertising-API-Scope`
  - Retry bei 429/5xx mit exponentiellem Backoff und Jitter, `Retry-After` respektieren
  - Timeout
  - Logging ohne Tokens
  - **Verlustfreies JSON-Parsing:** Große Zahlen (Profil-, Kampagnen-IDs) werden als String gelesen, nie als `number`.
  - Alle Antworten werden mit zod validiert; unbekannte Enum-Werte (z. B. neuer `accountType`) werden durchgereicht und geloggt, nicht verworfen.
- [x] `listProfiles(connection)` → normalisierte Profile (`amazonProfileId`, `amazonAccountId` als String).
- [x] **Mock-Anbieter** hinter derselben Schnittstelle (`AMAZON_ADS_USE_MOCK=true`): simulierte Einwilligungsseite → Callback mit Test-Code,
  feste Test-Identität und Test-Profile (inkl. einer Profil-ID > `Number.MAX_SAFE_INTEGER`). Damit ist Phase 0 ohne API-Freigabe vorführbar.
- [x] Tests mit msw: 429-Retry, Token-Rotation, Identität, und eine Profil-ID größer als `Number.MAX_SAFE_INTEGER` kommt unverändert an.
- [x] Umsetzung (Stand für 0.6/0.7):
  - **Doku geprüft am 2026-09-26:** Tabelle oben stimmt. Amazon liefert beim Refresh normalerweise **denselben** Refresh-Token;
    Rotation wird trotzdem unterstützt. Refresh-Tokens ab 30.07.2026 laufen **365 Tage nach der Einwilligung** ab (`invalid_grant`).
  - Einstieg `createAmazonAdsClient({ credentials, store, logger })` → `AmazonAdsClient` (`buildAuthorizeUrl`, `exchangeCode`,
    `getAccountIdentity`, `getAccessToken`, `invalidateAccessToken`, `request`, `listProfiles`). `ConnectionRef` = `{ id, organizationId, region }`.
  - `request()` nimmt nur Pfade relativ zum API-Host (Tokens gehen nie an fremde Hosts). Bei 401 höchstens ein erzwungener Token-Refresh
    je Minute und Connection (Amazon meldet 401 auch für nicht zugängliche Profile).
  - Retry: 429 immer; 5xx, Timeout und Netzwerkfehler nur bei GET oder mit `retryServerErrors` (keine Doppel-Writes). Equal Jitter,
    `Retry-After` hat Vorrang; ist es länger als `maxRetryAfterMs`, endet der Aufruf mit `AmazonAdsHttpError.retryAfterMs` (für Jobs).
  - Fehlerarten: `AmazonAdsHttpError`, `AmazonAdsReauthRequiredError` (LWA `invalid_grant`), `AmazonAdsNetworkError`, `AmazonAdsResponseError`.
  - Token-Store: `createConnectionTokenStore({ db, keyring })` in `@profitbash/db` (anbieterneutral). Transaktion mit `lock_timeout` (20 s)
    und `SELECT … FOR NO KEY UPDATE` gefiltert nach Connection **und** Organisation. `FOR NO KEY UPDATE` statt `FOR UPDATE`, damit Profil-Upserts
    (Fremdschlüssel → `FOR KEY SHARE`) nicht blockieren (Review-Befund). LWA-Aufrufe unter der Sperre haben knappe Limits (`LWA_HTTP_DEFAULTS`: 10 s, 3 Versuche,
    `Retry-After` höchstens 5 s).
  - Mock: `createMockAmazonAdsClient({ redirectUri, consentUrl, store })` ist der echte Client mit einem In-Process-`fetch` für die Amazon-Endpunkte.
    Die Einwilligungsseite rendert `renderMockConsentPage({ redirectUri, state })`; sie leitet nur auf die konfigurierte Redirect-URI zurück.
  - msw ist Dev-Abhängigkeit von `packages/amazon-ads`; sein Postinstall (Service-Worker-Datei für Browser) ist in `pnpm-workspace.yaml` abgeschaltet.

### 0.6 OAuth-Flow & Connections-API (`apps/api`)
- [x] `POST /api/amazon/oauth/start` (nur Admin, optional `connectionId` für „Neu verbinden") → Redirect-URL mit `state`:
  - signiert (HMAC mit `OAUTH_STATE_SECRET`), enthält Org, User, optional Connection, Ablaufzeit 10 Min. und eine Nonce
  - die Nonce ist **einmal verwendbar** (in `verifications` gespeichert und beim Callback gelöscht)
- [x] `GET /api/amazon/oauth/callback`:
  - verlangt eine Session: `session.userId == state.userId`, und der Nutzer ist weiterhin Admin von `state.orgId`
  - Code tauschen, Identität holen, Connection per **Upsert** auf (`organization_id`, `provider`, `region`, `external_account_id`) anlegen bzw. aktualisieren
    (Token verschlüsselt mit `connectionTokenAad` über genau diesen natürlichen Schlüssel, `status = active`)
  - `profiles-sync` sofort enqueuen, Redirect auf `${APP_URL}/admin/connections`. Fehler landen als Hinweis auf der Seite.
- [x] Connections und Clients:
  - `GET /api/connections`, `POST /api/connections/:id/sync`
  - `GET /api/connections/:id/profiles`
  - `PATCH /api/profiles/:id` (`client_id`, `is_hidden`); `client_id` muss zur selben Organisation gehören (die DB erzwingt es zusätzlich)
  - `GET /api/clients`, `POST /api/clients`, `PATCH /api/clients/:id`
- [x] Jede schreibende Aktion erzeugt ein `audit_event`.
- [x] Tests: fremde Session am Callback, abgelaufener und wiederverwendeter `state`, Neu-Verbinden aktualisiert statt dupliziert
  **und der gespeicherte Token lässt sich danach entschlüsseln**.
- [x] Offen aus 0.5:
  - Env-Schema für `AMAZON_ADS_CLIENT_ID`/`_SECRET`/`_REDIRECT_URI`/`_USE_MOCK` und `ENCRYPTION_*` (Keyring) in die API einbinden;
    `AMAZON_ADS_USE_MOCK=true` → `createMockAmazonAdsClient`, sonst `createAmazonAdsClient` (Client-ID/Secret dann Pflicht).
  - Route für die Mock-Einwilligungsseite (`renderMockConsentPage`) nur bei `AMAZON_ADS_USE_MOCK=true` mounten, `consentUrl` darauf zeigen lassen.
  - Beim Verdrahten per Typ prüfen, dass `ConnectionTokenStore` (db) zu `RefreshTokenStore` (amazon-ads) passt (heute strukturell kompatibel).
  - Nach dem Neu-Verbinden `invalidateAccessToken(connectionId)` aufrufen. Callback-Parameter `error=access_denied` als Hinweis anzeigen.
- [x] Umsetzung (Stand für 0.7/0.8):
  - **Env:** Bausteine in `@profitbash/shared/env` (`encryptionEnvSchema` + `refineKeyring`, `oauthStateSecretSchema`, `amazonAdsEnvSchema` +
    `refineAmazonAdsCredentials`), damit der Worker in 0.7 dieselben Regeln nutzt. `AMAZON_ADS_USE_MOCK` ist ohne Angabe `false`;
    `AMAZON_ADS_REDIRECT_URI` muss genau `${APP_URL}/api/amazon/oauth/callback` sein. `loadApiEnv()` liefert zusätzlich `keyring`.
  - **Verdrahtung:** `createAmazonAdsDeps({ env, db, keyring, logger })` in `apps/api/src/amazon.ts` wählt Mock oder echten Client
    (Token-Store per Typ als `RefreshTokenStore` abgesichert). Die Mock-Einwilligungsseite liegt unter `/api/amazon/oauth/mock-consent`
    (eigene CSP, `no-referrer`), Callback und Mock-Seite stehen bewusst nicht im OpenAPI-Dokument.
  - **State:** `apps/api/src/oauth-state.ts`, Format `<base64url(JSON)>.<base64url(HMAC-SHA256)>` mit Kontext-Präfix. Nonce in `verifications`
    mit Präfix `amazon-ads-oauth:` (Wert = User-ID), abgelaufene werden beim nächsten Start aufgeräumt. Der Start selbst schreibt kein
    Audit-Event (nur technische Nonce); auditiert wird der Upsert (`connection.create` bzw. `connection.reconnect`, `xmax = 0`).
  - **Callback-Reihenfolge:** Signatur/Ablauf → Session-Nutzer = `state.userId` → Nonce verbrauchen → `error`-Parameter → Admin von `state.orgId`
    → bei „Neu verbinden“ muss die Connection existieren und das Amazon-Konto gleich sein (`account_mismatch`) → Upsert → `invalidateAccessToken`
    → Sync einplanen. Ergebnis immer als Redirect `/admin/connections?oauth=<Ergebnis>`, Werte in `AMAZON_OAUTH_RESULTS` (`@profitbash/shared`),
    auch bei unerwarteten Fehlern (`internal_error`).
  - **Rechte:** Alle Connection-, Profil- und Client-Endpunkte sind in Phase 0 admin-only, per Middleware je Route (`orgAdminOnly`), nicht per
    Pfad-Präfix. Profile laufen über den Access-Layer, der dafür `includeRemoved` (nur Admins) bekommen hat.
  - **Fehler-Log:** Fehlgeschlagene Drizzle-Abfragen werden ohne Parameterwerte geloggt (`errorLogFields`: SQL mit Platzhaltern, Postgres-Code, Constraint).
  - **Offen für 0.7 (erledigt, siehe 0.7 „Umsetzung“):**
    - `JobQueue` (`apps/api/src/jobs.ts`) mit pg-boss umsetzen; `createUnavailableJobQueue` in `index.ts` ersetzen (loggt heute nur `jobs.not_available`,
      `POST /api/connections/:id/sync` antwortet trotzdem `202`).
    - `POST /api/connections/:id/sync` schreibt das Audit-Event und plant den Job in einer Transaktion ein. Mit pg-boss auf eigener Verbindung
      entweder `send` mit derselben Transaktion ausführen oder erst nach dem Commit einplanen (sonst Job ohne Audit-Event möglich).
  - **Offen für 0.8 Teil 2:** Methoden im Web-Client (`src/api/client.ts`) für die neuen Endpunkte; Hinweis aus `?oauth=` über i18n-Keys je Wert
    aus `AMAZON_OAUTH_RESULTS`; Start per `POST /api/amazon/oauth/start` und `window.location = url`.
  - **Offen für Phase 6:** Connections und Clients filtern direkt nach Organisation (keine Profile, daher nicht im Access-Layer). Für den
    Lesezugriff von Kunden-Orgs auf Clients Helfer in `packages/db/src/access.ts` ergänzen (ADR 002 §5).

### 0.7 Worker & Jobs (`apps/worker`)
- [x] pg-boss-Setup, Job-Wrapper `runJob(name, scope, fn)`:
  - schreibt `job_runs` (running → success/failed, mit `organization_id`)
  - fängt Fehler ab
  - pingt Healthchecks (Start/Erfolg/Fehler), wenn eine URL konfiguriert ist
- [x] Worker exportiert `startWorker()`. `WORKER_MODE=inline` startet ihn im API-Prozess, `separate` als eigenen Prozess.
  Der eigenständige Worker-Prozess beendet sich bei `WORKER_MODE=inline` mit einem Hinweis (sonst liefe er in `pnpm dev` doppelt).
- [x] Jobs je Connection laufen nicht parallel (pg-boss `singletonKey` = Connection-ID).
- [x] `token-refresh`: stündlich; markiert Connections mit ungültigem Token als `status = 'reauth_required'`.
  - Aus 0.5: `AmazonAdsReauthRequiredError` → Status in einer **eigenen** Anweisung nach dem Rollback setzen (die Store-Transaktion rollt zurück).
  - Connections mit `reauth_required` nicht mehr refreshen (auch der Store ruft LWA bisher unabhängig vom Status auf).
  - `AmazonAdsHttpError.retryAfterMs` für das Neu-Planen nutzen.
- [x] `profiles-sync`: täglich 05:00 Europe/Berlin und on demand.
  - Profile upserten über (`organization_id`, `amazon_profile_id`); `connection_id` auf die synchronisierende Connection setzen; `removed_at` zurücksetzen, wenn ein Profil wieder auftaucht.
  - Profile, die Amazon über keine Connection der Org mehr liefert, bekommen `removed_at = now()`. Nichts wird gelöscht, `is_hidden` bleibt unberührt.
- [x] `job-runs-cleanup`: täglich, löscht `job_runs` älter als 90 Tage.
- [x] Graceful Shutdown.
- [x] Umsetzung (Stand für 0.8 Teil 2/0.9):
  - **Paket:** `@profitbash/worker` exportiert `startWorker`, `startJobQueue`, `healthcheckUrls` und die Typen `JobQueue`/`ProfilesSyncJob`
    (`src/index.ts`); der eigenständige Prozess ist `src/main.ts` (tsup-Einstieg, `dist/main.js`). pg-boss 12 nutzt `DATABASE_URL_DIRECT`
    (jetzt auch Pflicht in der API-Env).
  - **API:** `WORKER_MODE=inline` → `startWorker` im API-Prozess (teilt sich den Amazon-Client samt Token-Cache); `separate` → `startJobQueue`
    (pg-boss ohne Wartung und Zeitpläne, nur Einplanen). Herunterfahren: HTTP schließen → laufende Jobs abwarten (max. 30 s) → DB schließen.
  - **Queues (Policy `stately`, `retryLimit` 0, Ablauf 10 Min.):** `token-refresh` und `profiles-sync` je Connection (`singletonKey` =
    Connection-ID: höchstens ein wartender und ein laufender Job **je Queue**; `token-refresh` und `profiles-sync` derselben Connection
    können gleichzeitig laufen, z. B. um 05:00, das ist unkritisch: der Token-Store serialisiert LWA über die Zeilensperre); Cron-Auslöser `token-refresh-all` (stündlich, `0 * * * *` UTC),
    `profiles-sync-all` (05:00 Europe/Berlin) planen je **aktiver** Connection einen Job ein; `job-runs-cleanup` 03:30 Europe/Berlin.
  - **Einplanen in der Transaktion des Aufrufers:** `enqueueProfilesSync(job, { tx })` schreibt über `fromDrizzle(tx, sql)` von pg-boss.
    `POST /api/connections/:id/sync` plant so in derselben Transaktion wie das Audit-Event ein (Rollback → kein Job). Der OAuth-Callback plant
    weiterhin nach dem Commit ein (Fehler → `connected_sync_failed`).
  - **`runJob`:** eine `job_runs`-Zeile je Lauf; der Cron-Auslöser schreibt einen plattformweiten Lauf (`organization_id` null, Zähler
    `connections`/`queued`), jeder Connection-Job einen eigenen (Org + `scope` = Connection-ID). Fehlertexte: `JobFailure`-Meldung, bei
    fehlgeschlagenen Abfragen nur „Datenbankabfrage fehlgeschlagen.“ (`errorLogFields`/`isDbQueryError` liegen jetzt in `@profitbash/db`),
    sonst die Fehlermeldung (gekürzt auf 1000 Zeichen).
  - **Healthchecks:** `HEALTHCHECKS_TOKEN_REFRESH_URL` / `HEALTHCHECKS_PROFILES_SYNC_URL` (nur https, leer = aus). Auslöser und Connection-Jobs
    pingen dieselbe URL mit `rid` = `job_runs.id`; ein fehlgeschlagener Connection-Job setzt den Check auf „down“, der nächste erfolgreiche Lauf
    wieder auf „up“ (bewusst akzeptiert: eine dauerhaft scheiternde Connection erzeugt stündlich ein Down/Up-Paar; `reauth_required`-Connections
    scheiden nach dem ersten Fehlschlag aus). `JobFailure` mit `alert: false` (nach `Retry-After` neu eingeplant) pingt Erfolg statt `/fail`.
    Ping-Fehler lassen keinen Job scheitern, die URL wird nie geloggt. Cleanup pingt nicht.
  - **Fehler von Amazon:** `invalid_grant` → `markConnectionReauthRequired` (eigene Transaktion, nur von `active` und nur, solange noch der
    Token gespeichert ist, den der Job beim Start vorfand: ein während des Refreshes committetes Neu-Verbinden bleibt aktiv; Audit-Event
    `connection.reauth_required` ohne Akteur). Der Token-Store wirft bei `reauth_required` `ConnectionReauthRequiredError`, ohne LWA aufzurufen
    (gilt auch für die API). `Retry-After` → derselbe Job wird mit `startAfter` neu eingeplant, höchstens 3-mal (`retryAttempt` in den Jobdaten)
    und nur bis 1 h Wartezeit (sonst belegte der wartende Job den einzigen Warteplatz der Connection), danach holt es der nächste reguläre Lauf nach. Andere Fehler (z. B. 5xx nach den Client-Retries) → Lauf `failed`, kein pg-boss-Retry.
  - **`token-refresh`:** verwirft das gecachte Access-Token und erzwingt einen Refresh über den Store (`last_refreshed_at`).
  - **`profiles-sync`:** Lese- und Schreibzugriffe der Jobs liegen als Systemzugriff ohne Nutzerkontext in `packages/db/src/system-access.ts` (Sichtbarkeit für
    Nutzer bleibt in `access.ts`). Ablauf: Profile der Connection holen (doppelte IDs zusammengefasst) → Profile der Connection bestimmen, die
    fehlen → nur dann die **übrigen aktiven** Connections der Org abfragen → in einer Transaktion upserten, fehlende an die Connection hängen,
    die sie noch liefert, sonst `removed_at` setzen. Lässt sich eine andere Connection nicht abfragen, bleibt alles stehen (`removalDeferred`,
    Warnung `profiles_sync.removal_deferred`). Updates greifen nur auf Profile, die noch an der Connection hängen (parallele Syncs).
    Zähler: `profiles`, `created`, `reassigned`, `removed`, `removalDeferred`. Liefert Amazon eine leere Liste, gelten die Profile als entfernt,
    sofern keine andere Connection sie liefert (bewusst: Zugriff entzogen ist ein gültiger Fall, `removed_at` ist umkehrbar).
  - **`job-runs-cleanup`:** löscht `job_runs` älter als 90 Tage, setzt Läufe, die seit über 6 h auf `running` stehen, auf `failed`
    („Abgebrochen …“), und löscht abgelaufene OAuth-Nonces (`AMAZON_ADS_OAUTH_NONCE_PREFIX`, jetzt in `@profitbash/db`).
  - **Gemeinsam genutzt:** Logger (`Logger`, `consoleLogger`) liegt in `@profitbash/shared`; Amazon-Client aus der Konfiguration über
    `createAmazonAdsClientFromConfig` (`@profitbash/amazon-ads`); Pfad der Mock-Einwilligungsseite `AMAZON_ADS_MOCK_CONSENT_PATH` (`@profitbash/shared`).
  - **Offen für 0.8 Teil 2 (erledigt, siehe 0.8 „Umsetzung Sync-Status“):** API-Endpunkt für *Sync-Status* (letzte 100 `job_runs` der
    aktiven Org; plattformweite Läufe mit `organization_id` null gehören zur Plattform-Sicht, nicht zur Org-Sicht).
  - **Offen für 0.9:** Railway: `DATABASE_URL_DIRECT` setzen; bei `WORKER_MODE=separate` zweiter Service mit `node apps/worker/dist/main.js`
    und denselben Variablen (ohne `BETTER_AUTH_SECRET`/`OAUTH_STATE_SECRET`). Healthchecks.io: Check „token-refresh“ Periode 1 h,
    „profiles-sync“ Periode 1 Tag (Karenzzeit großzügig, Connection-Jobs laufen kurz nach dem Auslöser). Graceful Shutdown wartet bis 30 s auf
    laufende Jobs: Railways Drain-Zeit (`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`) auf mindestens 35 s setzen. Geänderte Queue-Optionen erreichen
    bestehende Queues nur über `boss.updateQueue` (siehe `createQueues`).

### 0.8 Frontend-Grundgerüst (`apps/web`)

Aufgeteilt: **Teil 1** (Login + Shell) ist erledigt. **Teil 2** (Clients & Connections, Sync-Status, Settings) folgt nach 0.5–0.7;
bis dahin öffnen diese Menüpunkte eine Platzhalterseite „Folgt in Kürze“.

- [x] Vue 3 + Vite + PrimeVue (Styled Mode, eigenes Preset in `src/theme/` aus `design/theme.js`, Light/Dark), Tailwind v4 für Layout,
  Pinia, Vue Router, TanStack Query, vue-i18n (Default `de`), generierter API-Client aus `/api/openapi.json`.
- [x] Das Web importiert aus `@profitbash/shared` nur die browserfähige Wurzel und `/access-control`, nie `/env` oder `/crypto`.
- [x] Fonts self-hosted (Space Grotesk, JetBrains Mono für alle Zahlen), keine Google-Fonts-Links.
- [x] Visuelle Referenz: `design/PROFITBASH-claude-design.html` (Screens `login`, Sidebar/Shell). Nur als Vorlage, kein Copy-Paste des Stitch-HTML.
- [x] Login-Seite; Router-Guards für `requiresAuth`, `feature`, `requiresOrgAdmin`, `requiresSuperadmin`.
- [x] App-Shell:
  - einklappbare Sidebar mit der Menüstruktur aus `docs/plan.md` §3 (Sichtbarkeit über `features`)
  - Account-Menü: Dark Mode, Settings, Shortcuts, Logout
  - Quick-Tools-Popover (nur Platzhalter)
- [x] Platzhalterseite je späterem Menüpunkt mit Phasenhinweis.
- [x] **Clients & Connections:**
  - Button „Amazon-Account verbinden", Liste der Connections mit Status (inkl. „Neu verbinden" bei `reauth_required`)
  - Profiltabelle (AG Grid Community): Flagge, Land, Account-Name, Typ, Währung, Zeitzone, Client (Auswahl oder neu anlegen), Ausblenden-Toggle, Filter „entfernte anzeigen"
  - Button „Jetzt synchronisieren"
- [x] Umsetzung Clients & Connections (Stand für Sync-Status/Settings):
  - Seite `src/pages/ConnectionsPage.vue`, Bausteine in `src/connections/` (Karte je Connection, Profiltabelle, Zellen, Client-Dialog,
    Query-Hooks). Der Router bekommt fertige Seiten über die Map `PAGES` in `src/router/index.ts` (Key = `NavItem.id`), alle anderen Einträge
    bleiben Platzhalter.
  - Query-Keys enthalten die aktive Org (`connectionKeys` in `src/connections/queries.ts`). Profil-Änderungen sind optimistisch und werden bei
    einem Fehler zurückgenommen (sonst zeigten Schalter/Auswahl einen ungespeicherten Stand).
  - Verbinden: `POST /api/amazon/oauth/start`, dann `browserNavigation.assign(url)` (nur `http(s)`-URLs; als Objekt, damit Tests es ersetzen).
    `?oauth=<Ergebnis>` erscheint als Hinweis (`oauthNotice`), Schließen entfernt den Parameter.
  - Nach „Jetzt synchronisieren“ und nach `?oauth=connected` fragen Connections und Profile 60 s lang alle 3 s nach (`useSyncPolling`).
    Den genauen Fortschritt zeigt der Sync-Status; der Hinweis „Sync eingeplant …“ kann dann dorthin verlinken.
  - Profil-Änderungen nehmen bei Fehlern nur ihre eigenen Felder zurück (zwei gleichzeitige Änderungen am selben Profil überschreiben sich nicht).
    Solange die Clients fehlen (Laden/Fehler), ist die Client-Auswahl gesperrt und zeigt „–“ statt „Kein Client“.
  - Offen: AG Grid ohne `LocaleModule`, die grid-eigenen ARIA-/Menütexte sind englisch. Deutsche `localeText` ergänzen, sobald ein Grid
    Sortier-/Filtermenüs braucht (spätestens Explorer, Phase 2).
  - **AG Grid:** `src/grid/grid.ts` registriert nur die genutzten Community-Module (fehlende meldet in der Entwicklung das `ValidationModule`)
    und baut das Theme aus den Token-CSS-Variablen (Hell/Dunkel ohne zweites Theme). Grid-CSS liegt im Layer `ag-grid` (Reihenfolge in
    `src/styles/main.css`) und wird in den `<body>` geschrieben (`gridStyleOptions`), sonst nähme Tailwinds Preflight den Zellen das Padding.
    Zeilenklassen über `rowClassRules` (nur die wertet AG Grid bei geänderten Daten neu aus, `getRowClass` nicht). Vue-Zellen bekommen
    Callbacks und Clients über den reaktiven Grid-`context`. Das Grid rendert unter happy-dom, Tests laufen gegen das echte Grid
    (`domLayout: autoHeight`, keine Spalten-Virtualisierung). PrimeVue-Select-Optionen reagieren auf `mousedown`, nicht auf `click`.
    AG Grid macht den Seiten-Chunk ca. 820 KB groß (lazy Route); `chunkSizeWarningLimit` ist deshalb auf 1000 KB gesetzt.
  - **Flaggen:** `flag-icons` (MIT) als SVG, keine Emoji-Flaggen (DESIGN.md). Lazy-Glob mit `?no-inline`: jede Flagge eine eigene Datei, geladen
    wird nur die angezeigte. Amazon liefert `UK` statt ISO `GB` (`isoCountryCode`).
- [x] **Sync-Status:** letzte 100 `job_runs`, filterbar nach Job und Status, Fehlertext aufklappbar.
- [x] Umsetzung Sync-Status (Stand für Settings/0.9):
  - **API:** `GET /api/job-runs` (`apps/api/src/routes/job-runs.ts`, nur Org-Admin): neueste `JOB_RUN_LIST_LIMIT` (100) Läufe der aktiven Org,
    nach `started_at` absteigend (Index `job_runs_org_started_idx`). Filter `job`/`status` als Query-Parameter (je ein Enum-Wert, unbekannte → 400);
    das Limit gilt nach dem Filter. Die Connection hinter `scope` kommt nur aus derselben Org (Join über `connections.id::text = scope` **und**
    Org), sonst `connection: null`. Jobläufe sind keine Profildaten: Der Org-Filter ist hier die Zugriffsregel (wie bei Connections).
  - **Gemeinsame Namen:** `CONNECTION_JOB_NAMES` und `JOB_RUN_STATUSES` in `@profitbash/shared`; die Worker-Queues (`CONNECTION_QUEUES`,
    `ConnectionQueue`) leiten sich davon ab. Ein neuer Connection-Job braucht dort einen Eintrag und einen i18n-Key `sync.job.<name>`
    (ohne Key erscheint der Name roh). Neue Zähler analog `sync.counter.<key>`, Reihenfolge in `COUNTER_ORDER` (`src/sync/labels.ts`;
    `jsonb` sortiert Keys nach Länge).
  - **Formatierung:** `formatDateTime` (Datum + Uhrzeit mit Sekunden, Zeitzone des Browsers) und `formatDuration` (Einheiten der Locale,
    z. B. „3 Min. 12 Sek.“) in `@profitbash/shared`. Zahlen der Zähler in `font-data`.
  - **Seite** `src/pages/SyncStatusPage.vue`, Bausteine in `src/sync/` (Grid, Zellen, Labels, Queries). Filter stehen in der URL (`?job=&status=`),
    unbekannte Werte gelten als „Alle“. Der Hinweis „Sync eingeplant …“ verlinkt auf `/ops/sync?job=profiles-sync`.
  - **Fehlertext:** in der Spalte „Ergebnis“ unter den Zählern (eigene Spalte lag bei 1440 px außerhalb des sichtbaren Bereichs), eingeklappt
    erste Zeile, aufgeklappt ganzer Text (`RowAutoHeightModule`, Zeile wächst mit).
  - **Aktualität:** Query mit `staleTime: 0`. Gepollt wird alle 3 s, solange ein Lauf `running` ist (jünger als 1 h, ältere gelten als
    abgebrochen) oder bis 60 s nach „Jetzt synchronisieren“/Verbinden (`useMarkSyncRequested`: Zeitstempel im Query-Cache je Org; der Job hat
    erst eine `job_runs`-Zeile, wenn der Worker ihn abholt). Beim Filterwechsel bleibt die alte Tabelle als Platzhalter stehen, nie über einen
    Org-Wechsel hinweg. Scheitert das Nachladen, bleibt der letzte Stand mit Hinweis stehen.
  - `useActiveOrgId()` liegt jetzt in `src/stores/session.ts` (für alle Query-Keys mit Org). `themeStyleContainer` wird als Funktion übergeben
    (die Prop von `ag-grid-vue3` erwartet eine Funktion).
- [x] **Settings:** Locale mit Formatvorschau (Zahl, Währung, Prozent), Theme.
- [x] Umsetzung Settings (Stand für 0.9 und später):
  - Seite `src/pages/SettingsPage.vue` (Route `settings` direkt im Router, kein Menüeintrag). Theme als Radiogruppe, Locale als Auswahl,
    Vorschau aus `src/settings/preview.ts` (Zahl, Betrag EUR/GBP, Prozent, Datum/Uhrzeit, fester Beispielzeitpunkt). `density` steht in der
    API, wird aber bewusst nicht angeboten (kein Punkt im Plan); bei Bedarf dieselbe Mechanik nutzen.
  - Änderungen gelten sofort und werden gleich gespeichert (`session.updatePreferences(patch)`, `setTheme` nutzt es auch für das
    Account-Menü). Weil `PUT /api/settings` alles ersetzt, laufen die Saves nacheinander; jeder sendet den Stand beim Senden. Schon
    gespeicherte Stände werden nicht erneut gesendet. Nach Abmelden oder neu geladenem `/api/me` entfällt ein wartender Save.
  - Scheitert ein Save, gilt für seine Felder wieder der **vom Server bestätigte** Wert (aus `/api/me` bzw. der letzten `PUT`-Antwort),
    nur solange das Feld seither nicht erneut geändert wurde (Versionszähler je Feld). Die Seite zeigt den Fehler, bis der Nutzer wieder
    etwas ändert, auch wenn ein späterer Save klappt. „Gespeichert.“ steht in einer dauerhaften Statusregion im Seitenkopf.
- [x] Gemeinsame Komponenten: `EmptyState`, `InlineError`, `PageHeader`, `SkeletonBlock`; Formatierungs-Helper (Zahl, Währung, Prozent) aus `packages/shared`.
- [x] Umsetzung Teil 1 (Stand für Teil 2):
  - **PrimeVue 4.x (MIT)**, nicht 5.x: Ab 5.x kommerzielle Lizenz, siehe ADR 001.
  - Tokens: `src/theme/tokens.ts` (Spiegel von `design/theme.js`, per Test geprüft; Dark-Werte dort abgeleitet) → Preset
    `src/theme/preset.ts` (`extend.pb` → CSS-Variablen `--p-pb-*`, Light an `:root`, Dark unter `.dark`) → Tailwind-Namen in
    `src/styles/main.css` (`bg-canvas`, `text-ink`, `p-gutter`, `text-data-md` …). Tailwinds Standardfarben sind abgeschaltet.
    Zahlen mit der Utility `font-data` (JetBrains Mono, tabellarisch).
  - API-Client: `apps/api/openapi.json` ist eingecheckt, `pnpm api:generate` erzeugt ihn neu und daraus `src/api/schema.gen.ts`.
    Zwei Tests schlagen an, wenn eins davon veraltet ist. Neue Endpunkte → `pnpm api:generate`, dann Methode in `src/api/client.ts`.
  - Navigation und Rechte: `src/navigation/navigation.ts` ist die einzige Quelle für Sidebar und Routen-Meta.
    Aus einem Platzhalter wird eine echte Seite, indem die Route in `src/router/index.ts` eine eigene Komponente bekommt.
  - Session: Pinia-Store `src/stores/session.ts` (`/api/me`), `src/router/session-sync.ts` (401 → Login mit Rücksprung,
    Guards erneut nach „Erneut versuchen“). Sidebar-Einklappen im UI-State `shell/sidebar`.
  - Tests im Web: Komponenten- und Router-Tests mit `mountWithApp()` und `stubFetch()` aus `src/test/`.

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

0.1 → 0.2 → 0.3 → 0.4 → 0.8 (Login + Shell) ✓ → 0.5 ✓ → 0.6 → 0.7 → 0.8 (Connections, Sync-Status, Settings) → 0.9.

Nach jedem Schritt: Tests grün, kurzer Commit, Häkchen in dieser Datei setzen.
