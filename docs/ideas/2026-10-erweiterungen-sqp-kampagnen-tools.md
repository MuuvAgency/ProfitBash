# Erweiterungen: SQP-Organic-Indikator, Kampagnenaufbau, Tools, Wettbewerb

> **Status: Ideen-Entwurf (2026-10-02), nicht eingeplant.** Grundlage: SYNQ-Studie zu SQP und organischem Rang, SYNQ-Seiten
> „Pulsar“, „Free Tools“ und „Beta“ (Wettbewerber-App), Webinar-Folien „Mastering Sponsored Product Campaigns“ (A. Swade) und
> „How to Stop Burning Money on Amazon Ads“ (SYNQ × myrealprofit).
> Vor der Umsetzung gilt `CLAUDE.md`: **kein Scope vorziehen**, und nach „Eigenständigkeit“ werden Texte, Kataloge, Schwellen-
> Tabellen oder Code aus Drittprodukten **nicht 1:1 übernommen**. Die Zahlen unten sind Recherche-Befunde, keine Vorgaben;
> eigene Werte werden aus Muuv-Daten kalibriert. Die Fragen an Dominik (Abschnitt 6) erst klären, dann in `plan.md` bzw.
> eine Phasen-Datei übernehmen.

## 0. Kurzfassung

| Baustein | Nutzen für Muuv | Braucht Ads-API? | Vorschlag Phase |
|---|---|---|---|
| **A. SQP-Import und Organic-Indikator** | Organischen Rang je Suchbegriff und Woche schätzen, ohne Rank-Tracker; Branded-Kannibalisierung und Funnel-Lücken sehen | Nein (CSV aus Brand Analytics); später SP-API | Nach 1.11, als eigener Block vor oder neben Phase 3 (F-S1) |
| **B. Suchbegriffe: N-Gramme, Harvest/Negate/Beobachten** | Kern der täglichen Optimierung; Daten liegen schon in der Bulk-Datei (Suchbegriff-Blätter) | Nein | Lesen: nach 1.11; Aktionen über Warenkorb in Phase 3 |
| **C. Kampagnen-Setup nach Struktur-Katalog** | Bausteine + Presets je Use Case (Kontrolle, Funnel-Hub, Launch …), Graduation-Kanten, Bulk-Datei-Export | Nein (Bulk-Datei) | Phase 4 (wie geplant), Inhalte unten |
| **D. Gebots-Stack-Simulator** | Effektives Gebot aus Basis × Strategie × Placement × Audience × B2B | Nein | Phase 4 als Quick-Tool |
| **E. Leitplanken „kein Geld verbrennen“** | vCPM, Off-Amazon, B2B, Placements, Sponsored Prompts, Branded CPCs als Prüfungen | Teilweise | Warnungen in Phase 3/4, Checks in Phase 5 |
| **F. Optimizer-Leitplanken** | Grenzen je Woche, Gebotsboden, Glättung, Schattenmodus | Nein (Bulk-Weg) | Phase 5 |
| **G. Rechner (Target-ACoS, Deal, LTV …)** | Ziele je Client, Profit-Sicht | Teilweise SP-API | Phase 6/7 |

---

## A. SQP als Indikator für den organischen Rang

### A.1 Befund der Studie (SYNQ, US, 6 Marken, 61.098 Keyword-Wochen, 09/2025–07/2026)

- Tägliche Rank-Tracker-Daten wurden auf SQP-Wochen (So–Sa) verdichtet und gegen die SQP-Anteile gelegt.
- **Impression-Share ist der beste Proxy** (Spearman ρ ≈ −0,73 gepoolt, bis −0,85 je Marke). Click-Share trennt oben schärfer,
  Purchase-Share ist unterhalb von Rang ~15 fast immer 0 und taugt nur als Dominanz-Signal.
- Entscheidungsregeln mit ≥ 80 % Präzision (US-Werte):
  - Seite 1: Impression-Share ≥ ~0,5 % (deckt ~76 % der echten Seite-1-Wochen ab), die praktischste Regel.
  - Top 10: Impression-Share ≥ ~4,2 %.
  - Top 3: Impression-Share ≥ ~9,4 % oder Click-Share ≥ ~52 %.
  - Trennschärfe (AUC): Top 3 ≈ 0,83, Top 10 ≈ 0,80. Seite 1 je Marke 0,74–0,99; fokussierte Kataloge schneiden deutlich besser ab
    als breite Multi-Kategorie-Marken.
