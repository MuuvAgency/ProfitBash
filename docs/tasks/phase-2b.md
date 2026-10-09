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
    (`numeric`), `purchases`, `units`, `imported_at`, `file_import_id` = Datei, aus der die Zeile stammt, leer nach dem Löschen
    des Verlaufs). Unique je (Profil, Ad-Typ, Zeitraum, Target, Suchbegriff). **Amazon-IDs
    ohne Fremdschlüssel:** Die Datei kann eine Teilmenge sein (z. B. ohne pausierte Targets); 2b.2 verbindet beim Lesen über
    (Profil, Amazon-ID) mit den Entity-Tabellen und muss mit fehlenden Entities rechnen.
  - **Schreiben:** `replaceSearchTermPeriodMetrics` (`packages/db/src/amazon-ads-metrics.ts`, Systemzugriff des Datei-Imports)
    ersetzt je Profil, Ad-Typ und Zeitraum **nur die Kampagnen, die in der Datei stehen** (die Konsole exportiert auch
    Teilmengen), bei „Datei ist vollständig“ den ganzen Zeitraum; ohne Zeilen geschieht nichts (ein Download ohne
    Leistungsdaten löscht nichts). Bei einer fremd wirkenden Datei (`unmatchedCampaigns`) werden keine Suchbegriffe
    geschrieben; Kampagnen der Suchbegriff-Zeilen zählen bei der Konto-Prüfung mit (anderes Profil → Ablehnung).
    Andere Zeiträume bleiben daneben stehen, auch überlappende: Auswertungen wählen **einen** Zeitraum, nie die Summe mehrerer.
  - **Lesen der Blätter** (`apps/worker/src/file-import/bulk-search-terms.ts`, in `importBulkFile` in derselben Transaktion
    wie die Entities): sichtbare Blätter „SP/SB … Suchbegriff“ bzw. „… Search Term …“; Kopfzeilen über eigene Aliasse (DE/EN);
    Beträge wie in 1.11d auf 15 signifikante Stellen, Zähler als ganze Zahl; abgeleitete Spalten (Klickrate, ACOS, CPC …) werden
    nicht gelesen. Doppelte Zeilen je Target und Suchbegriff werden summiert. Fehlen Spalten, wird das Blatt mit Log
    `bulk_import.search_term_sheet_skipped` übergangen (die Datei nicht abgelehnt). Ungültige Zeilen (ID, Suchbegriff oder Zahl
    fehlt bzw. unlesbar) zählen getrennt als `invalidSearchTermRows` und verhindern das Entfernen bei „vollständig“ nicht.
  - **Zeitraum** nur aus dem Dateinamen der Werbekonsole (`bulk-<konto>-<von>-<bis>-<zeitstempel>.xlsx`, `parseBulkPeriod`).
    Umbenannte Datei: Entities werden importiert, Suchbegriffe nicht (`searchTermsWithoutPeriod`, Log
    `bulk_import.search_terms_without_period`). Seit 2b.2c lässt sich der Zeitraum im Upload-Dialog von Hand angeben.
  - **Zähler** im Verlauf und Sync-Status: `searchTerms`, `searchTermsWithoutPeriod`, `invalidSearchTermRows` (nur wenn > 0).
  - **Echte Dateien gegengeprüft** (lokal gegen eine Wegwerf-Test-DB, 2026-10-07, drei Dateien von Dominik, nur Zähler): 359
    bzw. 347 Suchbegriff-Zeilen wie die Blätter, keine ungültigen Zeilen, alle Targets der Suchbegriffe unter den Entities,
    keine Gleitkomma-Reste, die deutsche und die englische Datei desselben Zeitraums ersetzen sich, je Datei rund 0,1 s.
  - Review (unabhängig): keine kritischen Befunde. Übernommen: Ersetzen nur der Kampagnen der Datei (vorher löschte eine
    Teilmengen-Datei die Suchbegriffe aller anderen Kampagnen des Zeitraums), nichts schreiben bei fremd wirkender Datei,
    Suchbegriff-Kampagnen in der Konto-Prüfung, Herkunft `file_import_id`, Zähler ohne Runden (`0.9999999999999999` ist
    ungültig), Konto-IDs mit Bindestrich im Dateinamen, Log für Suchbegriff-Blätter ohne „SP“/„SB“ im Namen. Bewusst so:
    keine `>= 0`-Checks in der Tabelle (der Leser lässt nur Zahlen ≥ 0 durch), eigene Kopfzeilen-Abbildung neben `mapHeader`
    (Kennzahlen-Spalten gehören nicht in die Entity-Blätter), Dateien mit Präfix („Kopie von bulk-…“) haben keinen Zeitraum.
  - **Nicht enthalten:** Lesen über den Access-Layer und die Oberfläche (2b.2); SB-Suchbegriffe sind nur mit leerem Blatt
    geprüft (Spalten wie SP ohne Portfolioname).

### 2b.2 Suchbegriff-Analyse (`packages/engine`, `apps/api`, `apps/web`)
Geteilt in **2b.2a** (Engine, Leseschicht, API) und **2b.2b** (Oberfläche).

**Entschieden (Dominik, 2026-10-07):**
- **Startwerte der Regeln „vorsichtig“:** Harvest ab 3 Käufen und ACoS ≤ 25 %; Negieren ab 25 Klicks ohne Kauf und
  mindestens 20 Spend (Betrag in der Währung des Profils); sonst Beobachten. Im UI änderbar.
- **Geschützte Begriffe** je Client werden bei **Clients & Connections** gepflegt (nicht im Explorer).
- **Zeitraum im Upload-Dialog:** ja, als Ausweich-Feld (zwei Datumsfelder nur, wenn der Dateiname keinen Zeitraum trägt);
  eigene kleine Aufgabe **2b.2c** nach 2b.2b.
- **Impression-Share-Bericht und SQP-CSVs:** liegen heute nicht vor. Der dritte Punkt unten bleibt offen, 2b.3 wartet auf
  echte SQP-Dateien (Spaltennamen werden nicht geraten).

