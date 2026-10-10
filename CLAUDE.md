# CLAUDE.md – ProfitBash

## Projekt
ProfitBash ist das interne Tool der Agentur Muuv zur Steuerung von Amazon-Advertising für mehrere Kunden,
später ergänzt um Profitabilität (SP-API). Fokus jetzt: **nur Amazon Ads**.

**Vor jeder Aufgabe lesen:**
1. `docs/plan.md` – Roadmap, Navigation, Feature-Keys, Architektur-Leitplanken
2. `docs/tasks/phase-N.md` – die aktuelle Phase (Häkchen zeigen den Stand)
3. `docs/decisions/` – getroffene Entscheidungen (ADRs, u. a. 001 Stack, 002 Mandanten-Modell). Nicht stillschweigend davon abweichen.

## Struktur
```
apps/api        Hono-API (+ liefert in Prod das Web aus), better-auth-Konfiguration, Seed
apps/worker     pg-boss-Jobs (inline im API-Prozess oder separat, WORKER_MODE)
apps/web        Vue 3 + PrimeVue + Tailwind
packages/db     Drizzle-Schema, Migrationen, Access-Layer, Test-Datenbanken
packages/amazon-ads  Amazon-Ads-API-Client (je externe API ein eigenes Paket)
packages/engine Fachlogik ohne I/O (Regeln, Pacing, Berechnungen)
packages/shared zod-Schemas, Feature-Keys, Rollen, Formatierung (Wurzel: browserfähig);
                Server-only über /env, /crypto; better-auth-Zugriffskontrolle über /access-control
design/         Design-System und Stitch-Referenzen (nur lesen, nicht verändern)
docs/           Plan, Phasen-Aufgaben, ADRs
```

## Befehle
`pnpm dev` · `pnpm test` · `pnpm typecheck` · `pnpm lint` · `pnpm build` · `pnpm db:generate` · `pnpm db:migrate` · `pnpm db:seed`
Lokale DB: Postgres 17 über Homebrew (`brew services start postgresql@17`), Datenbanken `profitbash` und `profitbash_test`.
Auth-Schema neu erzeugen (nach Änderungen an `apps/api/src/auth.ts`): `pnpm --filter @profitbash/api auth:schema`, dann `pnpm db:generate`.
Migrationen mit `pnpm db:generate` erzeugen, nie nachträglich ändern (vor dem ersten Deploy einmal zu `0000_init` zusammengefasst).
Regeln für generierte better-auth-Tabellen als eigene SQL-Migration (`drizzle-kit generate --custom`), nie in `schema/auth.ts`.

## Arbeitsweise
- Aufgaben in der Reihenfolge der Phasen-Datei abarbeiten. Nach jedem Schritt: Tests grün, kleiner Commit, Häkchen setzen.
- Unklarheiten oder Abweichungen vom Plan: nachfragen oder als offenen Punkt in der Phasen-Datei notieren, nicht raten.
- Neue Abhängigkeiten nur, wenn nötig; größere Entscheidungen als ADR in `docs/decisions/` festhalten.
- pnpm installiert nur Versionen, die lange genug veröffentlicht sind (Schutz vor Supply-Chain-Angriffen).
  Ist die neueste Version zu frisch, die vorherige nehmen. Keine `minimumReleaseAgeExclude`-Ausnahmen eintragen.
- Kein Scope aus späteren Phasen vorziehen.
- **Superpowers-Skills nutzen:**
  - Neue Logik und Bugfixes mit `superpowers:test-driven-development`: Test zuerst, Fehlschlag (RED) prüfen, dann Code.
  - Nach jeder abgeschlossenen Aufgabe `superpowers:requesting-code-review` (unabhängiger Reviewer), Befunde fixen oder begründet zurückweisen.
  - Vor jeder „fertig"-Meldung `superpowers:verification-before-completion`: gesamte Suite, typecheck, lint, build.
- **Ponytail-Plugin nutzen (Dominik, 2026-10-10):** immer aktiv (Stufe `full`): kleinste vollständige Änderung, Vorhandenes
  wiederverwenden, keine Abstraktion auf Vorrat; bekannte Abkürzungen als `shortcut:`-Kommentar. Nach jeder Aufgabe
  zusätzlich `ponytail:ponytail-review` auf den Diff. TDD, Validierung an Grenzen, Audit, Access-Layer und die Zustände
  im Frontend werden dadurch nie gekürzt. Jede Antwort endet mit: was ausgelassen oder nicht geprüft wurde, und Risiken.
