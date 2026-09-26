# Phase 1 – Daten

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§5 „Festlegungen für Phase 1 und später“), `docs/tasks/phase-0.md`
> (Umsetzungsnotizen 0.5–0.7), `docs/decisions/` (001 Stack, 002 Mandanten-Modell).
>
> **Status: Entwurf (2026-09-26), in Abstimmung mit Dominik.** Entscheidungen stehen als **F1–F12** unter
> „Fragen an Dominik“. Entschieden: F1, F2, F4, F6. Noch zu bestätigen: F3, F5, F7–F11 (je mit Empfehlung). Offen: F12.
> Aufgaben, die von einer Frage abhängen, verweisen darauf. 1.1 beginnt, sobald F3, F5, F7–F11 bestätigt sind.

## Ziel

Für jedes verbundene Profil liegen die Werbe-Entities und die täglichen Kennzahlen je Ebene in der Datenbank:
- Entity-Sync: Portfolios, Kampagnen, Ad Groups, Targets (Keywords, Produkt- und Auto-Targets), Negatives, Product Ads.
- Täglicher Report-Import je Ebene in `*_daily_metrics`, mit rollierendem Fenster und Upsert.
- Beträge exakt (`numeric` + Währung), Amazon-IDs als Text, Reports überstehen Neustarts.
- Phase 2 (Dashboard, Explorer) liest nur noch aus diesen Tabellen und muss am Import nichts umbauen.

## Definition of Done

- [ ] Mit dem Mock-Anbieter (`AMAZON_ADS_USE_MOCK=true`) füllt ein Sync alle Entity- und Metrik-Tabellen eines Profils;
      ein zweiter Lauf ändert nichts (idempotent), ein Lauf mit geänderten Mock-Daten aktualisiert per Upsert.
- [ ] Ein Neustart des Prozesses, während ein Report bei Amazon noch läuft, verliert nichts: Der nächste Lauf holt ihn ab.
- [ ] Beträge kommen ohne Umweg über `number` in die DB (Test mit Werten wie `0.1`, `1234567.89`, `0.005`).
      IDs größer als `Number.MAX_SAFE_INTEGER` kommen unverändert an.
- [ ] Neue Jobs laufen über `runJob`, schreiben `job_runs` mit Zählern, erscheinen im Sync-Status (i18n-Keys) und pingen Healthchecks.
- [ ] Jede neue Tabelle trägt `organization_id` und `profile_id`; die DB verhindert Verknüpfungen über Org-Grenzen (zusammengesetzte FKs).
- [ ] Connections speichern den Zeitpunkt der Einwilligung; die Connections-Seite zeigt, wann der Refresh-Token abläuft.
- [ ] ADR 003 (Decimal-Library) ist angenommen. ADR 004 (Amazon-API-Generation, F1) ist angenommen und nach dem ersten echten Lauf abgeglichen.
- [ ] Nach der Ads-API-Freigabe: ein echter Lauf gegen ein Profil der Agentur, Abweichungen zum Mock sind nachgezogen.
- [ ] `pnpm test`, `typecheck`, `lint`, `build` und beide Smoke-Tests grün, CI grün.

## Voraussetzungen

- [ ] **Ads-API-Freigabe** (Phase 0, 0.0b/0.0c). Phase 1 wird gegen Mocks gebaut; der echte Lauf (DoD) wartet auf die Freigabe.
- [ ] **Testkonto mit echten Kampagnen:** Für den echten Lauf ein Profil, das Dominik ohne Kundendaten-Risiko nutzen kann
      (eigenes Konto oder mit Einverständnis des Kunden). Ergebnisse und Logs enthalten keine Kundennamen (öffentliches Repo).
- Nicht nötig für Phase 1: Railway, R2, Healthchecks.io (bleiben Phase-0-Punkte). Ein Deploy vor Phase-1-Ende ist möglich, aber keine Bedingung.

## Stand der Amazon-Ads-API (geprüft am 2026-09-26)

Quelle: advertising.amazon.com/API/docs (Release Notes, Deprecations, Reporting-v3- und Reporting-v1-Guides). Beim Umsetzen jeder
Aufgabe die konkreten Endpunkte erneut gegen die Doku prüfen.

