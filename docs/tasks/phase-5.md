# Phase 5 – Automatisieren

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5 inkl. „Kennzahlen je Ad-Typ“),
> `docs/tasks/phase-4.md` (Definition of Done, 4.11 „Offen nach Phase 4“), `docs/tasks/phase-3.md` (3.1, 3.3, 3.4: Warenkorb,
> Übermittlung, Grenzen und Warnungen), `docs/tasks/phase-1.md` (1.11c/d: Datei-Import, 1.11e: entfallen),
> `docs/decisions/` (001–005), `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` (Abschnitte E und F, F-S6),
> `design/DESIGN.md`.
>
> **Status: verfeinert (2026-10-10), Fragen F1–F8 entschieden (die Nummern gelten nur in dieser Datei). Als Nächstes: 5.1.**
>
> **Ausgangslage:** Es gibt weiterhin keinen Ads-API-Zugang. Daten kommen nur aus der **Bulk-Datei**, die Dominik
> wöchentlich je Profil lädt (`phase-1.md` 1.11); Tagesberichte sind entfallen (1.11e, 2026-10-07). Datei-Profile haben
> damit **keine Tageskennzahlen**, und bisher übernimmt der Import aus der Bulk-Datei nur Struktur, Gebote, Budgets und die
> Suchbegriff-Blätter. Die Kennzahlen-Spalten der Kampagnen-Blätter (`Impressions`, `Clicks`, `Spend`, `Sales`, `Orders`,
> `Units`, SD zusätzlich `Viewable Impressions` und „(Views & Clicks)“) werden bisher ignoriert. Geschrieben wird wie in
> Phase 3 und 4 über Warenkorb, Übermittlung und Bulk-Datei, die Dominik von Hand hochlädt. Stündliche Daten gibt es
> nicht (bräuchten API und Amazon Marketing Stream).
>
> **Was daraus folgt:** Phase 5 baut die Automatik so, dass sie auf **Zeitraumsummen** rechnet (F1) und alles, was sie
> ändern will, als **Vorschlag** ablegt (F3): im Schattenmodus nur im Protokoll, freigeschaltet im Warenkorb. Der Takt ist
> „täglich, aber nur bei neuen Daten“: Der Lauf startet nach jedem Import und einmal am Tag, und er tut nichts, wenn seit
> dem letzten Lauf keine neuen Daten kamen. Kommt später die API (Tageswerte, direkte Writes), tauscht nur die Datenquelle
> (Tageswerte summiert statt Zeitraumsummen); Engine, Leitplanken und Oberfläche bleiben.

## Ziel

Die Agentur lässt ProfitBash Gebote und Budgets überwachen und Vorschläge machen, ohne die Kontrolle abzugeben:
- **Ziele** je Client (vorgezogen aus Phase 6, F4): Ziel-ACoS bzw. -ROAS, auch je Profil und Produktgruppe, mit Rechner.
- **Optimizer und Regeln** als Pipeline mit harten **Leitplanken** (höchste Änderung je Woche, Gebotsboden, Mindestdaten;
  Defaults je Organisation, je Client überschreibbar, F-S6) und **Schattenmodus** je Client.
- **Budget-Caps** je Profil und Monat mit **Pacing** (Ist, Soll, Prognose) und einem **Enforcer**, der meldet und
  Vorschläge in den Warenkorb legt (F5, F6).
- **Prüfungen „kein Geld verbrennen“** (Ideen-Dokument E), soweit die Bulk-Datei die Daten liefert.
- **Graduation- und Preset-Vorschläge** aus den Kanten des Struktur-Katalogs (Phase 4), nie automatisch.
- **Benachrichtigungen** in der App, live per SSE (F8).