- **Grenzen, die das Produkt ehrlich zeigen muss:**
  1. **Wochenbewegungen erkennt SQP nicht verlässlich.** Bei Rangsprüngen ≥ 5 Plätze stimmt die Richtung nur in ~63 % der Fälle.
     → Bänder und mehrwöchige Trends anzeigen, keine Platz-Zahl und kein Wochen-Delta.
  2. **Anzeigen verfälschen die Anteile:** oben +15–40 %, tief unten 2–3×. Ad-Impressions abzuziehen hat die Schätzung
     *verschlechtert* (AUC 0,80 → 0,74). Besser: Woche als „Ads aktiv“ markieren und ein Band tiefer einstufen.
  3. **Personalisierung:** Ein Tracker-#1 auf einem großen Begriff zeigte in SQP nur ~0,4 % Click-Share. Der Scraper sieht eine
     andere Suchergebnisseite als die Masse der Käufer. SQP ist also nicht „schlechter“ als ein Tracker, nur anders.
  4. Fehlt ein Begriff in SQP, heißt das mit ~67 % Wahrscheinlichkeit „tiefer als Seite 1“, genauer geht es nicht.
  5. SQP liefert höchstens ~100 Suchbegriffe je ASIN und Woche, das sind aber 30–60× mehr Begriffe, als ein Tracker überwacht.
- Gegenprobe: 37 % der Wochen, die beim Tracker als „nicht gerankt“ galten, hatten > 1 % Impression-Share in SQP (Lücken des Trackers).

**Konsequenz für ProfitBash:** Die Schwellen sind US-Werte für fremde Kataloge. Für DE/EU und Muuv-Kunden **eigene
Kalibrierung** (A.4); die Schwellen gehören als konfigurierbare Daten in die DB, nicht als Konstanten in den Code.

### A.2 Datenzugang

| Weg | Was | Einschränkung |
|---|---|---|
| **CSV aus Seller Central** (Marken → Brand Analytics → Search Query Performance) | ASIN- oder Marken-Ansicht, Woche/Monat/Quartal | Download von Hand; passt zum Datei-Import-Muster aus 1.11 (Upload → `runJob` → Schreibschicht) |
| **SP-API** `GET_BRAND_ANALYTICS_SEARCH_QUERY_PERFORMANCE_REPORT` | Rolle „Brand Analytics“, nur Brand-Registry-Marken; `reportPeriod` WEEK/MONTH/QUARTER, ASIN-Liste leerzeichengetrennt bis 200 Zeichen (~18 ASINs je Anfrage) | Laut GitHub-Issue #5240 gilt eine Quote von ~20 Anfragen/Tag, die Amazon nicht je App erhöht; Data Kiosk wird als Ausweg diskutiert. Braucht SP-API (Phase 7). |

**Empfehlung:** erst CSV-Import (sofort nutzbar, kein API-Zugang nötig), API-Sync später mit `packages/amazon-sp`.
Gespeichert werden **Zählwerte** (Gesamt und ASIN/Marke), Anteile werden berechnet. So bleiben Summen über ASINs korrekt.

### A.3 Modell (Skizze, Namen nach `plan.md` §5)

- `sqp_periods`: Client, Marktplatz, Ansicht (`asin` | `brand`), ASIN bzw. Marke, Periodentyp (`week`/`month`/`quarter`),
  Beginn, Ende (Datum in der Zeitzone des Marktplatzes), Quelle (`file`/`sp_api`), Import-Job.
- `sqp_query_metrics`: je Periode und Suchbegriff Suchvolumen, Score, Impressions/Klicks/Warenkorb/Käufe **gesamt** und **eigene**,
  Median-Preise (`numeric` + Währung), Lieferarten-Spalten, soweit vorhanden. Upsert je (Periode, Suchbegriff).
- `organic_rank_calibration`: Band-Definitionen je Organisation (Default-Satz plus Overrides je Client/Marktplatz):
  Band (`top3`, `top10`, `page1`, `deeper`, `unknown`), Metrik, Schwelle, Gültig-ab.
- **Engine** (`packages/engine`, ohne I/O): `estimateOrganicBand({ impressionShare, clickShare, purchaseShare, adsActive }, calibration)`
  → `{ band, confidence, reasons[] }`. `adsActive` = in derselben Woche Spend > 0 auf denselben Suchbegriff (aus den
  Suchbegriff-Daten der Ads) → ein Band tiefer, Grund wird angezeigt.

### A.4 Tracker im UI (neuer Explorer-Bereich „Organic / SQP“)