**Zwei API-Generationen laufen parallel:**

| Bereich | Bisher (produktspezifisch) | Neu (Amazon Ads API v1, `/adsApi/v1/...`) |
|---|---|---|
| Entities lesen | SP v3 (`POST /sp/campaigns/list` usw.), SB v4, SD; dazu die **Exports-API** (`POST /campaigns/export`, `/adGroups/export`, `/targets/export`, `/ads/export` → `GET /exports/{id}`, asynchron, gemeinsames Modell für SP/SB/SD, GA) | **Campaign Management API** (`POST /adsApi/v1/query/campaigns` usw.): GA seit 01.12.2025 für **SP, SB** (und DSP). **SD und Sponsored TV noch nicht** (angekündigt für „später“) |
| Reports | **Reporting v3** (`POST /reporting/reports` → `GET /reporting/reports/{id}` → gzip-JSON von S3), GA | **Reporting v1**: seit 11/2025 **open beta** (Betas-Bereich), keine Report-Typen mehr, kontoübergreifend, einheitliche Metriknamen |
| Abkündigung | SP v3, SB v4, Reporting v3 und Exports sind **nicht** abgekündigt. Abgekündigt: v1/v2-Snapshots (seit 2024), `/adsAccounts*` (Abschaltung 07/2027) | – |

**Reporting v3, relevant für uns:**
- Ablauf: Report anfordern → Status abfragen (`PENDING`/`PROCESSING`/`COMPLETED`/`FAILURE`), Erstellung **bis zu 3 Stunden** →
  Download über eine zeitlich begrenzte S3-URL (gzip, JSON).
- Identische Anfrage, solange die erste läuft: **425** (zu früh). Häufiges Abfragen: **429**. Rate-Limits sind dynamisch
  (lastabhängig, je Client und Region), Amazon veröffentlicht keine festen Werte → `Retry-After` und Backoff, kein fester Takt.
- `timeUnit: DAILY` mit Spalte `date`; höchstens **31 Tage** je Anfrage.
- **Aufbewahrung bei Amazon:** SP 95 Tage, SB 60 Tage, SD 65 Tage. Mehr Historie gibt es über v3 nicht (Reporting v1: Tageswerte 24 Monate,
  bis 120 Tage je Anfrage, aber Beta).
- Report-Typen je Ebene: SP `spCampaigns`, `spTargeting` (Keywords und Targets), `spAdvertisedProduct` (Product Ads), `spSearchTerm`;
  SB `sbCampaigns`, `sbAdGroup`, `sbTargeting`, `sbAds`; SD `sdCampaigns`, `sdAdGroup`, `sdTargeting`, `sdAdvertisedProduct`.
  Hinweis der Doku: SB-Reports in v3 sind noch „Preview“ (Kampagnen mit `isMultiAdGroupsEnabled=false` fehlen).
- Attribution: SP liefert 1/7/14/30-Tage-Spalten (`sales7d`, `purchases14d` …). Standard im Konsolen-Reporting: 7 Tage für Seller,
  14 Tage für Vendoren. SB/SD liefern ein Fenster (14 Tage) ohne Suffix.
- **Unklar, beim ersten echten Aufruf klären:** Die Doku nennt einen Header `Amazon-Ads-AccountId` als „erforderlich“ für Reports, die
  Beispielaufrufe kommen aber nur mit `Amazon-Advertising-API-Scope` (Profil-ID) aus. Falls nötig: welche Konto-ID (`adsAccountId` aus der
  Accounts-API vs. `accountInfo.id` aus `/v2/profiles`, heute in `amazon_ads_profiles.amazon_account_id`).

## Fragen an Dominik

Jede Frage mit Empfehlung. Antworten werden hier mit Datum eingetragen („Entschieden (Dominik, …)“).