Navigation (`plan.md` §3): „Budgets“ (`/ads/budgets`, Feature `budgets`), „Automationen & Regeln“ (`/ads/automations`,
Feature `automations`), „Ziele“ (`/ads/goals`, Feature `goals`, vorgezogen), „Benachrichtigungen“ (`/notifications`, alle).
Schreiben nur mit Recht `write` (Admin, Editor); Leitplanken-Defaults der Organisation nur Admins (wie Katalog, `phase-4.md` F11).

## Definition of Done

- [ ] Nichts geht automatisch an Amazon: Jede Änderung der Automatik ist ein Vorschlag (Schattenmodus: nur Protokoll;
      freigeschaltet: Warenkorb mit Herkunft `automation` bzw. `budget_cap`), übermittelt wird wie in Phase 3 von Hand.
- [ ] Jeder Lauf der Pipeline läuft über `runJob` und schreibt `job_runs`; je Lauf steht fest, auf welchen Daten (Datei,
      Zeitraum) er gerechnet hat, welche Regel bzw. welcher Optimizer-Schritt je Vorschlag gegriffen hat und welche
      Leitplanke ihn begrenzt hat. Läufe ohne neue Daten tun nichts (idempotent je Datenstand).
- [ ] Optimizer, Regeln, Leitplanken, Pacing, Prüfungen und Graduation-Kriterien liegen in `packages/engine` ohne I/O, mit
      Tests je Leitplanke, je Regelart und je Prüfung; Beträge nur mit `decimal.js`.
- [ ] Ziele, Leitplanken, Regeln, Schwellen der Prüfungen und Caps sind **Daten** der Organisation (mit eigenen
      Startwerten, änderbar), nichts davon ist hart codiert und nichts 1:1 aus Drittprodukten übernommen.
- [ ] Leitplanken halten in jedem Fall: Kein Vorschlag ändert ein Gebot stärker als erlaubt je 7 Tage (über alle
      Übermittlungen dieses Targets in dem Fenster, auch händische), unterschreitet den Boden oder überschreitet die Grenzen
      von Amazon (`limits`, Phase 3); zu wenig Daten heißt kein Vorschlag.
- [ ] Pacing kennzeichnet geschätzte Werte (Zeitraumsummen anteilig, „≈“), exakte nur aus Tageswerten.
- [ ] Benachrichtigungen erreichen alle berechtigten Mitglieder live (SSE) und nach einem Neuladen; ein fehlender
      SSE-Kanal legt keine Seite lahm.
- [ ] Beträge bleiben Decimal-Strings mit Währung; Amazon-IDs Strings.
- [ ] Alle Zugriffe über den Access-Layer (ADR 002); Test je Endpunkt (fremde Organisation, ausgeblendetes Profil, Recht `write`).
- [ ] Jede schreibende Aktion erzeugt ein `audit_event` (Einstellungen, Regeln, Ziele, Caps, Freischalten, Annehmen und
      Verwerfen von Vorschlägen).
- [ ] Tests gegen den Mock-Anbieter bzw. synthetische Bulk-Dateien, keiner gegen echte Amazon-Endpunkte.
- [ ] Browser-Pane geprüft wie in Phase 2–4 (1440 px, Tablet, Handy, Hell/Dunkel, Konsole).
- [ ] `pnpm test`, `typecheck`, `lint`, `build`, beide Smoke-Tests und CI grün.

## Fragen an Dominik

Gestellt zu Beginn der Planung (2026-10-10), jede mit Empfehlung.

- **F1 – Woher kommen die Kennzahlen?** Empfehlung: aus der Bulk-Datei, die Dominik ohnehin lädt (Summen über den Zeitraum
  der Datei je Kampagne, Ad Group, Target, Product Ad). Alternativen: zusätzlich Tagesberichte (1.11e wieder aufnehmen) oder
  Phase 5 nur gegen Demo-Daten.
  **Entschieden (Dominik, 2026-10-10): aus der Bulk-Datei, wie empfohlen.**