- **Heatmap** Suchbegriff × Woche mit Band-Farbe, Suchvolumen als Spalte, Filter „nur Begriffe mit Ads“ / „ohne Ads“.
- **Trend nur mehrwöchig:** gleitend über 3–4 Wochen; Hinweis „Indikator, kein Rang“ fest im UI.
- **Benachrichtigungen (Phase 5):** erst, wenn ein Band **zwei Wochen in Folge** fällt bzw. steigt (gegen das Rauschen).
- **Funnel-Lücken:** Impression → Klick → Warenkorb → Kauf je Begriff; großer Abfall zwischen zwei Stufen = Hinweis auf
  Bild/Preis (Klick) oder Listing/Bewertungen (Kauf). Vergleich gegen Vorperiode.
- **Branded-Kannibalisierung:** eigener Markenbegriff mit hohem Purchase-Share (Beispiel aus den Folien: ~90 % Kaufanteil bei
  ~78 % Klickanteil) → hohe Branded-CPCs prüfen. In den Folien sank der Branded-CPC von ~3 $ auf ~1,7 $, ohne dass die Umsätze
  einbrachen. Kennzahl: Markenbegriffe mit Purchase-Share > X % und CPC-Trend; Vorschlag „Gebot testweise senken“.
- **Harvest-Kandidaten:** hohes Suchvolumen, niedriger Impression-Share, kein aktives Target → in die Suchbegriff-Liste (B).
- **Preis-Effekt:** In den Folien hob eine Preissenkung (~60 $ → ~48 $ für eine Woche) einen Begriff von Rang ~170 auf ~5–8;
  nach der Rücknahme fiel er zurück. → Später Preisverlauf (SP-API/Keepa) als Linie neben dem Band, damit Preis und PPC nicht
  verwechselt werden.

### A.5 Eigene Kalibrierung (optional, stark für Muuv)

Wenn für einen Client ein Rank-Tracker-Export vorliegt (z. B. Helium 10, DataDive): Import als `rank_observations`, Verdichtung
auf SQP-Wochen, Schwellen je Band mit Zielpräzision ≥ 80 % neu bestimmen und als Override speichern. Ergebnis: eine DE-Kalibrierung,
die SYNQ für den deutschen Markt nicht veröffentlicht hat.

---

## B. Suchbegriffe: N-Gramme und Harvest/Negate/Beobachten

Die Bulk-Datei enthält bereits „SP Bericht „Suchbegriff““ und „SB Bericht „Suchbegriff““ (`phase-1.md` 1.11, Befund). Die neuen
Konsolen-Berichte liefern sie auch täglich.

- **N-Gramm-Analyse** (1-, 2-, 3-Gramme über alle Suchbegriffe): Spend, Sales, ACoS, CVR je N-Gramm. Zeigt Wortbausteine, die
  Geld verbrennen („gebraucht“, „kinder“, Fremdmarken) oder tragen. Reine Engine-Funktion, hoher Nutzen bei wenig Aufwand.
- **Klassifizierung je Suchbegriff** mit editierbaren Regeln (passt zum bestehenden Regelwerk aus dem Sheets-Tool):
  - *Harvest:* Käufe ≥ N, ACoS ≤ Ziel, noch kein exaktes Target → Vorschlag „Exakt-Kampagne anlegen“ (Phase 4, Setup).
  - *Negieren:* Klicks ≥ N, 0 Käufe, Spend ≥ Grenze → Vorschlag „negativ exakt“ in Quellkampagne.
  - *Beobachten:* zu wenig Daten.
  - **Geschützte Begriffe** (Marke, Hero-Begriffe) bekommen nie einen Negativ-Vorschlag.
- Aktionen gehen **immer über den Warenkorb** (Phase 3) und bis zur API-Freigabe als Bulk-Datei raus (`phase-3.md` F2).

---

## C. Kampagnenaufbau (Input für Phase 4 „Kampagnen-Setup“)

### C.1 Strukturoptionen (Kampagne : Anzeige : Target, Ad Group immer 1, außer 5/6)

| # | Struktur | Einsatz | Kontrolle |
|---|---|---|---|
| 1 | Single Keyword/Target (1:1:1, SKC) | Standard, sobald ein Target genug Volumen hat und dauerhaft beworben wird (Swade: > 75 % seiner Kampagnen) | höchste |
| 2 | Multi-Keyword (1:1:n) | Low-Volume-Targets (< ~1 Conversion/Tag), Keyword-Tests | mittel; keine Placement-/B2B-/Audience-Steuerung je Target, Budget kann einzelne Keywords abwürgen |
| 3 | Multi-Ad (1:n:1) | Temporär: welches Kind performt auf dem Begriff besser? | Gebot pro Keyword gut, Zuordnung je ASIN schwammig, keine ASIN-Budgetkontrolle |
| 4 | Multi-Ad + Multi-Keyword (1:n:n) | Schnelle Tests | Auswertung und Gebote deutlich ungenauer |
| 5/6 | Multi-Ad-Group | Nicht verwenden | kaum Auswertung nach Placement, schwer steuerbar |

