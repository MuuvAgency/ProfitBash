# Phase 3 – Ändern

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5 inkl. „Kennzahlen je Ad-Typ“),
> `docs/tasks/phase-2.md` (Definition of Done, Umsetzungsnotizen 2.4–2.13), `docs/tasks/phase-1.md` (1.5 Schreibschicht,
> 1.10, 1.11, F12), `docs/decisions/` (001–004), `design/DESIGN.md`.
>
> **Status: Entwurf (2026-09-29).** Entschieden: F1, F2. Offen: **F3–F8** unter „Fragen an Dominik“ (die Nummern gelten nur
> in dieser Datei); vor 3.1 mit Dominik klären und hier mit Datum eintragen. Zuerst kommen `phase-1.md` 1.11 (F1) und
> `phase-2b.md` (Suchbegriffe & Organic, entschieden 2026-10-07). Zusätzlich in Phase 3: Suchbegriff-Aktionen aus 2b (Negativ
> anlegen, Harvest vormerken) über den Warenkorb, siehe `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` Abschnitt B.
>
> **Ausgangslage:** Es gibt weiterhin keinen Ads-API-Zugang (`phase-1.md` F12: das Partner Network nimmt keine
> Einzelunternehmen an). Mit dem Abschluss von Phase 2 ist der Auslöser für den Datei-Import (`phase-1.md` 1.11) erreicht.

## Ziel

Die Agentur ändert ihre Amazon-Werbung aus ProfitBash heraus, nachvollziehbar und umkehrbar:
- **Warenkorb** („Ausstehend“): Änderungen aus dem Explorer sammeln, prüfen, gemeinsam übermitteln.
- **Übermittlungen** mit Ergebnis je Änderung (auch Teilfehler), **Verlauf** und **Revert**.
- **Bulk-Dialoge** für markierte Zeilen (Gebote, Budgets, Status).
- **Tags** zum Gruppieren von Kampagnen und weiteren Entities, filterbar im Explorer.

Navigation (`plan.md` §3): „Änderungen (Ausstehend · Übermittlungen)“ unter `/ads/changes` (Feature `changes`), „Tags“ unter
`/ads/tags/*` (Feature `tags`). Schreiben nur mit Recht `write` (Admin, Editor).

## Definition of Done (Entwurf)

- [ ] Jede Änderung läuft über den Warenkorb und eine Übermittlung (`runJob`, `job_runs`), nie direkt aus der Oberfläche an Amazon.
- [ ] Je Änderung stehen vorher/nachher, Ergebnis von Amazon (Erfolg, Fehler mit Text) und der handelnde Nutzer fest (`audit_event`).
- [ ] Teilfehler brechen die Übermittlung nicht ab; fehlgeschlagene Änderungen lassen sich erneut versuchen oder verwerfen.
- [ ] Revert setzt auf den Wert vor der Übermittlung zurück und prüft vorher, ob sich der Wert bei Amazon seitdem geändert hat.
- [ ] Beträge (Gebote, Budgets) bleiben Decimal-Strings mit Währung; Grenzen von Amazon je Ad-Typ und Marktplatz werden vor dem
      Übermitteln geprüft (Test je Grenze).
- [ ] Alle Zugriffe über den Access-Layer (ADR 002); Test je Endpunkt (fremde Organisation, ausgeblendetes Profil, Recht `write`).
- [ ] Tests gegen den Mock-Anbieter (msw bzw. `mock.ts`), keiner gegen echte Amazon-Endpunkte.
- [ ] Browser-Pane geprüft wie in Phase 2 (1440 px, Tablet, Handy, Hell/Dunkel, Konsole).
- [ ] `pnpm test`, `typecheck`, `lint`, `build`, beide Smoke-Tests und CI grün.

## Fragen an Dominik

Jede Frage mit Empfehlung. Antworten werden hier mit Datum eingetragen („Entschieden (Dominik, …)“).

- **F1 – Reihenfolge ohne API-Zugang.** Der Auslöser für 1.11 (Datei-Import aus Bulk-Datei und Konsolen-Reports) ist erreicht.
  Erst 1.11 bauen (echte Daten der Kunden in Dashboard und Explorer, ohne API), dann Phase 3? Oder Phase 3 gegen den Mock und
  1.11 später bzw. gar nicht? Empfehlung: **erst 1.11**. Ohne echte Daten ist ProfitBash für die Agentur noch nicht nutzbar,
  und Phase 3 lässt sich ohne API nur gegen den Mock prüfen.
  **Entschieden (Dominik, 2026-09-29): erst 1.11 (Datei-Import), dann Phase 3.**
- **F2 – Übermitteln ohne API.** Solange die API fehlt, kann eine Übermittlung nicht an Amazon gehen. Empfehlung: Die Schreibschicht
  quellenneutral bauen (wie 1.5) und als zweiten Weg **„als Bulk-Datei herunterladen“** anbieten (Upload in der Werbekonsole von
  Hand, Ergebnis per nächstem Datei-Import bestätigt). Der API-Weg wird gegen den Mock gebaut und mit 1.10 scharf geschaltet.
  **Entschieden (Dominik, 2026-09-29): wie empfohlen, Bulk-Datei als zweiter Weg.**