- **F2 – Zeitraum des wöchentlichen Downloads.** Empfehlung: letzte 30 Tage (genug Daten für den Optimizer; die
  Monatsausgaben fürs Pacing werden anteilig geschätzt und mit „≈“ gekennzeichnet). Alternativen: Monatsanfang bis gestern
  (exakt, aber am Monatsanfang wenig Daten) oder beide Dateien.
  **Entschieden (Dominik, 2026-10-10): letzte 30 Tage, wie empfohlen.** ProfitBash nimmt trotzdem jeden Zeitraum an
  (die vorhandenen Dateien haben 9 bis 60 Tage) und rechnet mit dem, was die neueste Datei abdeckt.
- **F3 – Wie weit darf der Optimizer gehen?** Empfehlung: neue Clients starten im Schattenmodus (rechnet und protokolliert);
  je Client auf „Vorschläge in den Warenkorb“ umschaltbar, übermittelt wird von Hand. Ob mit der API automatisch übermittelt
  wird, entscheiden wir, wenn die API da ist.
  **Entschieden (Dominik, 2026-10-10): Schatten, dann Warenkorb, wie empfohlen.**
- **F4 – Ziel für den Optimizer.** Empfehlung: einfache Einstellung Ziel-ACoS je Client unter „Automationen“, Seite „Ziele“
  bleibt in Phase 6.
  **Entschieden (Dominik, 2026-10-10): die Seite „Ziele“ aus Phase 6 vorziehen** (abweichend von der Empfehlung). Umfang
  in 5.3: Ziel-ACoS bzw. -ROAS je Client, Profil und Produktgruppe mit Rechner; TACoS nur als Hinweis „braucht
  Umsatzdaten (Phase 7)“. `plan.md` ist angepasst.
- **F5 – Wofür gilt ein Budget-Cap?** Empfehlung: je Profil und Monat in der Währung des Profils, für das ganze Profil oder
  eine Auswahl (Portfolio, Tag).
  **Entschieden (Dominik, 2026-10-10): je Profil und Monat, wie empfohlen.**
- **F6 – Was tut der Enforcer?** Empfehlung: Benachrichtigung und Vorschläge im Warenkorb (Tagesbudgets senken, bei
  erreichtem Cap pausieren); Dominik übermittelt. Alternative: zusätzlich das Monatslimit als Portfolio-Budget bei Amazon.
  **Entschieden (Dominik, 2026-10-10): melden und Vorschlag, wie empfohlen.**
- **F7 – Dayparting.** Ohne stündliche Daten weiß ProfitBash nicht, welche Stunden gut laufen. Amazon bietet
  Budgetregeln nach Tageszeit (Budget zu bestimmten Stunden **erhöhen**); die echte Bulk-Datei vom 2026-10-07 hat dafür ein
  Blatt „Budget Rules“ (Wochentage, `Intraday Schedule Start Time`/`End Time`, `Budget Rule Increase By …`), laut Amazons
  Ankündigung vom 30.11.2023 aber nur in USA, Kanada, UK, Indien und Japan. Empfehlung: verschieben.
  **Entschieden (Dominik, 2026-10-10): verschieben, bis API und stündliche Daten da sind.** `plan.md` ist angepasst.
- **F8 – Kanal für Benachrichtigungen.** Empfehlung: nur in der App (Glocke, Liste, live per SSE), kein externer Dienst.
  **Entschieden (Dominik, 2026-10-10): nur in der App, wie empfohlen.**

## Aufgaben (nach F1–F8, 2026-10-10)

**Begriffe:** Ein **Lauf** ist eine Ausführung der Pipeline für ein Profil auf einem Datenstand. Ein **Vorschlag** ist eine
gewünschte Änderung (Gebot, Budget, Zustand) mit Begründung; im **Schattenmodus** bleibt er im Protokoll, im Modus
**Warenkorb** wird er eine ausstehende Änderung (`ad_changes`) mit Herkunft `automation` bzw. `budget_cap`. Eine
**Leitplanke** begrenzt jeden Vorschlag, egal woher er kommt. Der **Datenstand** eines Profils ist die neueste importierte
Bulk-Datei mit Kennzahlen (später: der neueste Tag der Tageswerte).