**Kontrollebenen:** Kampagne = Tagesbudget, Gebotsstrategie, Placement-, Audience-, B2B-Anpassung, Off-Amazon-Einstellung.
Anzeige = welches Produkt. Target = wo und zu welchem Basisgebot. **Ad Group = nur Struktur, keine Steuerung.**

### C.2 Referenzstruktur Hero-ASIN

- Überwiegend SKC mit **Exact**; **Broad nur auf Root-Terms**.
- Dazu **Kategorie- (CAT), Produkt-Targeting (PAT) und Auto** für Harvesting und Ausspielung zu niedrigen Geboten.
- Klare, maschinenlesbare Namen (Kampagnenübersicht = Auswertung). In ProfitBash: **eigenes, konfigurierbares Namensschema**
  (`plan.md` Phase 4), Bausteine aus dem Sheets-Tool weiterverwenden: Funnel `NB`/`BD`/`AC`/`CA`, Match `KW-EX`/`KW-PH` usw.
- **Graduation-Pfad** aus dem Sheets-Tool übernehmen: NB Auto → Breit → Exakt → SKE, BD graduiert nie. Phase 4 legt die
  Zielkampagne an, Phase 5 schlägt die Graduation automatisch vor.

### C.2a Gegencheck: vernetzter Funnel (Fox Performance, „Der Amazon PPC Funnel“, Funnel-Edition 2026)

**Aufbau dort:** Eine aktiv gemanagte **Auto-Kampagne als Discovery-Hub** speist drei Funnel. Gewinner werden nach rechts graduiert
(enger), Verlierer negiert.
- **A Keyword:** Auto → **Breit+ je Keyword-Cluster (statt Phrase)** → Exakt → Single-Keyword-Exakt → Skalierungs-Layer
  (AMC-Audiences „High interest/High purchase intent“, B2B-Modifier). SB Video und Header auf dieselben Exakt-Gewinner.
- **B Produkt/ASIN:** Kategorie (mit Refinements Preis/Sterne/Marke) → PAT → Single-ASIN-Kampagne; **PAT Expanded mit der eigenen ASIN
  als Seed**; SB Header/Video auf PDPs; **Page Shielding** auf eigene ASINs; **Conquesting-Liste** (Wettbewerber < 4 Sterne,
  < 10 Reviews, Komplementärprodukte, teurer als X €).
- **C Display:** SD-Kategorie → SD-PAT; **Retargeting Views und Käufe**, je eigene und Wettbewerber-ASINs; Look-Back-Fenster
  parallel testen (eigene 7–90 Tage, Wettbewerber bis 365 Tage), ausgerichtet am Wiederkauf-Intervall.
- **Prinzipien:** „Narrow → Broad“ (Auto, Breit, Kategorie, Retargeting tragen zunehmend mehr als SKC allein), Placement-Modifier
  1× im Monat je Format nachziehen, **Optimierungs-Takt 1× pro Woche**, **TACoS-first** (Break-even-TACoS = Marge vor Werbung).

**Abgleich mit Swade (SKC-lastig) und dem Muuv-Sheets-Tool:**

| Punkt | Swade | Fox | Muuv heute | Bewertung |
|---|---|---|---|---|
| Rolle der Auto-Kampagne | Harvesting, günstige Ausspielung | Hub **und** eigener Performer | NB-Startpunkt | Fox ergänzt: Auto aktiv managen (4 Match-Arten getrennt bieten/negieren) |
| Phrase | – | ersetzt durch Breit-Cluster | `KW-PH` vorhanden | Phrase **optional** je Preset, Default Breit-Cluster |
| SKC | > 75 % der Kampagnen | Endstufe für Top-Keywords | SKE als Endstufe | einig: SKC nur für Targets mit Volumen |
| Brand-Trennung | – | nur Page Shielding | **BD/NB** getrennt, BD graduiert nie | Muuv behalten, Fox fehlt die Trennung von Marken-Suchbegriffen |
| Produkt-Targeting | CAT/PAT ergänzend | eigener Funnel bis Single-ASIN + Conquesting | – | **übernehmen**, Lücke im Sheets-Tool |
| Display/Retargeting | – | eigener Funnel | – | übernehmen, aber **nur CPC**, nie vCPM (Abschnitt E) |
| B2B-Modifier | als Option | Skalierungs-Layer | – | nur mit Inkrementalitäts-Check (B2B-Beispiel in E: Spend +70 %, organischer B2B −50 %) |
| Takt | – | 1× pro Woche | 1× pro Woche (Stabilisierungsphase) | einig; passt zu den Wochen-Grenzen in F |