- **F1 – API-Generation.** Welche Amazon-APIs nutzt Phase 1?
  - (a) **Empfehlung:** Entities über die **Exports-API** (ein asynchrones Muster für SP/SB/SD, gemeinsames Modell, GA, wenige Aufrufe),
    Portfolios über `POST /portfolios/list`, Kennzahlen über **Reporting v3** (GA). Beides hinter einer eigenen, schmalen Schnittstelle
    in `packages/amazon-ads`, damit ein Wechsel auf v1 später lokal bleibt. Als ADR 004 festhalten.
  - (b) Entities über die neue **Campaign Management API v1** (dieselbe API, die Phase 3 zum Schreiben nutzen könnte), Reports v3.
    Nachteil: SD fehlt dort noch.
  - (c) Alles v1 inkl. Reporting v1 (24 Monate Historie). Nachteil: Reporting v1 ist Beta, Brüche sind erlaubt.
  - (d) wie (a), dazu beim ersten Sync einmalig bis zu 24 Monate Historie über Reporting v1, getrennt markiert (`source`), nie mit v3-Werten vermischt.
  **Entschieden (Dominik, 2026-09-26): (a) „erstmal“.** Festgehalten in `docs/decisions/004-amazon-ads-api-generation.md`.
  (d) ist die Wiedervorlage, sobald Reporting v1 GA ist oder ältere Historie gebraucht wird (dann als eigene Aufgabe).
- **F2 – Ad-Typen.** Welche Anzeigentypen zuerst? Empfehlung: **SP vollständig** (alle Ebenen) als Kern von Phase 1; **SB und SD** als
  eigene, spätere Aufgaben in Phase 1 (1.9), sofern Kunden sie nutzen. Frage: Welche Typen laufen bei den betreuten Kunden heute
  (grob: Anteil Spend SP/SB/SD)? Sponsored TV und DSP bleiben draußen.
  **Entschieden (Dominik, 2026-09-26): SP zuerst vollständig, SB und SD danach in Phase 1 (1.9).**
- **F3 – Rollierendes Fenster.** Wie viele Tage lädt der tägliche Import neu? Empfehlung: **30 Tage** (passt in eine Anfrage mit
  max. 31 Tagen, deckt das 14-Tage-Attributionsfenster mit Reserve ab; mehr Tage kosten keine zusätzliche Anfrage).
- **F4 – Historie beim ersten Sync.** Wie weit zurück beim ersten Import eines Profils? Empfehlung: **so weit v3 erlaubt**
  (SP 95, SB 60, SD 65 Tage, in 31-Tage-Stücken). Mehr Historie ginge nur über Reporting v1 (Beta) oder Bulk-Downloads aus der Konsole
  (nicht geplant).
  **Entschieden (Dominik, 2026-09-26): Maximum, das v3 erlaubt.**
- **F5 – Aufbewahrung.** Wie lange bleiben Tageskennzahlen in unserer DB? Empfehlung: **unbegrenzt** (Pilot-Volumen klein,
  Amazon selbst hält nur 60–95 Tage vor, also ist unsere DB die einzige Historie). Wiedervorlage bei Stufe C. Report-Anfragen
  (`amazon_ads_report_requests`) nach 30 Tagen löschen. Heruntergeladene Rohdateien werden nicht gespeichert.
- **F6 – Report-Ebenen.** Plan: Kampagne, Ad Group, Target, Product Ad. Zusätzlich **Suchbegriffe** (`spSearchTerm`) und
  **Placements** (`spCampaigns` mit `campaignPlacement`)? Empfehlung: Suchbegriffe **ja** (Grundlage für Negatives und Regeln in
  Phase 3/5, und Amazon hält sie nur 95 Tage vor: was wir nicht sammeln, fehlt später), Placements **nein** (erst mit Bedarf).
  **Entschieden (Dominik, 2026-09-26): Suchbegriffe ja, Placements erst bei Bedarf.**
- **F7 – Attributionsfenster.** Welche SP-Spalten speichern? Empfehlung: Umsatz, Bestellungen und Einheiten für **7 und 14 Tage**,
  jeweils gesamt und „same SKU“. 1 und 30 Tage nicht (auf Nachfrage per jsonb nachrüstbar, siehe 1.5).
- **F8 – Wechselkurse.** Plan §5: Tageskurse (z. B. EZB) in einer eigenen Tabelle. Empfehlung: **erst in Phase 2** mit dem ersten
  Verbraucher (Dashboard-Summen in EUR). Phase 1 speichert nur Originalwährung + Währungscode.