### 5.1 Kennzahlen aus der Bulk-Datei (`packages/db`, `apps/worker`)
- [ ] Tabelle für Zeitraumsummen je Ebene (Kampagne, Ad Group, Target bzw. Keyword, Product Ad): Profil, Ebene, Amazon-ID,
      Zeitraum (von, bis) aus dem Dateinamen bzw. der Import-Angabe, Datei-Import, Kennzahlen als `numeric`/`bigint`
      (Impressions, Klicks, Ausgaben, Umsatz, Bestellungen, Einheiten; SD: sichtbare Impressions und „Views & Clicks“
      getrennt). Ersetzt wird je Profil und Datei-Import (wie die Suchbegriff-Zeitraumsummen, `phase-2b.md` 2b.1).
- [ ] Importer: Kennzahlen-Spalten der Blätter SP, SB (beide Blätter) und SD lesen, deutsche und englische Kopfzeilen
      (`COLUMN_ALIASES`); Zeilen ohne Kennzahlen (Schalter „Leistungsdaten“ aus) schreiben nichts. Abgeleitete Spalten (CTR,
      ACoS, CPC, ROAS) nicht übernehmen, sondern rechnen.
- [ ] Lesefunktion „Kennzahlen je Entity zum Datenstand“ hinter einer schmalen Schnittstelle: heute aus den Zeitraumsummen
      der neuesten Datei, später aus Tageswerten über ein Fenster. Rückgabe trägt Zeitraum und Herkunft (`file` | `daily`).
- [ ] Datenstand je Profil (neueste Datei mit Kennzahlen, Zeitraum) für die Pipeline und die Oberfläche („Daten bis“ für
      Datei-Profile wieder sinnvoll, Hinweis auf veraltete Daten nach 8 Tagen ohne Datei).
- **Offen vor dem Bau:** Attributionsfenster der Bulk-Kennzahlen (SP 7 Tage für Seller? SB-Summen mit oder ohne Views?)
  in der Bulksheets-Doku nachlesen und in `plan.md` §5 festhalten; Rundungsreste wie bei Geboten normalisieren (1.11d).

### 5.2 Benachrichtigungen (`packages/db`, `apps/api`, `apps/web`)
- [ ] Tabellen: Benachrichtigung (Organisation, optional Profil, Art, Schwere, Titel- und Text-Parameter für i18n, Link,
      Erzeugt), Lesestatus je Nutzer. Sichtbar nur für Mitglieder, die das Profil sehen (Access-Layer).
- [ ] Erzeugen über eine Funktion in `packages/db` (in der Transaktion des Auslösers), dazu Postgres `NOTIFY`; die API hört
      mit `LISTEN` und schiebt per **SSE** (`/api/notifications/stream`) an verbundene Clients. Funktioniert, wenn Worker und
      API getrennt laufen (`WORKER_MODE`). Wiederaufnahme über `Last-Event-ID`, Heartbeat.
- [ ] Erste Quellen: Datei-Import fertig bzw. fehlgeschlagen, Übermittlung abgeschlossen bzw. mit Fehlern, Daten veraltet
      (8 Tage ohne Bulk-Datei, einmal je Profil und Woche), Ablauf der Amazon-Einwilligung (Connections, 30/14/3 Tage vorher;
      `plan.md` §5). Spätere Aufgaben hängen ihre Arten an.
- [ ] Oberfläche: Glocke mit Zähler im Kopf, Seite `/notifications` (Liste, Filter ungelesen/Art/Profil, alle gelesen),
      Loading, Empty, Error; ohne SSE fällt die Glocke auf Abfragen beim Fokus zurück.