### C.2b Vorschlag: Struktur-Katalog mit Presets je Use Case („beide Wege“)

Statt einer festen Struktur baut Phase 4 einen **Katalog aus Bausteinen** mit **Graduation-Kanten**. Ein **Preset** wählt Bausteine
und Parameter aus und wird **je Client und je ASIN** gesetzt, sodass sich Strukturen in einem Konto mischen lassen.

- **Bausteine (Beispiele):** `AUTO` (4 Match-Arten, optional getrennt), `KW-BROAD-CLUSTER`, `KW-PHRASE`, `KW-EXACT` (multi),
  `KW-EXACT-SINGLE`, `BRAND-DEF` (eigene Marke), `CAT`, `PAT`, `PAT-EXPANDED-SELF`, `PAT-SINGLE-ASIN`, `PAT-CONQUEST`,
  `PAT-SHIELD` (eigene ASINs), `SB-HEADER-KW`, `SB-VIDEO-KW`, `SB-PAT`, `SD-CAT`, `SD-PAT`, `SD-RT-VIEWS`, `SD-RT-PURCHASE`.
  Je Baustein: Ad-Typ, Targeting, Struktur (1:1:1 / 1:1:n / 1:n:1), Gebotsstrategie, Placement-/Audience-/B2B-Defaults,
  Off-Amazon aus, Namensbaustein.
- **Graduation-Kanten** (Engine-Regeln, in Phase 5 automatisch vorgeschlagen): z. B. `AUTO → KW-BROAD-CLUSTER | KW-EXACT | PAT`,
  `KW-EXACT → KW-EXACT-SINGLE` (ab Mindestvolumen), `PAT → PAT-SINGLE-ASIN`, `KW-EXACT-SINGLE → SB-VIDEO-KW`. Beim Graduieren wird
  in der Quelle automatisch negiert. `BRAND-DEF` hat keine ausgehende Kante.
- **Presets (Start):**

| Preset | Use Case | Schwerpunkt |
|---|---|---|
| **Kontrolle** (Swade-Logik) | Hero-ASIN mit hohem Volumen, enges Ziel-ACoS | viel `KW-EXACT-SINGLE`, Broad nur Root-Terms, Auto/CAT/PAT als Zulieferer |
| **Funnel-Hub** (Fox-Logik) | Skalierung, breiter Katalog, wenig Zeit je ASIN | Auto-Hub, Breit-Cluster statt Phrase, PAT-Funnel, SD-Retargeting, Skalierungs-Layer |
| **Launch** | neue ASIN, Ranking-Ziel | Auto + Breit-Cluster + Exakt auf Haupt-Keywords mit TOS-Fokus, SQP-Band als Erfolgsmaß (A) |
| **Profit/Defend** | Bestandsprodukt, Marge knapp | `BRAND-DEF` mit gedeckeltem CPC (SQP-Check Branded), `PAT-SHIELD`, SD-RT-Purchase, Wachstums-Bausteine pausiert |
| **Verbrauchsgut** | Wiederkauf-Produkte | zusätzlich `SD-RT-PURCHASE` mit Look-Backs am Wiederkauf-Intervall |
| **Muuv-Standard** | Default | Hybrid: Funnel-Hub + BD/NB-Trennung + SKC ab Volumen-Schwelle |

- Presets sind **Daten** (eigener Katalog je Organisation, editierbar). Dominik pflegt sie, nichts ist hart codiert, und die
  Bezeichnungen sind eigene (Eigenständigkeit).
- **Wann ein Preset wechselt** (Vorschlag, Phase 5): Launch → Kontrolle oder Funnel-Hub, sobald das SQP-Band zwei Wochen
  Seite 1 hält; jeder Wechsel bleibt ein Vorschlag im Warenkorb, nie automatisch.

### C.3 Bulk-Erzeugung

Je neuer 1:1:1-Kampagne mindestens 4 Zeilen (Kampagne, Ad Group, Produktanzeige, Keyword/Target), mehr bei Anpassungen
(Placement-Zeilen) oder 1:n:n. Phase 4 erzeugt diese Zeilen aus Vorlage + Eingabe (ASIN, SKU, Portfolio, Keywords) und gibt sie
über denselben Bulk-Datei-Weg wie Phase 3 aus. **Achtung Locale:** Kopfzeilen und Werte in der Sprache des Kontos, Zustand-Werte
beim Upload aber englisch (`Paused`/`Enabled`, Fehler aus dem Sheets-Tool) → zentral in einer Mapping-Tabelle.