#### 2b.2a Engine, Leseschicht, API
- [x] N-Gramme (1–3) über Suchbegriffe mit Spend, Sales, ACoS, CVR je Datei-Zeitraum (F1), Engine ohne I/O.
- [x] Einstufung je Suchbegriff mit editierbaren Regeln je Organisation: Harvest, Negieren, Beobachten; geschützte Begriffe je
      Client. Nur Anzeige, Aktionen in Phase 3 (Warenkorb).
- [x] Lesen über den Access-Layer je Profil und Datei-Zeitraum; Endpunkte mit Tests (fremde Organisation, ausgeblendetes
      Profil, Entitlement).
- [x] Umsetzung (Stand für 2b.2b und später):
  - **Engine** (`packages/engine/src/search-terms.ts`): `tokenizeSearchTerm` (klein, an Leerraum getrennt, Satzzeichen bleiben
    im Wort), `buildNgrams(rows, sizes = [1, 2, 3])` (je Zeile zählt ein Baustein einmal; `searchTerms` = verschiedene
    Suchbegriffe; sortiert nach Spend, Länge, Text), `isProtectedSearchTerm` (geschützter Begriff als ganze, zusammenhängende
    Wortfolge, keine Wortteile), `classifySearchTerm(row, rules)` → `harvest` | `negate` | `watch` mit Grund
    bei `watch` (`protected`, `alreadyTargeted`, `acosAboveTarget`, `noSales`, `tooFewData`). Grenzwerte zählen mit; ACoS-Vergleich ohne
    Division (Spend ≤ Ziel × Umsatz); Käufe ohne Umsatz sind kein Harvest. Geschützte Begriffe werden nie negiert, dürfen aber
    geerntet werden. Negieren gilt auch für schon exakt gebuchte Begriffe.
  - **Einstufung je Zeile** (Suchbegriff je Target, wie das Blatt): Negativ-Vorschläge gehören in die Quellkampagne. Folge:
    Ein Begriff, dessen Käufe sich auf mehrere Targets verteilen, erreicht die Harvest-Grenze später. Seit 2b.2f
    zusätzlich je Suchbegriff über alle Targets des Profils eingestuft.
  - **Schema** (Migration `0022_search_term_rules`): `search_term_rules` (eine Zeile je Organisation: `harvest_min_purchases`,
    `harvest_max_acos` als Bruch, `negate_min_clicks`, `negate_min_cost`, `updated_by`, `updated_at`) und
    `clients.protected_terms` (`text[]`, normalisiert gespeichert). Ohne Zeile gelten die Startwerte
    `DEFAULT_SEARCH_TERM_RULES` (`packages/shared/src/search-terms.ts`), die Antwort kennzeichnet das (`isDefault`,
    `rulesAreDefault`). Overrides je Profil seit 2b.2g (die Spend-Grenze ist ein Betrag in der Währung des Profils,
    dieselbe Zahl bedeutet in SEK oder PLN viel weniger als in EUR).
  - **Leseschicht** (`packages/db/src/search-terms.ts`, nur über `visibleProfilesScope()`): `listSearchTermPeriods` (je
    sichtbarem Profil die Datei-Zeiträume mit Ad-Typen, Zeilenzahl, letztem Import; neuester zuerst),
    `querySearchTermPeriod` (Profil + **ein** Zeitraum, optional Ad-Typen; `null`, wenn das Profil nicht sichtbar ist; Zeilen
    nach Spend, über (Profil, Amazon-ID) mit Kampagne, Ad Group und Target verbunden, fehlende Entities `null`;
    `alreadyTargeted` = im Profil gibt es ein exaktes Keyword bzw. ein exaktes Produkt-Target (ASIN) mit dem Begriff, ohne
    archivierte und entfernte, pausierte zählen; geschützte Begriffe des Clients). `getSearchTermRules`/`saveSearchTermRules`
    (Mitglieder lesen, Audit `search_term_rules.update` mit `before`/`after`).
  - **API** (`routes/search-terms.ts`, Tag „Suchbegriffe“, Feature `sp-explorer`): `POST /api/ads/search-terms/periods`,
    `POST /api/ads/search-terms/analysis` (`profileId`, `periodStart`, `periodEnd`, `adProducts?` → `meta` mit Regeln,
    geschützten Begriffen, Währung, `total`, `counts` je Einstufung, `rows`, `ngrams`; nicht sichtbares Profil `404
    PROFILE_NOT_FOUND`), `GET`/`PUT /api/ads/search-terms/rules` (Schreiben mit Recht `write`, also Admins und Editoren).
    Einstufung, Zähler, Summe und N-Gramme rechnen über **alle** Zeilen des Zeitraums; die Antwort kürzt auf
    `MAX_SEARCH_TERM_ROWS` (10 000) Zeilen und `MAX_SEARCH_TERM_NGRAMS` (5 000) Bausteine mit dem höchsten Spend
    (`truncated`, `ngramsTruncated`). Beträge in der Währung des Profils, keine Umrechnung (ein Profil je Anfrage).
  - **Geschützte Begriffe:** `PATCH /api/clients/{id}` nimmt `protectedTerms` (höchstens 200, je 80 Zeichen; gespeichert
    klein, Leerraum zusammengefasst, ohne Doppelte, sortiert), `Client.protectedTerms` in allen Antworten, Audit
    `client.update` mit den Listen. Profile ohne Client haben keine geschützten Begriffe.
  - Review (unabhängig): keine kritischen Befunde; Mandantentrennung, Joins (je höchstens eine Zeile), Decimal-Rechnung und
    „nie Summen über Zeiträume“ bestätigt. Übernommen: Der Schutz trennt Wörter auch an Satzzeichen („nordwind-lampe“ ist
    durch „nordwind“ geschützt; die N-Gramme trennen weiter nur an Leerraum), `createProtectedTermMatcher` bereitet die
    Begriffe einmal je Anfrage vor, `classifySearchTerm` bekommt `protected` als Merker; eigener Grund `noSales` (Käufe
    ohne Umsatz) statt `acosAboveTarget`; Abgleich „schon exakt gebucht“ in Vergleichsform (klein, NFC, Leerraum
    zusammengefasst); Tests mit denselben Amazon-IDs und einem exakten Keyword in einem fremden und im ausgeblendeten
    Profil; ADR 002 um `search_term_rules` und geschützte Begriffe ergänzt. Bewusst so bzw. bekannte Grenzen:
    `alreadyTargeted` prüft nur das Target (nicht den Zustand von Kampagne und Ad Group) und gilt über Ad-Typen hinweg
    (ein exaktes SB-Keyword zählt auch für einen SP-Suchbegriff); `listSearchTermPeriods` gruppiert die ganze Tabelle
    (bei Wachstum eine Zeitraum-Tabelle); bei mehr als 10 000 Zeilen fallen die mit dem kleinsten Spend aus `rows`, die
    Zähler zählen sie (2b.2b nennt das); Wertebereiche der Regeln nur über zod (wie 2b.1); ein Speichern ohne Änderung
    schreibt trotzdem ein Audit-Event; `POST` für die Zeiträume wie die übrigen Auswertungs-Endpunkte.
  - **Nicht enthalten:** Oberfläche (2b.2b), Zeitraum-Feld im Upload (2b.2c), Hinweis „schon negiert“ (vorhandene Negatives
    werden nicht gegen die Vorschläge geprüft), Obergrenze beim Lesen sehr großer Zeiträume (alle Zeilen eines Zeitraums
    werden geladen; echte Dateien haben einige hundert Zeilen).