- **F9 – Zeitplan.** Empfehlung: Entity-Sync und Report-Anforderung täglich **06:00 Europe/Berlin** (nach dem Profil-Sync um 05:00),
  „Gestern“ jeweils in der Zeitzone des Profils. Zusätzlich manuell über „Jetzt synchronisieren“ (Profile → Entities → Reports).
- **F10 – Archivierte Entities.** Empfehlung: **mit** synchronisieren (Kennzahlen der Vergangenheit verweisen auf sie; im Explorer
  später per Filter ausgeblendet).
- **F11 – Sichtbares in Phase 1.** Empfehlung: keine Datenansichten (Explorer/Dashboard = Phase 2). Nur Sync-Status (neue Jobs,
  Zähler), auf der Connections-Seite der Ablauf der Einwilligung und je Profil „Daten bis“ (letzter importierter Tag).
- **F12 – Antragsweg Ads-API.** Der Übergabe-Prompt beschreibt den Weg „als Partner im Amazon Ads Partner Network → Request API Access“.
  In einer früheren Session hieß es, das Partner Network nehme nur juristische Personen (Muuv ist Einzelunternehmen). Welcher Weg gilt?
  (Betrifft nur die Doku in `phase-0.md` 0.0b/0.0c, nicht den Code.)
  **Stand (Dominik, 2026-09-26): noch offen, wird erst geklärt.** Bis dahin bleibt `phase-0.md` 0.0c unverändert.

## Aufgaben

### 1.1 Geld und Dezimalzahlen (`packages/shared`, `packages/amazon-ads`)
- [ ] **ADR 003 – Decimal-Library.** Vorschlag `decimal.js` (MIT, verbreitet, ohne Abhängigkeiten, beliebige Genauigkeit, Rundungsmodi).
      Alternativen im ADR abwägen: `big.js` (kleiner, weniger Funktionen), `dinero.js` (Geld-Objekte, bringt eigene Währungslogik mit,
      für unsere Decimal-Strings mehr als nötig). Entscheidung mit Dominik. Nur Server und `packages/engine`; das Web bekommt Decimal-Strings
      und formatiert sie (Formatierungs-Helper in `@profitbash/shared` auf Strings erweitern, nicht auf `number`).
- [ ] `parseJsonLossless(text, { decimals: 'string' })`: Dezimalzahlen (und Zahlen in Exponentialschreibweise) kommen als **Quelltext-String**,
      nicht über `String(number)`. Standard bleibt wie heute (Profile, Tokens). Tests: `0.1`, `1234567.89`, `1e-7`, `-0.00`, sehr lange Nachkommastellen.
- [ ] zod-Bausteine in `packages/amazon-ads`: `amazonDecimalSchema` (String oder sichere Zahl → normalisierter Decimal-String),
      `currencyCodeSchema` (ISO 4217, drei Großbuchstaben). Unbekannte Währungen durchreichen und loggen, nicht verwerfen.
- [ ] Konvention für die DB festhalten (in dieser Datei unter „Umsetzung“): Beträge `numeric(20, 6)` (Amazon liefert Gebote/CPC teils mit
      mehr als 2 Nachkommastellen), Zähler (`impressions`, `clicks`) `bigint`, Währung immer als eigene Spalte `currency_code`.
      Drizzle liefert `numeric` als String (`mode: 'string'`), nie als `number`.

### 1.2 Einwilligungszeitpunkt je Connection
- [ ] Migration: `connections.consented_at` (timestamptz, nullable für Bestandsdaten). Der OAuth-Callback setzt ihn bei Anlage **und**
      bei jedem Neu-Verbinden auf `now()` (jede Einwilligung startet die 365 Tage neu). Audit-Events `connection.create`/`reconnect` enthalten ihn.
- [ ] `refreshTokenExpiresAt = consented_at + 365 Tage` als abgeleiteter Wert in der API (`GET /api/connections`), nicht gespeichert.
      Hinweis: Die Regel gilt für Tokens ab 30.07.2026; ältere Connections ohne `consented_at` zeigen „unbekannt“.