- **F3 – Umfang der Änderungen.** Empfehlung für Phase 3: Status (aktiv/pausiert/archiviert) für Kampagnen, Ad Groups, Targets und
  Product Ads; Tagesbudget der Kampagne; Gebot von Targets und Standardgebot von Ad Groups; Negatives anlegen und archivieren.
  Nicht in Phase 3: neue Kampagnen, Ad Groups oder Keywords (Phase 4, Kampagnen-Setup), Placement-Anpassungen, Gebotsstrategie.
- **F4 – Warenkorb je Nutzer oder je Organisation?** Empfehlung: **je Nutzer** (jeder sammelt und übermittelt seine eigenen
  Änderungen), Übermittlungen und Verlauf sieht die ganze Organisation. Zwei offene Änderungen verschiedener Nutzer an derselben
  Entity: Hinweis beim Hinzufügen und beim Übermitteln.
- **F5 – Freigabe (Vier-Augen-Prinzip)?** Empfehlung: **nein** in Phase 3. Editoren und Admins übermitteln direkt; eine Freigabe
  durch Admins lässt sich später als Einstellung je Organisation nachrüsten.
- **F6 – Sicherheitsgrenzen.** Empfehlung: Warnung (mit Bestätigung) bei Gebots- oder Budgetänderungen über ±50 % und bei mehr als
  200 Änderungen in einer Übermittlung; harte Grenzen nur dort, wo Amazon sie vorgibt (Mindest- und Höchstgebote je Marktplatz).
- **F7 – Tags.** Amazon kennt Tags an Kampagnen (`extra.tags` aus dem Export), aber nicht an Targets. Empfehlung: **eigene Tags**
  in ProfitBash (je Organisation, Name und Farbe) für Kampagnen, Ad Groups, Targets und Product Ads, getrennt von den Amazon-Tags
  (die nur angezeigt werden). Filter „Tag“ im Explorer und in der Filterleiste des Dashboards.
- **F8 – Revert.** Empfehlung: Revert einer ganzen Übermittlung oder einzelner Änderungen als neue Übermittlung (mit eigenem
  Verlaufseintrag). Hat sich der Wert bei Amazon seit der Übermittlung geändert (nächster Sync), fragt die App nach, statt still
  zu überschreiben.

## Aufgaben (Entwurf, nach den Antworten verfeinern)

### 3.1 Schreibschicht für Änderungen (`packages/db`)
- [ ] Tabellen für Warenkorb, Übermittlungen und Änderungen je Entity (vorher/nachher, Status, Fehlertext von Amazon), Zugriffe nur
      über den Access-Layer; Audit-Events in derselben Transaktion.

### 3.2 Schreib-Client (`packages/amazon-ads`)
- [ ] Updates für Status, Budget und Gebote je Ad-Typ, Negatives anlegen und archivieren; Mock mit Teilfehlern und Rate-Limits;
      Grenzen je Ad-Typ und Marktplatz. Bei F2 zusätzlich: Bulk-Datei erzeugen.

### 3.3 Übermitteln, Wiederholen, Revert (`apps/worker`)
- [ ] Job über `runJob` mit Lease je Connection (wie die Datenjobs), Teilfehler, erneuter Versuch, Revert mit Konfliktprüfung (F8).

### 3.4 API (`apps/api`)
- [ ] Endpunkte für Warenkorb, Übermittlungen und Verlauf hinter `requireFeature('changes', 'write')` bzw. `'view'`; zod; OpenAPI.

### 3.5 Bearbeiten im Explorer
- [ ] Inline-Bearbeitung (Status, Budget, Gebot) und Bulk-Dialoge für markierte Zeilen, Anzeige offener Änderungen im Grid.

### 3.6 Seite „Änderungen“ (`/ads/changes`)
- [ ] Ausstehend (Warenkorb prüfen, übermitteln, verwerfen) und Übermittlungen (Ergebnis je Änderung, Revert).

### 3.7 Tags (`/ads/tags/*`, F7)
- [ ] Tags verwalten, zuweisen (auch per Bulk), Filter im Explorer und Dashboard.

## Bewusst nicht in Phase 3

- Keine neuen Kampagnen, Ad Groups oder Keywords (Phase 4, Kampagnen-Setup)
- Keine Regeln, keine automatischen Änderungen, keine Budget-Caps (Phase 5)
- Keine Profil-Freigaben je Mitglied (Phase 6)

## Reihenfolge für Claude Code

Nach F1: ggf. zuerst `phase-1.md` 1.11, dann 3.1 → 3.2 → 3.3 → 3.4 → 3.5 → 3.6 → 3.7. Bis zu drei Aufgaben je Session
(`CLAUDE.md`), nach jedem Schritt Tests grün, Commit, Häkchen und „Umsetzung“-Notiz.