### C.4 Welches Kind bewerben?

Standard: Hero-SKU. Ausnahmen als Setup-Option je Keyword-Cluster: Abverkauf/knapper Bestand beim Hero, Begriffe mit Varianten-
bezug (z. B. „groß“ → großes Kind; in den Folien: niedrigere CTR, aber höchste CVR), laufende Promotion, Ranking-Velocity über ein
günstigeres Kind. Zielgröße vorher festlegen: ACoS, Gesamtprofit, organischer Rang oder Abverkauf.

---

## D. Gebots-Stack-Simulator (Quick-Tool, Phase 4)

- **Effektives Gebot** = Basisgebot × Gebotsstrategie × Placement-Anpassung × Audience-Anpassung × B2B-Anpassung. Laut Swade-Folien
  werden die Anpassungen multipliziert, die Reihenfolge ist egal. **Vor dem Bau gegen die aktuelle Amazon-Doku prüfen.**
- Anpassungen jeweils +0 bis +900 %, nach unten nur über Basisgebot und Strategie. „Dynamisch hoch und runter“: SP höchstens +100 % auf
  Top of Search, +50 % auf Produktseiten/Rest. „Nur senken“: bis −100 %. „Fest“: keine Anpassung durch Amazon.
- Ausgabe: Spanne (min/max) je Placement × Audience × B2B als Tabelle und gestapelter Balken, dazu der CPC-Bezug aus den echten
  Placement-Daten. Reine Engine-Funktion mit Tests.

---

## E. Leitplanken „kein Geld verbrennen“ (aus den Folien)

| Thema | Befund | Umsetzung in ProfitBash |
|---|---|---|
| **vCPM** (SD „Reichweite“, SB „Grow brand impression share“) | Views zählen in der Attribution mit, ACoS sieht besser aus; Klick-ACoS im Beispiel doppelt so hoch, selten inkrementell für kleine Marken | Setup blockt vCPM standardmäßig; Explorer zeigt **Klick-ACoS** neben ACoS (Klick-Anteil liegt schon vor, `plan.md` §5) |
| **Off-Amazon** | Spend klein, ACoS ~170 % in den Beispielen; begrenzbar nur je Kampagne in der Konsole, kein Bulk | Setup-Default „aus“; Check „Kampagnen mit Off-Amazon-Spend“ |
| **B2B-Modifier** | Beispiel: Ad-Spend +70 %, organischer B2B-Umsatz −50 %, B2B gesamt flach → Kannibalisierung | Check: B2B-Ad-Umsatz vs. organischer B2B-Umsatz (braucht Business-Report, Phase 7) |
| **Placements** | Produktseiten lassen sich nicht abschalten; mit „nur senken“ und 0 % trotzdem Impressions; TOS 600 % / ROS 400 % → ACoS > 100 % | Placement-Report importieren, Warnung bei Anpassungen > X % mit ACoS über Ziel |
| **Sponsored Prompts** | KI-Prompts laufen automatisch mit, teils ohne Käufe; nur in der Konsole abschaltbar (Prompts mit Klicks der letzten 65 Tage) | Checkliste/Hinweis je Kampagne, solange es keinen API-/Bulk-Weg gibt |
| **SB Reserved Share of Voice** | Festpreis über die Laufzeit (Beispiel ~45,8 Tsd. $) | Nur mit expliziter Freigabe, Kosten im Budget-Pacing (Phase 5) |
| **Branded CPCs** | siehe A.4 | SQP-gestützter Check |
| **Preis vs. PPC** | Preis wirkt auf jede Suche, PPC nur auf gekaufte Sichtbarkeit | Preis-Linie im Organic-Tracker (A.4) |

---

## F. Optimizer-Leitplanken (Input für Phase 5)

SYNQ „Pulsar“ arbeitet **constraint-basiert**: Obergrenze ACoS oder TACoS setzen, optimiert wird Umsatz, Stück oder Profit darunter.
Veröffentlichte Parameter (als Orientierung, eigene Werte festlegen):