- [ ] Connections-Seite: „Einwilligung läuft ab am …“, ab 30 Tagen vorher als Warnung. Benachrichtigungen erst Phase 5.
- [ ] Tests: Anlage und Neu-Verbinden setzen den Zeitpunkt; Mock-Callback ebenso.

### 1.3 Anfrage-Budget und Nebenläufigkeit
- [ ] Bestehend: Jobs je Connection laufen nacheinander (`singletonKey` = Connection-ID). Das bleibt für die neuen Queues.
- [ ] **Anfrage-Budget je Profil** im Amazon-Client: einfacher Token-Bucket je (Connection, Profil) im Prozess (Standard z. B. 2 Anfragen/s,
      konfigurierbar). Bei 429 halbiert sich die Rate bis zum nächsten Erfolg (AIMD); `Retry-After` hat Vorrang (besteht schon in `request()`).
      Kein verteiltes Budget: Mit `WORKER_MODE=inline` gibt es einen Prozess; bei `separate` laufen die Jobs nur im Worker.
- [ ] Zähler je Lauf in `job_runs.counters`: `requests`, `throttled` (429), `retries`. Damit lässt sich das Budget später anhand echter Werte einstellen.
- [ ] Offen nach dem ersten echten Lauf: Standardrate an beobachtete 429-Quoten anpassen.

### 1.4 Asynchrone Amazon-Aufträge mit Zustand in der DB
Gemeinsamer Baustein für Exports (Entities) und Reports, damit Neustarts nichts verlieren.
- [ ] Tabelle `amazon_ads_report_requests` (Name gilt auch für Exports, Spalte `kind`):
  - `organization_id`, `profile_id`, `kind` (`report` | `export`), `ad_product` (`SPONSORED_PRODUCTS` …), `report_type` (z. B. `spCampaigns`,
    bei Exports `campaigns`/`adGroups`/`targets`/`ads`), `start_date`, `end_date` (nur Reports), `amazon_request_id` (Text),
    `status` (`requested` | `processing` | `downloading` | `imported` | `failed`), `attempts`, `next_poll_at`, `requested_at`,
    `completed_at`, `imported_at`, `failure_reason` (gekürzt, ohne URLs), `row_count`
  - Die Download-URL wird **nicht** gespeichert (signiert, läuft ab); sie wird beim Abholen frisch per Status-Abfrage gelesen.
  - unique (`profile_id`, `kind`, `report_type`, `start_date`, `end_date`) für offene Aufträge (partieller Index auf nicht abgeschlossene):
    kein doppelter Auftrag, auch nicht nach Neustart. 425 von Amazon → vorhandenen Auftrag weiterverwenden.
- [ ] Job `amazon-requests-poll` je Connection: fragt fällige Aufträge ab (`next_poll_at <= now()`), Backoff 1 → 2 → 5 → 10 → 15 Min.
      (Deckel 15 Min.), plant sich selbst mit `startAfter` neu ein, solange Aufträge offen sind. Abbruch nach 4 h (`failed`, Zähler).
- [ ] Download: gestreamt (gzip → JSON), Größe gedeckelt (z. B. 200 MB entpackt, sonst `failed` mit Hinweis), Parsen mit
      `parseJsonLossless({ decimals: 'string' })`, zod-Validierung je Zeile. Ungültige Zeilen zählen und loggen (ohne Werte), nicht den ganzen Import verwerfen.
- [ ] Import je Auftrag in **einer** Transaktion (Upsert), danach `imported`. Scheitert der Import, bleibt der Auftrag `downloading` und wird
      beim nächsten Lauf erneut geladen, solange Amazon die Datei noch liefert, sonst neu angefordert.
- [ ] Wartung: `job-runs-cleanup` löscht abgeschlossene Aufträge älter als 30 Tage (F5).
- [ ] Tests: Neustart zwischen Anforderung und Abholung, 425, 429 beim Status, `FAILURE` von Amazon, abgelaufene URL, kaputte Zeile.

