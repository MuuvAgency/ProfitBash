# Phase 2b – Suchbegriffe & Organic

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap inkl. „Erweiterungen aus dem Ideen-Dokument“, §3 Navigation,
> §5 inkl. „Kennzahlen je Ad-Typ“), `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` (Abschnitte A, B, G; Antworten
> F-S1–F-S9), `docs/tasks/phase-1.md` (1.11 komplett: Datei-Import, Befunde, Umsetzungsnotizen), `docs/decisions/` (001–004),
> `design/DESIGN.md`.
>
> **Status: Entwurf (2026-10-07).** Entschieden mit dem Ideen-Dokument: F-S1 (nach 1.11, vor Phase 3), F-S2 (Key `organic`,
> Suchbegriffe unter `sp-explorer`), F-S3 (wenige Kunden, unregelmäßige Downloads), F-S4 (keine Rank-Tracker-Exporte, Kalibrierung
> optional), F-S5 (Suchbegriffe read-only hier, Aktionen in Phase 3), dazu **F1–F3** unten (2026-10-07).
> Voraussetzung: `phase-1.md` 1.11 ist abgeschlossen (mindestens 1.11d–1.11f).
>
> **Eigenständigkeit:** Die Schwellen und Beispiele im Ideen-Dokument sind Recherche-Befunde (US, fremde Kataloge). Schwellen sind
> konfigurierbare Daten je Organisation, Bezeichnungen und Texte sind eigene.

## Ziel

Die Agentur sieht ohne Ads-API und ohne Rank-Tracker:
- **Suchbegriffe:** welche Wortbausteine Geld verbrennen oder tragen (N-Gramme), welche Suchbegriffe Kandidaten zum Ernten
  (Harvest), Negieren oder Beobachten sind, und wie viel Impression-Share sie haben. Nur lesen; Aktionen kommen mit dem
  Warenkorb (Phase 3).
- **Organic (SQP):** aus den Search-Query-Performance-CSVs (Brand Analytics) je Suchbegriff und Woche ein **Band** für den
  organischen Rang (Top 3, Top 10, Seite 1, tiefer, unbekannt), dazu Funnel-Lücken (Impression → Klick → Warenkorb → Kauf) und den
  Branded-Check (hoher Kaufanteil bei Markenbegriffen, CPC-Trend).

Navigation (`plan.md` §3): Suchbegriffe als Ebene bzw. Tab im Explorer (`sp-explorer`), „Organic (SQP)“ unter `/ads/organic`
(Feature `organic`, neuer Key in `packages/shared/src/features.ts`).

## Definition of Done (Entwurf)

- [ ] SQP-Dateien laufen über den Datei-Import aus 1.11 (Upload → `file_imports` → `runJob`), mit Verlauf, Fehlern und Hinweis auf
      veraltete Daten; keine zweite Import-Infrastruktur.
- [ ] Gespeichert werden **Zählwerte** (gesamt und eigene), Anteile werden berechnet. Preise als `numeric` mit Währung.
- [ ] Wochen ohne Datei sind als Lücke sichtbar (F-S3); Trends rechnen nur über vorhandene Wochen und sagen das.
- [ ] Der Organic-Indikator zeigt **Bänder und mehrwöchige Trends**, nie eine Platz-Zahl oder ein Wochen-Delta; „Indikator, kein
      Rang“ steht fest im UI. Wochen mit eigenen Anzeigen auf dem Begriff sind markiert (ein Band tiefer, Grund sichtbar).
- [ ] Schwellen liegen als Daten in der DB (Default je Organisation, Overrides je Client/Marktplatz), nicht im Code.
- [ ] Engine-Funktionen (N-Gramme, Einstufung, Band) ohne I/O in `packages/engine`, mit Tests je Regel und Grenzfall.
- [ ] Geschützte Begriffe (Marke, Hero-Begriffe) bekommen nie einen Negativ-Vorschlag (Test).
- [ ] Alle Zugriffe über den Access-Layer (ADR 002); Test je Endpunkt (fremde Organisation, ausgeblendetes Profil, Entitlement
      `organic`).
- [ ] Jede Datenansicht mit Skeleton, Empty- und Error-Zustand; Browser-Pane geprüft wie in Phase 2.
- [ ] Echte Dateien von Dominik nur lokal gegen eine Wegwerf-Test-DB geprüft (Kopfzeilen, Werte-Listen, Zähler); keine Kundendaten
      im Repo.
