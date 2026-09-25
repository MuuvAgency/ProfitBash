# CLAUDE.md – ProfitBash

## Projekt
ProfitBash ist das interne Tool der Agentur Muuv zur Steuerung von Amazon-Advertising für mehrere Kunden,
später ergänzt um Profitabilität (SP-API). Fokus jetzt: **nur Amazon Ads**.

**Vor jeder Aufgabe lesen:**
1. `docs/plan.md` – Roadmap, Navigation, Feature-Keys, Architektur-Leitplanken
2. `docs/tasks/phase-N.md` – die aktuelle Phase (Häkchen zeigen den Stand)
3. `docs/decisions/` – getroffene Entscheidungen (ADRs). Nicht stillschweigend davon abweichen.

## Struktur
```
apps/api        Hono-API (+ liefert in Prod das Web aus)
apps/worker     pg-boss-Jobs (inline im API-Prozess oder separat, WORKER_MODE)
apps/web        Vue 3 + PrimeVue + Tailwind
packages/db     Drizzle-Schema, Migrationen, Seed, Access-Layer
packages/amazon-ads  Amazon-Ads-API-Client (je externe API ein eigenes Paket)
packages/engine Fachlogik ohne I/O (Regeln, Pacing, Berechnungen)
packages/shared zod-Schemas, Feature-Keys, Formatierung, Verschlüsselung
design/         Design-System und Stitch-Referenzen (nur lesen, nicht verändern)
docs/           Plan, Phasen-Aufgaben, ADRs
```

## Befehle
`pnpm dev` · `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm build` · `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:seed`
Lokale DB: `docker compose up -d`.

## Arbeitsweise
- Aufgaben in der Reihenfolge der Phasen-Datei abarbeiten. Nach jedem Schritt: Tests grün, kleiner Commit, Häkchen setzen.
- Unklarheiten oder Abweichungen vom Plan: nachfragen oder als offenen Punkt in der Phasen-Datei notieren, nicht raten.
- Neue Abhängigkeiten nur, wenn nötig; größere Entscheidungen als ADR in `docs/decisions/` festhalten.
- Kein Scope aus späteren Phasen vorziehen.

## Regeln im Code
- TypeScript `strict`, kein `any` ohne Begründung. Eingaben an allen Grenzen mit zod validieren (HTTP, Env, externe APIs).
- **Mandanten:** Jede Query läuft im Org-Kontext. Profil-Zugriffe ausschließlich über `packages/db/src/access.ts`.
- **Amazon-IDs sind Strings.** JSON von Amazon verlustfrei parsen, nie als `number` behandeln.
- **Geld nie als Float:** `numeric` in der DB, Decimal-Strings in der API, Rechnen mit einer Decimal-Library.
- **Zeit:** Speicherung in UTC. Perioden (Tag, Monat) in der Zeitzone des Profils berechnen.
- **Secrets:** nie loggen, nie committen. Refresh-Tokens nur verschlüsselt speichern (`packages/shared` crypto).
- Viele IDs nie im Query-String übergeben (URL-Länge), sondern im POST-Body oder als serverseitiger Default.
- Jede schreibende Aktion erzeugt ein `audit_event`. Hintergrundarbeit läuft über `runJob()` und schreibt `job_runs`.
- Fehlerformat der API: `{ error: { code, message } }`.
- Externe APIs in Tests mit msw mocken. Kein Test spricht mit echten Amazon-Endpunkten.

## Frontend
- UI-Sprache Deutsch, alle Texte über vue-i18n-Keys.
- Design-Tokens aus `design/theme.js` → PrimeVue-Preset in `apps/web/src/theme/`. Keine Farben/Größen hart codieren.
- Zahlen immer in JetBrains Mono mit tabellarischen Ziffern, formatiert über die Helper aus `packages/shared`.
- Jede Datenansicht hat Loading- (Skeleton), Empty- und Error-Zustand. Ein fehlerhaftes Widget legt nie die ganze Seite lahm.
- Formularfelder haben sichtbare Labels, Icon-Buttons ein `aria-label`.

## Eigenständigkeit
ProfitBash ist eine eigene Implementierung. Allgemeine, marktübliche Muster sind erwünscht.
Texte, Kataloge, Namensschemata oder Code aus Drittprodukten werden nicht 1:1 übernommen.