### 1.5 Schema für Entities und Kennzahlen (`packages/db`)
Allgemeine Regeln für alle Tabellen dieser Aufgabe:
- `id` (uuid), `organization_id`, `profile_id`; zusammengesetzter FK (`profile_id`, `organization_id`) → `amazon_ads_profiles`
  (dafür unique (`id`, `organization_id`) an `amazon_ads_profiles` ergänzen, wie bei Clients/Connections).
- Amazon-IDs als Text (`amazon_campaign_id` …), unique (`profile_id`, `amazon_…_id`).
- `ad_product` (Text: `SPONSORED_PRODUCTS` | `SPONSORED_BRANDS` | `SPONSORED_DISPLAY`), `state` als Text (neue Amazon-Werte brechen nichts).
- Interne FKs zur Elternebene (`campaign_id`, `ad_group_id`), jeweils zusammengesetzt mit `organization_id`.
- `extra` (jsonb): produktspezifische Felder, die (noch) keine eigene Spalte haben. Nie Beträge, die wir rechnen (die bekommen Spalten).
- `amazon_updated_at` (falls geliefert), `synced_at`, `removed_at` (Amazon liefert die Entity nicht mehr; wie bei Profilen umkehrbar, nie löschen).

Entities:
- [ ] `amazon_ads_portfolios`: Name, Status, Budget (`budget_amount`, `budget_currency_code`, Budget-Typ, Zeitraum), `in_budget`.
- [ ] `amazon_ads_campaigns`: `portfolio_id` (nullable), Name, Status, Targeting-Typ (manuell/auto), Budget (Betrag, Währung, Typ),
      Gebotsstrategie, Start-/Enddatum, Platzierungs-Anpassungen in `extra`.
- [ ] `amazon_ads_ad_groups`: `campaign_id`, Name, Status, Standardgebot (`default_bid`, Währung).
- [ ] `amazon_ads_targets`: `campaign_id`, `ad_group_id` (nullable bei SB-Kampagnen-Targets), Art (`keyword` | `product` | `category` |
      `auto` | `audience`), Ausdruck (Keyword-Text + Match-Typ bzw. Target-Ausdruck als jsonb), Status, Gebot.
- [ ] `amazon_ads_negative_targets`: Ebene (`campaign` | `ad_group`), `campaign_id`, `ad_group_id` (nullable), Art, Ausdruck, Match-Typ, Status.
      Eigene Tabelle, weil Negatives kein Gebot und keine Kennzahlen haben.
- [ ] `amazon_ads_product_ads`: `campaign_id`, `ad_group_id`, ASIN, SKU (nullable, Vendoren haben keine), Status.

Kennzahlen (je Tag, Datum in der Zeitzone des Profils, so liefert Amazon es):
- [ ] `amazon_ads_campaign_daily_metrics`, `amazon_ads_ad_group_daily_metrics`, `amazon_ads_target_daily_metrics`,
      `amazon_ads_product_ad_daily_metrics`, `amazon_ads_search_term_daily_metrics` (F6; Schlüssel zusätzlich Suchbegriff-Text, bezogen auf das Target).
- [ ] Gemeinsame Spalten: `organization_id`, `profile_id`, FK auf die Entity, `date`, `ad_product`, `currency_code`, `impressions`, `clicks`,
      `cost`, dazu Attribution nach F7 (`sales_7d`, `sales_14d`, `purchases_7d`, `purchases_14d`, `units_7d`, `units_14d`, `…_same_sku_…`),
      `extra` (jsonb) für weitere Spalten, `imported_at`.
- [ ] Schlüssel (`profile_id`, `date`, Entity-FK) als Primär- bzw. Unique-Schlüssel für den Upsert; Index (`profile_id`, `date`).
- [ ] Taucht in einem Report eine Entity auf, die der Entity-Sync (noch) nicht kennt (z. B. gerade angelegt oder schon entfernt), legt der
      Import einen **Platzhalter** mit Amazon-ID und `removed_at = null`, `synced_at = null` an; der nächste Entity-Sync füllt ihn.
      So geht keine Kennzahl verloren und der FK bleibt hart.