- [ ] `pnpm test`, `typecheck`, `lint`, `build`, beide Smoke-Tests und CI grün.

## Fragen an Dominik

Jede Frage mit Empfehlung. Antworten werden hier mit Datum eingetragen („Entschieden (Dominik, …)“).

- **F1 – Quelle der Suchbegriffe.** Die Bulk-Datei enthält Suchbegriff-Blätter (SP, SB) nur als Summe über den Download-Zeitraum,
  der neue Konsolen-Bericht „Suchbegriff“ liefert Tageswerte. Empfehlung: **Tagesbericht „Suchbegriff“** in
  `amazon_ads_search_term_daily_metrics` (gleiche Tabelle wie der API-Weg), Bulk-Blätter nicht importieren. Braucht eine echte
  Beispieldatei (nur Kopfzeilen lesen).
  **Entschieden (Dominik, 2026-10-07): die Suchbegriff-Blätter der Bulk-Datei** (liegen in jeder Bulk-Datei vor, kein
  zusätzlicher Download). Folgen, in 2b.1 zu entwerfen: Die Blätter tragen nur **Summen über den Download-Zeitraum**; sie werden
  nicht als Tageswerte gespeichert (wie 1.11d) und nicht in `amazon_ads_search_term_daily_metrics` geschrieben, sondern je
  Import mit Zeitraum (von/bis). Zeiträume verschiedener Dateien überlappen sich und lassen sich nicht addieren: Die Analyse
  rechnet je Datei-Zeitraum (Auswahl des Imports statt freiem Zeitraum) und sagt das im UI. Der Tagesbericht „Suchbegriff“
  bleibt dem API-Sync vorbehalten: Tagesberichte als Datei wird es nicht geben (`phase-1.md` 1.11e entfällt, Dominik
  2026-10-07). „Ads aktiv“ für den Organic-Indikator (2b.4) kommt deshalb aus dem Datei-Zeitraum, der die SQP-Woche abdeckt,
  nicht aus Tageswerten derselben Woche; beim Entwurf von 2b.4 klären.
- **F2 – SQP-Ansicht.** Empfehlung: zuerst die **ASIN-Ansicht** (Woche), die Marken-Ansicht danach; Monat und Quartal nur, wenn du
  sie wirklich ziehst.
  **Entschieden (Dominik, 2026-10-07): ASIN- und Marken-Ansicht gleich von Anfang an** (Woche; Monat und Quartal nur bei
  Bedarf).
- **F3 – Schwellen zum Start.** Ohne eigene Kalibrierung (F-S4) braucht der Indikator Startwerte. Empfehlung: eigene, vorsichtig
  gewählte Startwerte je Organisation (vorläufig markiert), im UI änderbar; die US-Befunde nur als Orientierung, nicht übernommen.
  **Entschieden (Dominik, 2026-10-07): wie empfohlen.**

## Aufgaben (Entwurf, nach den Antworten verfeinern)

### 2b.1 Suchbegriffe importieren
- [x] Suchbegriff-Blätter (SP, SB) der Bulk-Datei im Bulk-Import mitlesen (F1): Kopfzeilen über Aliasse (DE/EN), Zuordnung zu
      Target bzw. Ad Group und Kampagne über die IDs aus 1.11d, Speicherung als Zeitraumsummen je Import (Zeitraum aus der
      Datei bzw. dem Dateinamen; neue Tabelle, nicht `amazon_ads_search_term_daily_metrics`); Test mit nachgebauter Datei.
      Echte Kopfzeilen: siehe Befund unten.