- Gebot bewegt sich höchstens **35 % je Woche**, der „Regler“ höchstens 15 % je Woche (zum Vergleich: `phase-3.md` F6 warnt erst bei ±50 %).
- **Gebotsboden 60 % des realisierten CPC**, damit weiter Daten entstehen.
- Wert je Klick mit Prior von **20 Klicks** geschrumpft, Halbwertszeit **14 Tage**.
- Erhöhungen werden über **3 Tage danach vs. 3 Tage davor** bewertet.
- SB-Kampagnen bekommen Halo-Credit, auf Keywords verteilt nach Klick-Anteil.

**Vorschlag für ProfitBash:** das bestehende Regelwerk (erste passende Regel gewinnt, % oder absolute Beträge) bleibt die sichtbare
Logik. Darüber kommen harte Leitplanken (max. Änderung je Woche, Boden, Mindestdaten) und ein **Schattenmodus** je Client:
Optimizer rechnet und protokolliert Vorschläge, schreibt aber nicht. Nach 2–4 Wochen wird verglichen, dann wird er freigeschaltet.
Das passt zum Bulk-Datei-Weg und baut Vertrauen bei Kunden.

---

## G. Free Tools von SYNQ → Übernahme in ProfitBash

Logik wird jeweils selbst entworfen (Eigenständigkeit). Priorität: **hoch** = Daten liegen nach 1.11 vor, Nutzen täglich.

| SYNQ-Tool | Idee in ProfitBash | Daten | Phase | Prio |
|---|---|---|---|---|
| Search Term Analyzer | Harvest/Negate/Beobachten mit Regeln, geschützte Begriffe (B) | Suchbegriffe | 3 (Aktionen), Lesen früher | hoch |
| N-Gram Analysis | N-Gramme über Suchbegriffe (B) | Suchbegriffe | nach 1.11 | hoch |
| SQP Opportunity Analyzer | Funnel-Lücken, Periodenvergleich (A.4) | SQP | mit A | hoch |
| Bidding Simulator | Gebots-Stack (D) | Eingabe | 4 | mittel |
| Impression Share Analyzer | Impression-Share/Rang je Suchbegriff neben ACoS: „unterbelichtet + gut“ vs. „ausgereizt + schlecht“ | Konsolen-Bericht „Suchbegriff-Impression-Share“ (Datei-Import) | nach 1.11 | mittel |
| Target ACOS Calculator | Break-even-ACoS = Marge vor Werbung; Ziel-ACoS mit Bestand/Strategie → Ziele je Client | Marge (Eingabe), später COGS | 6 | mittel |
| Deal & Coupon Calculator | Deckungsbeitrag nach Rabatt, Gebühren, Retouren; nötiger Mehrabsatz | Eingabe, später SP-API | 7 | mittel |
| SKU Profit Analyzer | ist Phase 7 (P&L) | SP-API | 7 | – (geplant) |
| Multi-Channel Dashboard | Amazon + Google Ads (Muuv macht beides) | Google Ads API | später | niedrig |
| Forecasting, Reorder Planner | Absatzprognose, Bestand als Gebots-Leitplanke | SP-API | 7 | niedrig |
| ROI, Lifetime Value | Rechner | Eingabe | 7 | niedrig |
| Backend Keyword Cleaner | Listing-Thema, nicht Kern | – | – | nein |

---

## H. Wettbewerber: SYNQ-App (Closed Beta, Stand 2026-10-02)

| SYNQ-Modul | ProfitBash heute/geplant | Lücke |
|---|---|---|
| Pulsar (Bid-Engine SP/SB/SD unter ACoS/TACoS-Deckel) | Phase 5 Regeln + Optimizer | Leitplanken aus F übernehmen |
| Hourly Tracker (Sync alle 2 h, Tracker 30 min) | – (tägliche Reports) | braucht AMS/API; erst nach Freigabe |
| Harvester & Negator mit lesbaren Regeln | – | **B** |
| Search Query Performance | – | **A** |
| Market Intelligence (SoV, Konkurrenzpreise, Rang) | – | teilweise über A; Preise später (Keepa/SP-API) |
| Creative Hub (Listings, A+) | – | bewusst außerhalb des Scopes |
| Multi-Client-/Multi-Marktplatz-Reporting | Phase 2 fertig | – |
| Mandantentrennung, Rollen | ADR 002, Rollen fertig | – |
| Shadow Mode beim Onboarding | – | **F** (Schattenmodus) |
| Quellen: Ads, SP-API, Google Ads, Helium 10, Keepa, DataDive; 10+ Marktplätze | Ads (Mock), EZB | SP-API (Phase 7), Importe für Tracker-Exporte (A.5) |

