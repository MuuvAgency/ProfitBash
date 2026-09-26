# ADR 001 – Tech-Stack und Hosting

- **Status:** angenommen
- **Datum:** 2026-09-25, zuletzt mit dem Code abgeglichen am 2026-09-26 (Stand Code Phase 0, vor dem ersten Deploy)
- **Beteiligte:** Dominik

## Kontext

ProfitBash ist ein internes, mandantenfähiges Tool zur Steuerung von Amazon-Advertising für mehrere Kunden.
Es braucht eine Web-UI mit dichten Tabellen, eine API, **dauerhaft laufende Hintergrundjobs**
(Token-Refresh, Syncs, später Report-Import, Budget-Enforcer, Regel-Pipeline) und Postgres.
Vorgaben: So wenig Kosten wie möglich, bis die ersten Kunden laufen. Später ohne Umbau skalierbar
und um weitere Marktplätze erweiterbar.

## Entscheidung

| Bereich | Wahl |
|---|---|
| Laufzeit | Node.js **22** (`engines.node` `>=22.13`, auf Railway über `railpack.json` fest) |
| Sprache | TypeScript **6.0** überall (`strict`, `noUncheckedIndexedAccess`). TypeScript 7 (nativer Compiler) erst, wenn typescript-eslint und vue-tsc es unterstützen (Stand 09/2026: typescript-eslint nur bis 6.0) |
| Monorepo | pnpm-Workspaces: `apps/{api,worker,web}`, `packages/{db,amazon-ads,engine,shared}` |
| API | Hono (Node), zod, OpenAPI via `@hono/zod-openapi` |
| Auth | better-auth: E-Mail/Passwort, Organization-Plugin (eigene Rollen admin/editor/viewer), Admin-Plugin (Superadmin) |
| DB | Postgres + Drizzle ORM/drizzle-kit, Treiber `postgres` (postgres.js) in allen Umgebungen |
| Jobs | pg-boss (Queue und Cron in Postgres, kein Redis) |
| Web | Vue 3 + Vite, **PrimeVue 4.x** (MIT, Styled Mode, Aura-basiertes Preset mit den Tokens aus `design/theme.js`) mit `@primeuix/themes` 2.x und PrimeIcons 7, Tailwind v4 für Layout, Pinia, Vue Router, TanStack Query, vue-i18n. API-Client: `openapi-fetch` mit Typen aus `openapi-typescript` (generiert aus `/api/openapi.json`). Fonts selbst gehostet über `@fontsource-variable` |
| Tabellen / Charts | AG Grid **Community** (Version exakt gepinnt), AG Charts Community (kommt mit dem ersten Chart, Phase 2) |
| Build | Apps `api`/`worker` mit tsup (bündelt die Workspace-Pakete, die TS-Quellcode exportieren); Web mit Vite. Dev: `tsx watch`. In Produktion nur `node`, kein tsx: eigene Bundles für Server, Migrationen, Seed, Schlüsselrotation und den Worker bei `WORKER_MODE=separate` (`docs/deploy.md`) |
| Tests | Vitest, HTTP-Mocks mit msw |
| Repository | GitHub, **öffentlich** (`MuuvAgency/ProfitBash`), Plan GitHub Free for organizations. Siehe Konsequenzen |
| CI | GitHub Actions, Postgres als Service-Container |
| Hosting | Railway, Build mit Railpack (`railpack.json`). Einstellungen im Dashboard nach `docs/deploy.md` (siehe Konsequenzen) |
| Datenbank | Postgres 17. Lokal: Homebrew. CI: Service-Container. **Prod: Railway-Postgres**. Neon (Free) nur bei Bedarf für geteilte Dev-/Preview-Datenbanken |
| Monitoring | Healthchecks.io (Job-Heartbeats) |

### Deploy-Topologie

- **Service `app`:** API und das gebaute Web auf **einer Origin** (Hono liefert `apps/web/dist` aus).
  Dadurch kein CORS, keine Cookie-Probleme, kein Proxy.
- **Worker:** Umschaltbar per `WORKER_MODE`:
  - `inline` (Pilot): Der Worker startet im selben Prozess wie die API → **nur ein Railway-Service**.
  - `separate` (Wachstum): eigener Railway-Service `worker`. Kein Code-Umbau nötig.