- [ ] Aufräumen: gelesene Benachrichtigungen nach 90 Tagen löschen (Job wie `job-runs-cleanup`).

### 5.3 Ziele (`/ads/goals`, vorgezogen aus Phase 6, F4)
- [ ] Tabelle Ziele: Organisation, Client, optional Profil oder Produktgruppe; Kennzahl `acos` oder `roas` (eins wird aus dem
      anderen gerechnet), Wert als Decimal-String, gültig ab. Vorrang: Produktgruppe vor Profil vor Client.
- [ ] Engine: „wirksames Ziel“ je Target/Kampagne (über Produktgruppe der beworbenen ASINs, sonst Profil, sonst Client);
      Rechner Break-even-ACoS aus Preis, Kosten je Einheit und Gebühren (von Hand eingegeben, nichts gespeichert außer dem
      übernommenen Ziel) und Ziel-ACoS = Break-even minus gewünschte Marge.
- [ ] API hinter `requireFeature('goals', …)`, Seite mit Liste je Client, Bearbeiten, Rechner im Dialog; TACoS und Wachstum
      als Hinweis „braucht Umsatzdaten (Phase 7)“. Platzhalter „Kommt in Phase 6“ entfällt.

### 5.4 Leitplanken und Automations-Einstellungen (`packages/shared`, `packages/db`, `apps/api`)
- [ ] Einstellungen je Organisation mit Startwerten (eigene Werte), je Client überschreibbar (F-S6): höchste Gebotsänderung je
      7 Tage (in %), Gebotsboden (in % des CPC im Zeitraum und absolut), höchstes Gebot (absolut, je Währung), Mindestdaten
      für einen Vorschlag (Klicks, Ausgaben), Schwelle „keine Bestellung“ (Klicks), Modus je Client: `off` | `shadow` |
      `cart` (Start `shadow`, F3).
- [ ] zod-Schemas in `packages/shared`, Speicherung mit Audit; Admins ändern die Defaults der Organisation, Admins und
      Editoren die Werte je Client.
- [ ] Engine: Leitplanken als reine Funktion über einen Vorschlag (Ausgangsgebot, letzte Änderungen der 7 Tage aus
      `ad_changes`, CPC) → begrenztes Gebot und Grund. Tests je Leitplanke, auch zusammen mit den Grenzen von Amazon.

### 5.5 Optimizer (`packages/engine`, ohne I/O)
- [ ] Gebotsvorschlag je Target (Keyword, Product Targeting; SP zuerst, SB und SD danach, vCPM-Gebote getrennt bzw.
      ausgenommen, `plan.md` §5) aus Zeitraumsummen und wirksamem Ziel: Wert je Klick geglättet gegen die Ebene darüber
      (Ad Group, dann Kampagne), wenn das Target wenig Klicks hat; Zielgebot = Wert je Klick × Ziel-ACoS; dann Leitplanken.
      Eigene Formel und eigene Startwerte, dokumentiert in der Umsetzungsnotiz.
- [ ] Targets ohne eigenes Gebot (Ad-Group-Standardgebot) und Auto-Targets: Vorschlag als eigenes Gebot am Target.
- [ ] Ausnahmen: geschützte Begriffe (Phase 2b) nur erhöhen bzw. nicht senken unter den Boden, archivierte und pausierte
      Entities nie, Entities mit offener ausstehender Änderung nicht doppelt.
- [ ] Tests mit synthetischen Zeitraumsummen: zu wenig Daten, über/unter Ziel, keine Bestellung, Boden, Obergrenze, Währung.

### 5.6 Regeln (`packages/engine`, `packages/db`, `apps/api`, `apps/web`)
- [ ] Regel = Name, Ebene (Target zuerst, Kampagne für Budgets), Bedingungen (Kennzahl im Zeitraum, Vergleich, Wert; auch
      relativ zum Ziel, z. B. „ACoS > 1,5 × Ziel“), Aktion (Gebot ± % oder absolut, Gebot setzen, pausieren), Gültigkeit je
      Client oder für alle. Reihenfolge je Client: **erste passende Regel gewinnt**, sonst der Optimizer (Ideen-Dokument F).