- **Bis zu drei Aufgabenpunkte je Session** (z. B. 2.3–2.5) in der Reihenfolge der Phasen-Datei (Dominik, 2026-09-28).
  Je Aufgabe ein eigener Branch von main, Review, Verifikation und PR. Fragen an Dominik möglichst zu Beginn der Session
  sammeln, damit danach ohne Unterbrechung gearbeitet werden kann. Der Stand steht im Repo (`docs/`), nicht im Chat.
- **Merge ohne Rückfrage:** PR per Rebase mergen, sobald die CI auf dem Head-Commit grün ist; danach die nächste Aufgabe von
  main starten. Nachfragen nur bei echten Entscheidungen (Abweichung vom Plan, neue Abhängigkeit, ADR).
- **Unterbrechungen einplanen:** Die Session kann jederzeit am Nutzungslimit enden. Deshalb nach jedem Schritt committen und
  pushen, Häkchen und „Umsetzung“-Notiz aktuell halten, damit eine neue Session ohne Chatverlauf weitermachen kann.
- **Übergabe am Ende jeder Session:** Nach Commit und Häkchen den fertigen Prompt für die nächste Session
  als Codeblock ausgeben, zum direkten Einfügen. Er nennt:
  - die nächste Aufgabe laut Reihenfolge in der Phasen-Datei
  - die zu lesenden Dateien
  - offene Punkte, Entscheidungen oder Voraussetzungen aus dieser Session, die nicht im Repo stehen
  - die Arbeitsweise (TDD, Review nach der Aufgabe, Verifikation vor dem Commit)

## Regeln im Code
- TypeScript `strict`, kein `any` ohne Begründung. Eingaben an allen Grenzen mit zod validieren (HTTP, Env, externe APIs).
- **Mandanten (ADR 002):** Daten gehören der Agentur-Org. Jede Query läuft im Org-Kontext. Profil-Zugriffe ausschließlich über
  `packages/db/src/access.ts`, nie direkt nach `organization_id` filtern.
- **Begriffe:** `profileId` = interne UUID, `amazonProfileId` = Amazons ID (analog für spätere Entities).
- **Amazon-IDs sind Strings.** JSON von Amazon verlustfrei parsen, nie als `number` behandeln.
- **Geld nie als Float:** `numeric` in der DB, Decimal-Strings in der API, Rechnen mit einer Decimal-Library.
- **Zeit:** Speicherung in UTC. Perioden (Tag, Monat) in der Zeitzone des Profils berechnen.
- **Secrets:** nie loggen, nie committen. Refresh-Tokens nur verschlüsselt speichern (`packages/shared` crypto).
- Viele IDs nie im Query-String übergeben (URL-Länge), sondern im POST-Body oder als serverseitiger Default.
- Jede schreibende Aktion erzeugt ein `audit_event`. Hintergrundarbeit läuft über `runJob()` und schreibt `job_runs`.
- Fehlerformat der API: `{ error: { code, message } }`.
- Externe APIs in Tests mit msw mocken. Kein Test spricht mit echten Amazon-Endpunkten.
- DB-Tests nutzen `createTestDatabase()` aus `@profitbash/db/testing` (eigene Datenbank je Testdatei, parallel sicher).
  `DATABASE_URL_TEST` muss auf `_test` enden; die Test-Einrichtung löscht diese Datenbank.

## Frontend
- UI-Sprache Deutsch, alle Texte über vue-i18n-Keys.
- Design-Tokens aus `design/theme.js` → PrimeVue-Preset in `apps/web/src/theme/`. Keine Farben/Größen hart codieren.
- Aus `@profitbash/shared` nur die Wurzel und `/access-control` importieren, nie `/env` oder `/crypto`.
- Zahlen immer in JetBrains Mono mit tabellarischen Ziffern, formatiert über die Helper aus `packages/shared`.
- Jede Datenansicht hat Loading- (Skeleton), Empty- und Error-Zustand. Ein fehlerhaftes Widget legt nie die ganze Seite lahm.
- Formularfelder haben sichtbare Labels, Icon-Buttons ein `aria-label`.

## Eigenständigkeit
ProfitBash ist eine eigene Implementierung. Allgemeine, marktübliche Muster sind erwünscht.
Texte, Kataloge, Namensschemata oder Code aus Drittprodukten werden nicht 1:1 übernommen.