#### 2b.2b Oberfläche
- [x] Reiter bzw. Ansicht im Explorer (`sp-explorer`): Auswahl Profil und Datei-Zeitraum (kein freier Zeitraum, Hinweis im
      UI), Grid der Suchbegriffe mit Einstufung und Grund, Grid der N-Gramme, Summen; Regeln ändern (Dialog, Recht `write`);
      geschützte Begriffe je Client bei Clients & Connections. Skeleton, Empty- und Error-Zustand, Browser-Pane.
- [x] Umsetzung (Stand für 2b.2c und später):
  - **Seite** `pages/SearchTermAnalysisPage.vue`, Route `/ads/explorer/search-term-analysis` (Feature `sp-explorer`, vor den
    Unterpfaden des Explorers), als achter Reiter „Suchbegriff-Analyse“ im Explorer verlinkt (`explorer/ExplorerTabs.vue`,
    aus der Explorer-Seite herausgelöst). Eigene Auswahl statt Filterleiste: **Profil** (nur Profile mit Suchbegriffen) und
    **Zeitraum der Datei** (Zeiträume des Profils mit Zeilenzahl, neuester zuerst). URL: `profile`, `from`, `to`, `view`
    (`ngrams`), `class` (Filter der Einstufung). Unbekannte Angaben ersetzt die Seite per `replace` durch die erste gültige
    Auswahl. Hinweis fest im UI: Summen über den Download-Zeitraum, Zeiträume werden nie addiert.
  - **Inhalt:** Kachel „Einstufung“ (Ernten, Negieren, Beobachten als Knöpfe mit Zählern, zugleich Filter; darunter Spend,
    Umsatz, ACoS, CVR des Zeitraums in der Währung des Profils), Kachel „Regeln“ (geltende Regeln als Satz, Kennzeichnung der
    Startwerte, geschützte Begriffe des Clients, „Regeln ändern“ nur mit Recht `write`), darunter die Ansichten
    **Suchbegriffe** (Grid: Suchbegriff fest links, Einstufung mit Grund und Farbe, Kampagne, Ad Group, Target über
    `targetLabel`, Kennzahlen; Summenzeile unten) und **Wortbausteine** (Baustein, Wörter, Anzahl Suchbegriffe, Kennzahlen;
    Umschalter Alle / 1 / 2 / 3 Wörter; Hinweis, dass sich Bausteine überschneiden). Sortieren und Filtern im Browser
    (`compareDecimalNullsLast`, `DecimalFilter`). Hinweise bei gekürzten Zeilen bzw. Bausteinen.
  - **Zustände:** Skeleton, Leerzustand ohne Datei-Zeiträume (dann keine Analyse-Anfrage), Fehler mit „Erneut versuchen“
    je Abfrage (Zeiträume, Analyse), auch beim Neuladen mit vorhandenen Daten; beim Wechsel bleiben die alten Werte blass
    stehen (`aria-busy`).
  - **Regeln ändern** (`search-terms/RulesDialog.vue`): vier Felder mit Labels; ACoS in Prozent eingegeben und als Bruch
    gesendet (`search-terms/decimal-input.ts`, Komma oder Punkt, ohne `number`), Prüfung mit `searchTermRulesSchema` vor dem
    Senden, danach lädt die Analyse neu.
  - **Geschützte Begriffe** (Dominik: bei Clients & Connections): Kachel „Clients“ (`connections/ClientsCard.vue`) listet
    die Clients mit ihren Begriffen; Dialog `ProtectedTermsDialog.vue` (ein Begriff je Zeile, höchstens 200 mit je 80
    Zeichen, Fehler im Dialog). Nach dem Speichern übernimmt die Liste den Stand des Servers, die Analyse lädt neu.
  - **Texte** unter `searchTerms.*` und `connections.clients.*`/`connections.protectedTerms.*`; eigene Bezeichnungen
    („Ernten“, „Negieren“, „Beobachten“, „Wortbausteine“).
  - **Browser-Pane geprüft (2026-10-08)** mit erfundenen Suchbegriffen für zwei Demo-Profile in der lokalen Dev-DB (EUR und
    SEK, zwei Zeiträume; kein Kundeninhalt): Leerzustand, Auswahl und URL, Zähler und Summen, Wortbausteine mit Umschalter,
    Regel-Dialog mit Startwerten, Clients-Kachel mit Dialog, 1440 px und Handy ohne waagerechtes Scrollen der Seite, Hell und
    Dunkel, Konsole ohne Fehler. Befund behoben: Die Zeitraum-Auswahl schnitt ihren Text ab (breiter).
  - Review (unabhängig): keine kritischen Befunde; Zahlen nie über `number`, nur registrierte Grid-Module, Rechte und
    i18n bestätigt. Übernommen: Fehler beim Neuladen mit vorhandenen Daten wird gemeldet („möglicherweise nicht aktuell“,
    vorher verschluckt, z. B. nach dem Speichern der Regeln); der URL-Abgleich hört auch auf die URL (ein Link ohne
    Parameter bekommt die Auswahl zurück) und nur, solange die Seite die Route ist; beim Wechsel von Profil oder Zeitraum
    bleiben die alten Werte blass stehen (`keepPreviousData`, auch das Grid); der Einstufungs-Filter gilt nicht in den
    Wortbausteinen; Regel-Dialog schließt erst nach dem Neuladen; Regel-Satz zeigt bis zu zwei Nachkommastellen; Dialog der
    geschützten Begriffe hört auf die Client-ID (eine laufende Eingabe wird nicht mehr zurückgesetzt); nach einem
    Datei-Import lädt die Analyse neu; Hinweis bei gekürzten Zeilen ohne Treffer in einer Einstufung; Tests für Profil-
    und Zeitraumwechsel mit Zurück-Taste, Währung des Profils, URL nach unbekannten Angaben. Bewusst so: „1.000“ gilt als
    1,000 (kein Tausenderpunkt, der Fehlertext sagt es); die Reiter der Analyse-Seite tragen keine Explorer-Parameter (die
    Filterleiste merkt sich ihre Auswahl selbst, ein Drill-Down geht beim Umweg verloren); die Länge der Wortbausteine
    steht nicht in der URL; die Clients-Kachel erscheint erst mit mindestens einem Client (Ladefehler der Clients meldet
    die Seite schon).
  - **Nicht enthalten:** Spaltenauswahl und gespeicherte Ansichten für diese Seite; Filter nach Ad-Typ (die API kann ihn
    schon). CSV-Export und Sprung in den Explorer kamen mit 2b.2e.