- [ ] Startregeln als Daten (eigene Werte, z. B. „viele Klicks ohne Bestellung → senken“), änderbar; Regeln einzeln
      abschaltbar.
- [ ] Editor auf `/ads/automations` (Tab „Regeln“) mit Vorschau „würde heute für N Targets greifen“ auf dem Datenstand.

### 5.7 Pipeline (`apps/worker`, `packages/db`)
- [ ] Job `automation-run` je Profil über `runJob`: ausgelöst nach jedem erfolgreichen Bulk-Import und täglich per Cron; tut
      nichts ohne neuen Datenstand seit dem letzten Lauf (außer bei geänderten Regeln/Zielen/Einstellungen, dann neu rechnen).
- [ ] Ablauf: Datenstand laden → Regeln → Optimizer → Leitplanken → Vorschläge speichern (Lauf, Vorschlag mit Regel bzw.
      Optimizer-Schritt, vorher/nachher, Begründung, begrenzt durch). Modus `cart`: Vorschläge als ausstehende Änderungen
      (`ad_changes.origin` um `automation` erweitern), vorhandene offene Vorschläge desselben Targets ersetzen, nie von Hand
      gelegte. Benachrichtigung „N neue Vorschläge“.
- [ ] ADR 006: Automatik ohne API (Zeitraumsummen, Datenstand als Takt, Vorschläge statt Writes, Weg zur API).

### 5.8 Seite „Automationen“ (`/ads/automations`)
- [ ] Tabs: **Läufe** (je Profil, Datenstand, Anzahl Vorschläge, Status), **Vorschläge** (Grid wie der Explorer: Entity, vorher,
      nachher, Regel/Optimizer, Leitplanke, Kennzahlen; im Schattenmodus „in den Warenkorb übernehmen“ einzeln oder markiert),
      **Regeln** (5.6), **Einstellungen** (5.4, Modus je Client).
- [ ] Schatten-Auswertung je Client: Vorschläge der letzten Wochen neben dem, was tatsächlich übermittelt wurde, und der
      Entwicklung der Kennzahlen der betroffenen Targets in den folgenden Dateien; Schalter „Vorschläge in den Warenkorb“.

### 5.9 Budgets: Caps, Pacing, Enforcer (`/ads/budgets`)
- [ ] Tabelle Caps: Profil, Monat (einmalig oder jeden Monat), Betrag in der Währung des Profils, Umfang (ganzes Profil,
      Portfolios oder Tags), Schwellen für Warnungen (z. B. Prognose über 100 %, Ist über 90 %).
- [ ] Engine Pacing: Ist im Monat (Tageswerte exakt; Zeitraumsummen anteilig für die Tage im Monat, „≈“), Soll (linear über
      den Monat), Prognose zum Monatsende aus der Rate der Datei; Tests für Monatswechsel, Datei über zwei Monate, Zeitzone des
      Profils.
- [ ] Enforcer im Lauf der Pipeline: Prognose über Cap → Benachrichtigung und Vorschlag „Tagesbudgets der betroffenen
      Kampagnen anteilig senken“ (Herkunft `budget_cap`, Grenzen von Amazon); Ist über Cap → Vorschlag „pausieren“. Modus wie
      F3 (Schatten bzw. Warenkorb je Client).
- [ ] Seite: Caps je Profil, Fortschrittsbalken Ist/Soll/Prognose, Datenstand, Liste der Kampagnen im Umfang.

