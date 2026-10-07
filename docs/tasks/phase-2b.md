# Phase 2b – Suchbegriffe & Organic

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap inkl. „Erweiterungen aus dem Ideen-Dokument“, §3 Navigation,
> §5 inkl. „Kennzahlen je Ad-Typ“), `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` (Abschnitte A, B, G; Antworten
> F-S1–F-S9), `docs/tasks/phase-1.md` (1.11 komplett: Datei-Import, Befunde, Umsetzungsnotizen), `docs/decisions/` (001–004),
> `design/DESIGN.md`.
>
> **Status: Entwurf (2026-10-07).** Entschieden mit dem Ideen-Dokument: F-S1 (nach 1.11, vor Phase 3), F-S2 (Key `organic`,
> Suchbegriffe unter `sp-explorer`), F-S3 (wenige Kunden, unregelmäßige Downloads), F-S4 (keine Rank-Tracker-Exporte, Kalibrierung
> optional), F-S5 (Suchbegriffe read-only hier, Aktionen in Phase 3). Offen: **F1–F3** unten, vor 2b.1 mit Dominik klären.
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
- **F2 – SQP-Ansicht.** Empfehlung: zuerst die **ASIN-Ansicht** (Woche), die Marken-Ansicht danach; Monat und Quartal nur, wenn du
  sie wirklich ziehst.
- **F3 – Schwellen zum Start.** Ohne eigene Kalibrierung (F-S4) braucht der Indikator Startwerte. Empfehlung: eigene, vorsichtig
  gewählte Startwerte je Organisation (vorläufig markiert), im UI änderbar; die US-Befunde nur als Orientierung, nicht übernommen.

## Aufgaben (Entwurf, nach den Antworten verfeinern)

### 2b.1 Suchbegriffe importieren
- [ ] Datei-Art für den Suchbegriff-Bericht (F1) im Datei-Import: Kopfzeilen über Aliasse (DE/EN), Zuordnung zu Target bzw. Ad
      Group und Kampagne über die IDs aus 1.11d, Upsert in `amazon_ads_search_term_daily_metrics`; Test mit nachgebauter Datei.

### 2b.2 Suchbegriff-Analyse (`packages/engine`, `apps/api`, `apps/web`)
- [ ] N-Gramme (1–3) über Suchbegriffe mit Spend, Sales, ACoS, CVR im gewählten Zeitraum; Grid im Explorer (`sp-explorer`).
- [ ] Einstufung je Suchbegriff mit editierbaren Regeln je Organisation: Harvest, Negieren, Beobachten; geschützte Begriffe je
      Client. Nur Anzeige, Aktionen in Phase 3 (Warenkorb).
- [ ] Impression-Share/-Rang je Suchbegriff neben ACoS, falls der Konsolen-Bericht „Suchbegriff-Impression-Share“ vorliegt
      (eigene Datei-Art, optional).

### 2b.3 SQP-Import (`packages/db`, `apps/worker`)
- [ ] Feature-Key `organic`, Navigationseintrag „Organic (SQP)“ (`/ads/organic`).
- [ ] Tabellen für SQP-Perioden (Client, Marktplatz, Ansicht, ASIN bzw. Marke, Periodentyp, Beginn/Ende in der Zeitzone des
      Marktplatzes, Quelle, Import) und Kennzahlen je Periode und Suchbegriff (Zählwerte gesamt und eigene, Preise `numeric` mit
      Währung); Upsert je (Periode, Suchbegriff); Zugriffe über den Access-Layer.
- [ ] Datei-Art `sqp` im Datei-Import, Kopfzeilen über Aliasse; Zuordnung der Datei zu Client und Marktplatz.

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