#### 2b.2c Zeitraum im Upload-Dialog (Ausweich-Feld)
- [x] Trägt der Dateiname keinen Zeitraum, erscheinen zwei Datumsfelder (von/bis); der Import nutzt sie für die
      Suchbegriffe. Sonst gilt weiter der Dateiname.
- [x] Umsetzung:
  - **Shared** (`packages/shared/src/file-imports.ts`, browserfähig): `parseBulkPeriod` und `BulkPeriod` liegen jetzt hier
    (vorher im Worker), Import, API und Dialog nutzen dieselbe Funktion (eine Regex). Neu: `BULK_PERIOD_MAX_DAYS` (60),
    `bulkPeriodIssue({ startDate, endDate }, today?)` → `incomplete` | `invalidDate` | `startAfterEnd` | `future` |
    `tooLong` | `null` (keine Angabe ist erlaubt), `todayInTimezone`.
  - **Regeln:** beide Tage oder keiner, von ≤ bis, letzter Tag nicht nach „heute“ **in der Zeitzone des Profils**,
    höchstens 60 Tage **zwischen** erstem und letztem Tag (bis − von ≤ 60; ein Tag mehr als „60 Tage eingeschlossen“,
    bewusst die großzügigere Lesart, damit kein echter Konsolen-Zeitraum abgelehnt wird).
  - **Schema** (Migration `0023_file_imports_period`): `file_imports.period_start`/`period_end` (`date`, leer erlaubt), Check
    `file_imports_period_ck` (beide oder keiner, von ≤ bis).
  - **DB** (`packages/db/src/file-imports.ts`): `createFileImport` nimmt `period` (und `now` für Tests). **Der Dateiname
    gewinnt:** Trägt er einen Zeitraum, wird die Angabe verworfen und nicht geprüft (sonst stünde im Verlauf ein Zeitraum,
    der nicht gilt). Ungültige Angabe → `FileImportError` `INVALID_PERIOD`. Der Zeitraum steht im Audit-Event
    `file_import.create` (`periodStart`, `periodEnd`), in `FileImport` (Upload-Antwort und Liste) und in
    `ClaimedFileImport.period`.
  - **API** (`POST /api/profiles/{id}/file-imports`): optionale Multipart-Felder `periodStart`, `periodEnd`
    (`YYYY-MM-DD`). zod prüft die Schreibweise immer, „beide oder keiner“, Reihenfolge und Spanne nur, wenn der Dateiname
    keinen Zeitraum trägt (`400 VALIDATION_ERROR`); „nicht in der Zukunft“ prüft die DB-Schicht mit der Zeitzone des
    Profils (`400 INVALID_PERIOD`).
  - **Worker:** `FileImporterInput.period`; `importBulkFile` nimmt `parseBulkPeriod(fileName) ?? period`. Nur wenn beides
    fehlt, bleibt es bei `searchTermsWithoutPeriod`.
  - **Web** (`FileImportsDialog.vue`): Nach der Dateiwahl erscheinen „Zeitraum von“/„Zeitraum bis“ (`input type="date"`,
    `max` = heute im Profil) samt Hinweis nur, wenn `parseBulkPeriod` für den Namen nichts liefert. Prüfung beim Absenden
    mit `bulkPeriodIssue`, Meldung bei den Feldern (`role="alert"`, `aria-invalid`, `aria-describedby`); beide leer →
    Upload ohne Zeitraum. Eine neue Dateiwahl leert die Felder. Der Verlauf zeigt unter dem Dateinamen
    „Zeitraum 01.09.2026 – 30.09.2026“ (`font-data`), nur bei von Hand angegebenem Zeitraum.
  - **Bewusst so bzw. offen:** Der Zähler-Text „Suchbegriff ohne Zeitraum (Dateiname geändert)“ ist unverändert. Der
    Zeitraum wird für jede Dateiart gespeichert, genutzt nur vom Bulk-Import. Ein gespeicherter Import lässt sich nicht
    nachträglich mit Zeitraum versehen (Datei erneut hochladen). Kein unabhängiges Review und kein Blick in die
    Browser-Pane in dieser Session (Auftrag ohne Dev-Server).
  - Review (unabhängig): keine kritischen Befunde; `parseBulkPeriod` unverändert nach `shared` umgezogen, Vorrang des
    Dateinamens einheitlich, Migration additiv, Rechte und Mandanten unverändert. Übernommen: Fehlercodes je Fall im
    API-Test festgelegt (vorher „einer von beiden“), leere Formularfelder gelten wie fehlende, Hinweis im Dialog, dass
    vorhandene Suchbegriffe desselben Zeitraums ersetzt werden, Texte „höchstens 60 Tage auseinander“ (die Regel ist
    bis − von ≤ 60). **Offen (Dominik bei Bedarf):** Ein falsch angegebener Zeitraum lässt sich nicht zurücknehmen
    (Tippfehler im Jahr ergibt einen dauerhaften Zeitraum in der Auswahl der Suchbegriff-Analyse; ein falscher, schon
    vorhandener Zeitraum wird für die Kampagnen der Datei überschrieben): Löschen eines Suchbegriff-Zeitraums und eine
    Untergrenze sind mit 2b.2d umgesetzt; die Analyse kennzeichnet von Hand angegebene Zeiträume noch nicht. Bewusst so: Ablehnungen der API erscheinen oben im Dialog (nur wenn Browser- und
    Server-Prüfung auseinanderlaufen); `max` der Datumsfelder wird bei der Dateiwahl bestimmt (die Prüfung beim Senden
    rechnet frisch).