### 5.10 Prüfungen „kein Geld verbrennen“ (Ideen-Dokument E)
- [ ] Prüfungen als Daten mit Schwellen je Organisation, Ergebnis je Lauf: aktive vCPM-Kampagnen (SD/SB, Kostenart aus der
      Datei), Off-Amazon aktiv (SP-Spalte „Off-Amazon ad serving“), Platzierungs-Anpassung über Schwelle bei Kampagnen-ACoS
      über Ziel, Targets mit Ausgaben über Schwelle ohne Bestellung, Kampagnen ohne Ziel bzw. ohne Cap.
- [ ] Hinweis-Checkliste je Kampagne für Dinge ohne Daten (Sponsored Prompts in der Konsole prüfen).
- [ ] Tab „Prüfungen“ auf `/ads/automations`, Benachrichtigung bei neuen Befunden (nicht bei jedem Lauf erneut), Befund
      quittierbar.

### 5.11 Graduation- und Preset-Vorschläge
- [ ] Graduation: Suchbegriffe (Zeitraumsummen, Phase 2b) in Kampagnen eines Bausteins mit ausgehender Kante, die die
      Kriterien der Kante erfüllen (Daten im Katalog, z. B. Bestellungen, ACoS gegen Ziel), werden vorgeschlagen; Annehmen
      legt sie auf die Harvest-Merkliste mit dem Zielbaustein der Kante (Phase 4, 4.6), Negativ in der Quelle wie dort.
- [ ] Preset-Wechsel: Kriterien je Preset (Daten, z. B. „Launch → Kontrolle nach N Wochen mit mindestens X Bestellungen je
      Woche“) auf Kennzahlen der Produktgruppe; Annehmen ändert das Preset der Produktgruppe (Audit), nie automatisch.
- [ ] Beides als Tab „Vorschläge“ bzw. eigener Abschnitt, Benachrichtigung bei neuen Vorschlägen.

### 5.12 Abschluss
- [ ] Definition of Done prüfen, Browser-Pane, offene Punkte festhalten.

## Offen vor dem Bau (nicht von Dominik zu entscheiden)

- Attributionsfenster und Views-Anteil der Bulk-Kennzahlen je Ad-Typ (5.1).
- Ob der Bulk-Import einen Zeitraum ohne Dateinamen (umbenannte Datei) erkennt; sonst Zeitraum im Upload-Dialog abfragen.
- SSE hinter dem Proxy von Railway (Puffern, Timeouts) beim ersten Deploy prüfen (5.2).

## Bewusst nicht in Phase 5

- **Dayparting** (F7): erst mit API und stündlichen Daten; Budgetregeln nach Tageszeit über das Blatt „Budget Rules“ nur
  dann, wenn Amazon sie in den Märkten von Muuv anbietet.
- Automatisch übermitteln ohne Rückfrage (F3: Entscheidung mit der API).
- Organic-Benachrichtigungen und Branded-CPC-Prüfung (brauchen SQP, offen), Preset-Wechsel nach SQP-Band.
- B2B-Prüfung (braucht Business-Report, Phase 7), Reserved Share of Voice (nicht in der Bulk-Datei), Prüfungen auf
  Platzierungs-Kennzahlen (keine Platzierungsberichte).
- E-Mail, Slack oder andere Kanäle (F8).
- TACoS-Ziele und Wachstumsziele mit Umsatzdaten (Phase 7); Kundenzugang, Audit-Log-UI (Phase 6).
- Wettbewerber-Liste je Client (F-S9, später).

## Reihenfolge für Claude Code

5.1 → 5.2 → 5.3 → 5.4 → 5.5 → 5.6 → 5.7 → 5.8 → 5.9 → 5.10 → 5.11 → 5.12. 5.2 (Benachrichtigungen) und 5.3 (Ziele) hängen
nicht an 5.1 und können parallel laufen; 5.5–5.11 brauchen 5.1. Bis zu drei Aufgaben je Session (`CLAUDE.md`), nach jedem
Schritt Tests grün, Commit, Häkchen und „Umsetzung“-Notiz.
