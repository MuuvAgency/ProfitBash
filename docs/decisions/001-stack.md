# ADR 001 – Tech-Stack und Hosting

- **Status:** angenommen
- **Datum:** 2026-09-25
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
| Sprache | TypeScript **6.0** überall (`strict`, `noUncheckedIndexedAccess`). TypeScript 7 (nativer Compiler) erst, wenn typescript-eslint und vue-tsc es unterstützen (Stand 09/2026: typescript-eslint nur bis 6.0) |
| Monorepo | pnpm-Workspaces: `apps/{api,worker,web}`, `packages/{db,amazon-ads,engine,shared}` |
| API | Hono (Node), zod, OpenAPI via `@hono/zod-openapi` |
| Auth | better-auth: E-Mail/Passwort, Organization-Plugin (eigene Rollen admin/editor/viewer), Admin-Plugin (Superadmin) |
| DB | Postgres + Drizzle ORM/drizzle-kit, Treiber `postgres` (postgres.js) in allen Umgebungen |
| Jobs | pg-boss (Queue und Cron in Postgres, kein Redis) |
| Web | Vue 3 + Vite, **PrimeVue 4.x** (MIT, Styled Mode, eigenes Preset aus `design/theme.js`) mit `@primeuix/themes` 2.x und PrimeIcons 7, Tailwind v4 für Layout, Pinia, Vue Router, TanStack Query, vue-i18n. API-Client: `openapi-fetch` mit Typen aus `openapi-typescript` (generiert aus `/api/openapi.json`). Fonts selbst gehostet über `@fontsource-variable` |
| Tabellen / Charts | AG Grid **Community**, AG Charts Community |
| Build | Apps `api`/`worker` mit tsup (bündelt die Workspace-Pakete, die TS-Quellcode exportieren); Web mit Vite. Dev: `tsx watch` |
| Tests | Vitest, HTTP-Mocks mit msw |
| CI | GitHub Actions, Postgres als Service-Container |
| Hosting | Railway |
| Datenbank | Postgres 17. Lokal: Homebrew. Dev-Branches: Neon (Free). CI: Service-Container. **Prod: Railway-Postgres** |
| Monitoring | Healthchecks.io (Job-Heartbeats) |

### Deploy-Topologie

- **Service `app`:** API und das gebaute Web auf **einer Origin** (Hono liefert `apps/web/dist` aus).
  Dadurch kein CORS, keine Cookie-Probleme, kein Proxy.
- **Worker:** Umschaltbar per `WORKER_MODE`:
  - `inline` (Pilot): Der Worker startet im selben Prozess wie die API → **nur ein Railway-Service**.
  - `separate` (Wachstum): eigener Railway-Service `worker`. Kein Code-Umbau nötig.
- **Migrationen:** Pre-Deploy-Command des `app`-Service.

### Warum Prod nicht auf Neon

pg-boss fragt die Datenbank im Sekundentakt ab (Queue und Cron-Überwachung). Neon kann dann nie in den
Ruhezustand wechseln, und die Compute-Kosten laufen rund um die Uhr. Ab Phase 1 wächst außerdem das
Datenvolumen durch Report-Daten. Railway-Postgres liegt im selben privaten Netz wie die App: planbare Kosten,
kurze Latenz, direkte Verbindung für pg-boss. Neon bleibt für Dev-Branches, dort darf die DB schlafen.

### Warum postgres.js statt Neon-Serverless-Treiber

Railway betreibt langlebige Prozesse. Ein TCP-Treiber funktioniert identisch lokal, in CI (Service-Container),
gegen Neon und gegen Railway. pg-boss nutzt immer die **direkte** Verbindung, nie einen Transaction-Pooler.

## Kosten

Bitte die aktuellen Konditionen der Anbieter vor Start prüfen. Die Zahlen sind Schätzungen.

| Stufe | Wann | Setup | Kosten |
|---|---|---|---|
| **A – Bauen** | jetzt bis Ads-API-Freigabe | Lokal (Homebrew-Postgres), GitHub Actions (Free-Kontingent), Healthchecks.io Free. Neon Free nur bei Bedarf für geteilte Dev-/Preview-Datenbanken. Kein Hosting nötig. Das Railway-Trial-Guthaben ist zeitlich begrenzt: erst nutzen, wenn der erste Deploy ansteht | **0 €** |
| **B – Pilot** | 1–2 Kunden live | Railway Hobby: 1 Service `app` (`WORKER_MODE=inline`) + Railway-Postgres, `*.up.railway.app`-Domain. Backups prüfen: Sind sie im Hobby-Plan nicht enthalten, nächtlicher `pg_dump` per GitHub Action | **ca. 5–10 $/Monat** |
| **C – Wachstum** | mehr Kunden/Daten | Worker separat, mehr DB-Ressourcen, eigene Domain, ggf. Neon Paid für Prod-Branches | nach Bedarf |

**Was dauerhaft kostenlos ist:** Amazon Ads API und SP-API, GitHub (privat), Healthchecks.io (bis 20 Checks),
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

- Nur ein Datenbanktyp (Postgres) für Daten, Jobs und Sessions.
- Code bleibt anbieterneutral. Hosting- und DB-Wechsel sind Konfiguration.
- Grids ohne Enterprise-Features: Gruppierungen und Aggregationen macht der Server.
- Das better-auth-Schema wird mit dem better-auth-CLI (`auth generate`) aus der Auth-Konfiguration erzeugt, nicht von Hand gepflegt.
- `apps/api` führt `@better-auth/core` als direkte Abhängigkeit, immer in exakt derselben Version wie `better-auth`. Die Audit-Hooks lesen daraus den handelnden Nutzer der laufenden Anfrage (Endpoint-Kontext).
- `packages/db` führt `kysely` als Dev-Abhängigkeit. Das ist nötig, damit pnpm in Entwicklung und Tests dieselbe drizzle-orm-Kopie wie better-auth nutzt (better-auth bringt kysely mit).