#### Offene Punkte aus 2b.2 (2b.2d–2b.2f)

**Entschieden (Dominik, 2026-10-08):** alle vier offenen Punkte aus 2b.2 werden umgesetzt: Suchbegriff-Zeitraum löschen und
Untergrenze für von Hand angegebene Zeiträume (**2b.2d**), CSV-Export und Sprung in den Explorer (**2b.2e**), Einstufung je
Suchbegriff über das Profil (**2b.2f**), Regeln je Client/Marktplatz (**2b.2g**, umgesetzt als Regeln je Profil, siehe
unten). SQP-CSVs und der Bericht
„Suchbegriff-Impression-Share“ liegen weiter nicht vor (2b.3 wartet). **SQP-Zuordnung:** über das Profil, im bestehenden
Upload-Dialog mit Datei-Art SQP wie die Bulk-Datei; Client und Marktplatz kommen vom Profil.

#### 2b.2f Einstufung je Suchbegriff über alle Targets
- [x] Zusätzlich zur Einstufung je Zeile (Suchbegriff je Target) eine Einstufung je Suchbegriff über alle seine Zeilen im
      Profil und Datei-Zeitraum, damit Kandidaten sichtbar werden, deren Käufe oder Klicks sich auf Targets verteilen.
- [x] Umsetzung:
  - **Engine** (`packages/engine/src/search-terms.ts`): `comparableSearchTerm` (Vergleichsform: klein, NFC, Leerraum
    zusammengefasst; dieselbe Funktion nutzt jetzt `@profitbash/db` für „schon exakt gebucht“) und
    `classifySearchTermsAcrossTargets(rows, rules)`: Zeilen desselben Begriffs summieren (Decimal), die Summe läuft durch
    `classifySearchTerm` mit denselben Regeln; `protected` und `alreadyTargeted` gelten, sobald eine Zeile sie meldet.
    Ergebnis je Begriff: Einstufung, Grund, `targets` (zählt **Zeilen**, nicht verschiedene Targets: zwei Schreibweisen auf
    einem Target oder eine SP- und eine SB-Zeile zählen doppelt), `onlyAcrossTargets` (Ernten bzw. Negieren, das keine
    Zeile allein erreicht), Summen. Die Einstufung der Zeile bleibt unverändert (Negativ-Vorschläge gehören in die
    Quellkampagne).
  - **API** (`POST /api/ads/search-terms/analysis`): je Zeile `termClassification`, `termReason`, `termTargets`,
    `termOnlyAcrossTargets`; in der Antwort `termCounts` (verschiedene Suchbegriffe je Einstufung) und
    `termCountsOnlyAcrossTargets` (`harvest`, `negate`). Gerechnet über alle Zeilen des Zeitraums vor dem Kürzen, im
    Ausschnitt der `adProducts`.
  - **Web:** Die Zelle „Einstufung“ zeigt eine zweite Zeile „Über alle Targets: Ernten (3 Zeilen)“, bei Beobachten mit
    Grund, nur wenn die Einstufung des Begriffs von der der Zeile abweicht. Der Text steckt im Wert der Spalte (Filter
    und Sortierung sehen ihn; das Grid zeichnet die Zelle nach einem Neuladen mit gleichen Zeilen-IDs neu). Kachel
    „Einstufung“: Zeile „Erst über alle Targets zusammen: n Suchbegriffe zum Ernten / zum Negieren“ als Filter
    (`class=harvest-across` bzw. `negate-across`). Texte unter `searchTerms.acrossTargets.*`.
  - Review (unabhängig): keine kritischen Befunde; Decimal-Rechnung, `onlyAcrossTargets`, Mandantentrennung, Rechnen vor
    dem Kürzen und XSS-Sicherheit der Zelle bestätigt. Übernommen: zweite Zeile im Spaltenwert (vorher blieb sie nach dem
    Ändern der Regeln veraltet stehen, mit AG Grid nachgestellt), Grund in der zweiten Zeile, „Zeilen“ statt „Targets“
    und Zahl über `formatNumber`, Tests für Negieren-Zeile mit Ernte-Begriff, leere Begriffe, Kürzung mit mehrzeiligem
    Begriff, Neuladen in beide Richtungen, Summenzeile, `view=ngrams` mit dem neuen Filter. Im vollen Lauf fiel ein neuer
    Test an der Reihenfolge bei gleichem Spend (zufällige Zeilen-ID): Prüfung nach Target geordnet.
  - **Bewusst so bzw. bekannte Grenzen:** Die drei Kacheln zählen Zeilen, die neue Zeile zählt Suchbegriffe (ein Klick
    zeigt deren Zeilen). Eine Zeile kann allein „Negieren“ sein, während der Begriff über alle Targets ein
    Ernte-Kandidat ist; beides wird gezeigt. Bei gekürzter Antwort (mehr als 10 000 Zeilen) kann der Filter weniger
    Zeilen zeigen, als der Zähler nennt (Kandidaten haben oft wenig Spend je Zeile). `termCounts` wird geliefert, aber
    noch nicht angezeigt; die Oberfläche sendet keine `adProducts`.
  - **Browser-Pane nachgeholt (2026-10-08, Demo-Daten, Profil SEK, Dunkel-Modus):** Die zweite Zeile „Über alle Targets:
    Negieren (3 Zeilen)“ steht bei 300 px Spaltenbreite vollständig in der Zelle (nichts abgeschnitten), der Filter „1
    Suchbegriff zum Negieren“ zeigt die drei Zeilen des Begriffs. Für 2b.2d: Knopf „Zeitraum löschen“ und Dialog mit
    Profil, Zeitraum und Zeilenzahl geprüft (nicht bestätigt, die Demo-Daten bleiben). Für 2b.2e: Der Sprung von der
    Kampagne landet im Explorer auf den Ad Groups der richtigen Kampagne, mit dem Client, dem Datei-Zeitraum als eigenem
    Zeitraum und „Entfernte anzeigen“; „CSV exportieren“ ist sichtbar. Nicht im Browser geprüft: der Download selbst und
    die Währung der Kennzahl-Spalten nach dem Sprung (die Spalten lagen im schmalen Fenster außerhalb des gezeichneten
    Bereichs); beides decken die Tests ab.