- **Migrationen:** Pre-Deploy-Command des `app`-Service (gebündeltes `migrate`).
- **Healthcheck:** `GET /api/health` (200 nur mit erreichbarer Datenbank).

### Warum Prod nicht auf Neon

pg-boss fragt die Datenbank im Sekundentakt ab (Queue und Cron-Überwachung). Neon kann dann nie in den
Ruhezustand wechseln, und die Compute-Kosten laufen rund um die Uhr. Ab Phase 1 wächst außerdem das
Datenvolumen durch Report-Daten. Railway-Postgres liegt im selben privaten Netz wie die App: planbare Kosten,
kurze Latenz, direkte Verbindung für pg-boss. Neon bleibt bei Bedarf für geteilte Dev-/Preview-Datenbanken, dort darf die DB schlafen.

### Warum postgres.js statt Neon-Serverless-Treiber

Railway betreibt langlebige Prozesse. Ein TCP-Treiber funktioniert identisch lokal, in CI (Service-Container),
gegen Neon und gegen Railway. pg-boss nutzt immer die **direkte** Verbindung, nie einen Transaction-Pooler.

## Kosten

Bitte die aktuellen Konditionen der Anbieter vor Start prüfen. Die Zahlen sind Schätzungen.

| Stufe | Wann | Setup | Kosten |
|---|---|---|---|
| **A – Bauen** | jetzt bis Ads-API-Freigabe | Lokal (Homebrew-Postgres), GitHub Actions (öffentliches Repo, ohne Minutenlimit), Healthchecks.io Free. Neon Free nur bei Bedarf für geteilte Dev-/Preview-Datenbanken. Kein Hosting nötig. Das Railway-Trial-Guthaben ist zeitlich begrenzt: erst nutzen, wenn der erste Deploy ansteht | **0 €** |
| **B – Pilot** | 1–2 Kunden live | Railway Hobby: 1 Service `app` (`WORKER_MODE=inline`) + Railway-Postgres, `*.up.railway.app`-Domain. Der Hobby-Plan enthält keine Datenbank-Backups (Stand 2026-09-26), deshalb nächtlicher `pg_dump` (Ziel und Ausführungsort: `docs/deploy.md`) | **ca. 5–10 $/Monat** |
| **C – Wachstum** | mehr Kunden/Daten | Worker separat, mehr DB-Ressourcen, eigene Domain, ggf. Neon Paid für Prod-Branches | nach Bedarf |

**Was dauerhaft kostenlos ist:** Amazon Ads API und SP-API, GitHub (öffentliches Repo: Rulesets, Auto-Merge und Actions ohne Minutenlimit), Healthchecks.io (bis 20 Checks),
Neon Free für Dev, AG Grid/AG Charts Community.

**Was nicht (sinnvoll) kostenlos geht:**
- **Always-on-Hosting mit verlässlichen Cron-Jobs.** Railway hat nach dem Trial keinen dauerhaften Gratis-Plan
  für Always-on-Dienste. Gratis-Tarife anderer Anbieter (z. B. Render Free) legen die App nach Inaktivität
  schlafen, dann laufen nächtliche Syncs nicht zuverlässig. Für echte Kunden deshalb nicht empfohlen.
- **Echte 0-€-Variante:** Eine eigene Always-Free-VM (z. B. Oracle Cloud) mit Docker. Das ist möglich, aber
  Server-Pflege liegt bei uns (Updates, Backups, Sicherheit). Nur als Notlösung.
- **AG Grid Enterprise** (Row-Grouping, Set-Filter) ist lizenzpflichtig → bewusst Community plus
  serverseitige Gruppierung.

**Wechsel von B nach C** ist reine Konfiguration: `WORKER_MODE=separate`, zweiter Service, ggf. `pg_dump`/`pg_restore`
auf einen anderen Postgres-Anbieter.

## Alternativen (verworfen)