- **Befund aus drei echten Bulk-Dateien** (Dominik, 2026-10-07, nur Kopfzeilen und Zeilenzahlen, nicht im Repo): Blätter
  „SP Bericht „Suchbegriff““/„SP Search Term Report“ und „SB Bericht „Suchbegriff““/„SB Search Term Report“ (SB leer, nur
  Kopfzeile). Spalten deutsch: `Produkt`, `Kampagnen-ID`, `Anzeigengruppen-ID`, `Keyword-ID`, `Produkt-Targeting-ID`,
  `Kampagnenname`, `Name der Anzeigengruppe`, `Portfolioname` (nur SP; alle drei „(Nur zu Informationszwecken)“), `Zustand`,
  `Kampagnenstatus`, `Gebot`, `Keyword-Text`, `Übereinstimmungstyp`, `Ausdruck für Produkt-Targeting`, `Suchbegriff eines
  Kunden`, `Impressions`, `Klicks`, `Klickrate`, `Ausgaben`, `Verkäufe`, `Bestellungen`, `Einheiten`, `Conversion-Rate`, `ACOS`,
  `CPC`, `ROAS`. Englisch: `Product`, `Campaign ID`, `Ad Group ID`, `Keyword ID`, `Product Targeting ID`, `Campaign Name`,
  `Ad Group Name`, `Portfolio Name`, `State`, `Campaign State`, `Bid`, `Keyword Text`, `Match Type`, `Product Targeting
  Expression`, `Customer Search Term`, `Impressions`, `Clicks`, `Click-through Rate`, `Spend`, `Sales`, `Orders`, `Units`,
  `Conversion Rate`, `ACOS`, `CPC`, `ROAS`. Kein Datum und keine Währung in den Zeilen (Zeitraum nur im Dateinamen, Währung =
  Profil). Abgeleitete Spalten (Klickrate, Conversion-Rate, ACOS, CPC, ROAS) nicht speichern, sondern berechnen. Die deutsche
  Datei hat eine falsch übersetzte Spalte für den aufgelösten Ausdruck („Problem mit dem Ausdruck … Behoben“).

- [x] Umsetzung (Stand für 2b.2 und später):
  - **Schema** (Migration `0021_search_term_period_metrics`): `amazon_ads_search_term_period_metrics` (Organisation, Profil,
    `ad_product`, `period_start`/`period_end`, `amazon_campaign_id`, `amazon_ad_group_id`, `amazon_target_id` = Keyword- bzw.
    Produkt-Targeting-ID, `search_term`, `currency_code` = Währung des Profils, `impressions`, `clicks`, `cost`, `sales`
    (`numeric`), `purchases`, `units`, `imported_at`). Unique je (Profil, Ad-Typ, Zeitraum, Target, Suchbegriff). **Amazon-IDs
    ohne Fremdschlüssel:** Die Datei kann eine Teilmenge sein (z. B. ohne pausierte Targets); 2b.2 verbindet beim Lesen über
    (Profil, Amazon-ID) mit den Entity-Tabellen und muss mit fehlenden Entities rechnen.
  - **Schreiben:** `replaceSearchTermPeriodMetrics` (`packages/db/src/amazon-ads-metrics.ts`, Systemzugriff des Datei-Imports)
    ersetzt je Profil, Ad-Typ und Zeitraum; ohne Zeilen geschieht nichts (ein Download ohne Leistungsdaten löscht nichts).
    Andere Zeiträume bleiben daneben stehen, auch überlappende: Auswertungen wählen **einen** Zeitraum, nie die Summe mehrerer.
  - **Lesen der Blätter** (`apps/worker/src/file-import/bulk-search-terms.ts`, in `importBulkFile` in derselben Transaktion
    wie die Entities): sichtbare Blätter „SP/SB … Suchbegriff“ bzw. „… Search Term …“; Kopfzeilen über eigene Aliasse (DE/EN);
    Beträge wie in 1.11d auf 15 signifikante Stellen, Zähler als ganze Zahl; abgeleitete Spalten (Klickrate, ACOS, CPC …) werden
    nicht gelesen. Doppelte Zeilen je Target und Suchbegriff werden summiert. Fehlen Spalten, wird das Blatt mit Log
    `bulk_import.search_term_sheet_skipped` übergangen (die Datei nicht abgelehnt). Ungültige Zeilen (ID, Suchbegriff oder Zahl
    fehlt bzw. unlesbar) zählen getrennt als `invalidSearchTermRows` und verhindern das Entfernen bei „vollständig“ nicht.
  - **Zeitraum** nur aus dem Dateinamen der Werbekonsole (`bulk-<konto>-<von>-<bis>-<zeitstempel>.xlsx`, `parseBulkPeriod`).
    Umbenannte Datei: Entities werden importiert, Suchbegriffe nicht (`searchTermsWithoutPeriod`, Log
    `bulk_import.search_terms_without_period`). **Offen:** Zeitraum im Upload-Dialog von Hand angeben, falls das stört.
  - **Zähler** im Verlauf und Sync-Status: `searchTerms`, `searchTermsWithoutPeriod`, `invalidSearchTermRows` (nur wenn > 0).
  - **Echte Dateien gegengeprüft** (lokal gegen eine Wegwerf-Test-DB, 2026-10-07, drei Dateien von Dominik, nur Zähler): 359
    bzw. 347 Suchbegriff-Zeilen wie die Blätter, keine ungültigen Zeilen, alle Targets der Suchbegriffe unter den Entities,
    keine Gleitkomma-Reste, die deutsche und die englische Datei desselben Zeitraums ersetzen sich, je Datei rund 0,1 s.
  - **Nicht enthalten:** Lesen über den Access-Layer und die Oberfläche (2b.2); SB-Suchbegriffe sind nur mit leerem Blatt
    geprüft (Spalten wie SP ohne Portfolioname).