#### 2b.2g Regeln je Profil

**Entschieden (Dominik, 2026-10-08):** Abweichende Regeln gelten **je Profil** (ein Profil ist ein Client auf einem
Marktplatz; nicht je Client, je Marktplatz oder je Währung). **Alle vier Werte** lassen sich einzeln abweichend festlegen,
leer heißt „wie für alle Profile“. Gepflegt wird im **Regel-Dialog der Suchbegriff-Analyse** (Recht `write`, also Admins
und Editoren). „Zeitraum löschen“ (2b.2d) bleibt bei Org-Admins.

- [x] Abweichende Regeln je Profil speichern und in der Einstufung anwenden (Migration, Leseschicht, API).
- [x] Regel-Dialog mit Bereich „Nur für dieses Profil“; die Kachel „Regeln“ nennt die geltenden Regeln und die Abweichung.
- [x] Umsetzung:
  - **Shared** (`packages/shared/src/search-terms.ts`): `searchTermRuleOverridesSchema` (die vier Felder der Regeln, je
    Feld `null` erlaubt, gleiche Wertebereiche), `NO_SEARCH_TERM_RULE_OVERRIDES`, `resolveSearchTermRules(organisation,
    overrides)` (je Feld der Wert des Profils, sonst der der Organisation; `0` ist ein Wert).
  - **Schema** (Migration `0024_search_term_rule_overrides`): `search_term_rule_overrides` (eine Zeile je Profil:
    `profile_id` als Schlüssel, `organization_id`, die vier Werte leer erlaubt, `updated_by`, `updated_at`).
    Fremdschlüssel (Profil, Organisation) auf `amazon_ads_profiles` mit `on delete cascade`; Check: mindestens ein Wert
    (eine Zeile ohne Wert gibt es nicht).
  - **DB** (`packages/db/src/search-terms.ts`): `querySearchTermPeriod` liefert `ruleOverrides` des Profils mit;
    `saveSearchTermRuleOverrides` (nur sichtbare Profile über `visibleProfilesScope()`, sonst `null`; alle Felder `null`
    löscht die Zeile; Audit `search_term_rule_overrides.update` mit `before`/`after` in derselben Transaktion, nicht bei
    „nichts gespeichert und nichts abweichend“).
  - **API:** `PUT /api/ads/search-terms/rules/profile` (`profileId`, `overrides`; Recht `write` im Feature `sp-explorer`,
    nicht sichtbares Profil `404 PROFILE_NOT_FOUND`). `POST …/analysis` stuft nach den **geltenden** Regeln ein
    (`meta.rules`), dazu `meta.organizationRules` und `meta.ruleOverrides`; `meta.rulesAreDefault` sagt weiter nur, ob die
    Organisation noch die Startwerte hat. `GET`/`PUT …/rules` bleiben die Regeln der Organisation.
  - **Web** (`search-terms/RulesDialog.vue`): zwei Bereiche „Für alle Profile“ und „Nur für <Profil>“ mit je vier Feldern;
    die Felder des Profils sind leer oder tragen den abweichenden Wert, der Platzhalter zeigt den Wert für alle.
    „Abweichung zurücknehmen“ leert sie. Gesendet wird nur, was sich geändert hat (Regeln für alle, Abweichung des
    Profils oder beides nacheinander); ohne Änderung schließt der Dialog ohne Anfrage. Die Kachel „Regeln“ zeigt die
    geltenden Regeln des Profils und darunter „Eigene Werte für dieses Profil: … Für alle Profile gilt: …“.
  - **Browser-Pane (2026-10-08, Demo-Profil SE):** Dialog mit beiden Bereichen und Platzhaltern geprüft; Spend-Grenze
    200 SEK nur für das Profil gespeichert: „Negieren“ fiel von 312 auf 0 Zeilen, die Kachel nennt die Abweichung. Die
    Abweichung steht noch in der lokalen Dev-DB. Kein Screenshot des Dialogs (die Pane war zuletzt nicht eingeblendet).
  - Review (unabhängig): keine kritischen Befunde; Access-Layer, Rechte, Decimal-Rechnung, Audit, Migration und „geltende
    Regeln nur in der Einstufung“ bestätigt (CSV-Export und Spalten nutzen keine Regeln). Übernommen: Tests für das halb
    gelungene Speichern (Regeln für alle gespeichert, Abweichung scheitert: der zweite Versuch sendet nur noch die
    Abweichung, Abbrechen lädt neu); Felder und Knöpfe bleiben gesperrt, während gespeichert und neu geladen wird (kein
    zweites Absenden); der Hinweis zu den Startwerten heißt „Für alle Profile gelten noch die vorläufigen Startwerte“;
    „Eigene Werte für dieses Profil“ statt „weicht ab“ (ein eigener Wert kann dem für alle gleichen und folgt dessen
    Änderungen nicht); der Hinweis „leer heißt wie für alle“ hängt per `aria-describedby` an den Feldern des Profils.
    Bewusst so: „geändert“ vergleicht die Texte der Felder („20,00“ statt „20“ sendet erneut, mit Audit-Event ohne
    Unterschied); die Meldung bei ungültiger Eingabe nennt weder Bereich noch Feld; kein Test für das Mitlöschen der
    Abweichung mit dem Profil (Fremdschlüssel mit Cascade, Profile werden im Betrieb nicht gelöscht).
  - **Bewusst so bzw. bekannte Grenzen:** Abweichungen gibt es nur je Profil; wer denselben Wert für alle Profile eines
    Clients oder Marktplatzes will, trägt ihn je Profil ein. Eine Übersicht aller Abweichungen (z. B. bei Clients &
    Connections) gibt es nicht, man sieht sie beim jeweiligen Profil. Profile ohne Suchbegriffe erreicht der Dialog
    nicht (die Analyse braucht einen Datei-Zeitraum).