- **Cloudflare Workers + D1/Supabase:** günstig, aber keine langlebigen Prozesse für den Worker, D1 ist kein Postgres.
- **Alles auf Neon inkl. Prod:** komfortabel (Prod-Branches), aber durch pg-boss dauerhaft wach → teuer.
- **Redis/BullMQ statt pg-boss:** ein weiterer Dienst mit eigenen Kosten, für unser Volumen unnötig.
- **Next.js/React:** Der Vue-Stack mit PrimeVue und Grids ist für dichte Admin-Oberflächen erprobt.

## Konsequenzen

- **PrimeVue bleibt auf 4.x (Stand 09/2026: 4.5.5).** Ab PrimeVue 5, `@primeuix/themes` 3 und PrimeIcons 8 gilt die kommerzielle
  „PrimeUI License“: Lizenzschlüssel Pflicht (ohne Schlüssel erscheint ein Lizenz-Banner), kostenlose Community-Lizenz nur für
  kleine Organisationen (< 1 Mio. $ Umsatz, < 5 Entwickler, < 10 Mitarbeitende, jährliche Bestätigung), sonst 599–799 $ je Entwickler.
  4.x ist MIT und deckt alles ab, was die App braucht (Tabellen kommen aus AG Grid). Nachteil: 4.x bekommt keine neuen Features mehr.
  Ein Umstieg auf 5 ist eine eigene Entscheidung (Lizenz + Anpassung des Presets). Entschieden am 2026-09-25.

- **Öffentliches Repo** (entschieden am 2026-09-26, ursprünglich privat geplant): Im Gratis-Plan gibt es Rulesets (Schutz von
  `main`: grüner `ci`-Check, kein Force-Push) und Auto-Merge nur für öffentliche Repos; privat bräuchte GitHub Team.
  Dass der Code einsehbar ist, ist akzeptiert. Regeln: keine Secrets, keine echten Kundennamen oder -daten (Tests und Doku
  nutzen erfundene Namen), nichts Sensibles in Actions-Logs oder -Artefakte (Artefakte öffentlicher Repos kann jeder laden).
  Zurück auf privat ist jederzeit möglich (dann GitHub Team für Ruleset und Auto-Merge).
- **Railway-Einstellungen im Dashboard, kein Config as Code** (entschieden am 2026-09-26): Railway liest
  `railway.json`/`railway.toml` für neue Services nicht mehr; der Nachfolger (Infrastructure as Code, `.railway/railway.ts`)
  lohnt sich für einen Service nicht. `docs/deploy.md` ist die Quelle der Einstellungen im Repo. Wiedervorlage bei Stufe C.
- **Backups im Pilot selbst:** Der Hobby-Plan enthält keine Datenbank-Backups. Nächtlicher `pg_dump`, vor dem Upload
  verschlüsselt; Ziel und Ausführungsort sind noch offen (`docs/deploy.md`).
- **Secrets in der Datenbank** (bestehende Praxis seit 0.3, hier nur festgehalten): Refresh-Tokens mit AES-256-GCM über
  `node:crypto` (`@profitbash/shared/crypto`), ohne externen Schlüsseldienst. Der Schlüssel kommt aus der Umgebung,
  Rotation über Schlüssel-IDs und ein Skript (`docs/deploy.md`).
- **flag-icons 7.x (MIT)** für Länderflaggen als SVG, jede Flagge wird erst bei Bedarf einzeln geladen. Emojis sind im Design
  ausgeschlossen und fehlen unter Windows.

- Nur ein Datenbanktyp (Postgres) für Daten, Jobs und Sessions.
- Code bleibt anbieterneutral. Hosting- und DB-Wechsel sind Konfiguration.
- Grids ohne Enterprise-Features: Gruppierungen und Aggregationen macht der Server.
- Das better-auth-Schema wird mit dem better-auth-CLI (`auth generate`) aus der Auth-Konfiguration erzeugt, nicht von Hand gepflegt.
- `apps/api` führt `@better-auth/core` als direkte Abhängigkeit, immer in exakt derselben Version wie `better-auth`. Die Audit-Hooks lesen daraus den handelnden Nutzer der laufenden Anfrage (Endpoint-Kontext).
- `packages/db` führt `kysely` als Dev-Abhängigkeit. Das ist nötig, damit pnpm in Entwicklung und Tests dieselbe drizzle-orm-Kopie wie better-auth nutzt (better-auth bringt kysely mit).