- [ ] Nullzeilen: Amazon liefert nur Tage mit Aktivität. Tage ohne Zeile im Report bedeuten 0; innerhalb des neu geladenen Fensters werden
      Zeilen, die Amazon nicht mehr liefert, gelöscht (sonst blieben korrigierte Werte stehen). Test dafür.
- [ ] Keine Partitionierung im Pilot (Volumen je Profil und Tag: einige Tausend Zeilen). Wiedervorlage bei Stufe C.
- [ ] Systemzugriffe (Upserts, Platzhalter) in `packages/db/src/system-access.ts` bzw. einer neuen Datei daneben. Nutzerseitige Lesezugriffe
      gibt es in Phase 1 nicht (außer „Daten bis“ je Profil, 1.8, über `visibleProfilesScope`); der Access-Layer bekommt dafür keine neuen Regeln.

### 1.6 Amazon-Client: Entities und Reports (`packages/amazon-ads`)
Endpunkte nach F1 (a), siehe ADR 004.
- [ ] Exports: `requestExport(profile, 'campaigns' | 'adGroups' | 'targets' | 'ads', { adProducts, states })`, `getExport(id)`,
      `downloadExport(url)`. Content-Types laut Doku (`application/vnd.campaignsexport.v1+json` usw., beim Umsetzen prüfen).
- [ ] Portfolios: `listPortfolios(profile)` mit Paginierung.
- [ ] Reports: `requestReport(profile, { reportTypeId, adProduct, groupBy, columns, startDate, endDate })`, `getReport(id)`,
      `downloadReport(url)`. 425 als eigener Fehler mit Hinweis „läuft bereits“.
- [ ] Normalisierung in ein eigenes Modell (`AmazonAdsCampaign` …) mit zod; IDs und Beträge als Strings. Unbekannte Enum-Werte durchreichen und loggen.
- [ ] Download-Hosts: S3-URLs aus Amazon-Antworten nur per `https` und **ohne** Authorization-Header abrufen (Tokens gehen nie an fremde Hosts,
      Regel aus 0.5). Erlaubte Host-Muster als Konstante.
- [ ] Mock-Anbieter erweitern: Entities für die Test-Profile (inkl. großer IDs, Beträge mit vielen Nachkommastellen, archivierter Kampagne,
      Negatives auf beiden Ebenen, Vendor-Profil ohne SKU), Reports als gzip-JSON mit simulierter Verarbeitungszeit, 425 und `FAILURE` auf Wunsch.
- [ ] Tests mit msw für jeden Endpunkt (Paginierung, 429, 425, Validierungsfehler, verlustfreie Zahlen).

### 1.7 Jobs (`apps/worker`)
- [ ] `entities-sync` je Connection: für jedes aktive, nicht entfernte Profil Exports anfordern (über 1.4) und Portfolios lesen;
      das Abholen übernimmt `amazon-requests-poll`. Import in Hierarchie-Reihenfolge (Portfolios → Kampagnen → Ad Groups → Targets,
      Negatives, Product Ads). Entities, die ein vollständiger Export nicht mehr enthält, bekommen `removed_at`.
      Zähler: `profiles`, `created`, `updated`, `removed`, `placeholders`.
- [ ] `reports-sync` je Connection: je Profil, Ad-Typ (F2) und Ebene (F6) einen Report über das rollierende Fenster (F3) anfordern;
      beim ersten Lauf eines Profils zusätzlich die Historie (F4) in 31-Tage-Stücken. Zähler: `requested`, `reused` (425), `imported`, `rows`.
- [ ] `amazon-requests-poll` je Connection (siehe 1.4).
- [ ] Cron-Auslöser `entities-sync-all` und `reports-sync-all` (F9), wie `profiles-sync-all` nur für aktive Connections.
      „Jetzt synchronisieren“ plant Profile, Entities und Reports nacheinander ein (Kette über das Ende des vorigen Jobs, nicht über Zeitabstände).