**Entschieden (Dominik, 2026-10-08): Themen ohne Berichte bleiben bis zum Ende offen.** 2b.3 bis 2b.6 (SQP-Import,
Organic-Indikator, Oberfläche „Organic (SQP)“, Kalibrierung) und der Impression-Share je Suchbegriff werden erst
entwickelt, wenn das übrige Projekt durch ist und die Berichte vorliegen (SQP-CSVs, „Suchbegriff-Impression-Share“). Phase 2b
ist damit bis auf diese Punkte abgeschlossen; weiter geht es mit Phase 3.

#### 2b.2d Suchbegriff-Zeitraum löschen, Untergrenze für von Hand angegebene Zeiträume
- [x] Ein Datei-Zeitraum der Suchbegriffe lässt sich löschen; von Hand angegebene Zeiträume dürfen höchstens 365 Tage
      zurückliegen (offener Punkt aus 2b.2c).
- [x] Umsetzung:
  - **Löschen, DB** (`packages/db/src/search-terms.ts`): `deleteSearchTermPeriod` prüft das Profil über
    `visibleProfilesScope()` und löscht in einer Transaktion alle Zeilen von Profil und exaktem Zeitraum (alle Ad-Typen),
    dazu Audit `search_term_period.delete` (Profil, Zeitraum, `deletedRows`). `null` bei nicht sichtbarem Profil; 0 Zeilen
    schreiben kein Audit-Event. Kampagnen, der Verlauf der Datei-Importe und andere Zeiträume bleiben.
  - **Löschen, API:** `POST /api/ads/search-terms/periods/delete` (`profileId`, `periodStart`, `periodEnd`) →
    `{ deletedRows }`; `404 PROFILE_NOT_FOUND`, `404 SEARCH_TERM_PERIOD_NOT_FOUND` (nur bei sichtbarem Profil erreichbar).
    **Nur Org-Admins** mit Feature `sp-explorer` (dieselbe Prüfung wie der Upload): Der Server behält die Datei nicht, ein
    gelöschter Zeitraum lässt sich nur durch erneutes Hochladen wiederherstellen, und hochladen dürfen nur Admins.
    Entscheidung der Session nach dem Review (2026-10-08), Dominik kann sie auf das Recht `write` zurückstellen.
  - **Löschen, Web:** Knopf „Zeitraum löschen“ neben der Zeitraum-Auswahl der Suchbegriff-Analyse (nur Admins), Dialog
    `search-terms/DeletePeriodDialog.vue` mit Profil, Zeitraum und Zeilenzahl; er sagt, was bleibt, dass die Datei bzw.
    die Dateien des Zeitraums erneut hochgeladen werden können und dass ein noch laufender Import den Zeitraum
    zurückbringt. Fehler im Dialog; nach dem Erfolg bleibt er gesperrt, bis die Zeiträume neu geladen sind, dann fällt
    die Auswahl auf den nächsten Zeitraum oder den Leerzustand.
  - **Untergrenze** (`packages/shared/src/file-imports.ts`): `BULK_PERIOD_MAX_AGE_DAYS` (365), `oldestBulkPeriodStart`,
    Befund `tooOld` in `bulkPeriodIssue` (erster Tag mehr als 365 Tage vor „heute“ in der Zeitzone des Profils, der
    Grenztag ist erlaubt; geprüft nach `tooLong`). Wie `future` prüft das die DB-Schicht (`INVALID_PERIOD`), der Dialog
    setzt `min` und meldet es bei den Feldern. Ein Zeitraum aus dem Dateinamen wird weiterhin nicht geprüft (alte
    Konsolen-Dateien laufen).
  - Review (unabhängig): keine kritischen Befunde; Mandantentrennung, Löschbedingung, Audit in derselben Transaktion und
    die Grenze (365 erlaubt, 366 abgelehnt, Schalttag) bestätigt. Übernommen: Löschen nur für Admins (vorher Recht
    `write`, der Dialog versprach Editoren ein erneutes Hochladen, das sie nicht dürfen), kein zweites Absenden während
    des Neuladens, „1 Zeile“, Text der Untergrenze nennt die Regel („Der erste Tag darf höchstens 365 Tage
    zurückliegen“), API-Grenztest ohne Tageswechsel-Risiko (genaue Grenze im DB-Test mit fester Uhr), Tests für
    unbekanntes Profil und verdrehten Zeitraum. Bestehende Tests mit festen September-2026-Zeiträumen bekamen eine feste
    Uhr bzw. Tage relativ zu heute (sonst wären sie ab 2027 „zu alt“).
  - **Bewusst so bzw. bekannte Grenzen:** keine Erfolgsmeldung nach dem Löschen (die App meldet Erfolge nirgends per
    Toast; die Auswahl springt sichtbar weiter). Die Sichtbarkeit wird vor der Transaktion geprüft (wie beim Lesen).
    Läuft gleichzeitig ein Import in denselben Zeitraum, kann das Löschen 0 Zeilen treffen (`404`) bzw. der Zeitraum
    danach wieder erscheinen; keine Sperre. Nach dem Löschen des letzten Zeitraums fällt der Fokus auf die Seite (der
    Knopf ist weg). Kein Test, dass Löschen und Audit-Event gemeinsam zurückrollen. Die Analyse kennzeichnet von Hand
    angegebene Zeiträume weiter nicht.
  - **Offen:** Blick in die Browser-Pane (Knopf neben der Auswahl, Dialog, Handy-Breite): in dieser Session war der
    Zugriff auf die Browser-Pane gesperrt.