SYNQ zielt auf Managed-Service-Kunden und Agenturen, die die Plattform lizenzieren. **Abgrenzung für ProfitBash:** DE/EU-first
(deutsche Bulk-Dateien und Werte, Mehrwährung mit EZB-Kursen), funktioniert **ohne Ads-API** über Datei-Import und Bulk-Rückweg,
eigene DE-Kalibrierung des Organic-Indikators, Profit-Sicht (Phase 7), Betriebskosten nahe 0.

---

## 6. Fragen an Dominik (mit Empfehlung)

- **F-S1 – Wo kommt SQP hin?** Empfehlung: als eigener Block **direkt nach 1.11** (Datei-Import ist dann gebaut, SQP-CSV nutzt
  denselben Weg) und **vor Phase 3**. Oder: Phase 3 zuerst, SQP danach. Oder: erst mit SP-API (Phase 7).
- **F-S2 – Neuer Feature-Key?** Empfehlung: `organic` (SQP-Tracker, Funnel, Branded-Check) als eigener Key, damit er separat
  buchbar ist. Suchbegriff-Analyse (B) unter `sp-explorer`.
- **F-S3 – Welche Kunden haben Brand Registry und Zugriff auf Brand Analytics?** Ohne Brand-Analytics-Zugriff kein SQP. Wie oft
  kannst du die CSVs ziehen (wöchentlich je Marktplatz)?
- **F-S4 – Gibt es Rank-Tracker-Exporte** (Helium 10, DataDive …) für mind. einen Kunden, um DE zu kalibrieren (A.5)?
- **F-S5 – Suchbegriffe lesen schon vor Phase 3?** Empfehlung: ja, N-Gramme und Klassifizierung read-only direkt nach 1.11.
  Aktionen (Negativ, Harvest) erst mit dem Warenkorb.
- **F-S6 – Optimizer-Grenzen:** Wöchentliche Maximaländerung (Vorschlag 30–35 %) und Gebotsboden (Vorschlag 60 % CPC) als
  Default je Organisation, überschreibbar je Client?
- **F-S7 – vCPM und Off-Amazon im Setup:** standardmäßig blocken (Empfehlung) oder nur warnen?
- **F-S8 – Struktur-Katalog (C.2b):** Presets je Client und ASIN (Empfehlung) oder nur je Client? Welche Presets zum Start
  (Empfehlung: Muuv-Standard, Kontrolle, Funnel-Hub; Launch, Profit/Defend und Verbrauchsgut danach)? Phrase weiter anbieten?
- **F-S9 – Conquesting-Kriterien** (Sterne, Reviews, Preis) brauchen Katalogdaten der Wettbewerber (Keepa/SP-API). Bis dahin:
  Conquesting-Liste von Hand pflegen (Empfehlung)?

## 7. Quellen

- SYNQ: SQP als Indikator für den organischen Rang – https://wearesynq.com/research/amazon-sqp-organic-rank
- SYNQ Pulsar – https://wearesynq.com/pulsar
- SYNQ Free Tools – https://wearesynq.com/free-tools
- SYNQ App (Beta) – https://wearesynq.com/beta
- Amazon SP-API, Brand-Analytics-Berichte – https://developer-docs.amazon/sp-api/docs/report-type-values-analytics
- GitHub-Issue zur SQP-Quote – https://github.com/amzn/selling-partner-api-models/issues/5240
- Folien (nicht im Repo, von Dominik): „Mastering Sponsored Product Campaigns on Amazon“ (A. Swade, Quartile),
  „How to Stop Burning Money On Amazon Ads“ (SYNQ × myrealprofit), „Der Amazon PPC Funnel“ (Fox Performance, Funnel-Edition 2026)

## 8. Prompt für die nächste Claude-Code-Session

```
Lies CLAUDE.md, docs/plan.md, docs/tasks/phase-1.md (1.11), docs/tasks/phase-3.md und
docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md.
Ziel dieser Session: die Ideen aus dem Ideen-Dokument in die Planung übernehmen, noch kein Code.
1. Stelle mir die Fragen F-S1 bis F-S9 gesammelt zu Beginn (mit deinen Empfehlungen).
2. Trage meine Antworten mit Datum ein und übernimm die Bausteine in docs/plan.md (Roadmap, Navigation,
   Feature-Keys) und als Aufgabenpunkte in die passende Phasen-Datei (ggf. neue Datei für den SQP-Block).
3. Halte Eigenständigkeit ein: keine Texte/Tabellen/Schwellen aus SYNQ 1:1, Schwellen als konfigurierbare Daten.
4. Kleiner Commit auf eigenem Branch, PR, dann Übergabe-Prompt für die Umsetzung.
```