### 2b.2 Suchbegriff-Analyse (`packages/engine`, `apps/api`, `apps/web`)
- [ ] N-Gramme (1–3) über Suchbegriffe mit Spend, Sales, ACoS, CVR je Datei-Zeitraum (F1); Grid im Explorer (`sp-explorer`).
- [ ] Einstufung je Suchbegriff mit editierbaren Regeln je Organisation: Harvest, Negieren, Beobachten; geschützte Begriffe je
      Client. Nur Anzeige, Aktionen in Phase 3 (Warenkorb).
- [ ] Impression-Share/-Rang je Suchbegriff neben ACoS, falls der Konsolen-Bericht „Suchbegriff-Impression-Share“ vorliegt
      (eigene Datei-Art, optional).

### 2b.3 SQP-Import (`packages/db`, `apps/worker`)
- [ ] Feature-Key `organic`, Navigationseintrag „Organic (SQP)“ (`/ads/organic`).
- [ ] Tabellen für SQP-Perioden (Client, Marktplatz, Ansicht, ASIN bzw. Marke, Periodentyp, Beginn/Ende in der Zeitzone des
      Marktplatzes, Quelle, Import) und Kennzahlen je Periode und Suchbegriff (Zählwerte gesamt und eigene, Preise `numeric` mit
      Währung); Upsert je (Periode, Suchbegriff); Zugriffe über den Access-Layer.
- [ ] Datei-Art `sqp` im Datei-Import, Kopfzeilen über Aliasse, ASIN- und Marken-Ansicht (F2); Zuordnung der Datei zu Client
      und Marktplatz.

### 2b.4 Organic-Indikator (`packages/engine`)
- [ ] Tabelle für Band-Schwellen (Default je Organisation, Overrides je Client/Marktplatz, gültig ab) mit Startwerten nach F3.
- [ ] `estimateOrganicBand` (Anteile, Ads aktiv, Schwellen) → Band, Konfidenz, Gründe; „Ads aktiv“ aus den Suchbegriff-Kennzahlen
      derselben Woche.

### 2b.5 Oberfläche „Organic (SQP)“ (`apps/web`)
- [ ] Heatmap Suchbegriff × Woche mit Band, Suchvolumen, Filter mit/ohne Anzeigen, Wochen-Lücken sichtbar.
- [ ] Mehrwöchiger Trend; Funnel-Lücken mit Vergleich zur Vorperiode; Branded-Check; Harvest-Kandidaten (hohes Volumen, geringer
      Anteil, kein aktives Target) mit Verweis in die Suchbegriff-Analyse.

### 2b.6 Eigene Kalibrierung (optional, nur mit Rank-Tracker-Export)
- [ ] Import von Rang-Beobachtungen, Verdichtung auf SQP-Wochen, Schwellen je Band mit Zielpräzision neu bestimmen und als Override
      speichern (Ideen-Dokument A.5). Auslöser: Dominik hat einen Export für mindestens einen Kunden.

## Bewusst nicht in Phase 2b

- Aktionen auf Suchbegriffe (Negativ, Harvest-Kampagne): Phase 3 bzw. 4.
- SQP per SP-API und Preisverlauf neben dem Band: Phase 7.
- Benachrichtigungen bei Band-Wechseln: Phase 5.