#### 2b.2e CSV-Export und Sprung in den Explorer
- [x] CSV-Export für „Suchbegriffe“ und „Wortbausteine“; Kampagne und Ad Group einer Zeile verlinken in den Explorer.
- [x] Umsetzung (nur `apps/web`, keine API-Änderung):
  - **Geteilte Helfer** aus dem Explorer herausgelöst, Verhalten dort unverändert bis auf den Hinweis (unten):
    `grid/csv.ts` (`gridCsv`, `downloadCsv`, `fileNamePart`, `csvSafe`), `grid/keyboard.ts`
    (`activateCellControlOnEnter`), `filterLink` in `analytics/useAnalyticsFilters.ts`.
  - **Export:** Knopf „CSV exportieren“ neben dem Umschalter der Ansicht, gesperrt ohne Zeilen und bis das Grid bereit
    ist. Die Datei enthält, was das Grid zeigt (Einstufungs-Filter, Wortzahl, Spaltenfilter, Sortierung), in der
    Schreibweise des Explorers: Komma, BOM, Beträge und Zähler als Decimal-String mit Punkt, Spalte „Währung“, fehlende
    Werte leer, Texte gegen Formeln entschärft, ohne Summenzeile. Einstufung als Text wie im Grid, die Einstufung über
    alle Targets (2b.2f) in derselben Zelle („Beobachten · Zu wenig Daten; Über alle Targets: Ernten (2 Zeilen)“).
    Dateiname `profitbash-search-term-analysis-[<class>-]<konto>-<land>-<von>_<bis>.csv` bzw. `…-ngrams-…`. Bei
    gekürzter Antwort steht ein eigener Hinweis (`searchTerms.csvTruncatedNote`, `csvNgramsTruncatedNote`) als erste
    Zeile, als ein Feld in Anführungszeichen (gilt jetzt auch für den Hinweis des Explorers).
  - **Sprung:** `search-terms/explorer-link.ts` und `EntityLinkCell.vue` (RouterLink, Enter auf der Zelle, `title` mit
    dem vollen Namen). Kampagne → `/ads/explorer/ad-groups?campaign=…`, Ad Group → `/ads/explorer/targets?campaign=…
    &adGroup=…`, dazu Client (`clients=…` bzw. `nc=1`), der Datei-Zeitraum (`period=custom&from&to`) und `removed=1`.
    Fehlt die Entity im Profil (Datei war eine Teilmenge) oder hat sie keinen Namen, bleibt es reiner Text.
  - Review (unabhängig): keine kritischen Befunde; das Herauslösen der Helfer zeilenweise als verhaltensgleich bestätigt,
    ebenso Quoting und Formel-Schutz. Übernommen: Der Link nennt **keine einzelnen Profile** mehr (mit `pf=1` löste er
    sich in einem neuen Tab oder bei einem Kollegen auf deren gespeicherte Profil-Auswahl auf und konnte leer landen;
    Client plus Kampagne bzw. Ad Group legen die Daten fest), `removed=1` (der Explorer blendet entfernte Entities sonst
    aus, ein Sprung aus einem älteren Zeitraum landete leer), eigener Hinweis-Text in der Datei, `csvSafe` nach
    `grid/csv.ts`, kein Export vor dem Grid, Tests für Formeln in Namen, Sonderzeichen, Summenzeile ohne Link.
  - **Bewusst so bzw. bekannte Grenzen:** Die Filterleiste des Explorers zeigt nach dem Sprung den Client, nicht das
    einzelne Profil; mit Währung „auto“ und Profilen in verschiedenen Währungen kann der Explorer umgerechnete Beträge
    zeigen, die Analyse die Währung des Profils (nicht geprüft). „Entfernte anzeigen“ bleibt nach dem Sprung angehakt.
    Vergleich, Währung und Attribution des Links sind die Standardwerte des Explorers. Spaltenfilter ohne Treffer
    ergeben eine Datei nur mit Kopfzeile (wie im Explorer). Kontonamen ohne lateinische Zeichen fallen im Dateinamen
    weg. Datei-Zeiträume über 400 Tage (nur über umbenannte Dateien denkbar) nimmt der Explorer nicht an und zeigt
    seinen Standard-Zeitraum. Dass der Knopf vor „Grid bereit“ gesperrt ist, deckt nur der Test des Grids ab.
  - **Browser-Pane nachgeholt (2026-10-08 und 2026-10-09):** Knopf, Links und Sprung sind geklickt, der Download und die
    Währung nach dem Sprung geprüft; Ergebnis in `phase-3.md` („Nachprüfung im Browser“). Offen bleibt nur die Summenzeile
    in EUR bei Clients mit mehreren Währungen.

#### Später (nur mit Datei, am Ende des Projekts)
- [ ] Impression-Share/-Rang je Suchbegriff neben ACoS, falls der Konsolen-Bericht „Suchbegriff-Impression-Share“ vorliegt
      (eigene Datei-Art, optional).

### 2b.3 SQP-Import (`packages/db`, `apps/worker`)
> Zurückgestellt bis zum Ende des Projekts (Dominik, 2026-10-08): wartet auf echte SQP-CSVs. Gilt auch für 2b.4–2b.6.
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