- [ ] Queue-Optionen: `expireInSeconds` für Import-Jobs anheben (große Profile), bestehende Queues über `boss.updateQueue` (siehe `createQueues`).
- [ ] Neue Namen in `CONNECTION_JOB_NAMES`, i18n-Keys `sync.job.*` und `sync.counter.*`, Reihenfolge in `COUNTER_ORDER`.
- [ ] Healthchecks: `HEALTHCHECKS_ENTITIES_SYNC_URL`, `HEALTHCHECKS_REPORTS_SYNC_URL` (optional, https), in `.env.example` und `docs/deploy.md`.
- [ ] `reauth_required`-Connections und ausgeblendete Profile: Connections ohne gültigen Token überspringen. Ausgeblendete Profile trotzdem
      synchronisieren? → Empfehlung ja (Ausblenden ist Darstellung, keine Datenentscheidung); entfernte Profile nicht.

### 1.8 Sichtbares (`apps/api`, `apps/web`)
Nach F11.
- [ ] Sync-Status zeigt die neuen Jobs und Zähler.
- [ ] Connections-Seite: Ablauf der Einwilligung (1.2); Profiltabelle mit Spalte „Daten bis“ (letzter importierter Tag, `max(date)` der
      Kampagnen-Kennzahlen) über einen Endpunkt, der die Profile über `visibleProfilesScope` begrenzt.
- [ ] Optional aus dem Review-Backlog: Sync-Status „läuft seit“ für laufende Jobs (passt, weil Import-Jobs länger laufen).

### 1.9 Weitere Ad-Typen (nach F2)
- [ ] SB: Entities (Exports decken SB ab) und Reports (`sbCampaigns`, `sbAdGroup`, `sbTargeting`, `sbAds`); Hinweis auf die v3-Preview-Lücke
      (SB-Kampagnen ohne Multi-Ad-Group fehlen) in der UI-Doku von Phase 2 vermerken.
- [ ] SD: Entities und Reports (`sdCampaigns`, `sdAdGroup`, `sdTargeting`, `sdAdvertisedProduct`); SD-Metriken sind klick- **und**
      view-basiert, Spalten entsprechend (`extra` oder eigene Spalten, beim Umsetzen entscheiden).

### 1.10 Erster echter Lauf (nach der Freigabe)
- [ ] Ein Profil mit echten Kampagnen synchronisieren, Zählwerte gegen die Amazon-Konsole abgleichen (Stichprobe: Kosten und Klicks einer
      Kampagne an drei Tagen). Abweichungen und Überraschungen (Header `Amazon-Ads-AccountId`, Content-Types, Laufzeiten, 429-Quote) hier festhalten.
- [ ] Keine Kundennamen, IDs oder Werte in Commits, Tests oder Actions-Logs.

## `.env.example`

Neu in Phase 1 (Vorschlag): `HEALTHCHECKS_ENTITIES_SYNC_URL`, `HEALTHCHECKS_REPORTS_SYNC_URL` (1.7), optional `AMAZON_ADS_REQUESTS_PER_SECOND` (1.3).

## Bewusst nicht in Phase 1

- Keine Datenansichten: kein Explorer, kein Dashboard, keine Charts (Phase 2)
- Keine Wechselkurse und keine EUR-Summen (Phase 2, siehe F8)
- Keine Writes an Amazon, keine Gebots- oder Budgetänderungen (Phase 3)
- Kein Amazon Marketing Stream, keine stündlichen Daten (Dayparting ist Phase 5; Stream bräuchte eine eigene AWS-Infrastruktur)
- Keine Benachrichtigung zum Token-Ablauf (Phase 5), nur die Anzeige
- Kein Sponsored TV, kein DSP, keine SP-API-Daten (Phase 7)
- Keine Profil-Freigaben oder Kundenzugänge (Phase 6); neue Tabellen folgen ADR 002 ohne Vorgriff darauf

## Reihenfolge für Claude Code

Bestätigung F3, F5, F7–F11 → 1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 (SP) → 1.7 → 1.8 → 1.9 (nach F2) → 1.10 (nach der Freigabe).

Eine frische Session je Aufgabe (1.5 und 1.6 ggf. in Entities und Reports geteilt). Nach jedem Schritt: Tests grün, kleiner Commit,
Häkchen in dieser Datei, Umsetzungsnotizen unter der Aufgabe („Umsetzung (Stand für …)“ wie in Phase 0).
