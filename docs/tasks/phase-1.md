# Phase 1 – Daten

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§5 „Festlegungen für Phase 1 und später“), `docs/tasks/phase-0.md`
> (Umsetzungsnotizen 0.5–0.7), `docs/decisions/` (001 Stack, 002 Mandanten-Modell, 003 Decimal-Library, 004 Amazon-API).
>
> **Status: abgestimmt (2026-09-26), in Umsetzung.** Entscheidungen stehen als **F1–F14** unter „Fragen an Dominik“.
> Entschieden: F1–F11, F13, F14. Offen: F12 (Ads-API-Zugang; Stand 2026-09-28 unter F12: vorerst keiner, Phase 2 läuft gegen Mocks).
> Aufgaben, die von einer Frage abhängen, verweisen darauf.

## Ziel

Für jedes verbundene Profil liegen die Werbe-Entities und die täglichen Kennzahlen je Ebene in der Datenbank:
- Entity-Sync: Portfolios, Kampagnen, Ad Groups, Targets (Keywords, Produkt- und Auto-Targets), Negatives, Product Ads.
- Täglicher Report-Import je Ebene in `*_daily_metrics`, mit rollierendem Fenster und Upsert.
- Beträge exakt (`numeric` + Währung), Amazon-IDs als Text, Reports überstehen Neustarts.
- Phase 2 (Dashboard, Explorer) liest nur noch aus diesen Tabellen und muss am Import nichts umbauen.

## Definition of Done

- [x] Mit dem Mock-Anbieter (`AMAZON_ADS_USE_MOCK=true`) füllt ein Sync alle Entity- und Metrik-Tabellen eines Profils;
      ein zweiter Lauf ändert nichts (idempotent), ein Lauf mit geänderten Mock-Daten aktualisiert per Upsert.
- [x] Ein Neustart des Prozesses, während ein Report bei Amazon noch läuft, verliert nichts: Der nächste Lauf holt ihn ab.
- [x] Beträge kommen ohne Umweg über `number` in die DB (Test mit Werten wie `0.1`, `1234567.89`, `0.005`).
      IDs größer als `Number.MAX_SAFE_INTEGER` kommen unverändert an.
- [x] Neue Jobs laufen über `runJob`, schreiben `job_runs` mit Zählern, erscheinen im Sync-Status (i18n-Keys) und pingen Healthchecks (außer `amazon-requests-poll`, siehe 1.7).
- [x] Jede neue Tabelle trägt `organization_id`, jede Tabelle mit Profildaten zusätzlich `profile_id` (die Lease-Tabelle aus 1.3 gilt je
      Connection); die DB verhindert Verknüpfungen über Org- und Profilgrenzen (zusammengesetzte FKs).
- [x] Connections speichern den Zeitpunkt der Einwilligung; die Connections-Seite zeigt, wann der Refresh-Token abläuft.
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
  Beispielaufrufe kommen aber nur mit `Amazon-Advertising-API-Scope` (Profil-ID) aus; die OpenAPI-Spec nennt ihn optional (DSP, Stand 2026-09-27). Falls nötig: welche Konto-ID (`adsAccountId` aus der
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
  **Entschieden (Dominik, 2026-09-26): wie empfohlen.**
- **F4 – Historie beim ersten Sync.** Wie weit zurück beim ersten Import eines Profils? Empfehlung: **so weit v3 erlaubt**
  (SP 95, SB 60, SD 65 Tage, in 31-Tage-Stücken). Mehr Historie ginge nur über Reporting v1 (Beta) oder Bulk-Downloads aus der Konsole
  (nicht geplant).
  **Entschieden (Dominik, 2026-09-26): Maximum, das v3 erlaubt.**
- **F5 – Aufbewahrung.** Wie lange bleiben Tageskennzahlen in unserer DB? Empfehlung: **unbegrenzt** (Pilot-Volumen klein,
  Amazon selbst hält nur 60–95 Tage vor, also ist unsere DB die einzige Historie). Wiedervorlage bei Stufe C. Report-Anfragen
  (`amazon_ads_report_requests`) nach 30 Tagen löschen. Heruntergeladene Rohdateien werden nicht gespeichert.
  **Entschieden (Dominik, 2026-09-26): wie empfohlen.**
- **F6 – Report-Ebenen.** Plan: Kampagne, Ad Group, Target, Product Ad. Zusätzlich **Suchbegriffe** (`spSearchTerm`) und
  **Placements** (`spCampaigns` mit `campaignPlacement`)? Empfehlung: Suchbegriffe **ja** (Grundlage für Negatives und Regeln in
  Phase 3/5, und Amazon hält sie nur 95 Tage vor: was wir nicht sammeln, fehlt später), Placements **nein** (erst mit Bedarf).
  **Entschieden (Dominik, 2026-09-26): Suchbegriffe ja, Placements erst bei Bedarf.**
- **F7 – Attributionsfenster.** Welche SP-Spalten speichern? Empfehlung: Umsatz, Bestellungen und Einheiten für **7 und 14 Tage**,
  jeweils gesamt und „same SKU“. 1 und 30 Tage nicht (auf Nachfrage per jsonb nachrüstbar, siehe 1.5).
  **Entschieden (Dominik, 2026-09-26): wie empfohlen.**
- **F8 – Wechselkurse.** Plan §5: Tageskurse (z. B. EZB) in einer eigenen Tabelle. Empfehlung: **erst in Phase 2** mit dem ersten
  Verbraucher (Dashboard-Summen in EUR). Phase 1 speichert nur Originalwährung + Währungscode.
  **Entschieden (Dominik, 2026-09-26): wie empfohlen.**
- **F9 – Zeitplan.** Empfehlung: Entity-Sync und Report-Anforderung täglich **06:00 Europe/Berlin** (nach dem Profil-Sync um 05:00),
  „Gestern“ jeweils in der Zeitzone des Profils; das Fenster ist `[gestern − (F3 − 1), gestern]`, der laufende Tag nie (unvollständig).
  Zusätzlich manuell über „Jetzt synchronisieren“ (Profile → Entities → Reports).
  **Entschieden (Dominik, 2026-09-26): wie empfohlen.**
- **F10 – Archivierte Entities.** Empfehlung: **mit** synchronisieren (Kennzahlen der Vergangenheit verweisen auf sie; im Explorer
  später per Filter ausgeblendet).
  **Entschieden (Dominik, 2026-09-26): wie empfohlen.**
- **F11 – Sichtbares in Phase 1.** Empfehlung: keine Datenansichten (Explorer/Dashboard = Phase 2). Nur Sync-Status (neue Jobs,
  Zähler), auf der Connections-Seite der Ablauf der Einwilligung und je Profil „Daten bis“ (letzter importierter Tag).
  **Entschieden (Dominik, 2026-09-26): wie empfohlen.**
- **F12 – Antragsweg Ads-API.** Der Übergabe-Prompt beschreibt den Weg „als Partner im Amazon Ads Partner Network → Request API Access“.
  In einer früheren Session hieß es, das Partner Network nehme nur juristische Personen (Muuv ist Einzelunternehmen). Welcher Weg gilt?
  (Betrifft nur die Doku in `phase-0.md` 0.0b/0.0c, nicht den Code.)
  **Stand (Dominik, 2026-09-26): noch offen, wird erst geklärt.** Bis dahin bleibt `phase-0.md` 0.0c unverändert.
  **Stand (Dominik, 2026-09-27):** Laut Amazon-FAQ müssen Anbieter von Werbedienstleistungen über das Partner Network (3P-Formular)
  gehen; ein Antrag als Direct Advertiser (1P) würde abgelehnt. Dominik hat den Partner-Network-Antrag erneut gestellt und fragt beim
  Support nach, wie ein Einzelunternehmen die 3P-Registrierung abschließt (Rückfall: schriftliche Bestätigung, dass der Weg als Direct
  Advertiser für ihn zulässig ist). `phase-0.md` 0.0b/0.0c/0.0e erst nach der Antwort anpassen. Rückfallebene ohne API: 1.11.
  **Stand (Dominik, 2026-09-28):** Antwort des Supports: Das Partner Network nimmt keine Einzelunternehmen auf (Vorgabe der
  Rechtsabteilung zum Umgang mit personenbezogenen Daten, keine Frage fehlender Unterlagen); der Weg als Direct Advertiser gilt nur
  für das eigene Werbekonto, Agenturarbeit ist 3P. Der erneute Antrag unter „Muuv“ wurde abgelehnt (Registrierung nicht
  validierbar). Damit gibt es vorerst **keinen Ads-API-Zugang**; er kommt erst mit einer eingetragenen Gesellschaft (Dominiks
  Entscheidung, ohne Termin). **Entschieden (Dominik, 2026-09-28): Phase 2 jetzt beginnen, gegen die Mock-Daten**
  (`docs/tasks/phase-2.md`); 1.10 und die offenen DoD-Punkte warten auf den Zugang, danach greift der Auslöser von 1.11.
  `phase-0.md` 0.0c bleibt bis zur Entscheidung über den Zugang unverändert.
- **F13 – Decimal-Library (ADR 003).** Empfehlung `decimal.js` (Begründung und Alternativen in 1.1).
  **Entschieden (Dominik, 2026-09-26): wie empfohlen.**
- **F14 – Ausgeblendete Profile.** Synchronisieren? Empfehlung **ja**: Ausblenden ist Darstellung, keine Datenentscheidung, und
  Amazon hält Kennzahlen nur 60–95 Tage vor (später wieder eingeblendete Profile hätten sonst Lücken). Entfernte Profile nicht.
  **Entschieden (Dominik, 2026-09-26): wie empfohlen.**

## Aufgaben

### 1.1 Geld und Dezimalzahlen (`packages/shared`, `packages/amazon-ads`)
- [x] **ADR 003 – Decimal-Library.** Vorschlag `decimal.js` (MIT, verbreitet, ohne Abhängigkeiten, beliebige Genauigkeit, Rundungsmodi).
      Alternativen im ADR abwägen: `big.js` (kleiner, weniger Funktionen), `dinero.js` (Geld-Objekte, bringt eigene Währungslogik mit,
      für unsere Decimal-Strings mehr als nötig). Entscheidung mit Dominik (F13). Nur Server und `packages/engine`; das Web bekommt Decimal-Strings
      und formatiert sie (Formatierungs-Helper in `@profitbash/shared` auf Strings erweitern, nicht auf `number`).
- [x] `parseJsonLossless(text, { decimals: 'string' })`: Dezimalzahlen (und Zahlen in Exponentialschreibweise) kommen als **Quelltext-String**,
      nicht über `String(number)`. Standard bleibt wie heute (Profile, Tokens). Tests: `0.1`, `1234567.89`, `1e-7`, `-0.00`, sehr lange Nachkommastellen.
- [x] zod-Bausteine in `packages/amazon-ads`: `amazonDecimalSchema` (String oder sichere Ganzzahl → normalisierter Decimal-String),
      `currencyCodeSchema` (ISO 4217, drei Großbuchstaben). Unbekannte Währungen durchreichen und loggen, nicht verwerfen.
- [x] Konvention für die DB festhalten (in dieser Datei unter „Umsetzung“): Beträge von Amazon als `numeric` **ohne** feste Skala
      (speichert exakt, was Amazon liefert, rundet nie still; Gebote/CPC haben teils mehr als 2 Nachkommastellen). Gerundet wird erst beim
      Rechnen bzw. Anzeigen. Zähler (`impressions`, `clicks`) `bigint`, Währung immer als eigene Spalte `currency_code`.
      Drizzle liefert `numeric` als String (`mode: 'string'`), nie als `number`. Tagesdaten als `date` mit `mode: 'string'` (ein JS-`Date`
      um Mitternacht UTC verschiebt Tage in anderen Zeitzonen).
- [x] Umsetzung (Stand für 1.2 und später):
  - ADR 003 angenommen (`decimal.js` ^10.6), Abhängigkeit vorerst nur in `packages/amazon-ads`. `packages/engine` bekommt sie mit der
    ersten Berechnung, dann als **eine** konfigurierte Kopie (`Decimal.clone`), nie über die globale Konfiguration.
  - `parseJsonLossless(text, { decimals: 'string' })`: jede Zahl mit Nachkommastellen oder Exponent kommt als Quelltext-String
    (`1.50` bleibt `'1.50'`, `1e3` wird `'1e3'`), sichere Ganzzahlen ohne Exponent bleiben `number` (Zähler), unsichere wie bisher String.
    Standard unverändert. Report- und Export-Downloads (1.4/1.6) rufen den Parser mit der Option auf. **Offen für 1.6:** `request()` in
    `http.ts` parst mit dem Standard; Endpunkte mit Beträgen (z. B. `POST /portfolios/list`, Budgets) brauchen die Option, also
    `request()` um eine Parse-Option erweitern. Ohne sie scheitert `amazonDecimalSchema` laut (siehe unten), statt still zu runden.
    Mit der Option kommen **alle** gebrochenen Werte als String, auch Raten (CTR, ACoS, ROAS): Zeilen-Schemas nutzen für jede
    gebrochene Spalte `amazonDecimalSchema`, nie `z.number()`.
  - `packages/amazon-ads/src/money.ts`:
    - `amazonDecimalSchema`: String nach JSON-Zahlgrammatik (auch mit führenden Nullen, ohne `+`, Leerzeichen, Komma) oder sichere
      Ganzzahl → `Decimal#toFixed()`: exakt, ohne Exponent, ohne überflüssige Nullen, `-0` → `0`. Zahlen mit Nachkommastellen werden
      abgelehnt (fehlende Parser-Option, Wert womöglich schon über `number` gerundet). Exponent in der Eingabe höchstens vierstellig
      (größere macht decimal.js zu `Infinity` bzw. still zu `0`), Zehnerpotenz des Werts höchstens ±40 (`1e-1000000` ergäbe sonst
      einen String mit einer Million Zeichen).
      Ungültige Werte scheitern in zod; die Zeile zählt dann als ungültig (1.4).
    - `currencyCodeSchema`: nur Format (`^[A-Z]{3}$`). `isKnownCurrencyCode(code)` prüft gegen `Intl.supportedValuesOf('currency')`;
      die Normalisierung (1.6) loggt unbekannte Codes wie unbekannte Enum-Werte (`amazon_ads.unknown_enum_value`) und reicht sie durch.
  - Die Formatierungs-Helper in `@profitbash/shared` nahmen schon Decimal-Strings ohne Umweg über `number` (Tests für `0.005` und
    Werte über `MAX_SAFE_INTEGER`); die Ausgabe von `amazonDecimalSchema` passt zu deren Muster. Keine Änderung nötig.
  - **DB-Konvention** (gilt ab 1.5):
    - Beträge: `numeric('cost')` ohne `precision`/`scale`, Drizzle-Standard `mode: 'string'` (nie `'number'`). Gerundet wird erst
      beim Rechnen oder Anzeigen. Postgres gibt `numeric` unverändert zurück (`'1.5'` bleibt `'1.5'`); normalisiert ist der Wert
      schon beim Einlesen.
    - Jeder Betrag mit Währungsbezug hat eine eigene Spalte `currency_code` (bzw. `budget_currency_code` o. ä. je Betragsgruppe).
    - Zähler (`impressions`, `clicks`, `purchases_*`, `units_*`): `bigint(..., { mode: 'number' })`. Tageswerte liegen weit unter
      2^53; `mode: 'bigint'` wäre nicht JSON-serialisierbar. Bei Summen über viele Profile in SQL (`sum()` gibt `numeric`) beachten.
    - Tage: `date(..., { mode: 'string' })` (`'2026-09-25'`), nie `Date`. Zeitpunkte wie bisher `timestamptz`.
    - Amazon-IDs: `text`.

### 1.2 Einwilligungszeitpunkt je Connection
- [x] Migration: `connections.consented_at` (timestamptz, nullable für Bestandsdaten). Der OAuth-Callback setzt ihn bei Anlage **und**
      bei jedem Neu-Verbinden auf `now()` (jede Einwilligung startet die 365 Tage neu). Audit-Events `connection.create`/`reconnect` enthalten ihn.
- [x] `refreshTokenExpiresAt = consented_at + 365 Tage` als abgeleiteter Wert in der API (`GET /api/connections`), nicht gespeichert.
      Hinweis: Die Regel gilt für Tokens ab 30.07.2026; ältere Connections ohne `consented_at` zeigen „unbekannt“.
- [x] Connections-Seite: „Einwilligung läuft ab am …“, ab 30 Tagen vorher als Warnung. Benachrichtigungen erst Phase 5.
- [x] Tests: Anlage und Neu-Verbinden setzen den Zeitpunkt; Mock-Callback ebenso.
- [x] Umsetzung (Stand für 1.3 und später):
  - Migration `0002_connections_consented_at` (nur `ADD COLUMN`, Bestandszeilen bleiben `NULL`). Der Callback nimmt **einen** Zeitpunkt
    für `consented_at` und `last_refreshed_at` (nach Code-Tausch und Konto-Prüfung, in der Transaktion mit dem Audit-Event); das
    Audit-Event trägt ihn als `target.consentedAt` (ISO). Die Mock-Einwilligungsseite läuft über denselben Callback.
  - `@profitbash/shared` (`src/consent.ts`): `AMAZON_ADS_CONSENT_LIFETIME_DAYS` (365, feste Tage, kein Kalenderjahr),
    `CONSENT_EXPIRY_WARNING_DAYS` (30), `refreshTokenExpiresAt(consentedAt)`, `consentExpiryStatus(expiresAt, now)` →
    `unknown` | `valid` | `expiring` | `expired`. Dazu `formatDate` (Datum ohne Uhrzeit, Zeitzone des Browsers).
  - `GET /api/connections` liefert `consentedAt` und `refreshTokenExpiresAt` (nur für `amazon_ads` abgeleitet, sonst `null`).
    OpenAPI und `schema.gen.ts` neu erzeugt.
  - Connections-Karte: „Einwilligung läuft ab am …“ / „abgelaufen am …“ / „Ablauf der Einwilligung: unbekannt“. Bei `expiring`/`expired`
    ein Warnhinweis und „Neu verbinden“ **neben** „Jetzt synchronisieren“ (Neu-Verbinden startet die 365 Tage neu). Bei `reauth_required`
    gilt nur der bisherige Hinweis. Der Status wird beim Anzeigen berechnet (nicht reaktiv auf die Uhr); ein offener Tab zeigt den
    Wechsel über die 30-Tage-Grenze erst nach einem Neuladen, bis die Benachrichtigungen in Phase 5 kommen.
  - Nach Ablauf bleibt die Connection `active`, bis Amazon den Token ablehnt (`invalid_grant` → `reauth_required` über `token-refresh`).

### 1.3 Anfrage-Budget und Nebenläufigkeit
- [x] **Richtigstellung zum Bestand:** `singletonKey` = Connection-ID gilt bei pg-boss `stately` nur **innerhalb einer Queue**
      (siehe 0.7: `token-refresh` und `profiles-sync` derselben Connection können gleichzeitig laufen). Mit den neuen Queues
      (`entities-sync`, `reports-sync`, `amazon-requests-poll`) liefen ohne weitere Maßnahme mehrere Datenjobs einer Connection parallel.
      Plan §5 verlangt „Jobs je Connection laufen nacheinander“.
- [x] **Sperre je Connection für die Amazon-Datenjobs** (`profiles-sync`, `entities-sync`, `reports-sync`, `amazon-requests-poll`;
      `token-refresh` nicht, der Token-Store serialisiert LWA bereits über die Zeilensperre). Empfehlung: **Lease-Zeile** in der DB
      (`connection_job_leases`: `organization_id`, `connection_id` unique, `job`, `job_run_id`, `expires_at`; zusammengesetzter FK
      (`connection_id`, `organization_id`) → `connections`), per `INSERT … ON CONFLICT … WHERE expires_at < now()`
      genommen und am Ende freigegeben. Übersteht Abstürze (läuft ab), ist in der DB sichtbar und braucht keine langen Transaktionen
      (session-weite Advisory-Locks sind mit dem Verbindungspool von postgres.js unzuverlässig). Ist die Lease belegt, plant sich der Job mit
      `startAfter` (z. B. 60 s) neu ein und zählt `deferred`. Die Lease-Dauer liegt über der Job-Laufzeit (kurze Jobs, siehe 1.7); längere
      Schritte verlängern sie. Das Neu-Einplanen hat keine Obergrenze (anders als `Retry-After`: max. 3-mal, 1 h), belegt aber den einzigen
      Warteplatz der Connection in dieser Queue: Ein Cron-Einplanen währenddessen fällt als Duplikat weg, der wartende Job erledigt dieselbe
      Arbeit. Die Entscheidung (Lease oder Alternative) hier unter „Umsetzung“ festhalten.
- [x] **Anfrage-Budget je Profil** im Amazon-Client: Token-Bucket je **Profil** (nicht je Connection und Profil: ein Profil kann die
      Connection wechseln) im Prozess, Standard z. B. 2 Anfragen/s, konfigurierbar. Bei einem 429 halbiert sich die Rate des Profils
      (Untergrenze z. B. 0,2/s), je erfolgreicher Anfrage steigt sie additiv um einen kleinen Schritt bis zum Standard (AIMD).
      `Retry-After` hat Vorrang (besteht schon in `request()`). Kein verteiltes Budget: Die Datenjobs laufen in genau einem Prozess
      (`inline`: API-Prozess, `separate`: Worker).
- [x] Zähler je Lauf in `job_runs.counters`: `requests`, `throttled` (429), `retries`, `deferred`. Damit lässt sich das Budget später
      anhand echter Werte einstellen.
- [ ] Offen nach dem ersten echten Lauf: Standardrate an beobachtete 429-Quoten anpassen.
- [x] Umsetzung (Stand für 1.4 und später):
  - **Entscheidung: Lease-Zeile** wie empfohlen. Tabelle `connection_job_leases` (Migration `0003_connection_job_leases`):
    `connection_id` als Primärschlüssel, `organization_id`, `job`, `job_run_id`, `acquired_at`, `expires_at`; zusammengesetzter FK
    (`connection_id`, `organization_id`) → `connections` mit `ON DELETE CASCADE` (die Lease verschwindet mit der Connection).
    `job_run_id` ohne FK: Die Lease wird **vor** dem Lauf genommen (siehe unten), die ID steht dann schon fest.
  - Zugriffe in `packages/db/src/connection-leases.ts` (Systemzugriff, an Org und Connection gebunden): `acquireConnectionLease`
    (`INSERT … ON CONFLICT (connection_id) DO UPDATE … WHERE expires_at < now() AND organization_id = excluded.organization_id`;
    belegt → `{ acquired: false, heldBy }`), `extendConnectionLease` und `releaseConnectionLease` (nur die eigene Lease, erkannt an
    `job_run_id`). Ablauf in Datenbankzeit (`now()`), damit alter und neuer Container beim Deploy dieselbe Uhr sehen.
  - Worker: `CONNECTION_JOBS` in `worker.ts` führt je Queue `{ run, lease }`; `lease: true` heißt Amazon-Datenjob (heute nur
    `profiles-sync`). **1.7 meldet `entities-sync`, `reports-sync` und `amazon-requests-poll` dort nur mit `lease: true` an.**
    `runConnectionJob` (`jobs/run-connection-job.ts`): Lauf-ID vorab erzeugen → Lease nehmen (`CONNECTION_LEASE_SECONDS` = 15 Min.,
    länger als `JOB_EXPIRE_SECONDS` = 10 Min. von pg-boss, per Test abgesichert) → `runJob` mit dieser ID → Lease im `finally`
    freigeben (scheitert das, läuft sie ab; Log `job.lease_release_failed`). Fehlt die Connection (gelöscht, fremde Organisation),
    endet der Lauf ohne Lease mit „Connection nicht gefunden.“.
  - **Belegt:** Es entsteht **kein** `job_runs`-Eintrag und kein Healthcheck-Ping. Derselbe Job wird mit `startAfter`
    (`LEASE_DEFER_SECONDS` = 60 s) und `deferredCount + 1` neu eingeplant (Log `job.deferred` mit dem Halter); der spätere Lauf zeigt
    den Zähler `deferred`. So erzeugt eine länger belegte Connection keine Zeile je Minute im Sync-Status, und Healthchecks sieht nur
    echte Läufe. Wartet schon ein Job der Queue auf die Connection, fällt der zurückgestellte weg (Ergebnis `queued: false`).
    `extendConnectionLease` ist für lange Schritte da; heute nutzt es noch kein Job. 1.7 reicht es bei Bedarf über `ConnectionJobRun`
    weiter (z. B. `run.extendLease()`), statt dass Jobs die DB-Funktion direkt aufrufen: Bei 0,2/s dauern 180 Aufrufe an ein Profil
    schon 15 Min. **Betrieb:** Stirbt ein Halter, bleibt die Connection bis zu 15 Min. belegt; manuelle Syncs erscheinen solange nicht
    im Sync-Status, nur als Log `job.deferred` etwa jede Minute. Selten kommt `heldBy: null` vor (Halter gab zwischen den beiden
    Abfragen frei); der Job wartet dann trotzdem 60 s (bewusst nicht optimiert).
  - **Anfrage-Budget:** `packages/amazon-ads/src/rate-limit.ts` (`createProfileRateLimiter`): Token-Bucket mit Kapazität 1 je Profil
    (Schlüssel `region:amazonProfileId`), also gleichmäßiger Abstand `1/Rate`, auch für gleichzeitige Aufrufe. Standard 2/s, Untergrenze
    0,2/s, +0,05/s je Erfolg, 429 halbiert; `Retry-After` sperrt das Profil bis zum Ende der Pause. Wer beim 429 schon auf seinen
    Schlitz wartete, bucht nach dem Aufwachen neu (nach der Pause, halbierte Rate). Ist die Pause länger als `maxRetryAfterMs` (60 s),
    wird nicht gesendet: Der Aufruf endet sofort mit `AmazonAdsHttpError` (429, Code `PROFILE_PAUSED`, `retryAfterMs` = Restdauer), und
    `handleAmazonError` plant neu bzw. lässt den Lauf scheitern wie bei einem zu langen `Retry-After`. Greift in `request()` nur mit
    `amazonProfileId` (Profil-Scope), vor **jedem** Versuch inkl. Wiederholungen; `/v2/profiles` und LWA laufen ohne Profil-Budget.
    Konfigurierbar über `AMAZON_ADS_REQUESTS_PER_SECOND` (optional, 0,2–100; `.env.example`, `docs/deploy.md`). Im Modus `inline`
    teilen API und Worker denselben Client und damit dasselbe Budget.
  - **Zähler:** `createRequestMeter()` (`@profitbash/amazon-ads`) zählt je Lauf `requests` (jede gesendete Anfrage an die Ads-API,
    ohne LWA), `throttled` (429) und `retries` (zweiter und weitere Versuche, auch der Neuversand nach einem 401). Jobs reichen ihn über den dritten Parameter (`ConnectionJobRun`) an jeden Aufruf
    weiter (`request(…, { meter })`, `listProfiles(connection, { meter })`); neue Client-Methoden in 1.6 nehmen dieselbe Option.
    `runJob` hat dafür die Option `counters` (auch bei Fehlschlag geschrieben, gerade gedrosselte Läufe sollen sie zeigen) und `runId`.
    Nur Datenjobs schreiben diese vier Zähler; Anzeige nach den fachlichen Zählern (`COUNTER_ORDER`), Nullwerte ausgeblendet.
    Offen nach dem ersten echten Lauf: ob ein Zähler für die Wartezeit im Budget (`pacedMs`) nötig ist, um Budget und Amazon als
    Engpass zu unterscheiden.

### 1.4 Asynchrone Amazon-Aufträge: Tabelle und Zustandsmaschine
Gemeinsamer Baustein für Exports (Entities) und Reports, damit Neustarts nichts verlieren. Diese Aufgabe baut **Tabelle und
Zustandsmaschine** und testet sie gegen eine injizierte Fake-Schnittstelle („anfordern“, „Status“, „laden“, „importieren“). Die echten
Client-Methoden kommen in 1.6, Jobs und Dispatcher in 1.7.
- [x] Tabelle `amazon_ads_report_requests` (gilt auch für Exports, Spalte `kind`):
  - `organization_id`, `profile_id`, `kind` (`report` | `export`), `ad_product` (**ein** Ad-Typ je Auftrag, auch bei Exports),
    `report_type` (z. B. `spCampaigns`, bei Exports `campaigns`/`adGroups`/`targets`/`ads`), `start_date`, `end_date` (nur Reports),
    `batch_id` (Exports eines Entity-Syncs gehören zusammen, siehe 1.7), `amazon_request_id` (Text, leer bis zur Antwort von Amazon)
  - `status`: `pending_request` → `requested` → `completed` → `imported`, oder `failed`
  - `attempts` (Status-Abfragen), `import_attempts`, `next_poll_at`, `requested_at`, `completed_at`, `imported_at`,
    `failure_reason` (gekürzt, ohne URLs), `row_count`, `invalid_row_count`
  - Die Download-URL wird **nicht** gespeichert (signiert, läuft ab); sie wird beim Abholen frisch per Status-Abfrage gelesen.
  - Unique (`profile_id`, `kind`, `ad_product`, `report_type`, `start_date`, `end_date`) mit **`NULLS NOT DISTINCT`** als partieller Index auf
    offene Aufträge (`status` nicht `imported`/`failed`): kein doppelter offener Auftrag, auch bei Exports (Daten leer) und nach Neustart.
- [x] **Erst schreiben, dann anfordern:** Zeile mit `pending_request` anlegen, dann Amazon aufrufen, dann `amazon_request_id` speichern.
      Stirbt der Prozess dazwischen, findet der nächste `amazon-requests-poll` die Zeile ohne ID (sie zählt als offener Auftrag, auch für den
      Dispatcher in 1.7) und fordert erneut an. Antwortet Amazon dann mit 425
      (identische Anfrage läuft noch): die Report-ID aus der Fehlerantwort übernehmen, falls Amazon sie liefert (beim Umsetzen prüfen),
      sonst `next_poll_at` in 15 Min. und dann erneut anfordern.
- [x] **Abbruchregel:** `failed` erst, wenn Amazon bei einer Abfrage noch `PENDING`/`PROCESSING` meldet und der Auftrag älter als 4 h ist,
      oder wenn Amazon `FAILURE` meldet. Ein Auftrag, den nur wir nicht abgefragt haben (Absturz, Deploy), wird beim nächsten Poll normal abgeholt.
- [x] **Download:** Entpacken gestreamt mit Größendeckel (z. B. 50 MB entpackt, sonst `failed` mit Hinweis), dann `parseJsonLossless`
      über den ganzen Text (der Parser arbeitet nicht auf Streams). Der Deckel schützt den Speicher bei `WORKER_MODE=inline`; bei Bedarf
      später ein verlustfreier Streaming-Parser (neue Abhängigkeit, ADR-Notiz). zod-Validierung je Zeile; ungültige Zeilen zählen
      (`invalid_row_count`) und ohne Werte loggen.
- [x] **Import:** Reports je Auftrag in **einer** Transaktion (Regeln in 1.5), danach `imported`. **Ausnahme Exports:** Sie werden je
      `batch_id` gemeinsam importiert, Importversuche zählen je Batch (Regeln in 1.7). Scheitert der Import, bleibt der Auftrag
      `completed` und wird beim nächsten Poll erneut geladen; nach 3 Importversuchen `failed` (sonst lädt ein Fehler die Datei endlos).
      Ist die URL abgelaufen, frisch per Status-Abfrage holen; liefert Amazon die Datei nicht mehr, neu anfordern.
- [x] **Reihenfolge:** Ein Report-Auftrag importiert nur die Tage, die kein **später angeforderter**, schon importierter Auftrag desselben
      Profils, Ad-Typs und Report-Typs abdeckt (sonst überschrieben ältere Werte neuere); das Ersetzen des Ausschnitts (1.5) gilt dann nur für
      diese Tage. Deckt ein neuerer Auftrag alle Tage ab, endet der Auftrag als `imported` mit Zähler `superseded` (seine Tage sind ja durch den
      neueren importiert; für den Historien-Merker in 1.7 zählt er als importiert).
- [x] Wartung: `job-runs-cleanup` löscht abgeschlossene Aufträge älter als 30 Tage (F5).
- [x] Tests (gegen die Fake-Schnittstelle): Absturz vor und nach dem Anfordern, 425 mit und ohne ID, 429 beim Status, `FAILURE`,
      abgelaufene URL, Datei über dem Deckel, kaputte Zeile, dreimal scheiternder Import, überholter Auftrag.
- [x] Umsetzung (Stand für 1.5 und später):
  - **Tabelle** (`packages/db/src/schema/app.ts`): Migrationen `0004_amazon_ads_profiles_id_org_unique` (unique (`id`, `organization_id`)
    an `amazon_ads_profiles`, Ziel der zusammengesetzten FKs; **gilt auch für 1.5**, dort nicht erneut anlegen; dazu die Enums),
    `0005_amazon_ads_report_requests` (Tabelle), `0006_…_open_nulls_not_distinct` (eigene SQL-Migration: Drizzle erzeugt
    `NULLS NOT DISTINCT` nur für Constraints, der partielle Index wird dort neu angelegt; der Schema-Eintrag verweist darauf) und
    `0007_…_error_and_request_counts`. Getrennte Migrationen, weil Drizzle den Unique-Constraint sonst **nach** dem FK anlegt, der ihn braucht.
    - `kind` und `status` als Postgres-Enums (feste interne Mengen), `ad_product`/`report_type` als Text (Amazon-Werte).
    - CHECK: Reports haben Zeitraum (`start_date <= end_date`) und keinen Batch, Exports einen Batch und keinen Zeitraum.
    - Zusätzliche Spalten: `error_count` (vorübergehende Fehler in Folge), `request_count` (Anforderungen, begrenzt das Neu-Anfordern),
      `created_at`/`updated_at`. `next_poll_at` ist nullable: `null` = wartet auf andere Exports des Batches (nie fällig).
    - **FK auf Profile mit `ON DELETE CASCADE`**, nicht `NO ACTION` wie in 1.5: Aufträge sind Betriebszustand, keine Historie; sie
      sollen das Löschen eines Profils nicht blockieren.
  - **Zugriffe** in `packages/db/src/amazon-requests.ts` (Systemzugriff, an die Organisation gebunden): `createAmazonRequest` (offener
    Auftrag mit gleichem Schlüssel → `created: false` und dieser Auftrag), `createAmazonExportBatch` (alle Exports eines Batches in
    einer Transaktion; ist für Profil und Ad-Typ noch ein Export offen, entsteht kein neuer Batch), `findAmazonRequest`,
    `updateAmazonRequest(Batch)`, `listDueAmazonRequests` (fällige offene Aufträge der Profile, die an der Connection hängen, älteste
    zuerst, mit `limit`), `listAmazonRequestBatch`, `listNewerImportedReportRanges`, `deleteFinishedAmazonRequestsBefore`.
  - **Download** (`@profitbash/amazon-ads`, `decodeGzipJson(body, { maxBytes })`): entpackt gestreamt, bricht beim Überschreiten des
    Deckels ab (`AmazonAdsDownloadTooLargeError`), parst dann mit `parseJsonLossless(…, { decimals: 'string' })`. Kaputtes gzip/JSON →
    `AmazonAdsResponseError` ohne Inhalt; Fehler des Bodys (Netzwerk) bleiben unverändert.
  - **Zustandsmaschine** (`apps/worker/src/amazon-requests/state-machine.ts`) gegen die Schnittstelle `AmazonRequestPort`
    (`request`, `getStatus`, `download`, `rowSchema`, `import(tx, …)`), Einstiegspunkte für 1.7: `submitAmazonRequest` (nur Reports),
    `submitAmazonExportBatch` (Exports immer als Batch) und `advanceAmazonRequest(deps, ref)` (liest die Zeile frisch, ein Schritt je
    Aufruf). Ergebnis: Zeile plus Zähler `requested`, `reused`, `imported`, `rows`, `superseded`, `failed` für `job_runs.counters`.
    Uhr injiziert (`now`), Deckel 50 MB (`maxDownloadBytes`).
    - **Fehler der Connection** (abgelehnter Refresh-Token, 429 bzw. `Retry-After` inkl. `PROFILE_PAUSED` aus 1.3) gehen unverändert an
      den Job (`handleAmazonError`), der Auftrag bleibt, wie er war.
    - **Anfordern:** Erfolg → `requested`, `next_poll_at` in 1 Min. 425 mit ID → übernommen (Zähler `reused`). 425 ohne ID → 15 Min.
      warten; **Erweiterung:** meldet Amazon das über 4 h (seit Anlegen bzw. Neu-Anfordern), `failed` (sonst blockierte die Zeile den
      Schlüssel endlos). **Doku-Stand 2026-09-27:** Die API-Referenz nennt für 425 nur `{ code, detail }`; ob `detail` die Report-ID
      enthält, prüft 1.6 (Port liefert `{ status: 'duplicate', amazonRequestId: string | null }`).
    - **Status:** `PENDING`/`PROCESSING` → Backoff 1 → 2 → 5 → 10 → 15 Min. (Zahl der Abfragen), `failed` erst ab 4 h seit dem Anfordern.
      `FAILURE` → `failed`. `NOT_FOUND` → Report neu anfordern, Export: Batch `failed`. `COMPLETED` → `completed` und sofort laden.
    - **Erweiterungen zur Abbruchregel:** 4xx außer 408/425/429 beim Anfordern oder Abfragen → sofort `failed` (eine Wiederholung ändert
      nichts). Vorübergehende Fehler (5xx, Netzwerk) → Backoff, `failed` erst nach 10 Fehlern in Folge (`error_count`, jede Antwort von
      Amazon setzt zurück), **nicht** nach Alter: Ein Auftrag, den wir nur lange nicht abgefragt haben, bleibt abholbar.
    - **Laden/Import:** URL aus der gerade gelaufenen Abfrage; ist sie abgelaufen (`expired`), genau eine frische Status-Abfrage. Fehlt die
      Datei danach noch: Report neu anfordern, höchstens 3 Anforderungen insgesamt (`request_count`), danach `failed`. Kein Array oder Fehler
      beim Laden/Import → Importversuch (3 → `failed`, sonst in 5 Min. erneut); Datei über dem Deckel → sofort `failed`. Ein vorübergehender
      Fehler der frischen Status-Abfrage zählt nicht als Importversuch. Ungültige Zeilen: je Datei höchstens 5 Logs
      (`amazon_requests.invalid_row`, nur Pfad und Code) plus Summe.
    - **Reihenfolge:** Vollständig überholte Reports enden ohne Download als `imported` (`row_count` 0, Zähler `superseded`). Die offenen
      Tage (`ranges`) werden in der Import-Transaktion neu berechnet und an `import` übergeben; **1.5 ersetzt nur diese Tage** und filtert
      die Zeilen darauf. „Später angefordert“ = `requested_at`; bei 425 mit ID ist das der Zeitpunkt der Übernahme (höchstens etwas zu spät).
    - **Exports je Batch** (Zustandsteil der Regeln aus 1.7, schon hier umgesetzt): Ein fertiger Export wartet ohne Termin, bis alle Exports
      des Batches `completed` sind; der zuletzt fertige bleibt fällig, bis der Import gelaufen ist (übersteht Drosselung und Absturz). Import
      aller Dateien in **einer** Transaktion (`import` bekommt `{ kind: 'export', batchId, files }`, Reihenfolge der Hierarchie ist Sache von
      1.7). Importversuche zählen je Batch, wieder fällig wird nur der auslösende Auftrag. Jeder endgültige Fehler eines Exports (4xx,
      `FAILURE`, 4 h, Datei fehlt, zu groß, 3 Importversuche) lässt den ganzen Batch scheitern; einzelne Exports werden nie neu angefordert.
  - **Wartung:** `job-runs-cleanup` löscht `imported`/`failed`-Aufträge, die vor über 30 Tagen angelegt wurden (Zähler `deletedAmazonRequests`).
  - **Für 1.6:** Port je Connection bauen (mit `meter` aus `ConnectionJobRun`), Status von Reports (`PENDING`/`PROCESSING`/`COMPLETED`/
    `FAILURE`) und Exports (`PROCESSING`/`COMPLETED`/`FAILED`) auf `AmazonRequestState` abbilden, 404 → `NOT_FOUND`, abgelaufene S3-URL
    (403/404 vom Download-Host) → `expired`, `download` liefert den rohen gzip-Body (die Zustandsmaschine entpackt). Zeilen-Schemas mit
    `amazonIdSchema`/`amazonDecimalSchema` (sichere Ganzzahlen kommen als `number`).
  - **Für 1.7:** Poll-Lauf: `listDueAmazonRequests` → je Auftrag `advanceAmazonRequest`, Zähler addieren; ein Fehler der Connection beendet
    den Lauf (`handleAmazonError`). `entities-sync` nutzt nur `submitAmazonExportBatch`. Keine Absicherung per Compare-and-set in
    `updateAmazonRequest` (bewusst): Die Lease der Connection serialisiert die Läufe; lange Poll-Läufe (bis zu 4 Dateien à 50 MB) sollen
    die Lease über `run.extendLease()` verlängern (siehe 1.3), sonst könnte nach 15 Min. ein zweiter Lauf denselben Auftrag bearbeiten.
    Ein Auftrag eines Profils, das die Connection gewechselt hat, erscheint im Poll der neuen Connection.
  - Review (unabhängig): Befunde zu hängenden Export-Batches (Drosselung/Absturz nach dem letzten `COMPLETED`, 4xx beim Anfordern eines
    Exports, zwei Schreibvorgänge ohne Transaktion), zur 4-h-Regel bei vorübergehenden Fehlern, zum unbegrenzten Neu-Anfordern und zum
    Batch-Modell behoben. Zurückgewiesen: Compare-and-set (siehe „Für 1.7“), eine eingesparte Status-Abfrage je Batch (einfacherer Code),
    Text „0 MB“ in `AmazonAdsDownloadTooLargeError` bei Deckeln unter 1 MB (die Zustandsmaschine formatiert selbst).

### 1.5 Schema für Entities und Kennzahlen (`packages/db`)
Allgemeine Regeln für alle Tabellen dieser Aufgabe:
- `id` (uuid), `organization_id`, `profile_id`; zusammengesetzter FK (`profile_id`, `organization_id`) → `amazon_ads_profiles`
  (unique (`id`, `organization_id`) an `amazon_ads_profiles` gibt es seit 1.4, Migration `0004`).
- Amazon-IDs als Text (`amazon_campaign_id` …), unique (`profile_id`, `amazon_…_id`).
- `ad_product` (Text: `SPONSORED_PRODUCTS` | `SPONSORED_BRANDS` | `SPONSORED_DISPLAY`), `state` als Text (neue Amazon-Werte brechen nichts).
- Jede Entity-Tabelle bekommt unique (`id`, `profile_id`). Interne FKs zur Elternebene (`campaign_id`, `ad_group_id`) und von den
  Kennzahlen zur Entity sind zusammengesetzt mit `profile_id` (z. B. (`campaign_id`, `profile_id`) → `amazon_ads_campaigns`): So kann eine
  Ad Group nicht auf die Kampagne eines anderen Profils zeigen. Die Org ist über den Profil-FK festgelegt.
- Verweise auf Profile und Elternebenen mit `ON DELETE NO ACTION` (Drizzle-Standard), nicht `CASCADE`: Historie ist nicht
  wiederbeschaffbar (F5), ein einzelnes Profil oder eine Kampagne darf sie nicht mitreißen. Nicht `RESTRICT`: Das prüft sofort und kann das
  Löschen einer ganzen Organisation scheitern lassen, wenn deren Kaskade (`organization_id` → `organizations`, `CASCADE` wie überall) Eltern
  vor Kindern erreicht; `NO ACTION` prüft erst am Ende der Anweisung. Test: Organisation mit Daten löschen gelingt, einzelnes Profil mit
  Daten löschen scheitert. Hinweis: `amazon_ads_profiles.connection_id` hat heute `ON DELETE CASCADE`; ein künftiges „Connection löschen“
  muss das berücksichtigen (Profile entkoppeln, nicht löschen).
- `extra` (jsonb): produktspezifische Felder, die (noch) keine eigene Spalte haben. Nie Beträge, die wir rechnen (die bekommen Spalten).
- `amazon_updated_at` (falls geliefert), `synced_at`, `removed_at` (Amazon liefert die Entity nicht mehr; wie bei Profilen umkehrbar, nie löschen).

Entities:
- [x] `amazon_ads_portfolios`: Name, Status, Budget (`budget_amount`, `budget_currency_code`, Budget-Typ, Zeitraum), `in_budget`.
- [x] `amazon_ads_campaigns`: `portfolio_id` (nullable), Name, Status, Targeting-Typ (manuell/auto), Budget (Betrag, Währung, Typ),
      Gebotsstrategie, Start-/Enddatum, Platzierungs-Anpassungen in `extra`.
- [x] `amazon_ads_ad_groups`: `campaign_id`, Name, Status, Standardgebot (`default_bid`, Währung).
- [x] `amazon_ads_targets`: `campaign_id`, `ad_group_id` (nullable bei SB-Kampagnen-Targets), Art (`keyword` | `product` | `category` |
      `auto` | `audience`), Ausdruck (Keyword-Text + Match-Typ bzw. Target-Ausdruck als jsonb), Status, Gebot.
- [x] `amazon_ads_negative_targets`: Ebene (`campaign` | `ad_group`), `campaign_id`, `ad_group_id` (nullable), Art, Ausdruck, Match-Typ, Status.
      Eigene Tabelle, weil Negatives kein Gebot und keine Kennzahlen haben. Quelle: voraussichtlich `/targets/export` mit Negativ-Kennzeichen
      (kein eigener Endpunkt; beim Umsetzen prüfen).
- [x] `amazon_ads_product_ads`: `campaign_id`, `ad_group_id`, ASIN, SKU (nullable, Vendoren haben keine), Status.

Kennzahlen (je Tag, Datum in der Zeitzone des Profils, so liefert Amazon es):
- [x] `amazon_ads_campaign_daily_metrics`, `amazon_ads_ad_group_daily_metrics`, `amazon_ads_target_daily_metrics`,
      `amazon_ads_product_ad_daily_metrics`, `amazon_ads_search_term_daily_metrics` (F6; Schlüssel zusätzlich Suchbegriff-Text, bezogen auf das Target).
- [x] Gemeinsame Spalten: `organization_id`, `profile_id`, FK auf die Entity, `date`, `ad_product`, `currency_code`, `impressions`, `clicks`,
      `cost`, dazu Attribution nach F7 (`sales_7d`, `sales_14d`, `purchases_7d`, `purchases_14d`, `units_7d`, `units_14d`, `…_same_sku_…`),
      `extra` (jsonb) für weitere Spalten, `imported_at`.
  - `currency_code` kommt aus `amazon_ads_profiles.currency_code` (v3-Reports liefern je Zeile keine Währung, außer bei Budget-Spalten).
  - SB/SD liefern ein Fenster ohne Suffix (14 Tage) → `*_14d`; `*_7d` bleibt dort leer (`NULL`), nicht 0.
- [x] Schlüssel: `id` (uuid) als Primärschlüssel, unique (`profile_id`, `date`, Entity-FK) für den Upsert (Suchbegriffe zusätzlich mit
      dem Text); Index (`profile_id`, `date`).
- [x] **Platzhalter:** Taucht in einem Report eine Entity auf, die der Entity-Sync (noch) nicht kennt (gerade angelegt oder schon entfernt),
      legt der Import sie als Platzhalter an, **Eltern zuerst** aus den IDs der Report-Zeile (Kampagne → Ad Group → Target/Product Ad).
      Platzhalter haben `synced_at = null`; Name, Status, Gebot, Budget und Währung sind dafür nullable (keine Ersatzwerte). Report-Spalten
      wie `campaignName` dürfen den Namen vorbelegen. Der nächste Entity-Sync füllt sie. So geht keine Kennzahl verloren und der FK bleibt hart.
- [x] **Neu geladenes Fenster ersetzen:** Amazon liefert nur Tage mit Aktivität; fehlende Zeilen bedeuten 0. Der Import ersetzt deshalb in
      derselben Transaktion genau den Ausschnitt (Profil, Ad-Typ, Tabelle, `start_date`–`end_date` **dieses** Auftrags): Upsert der gelieferten
      Zeilen, Löschen der übrigen in diesem Ausschnitt. **Kein Löschen**, wenn der Auftrag ungültige Zeilen hatte, oder wenn er 0 Zeilen liefert,
      der Ausschnitt aber Zeilen hat (dann Import `failed` mit Hinweis, kein stiller Datenverlust). Tests für alle drei Fälle und dafür, dass
      ein SP-Import keine SB/SD-Zeilen löscht.
- [x] Keine Partitionierung im Pilot (Volumen je Profil und Tag: einige Tausend Zeilen). Wiedervorlage bei Stufe C.
- [x] Systemzugriffe (Upserts, Platzhalter) in `packages/db/src/system-access.ts` bzw. einer neuen Datei daneben. Sie schreiben **keine**
      `audit_events` (wie `profiles-sync` in 0.7): Nachvollziehbar sind sie über `job_runs` und ihre Zähler; Audit gilt für Aktionen von
      Nutzern und Änderungen an Connections. Nutzerseitige Lesezugriffe
      gibt es in Phase 1 nicht (außer „Daten bis“ je Profil, 1.8, über `visibleProfilesScope`); der Access-Layer bekommt dafür keine neuen Regeln.
- Umsetzung (Vorgabe aus 1.11, entschieden 2026-09-27, gilt auch für 1.7): Die Upserts für Entities und Kennzahlen nehmen **normalisierte
  Datensätze** entgegen (eigene Typen in `packages/db` bzw. das Modell aus 1.6), nie Antworttypen der Amazon-API. So kann ein späterer
  Datei-Import (1.11) dieselbe Schreibschicht nutzen. Der Datei-Import selbst wird hier **nicht** gebaut.
- [x] Umsetzung (Stand für 1.6 und später):
  - **Schema** in `packages/db/src/schema/amazon-ads-data.ts` (gemeinsame Spalten-Helfer jetzt in `schema/columns.ts`), Migrationen
    `0008_amazon_ads_entities` und `0009_amazon_ads_daily_metrics`. Alle Tabellen neu, deshalb stehen die Unique-Constraints in den
    `CREATE TABLE` vor den FKs (kein Aufteilen nötig wie in 1.4).
    - FK-Namen `<tabelle>_profile_org_fk`, `<tabelle>_<eltern>_fk`; alle `ON DELETE NO ACTION`. Getestet: Organisation mit Entities und
      Kennzahlen löschen gelingt; Profil, Kampagne mit Ad Groups bzw. Kampagne mit Kennzahlen löschen scheitert (23503).
    - Jede FK-Prüfung hat einen passenden Index (Eltern-Indizes `…_campaign_idx`/`…_ad_group_idx`, Kennzahl-Schlüssel beginnen mit
      (`profile_id`, Entity-ID)): Das Löschen einer Organisation prüft per Index statt per Scan. Kein Index auf `organization_id` (die
      Kaskade beim Löschen einer Organisation scannt je Tabelle einmal; selten).
    - Portfolios ohne `ad_product` (gelten für alle Ad-Typen). Platzhalter-fähige Spalten nullable (Name, Status, Budget, Gebot, Währung,
      bei Targets auch `target_type`, bei Product Ads `asin`). Negatives haben keine Platzhalter: `target_type` und `state` Pflicht,
      CHECK `amazon_ads_negative_targets_level_ck` (`campaign` ohne, `ad_group` mit Ad Group). `extra` ist `jsonb not null default '{}'`.
    - Kennzahlen: Schlüssel unique (`profile_id`, Entity-ID, `date`) bzw. bei Suchbegriffen zusätzlich `search_term` (Suchbegriff bezogen
      auf das Target), dazu Index (`profile_id`, `date`). Pflicht: `currency_code`, `impressions`, `clicks`, `cost`, `imported_at`;
      Attribution nullable.
    - Nicht erzwungen: dass die Ad Group eines Targets/Product Ads zur selben Kampagne gehört (Review-Befund, bewusst offen: Werte kommen
      aus Amazons eigenen IDs, ein zusätzlicher FK (`ad_group_id`, `campaign_id`) erschwerte die Platzhalter ohne echten Gewinn).
    - Offen für 1.10: Die Schlüssel (`profile_id`, `amazon_…_id`) nehmen an, dass sich Amazon-IDs über Ad-Typen eines Profils nicht
      überschneiden. Falls doch, brauchen Entity- und Kennzahl-Schlüssel zusätzlich `ad_product`.
  - **Entities** (`packages/db/src/amazon-ads-entities.ts`): `upsertPortfolios`, `upsertCampaigns`, `upsertAdGroups`, `upsertTargets`,
    `upsertNegativeTargets`, `upsertProductAds` nehmen normalisierte Datensätze (`PortfolioRecord` …, Eltern als Amazon-IDs) und liefern
    `{ created, updated, placeholdersFilled, placeholdersCreated }`. `updated` zählt nur tatsächlich geänderte Entities (Vergleich per
    `IS DISTINCT FROM`, dazu Platzhalter und wieder aufgetauchte); unveränderte bekommen nur `synced_at` (`updated_at` bleibt).
    `removed_at` wird beim Wiederauftauchen gelöscht; Setzen von `removed_at` ist Sache von 1.7. Doppelte IDs in einer Lieferung: der
    letzte Datensatz gilt. Stücke zu 1000 Zeilen (Parametergrenze). Jeder Upsert in eigener Transaktion bzw. Savepoint.
  - **Platzhalter:** `ensurePortfolios`, `ensureCampaigns`, `ensureAdGroups`, `ensureTargets`, `ensureProductAds` (Eltern zuerst, vorhandene
    unberührt, Namen aus Report-Spalten nur beim Anlegen). Die Upserts nutzen sie für fehlende Eltern (Zähler `placeholdersCreated`).
  - **Organisation:** `assertProfileInOrganization` in jedem Upsert und jedem `ensure*` (Review-Befund: `ON CONFLICT DO UPDATE` prüft
    keine FKs, fremde Zeilen wären sonst überschreibbar), Fehler `ProfileNotFoundError`.
  - **Kennzahlen** (`packages/db/src/amazon-ads-metrics.ts`): `replaceDailyMetrics(tx, { organizationId, profileId, adProduct, ranges,
    invalidRowCount, now, level, rows })` mit `level` `campaign` | `adGroup` | `target` | `productAd` | `searchTerm` und normalisierten
    Zeilen (`CampaignDailyMetric` …: Tag, Amazon-IDs, optionale Namen/ASIN/SKU für Platzhalter, `DailyMetricValues`). Währung aus dem
    Profil. Ablauf: Zeilen auf `ranges` filtern (Zähler `skipped`), Platzhalter, Upsert, dann Löschen der übrigen Zeilen im Ausschnitt
    (Profil, Ad-Typ, Tabelle, Tage in `ranges`) über `id <> all($ids::uuid[])` (ein Parameter, auch bei 150 000 Zeilen). Ergebnis
    `{ rows, skipped, deleted, placeholdersCreated }`. `ranges` müssen im Zeitraum des Auftrags liegen (so liefert es 1.4).
    - Kein Löschen bei `invalidRowCount > 0`. `MetricsImportRejectedError` bei: 0 Zeilen in den Tagen, obwohl der Ausschnitt Kennzahlen
      hat (bewusst nach dem Filter auf `ranges`); Datei nur mit ungültigen Zeilen (sonst endete ein falsches Zeilen-Schema als „importiert“
      und 1.7 setzte den Historien-Merker ohne Daten); doppelte Zeilen; Zeilen ohne Pflicht-ID. Die Zustandsmaschine (1.4) lässt den
      Auftrag bei diesem Fehler **sofort** `failed` (statt dreimal dieselbe Datei zu laden).
    - Die Kennzahlen im Fenster werden bei jedem Import neu geschrieben (kein Vergleich wie bei Entities; der Löschschritt braucht die IDs
      aller gelieferten Zeilen). Bei spürbarem WAL-/Vacuum-Druck später vergleichen und anders löschen.
  - **Für 1.6/1.7:** Der Port-`import` bildet die Report-Zeilen auf die normalisierten Typen ab (`spCampaigns` → `campaign` bzw. mit
    `groupBy` Ad Group → `adGroup`, `spTargeting` → `target`, `spAdvertisedProduct` → `productAd`, `spSearchTerm` → `searchTerm`) und
    ruft `replaceDailyMetrics` mit der Transaktion aus der Zustandsmaschine. Der Entity-Batch-Import (1.7) ruft die Upserts in
    Hierarchie-Reihenfolge in einer Transaktion; seine Zähler `created`/`updated`/`placeholders_filled` kommen aus den Upserts, `removed`
    aus einer neuen Funktion in 1.7.
  - Review (unabhängig): Org-Bindung für vorhandene Zeilen, `updated_at` bei unveränderten Entities, Atomarität der Upserts, vollständig
    ungültige Dateien und dauerhafte Fehler ohne Wiederholung behoben; Meldung der 0-Zeilen-Ablehnung präzisiert. Zurückgewiesen:
    FK Ad Group ↔ Kampagne (siehe oben).

### 1.6 Amazon-Client: Entities und Reports (`packages/amazon-ads`)
Endpunkte nach F1 (a), siehe ADR 004.
- [x] Exports: `requestExport(profile, 'campaigns' | 'adGroups' | 'targets' | 'ads', { adProducts, states })`, `getExport(id)`,
      `downloadExport(url)`. Content-Types laut Doku (`application/vnd.campaignsexport.v1+json` usw., beim Umsetzen prüfen).
- [x] Portfolios: `listPortfolios(profile)` mit Paginierung.
- [x] Reports: `requestReport(profile, { reportTypeId, adProduct, groupBy, columns, startDate, endDate })`, `getReport(id)`,
      `downloadReport(url)`. 425 als eigener Fehler mit Hinweis „läuft bereits“.
- [x] Normalisierung in ein eigenes Modell (`AmazonAdsCampaign` …) mit zod; IDs und Beträge als Strings (Beträge und alle gebrochenen
      Werte über `amazonDecimalSchema`, Währungen über `currencyCodeSchema`). Unbekannte Enum-Werte und unbekannte Währungscodes
      (`isKnownCurrencyCode`) durchreichen und loggen.
- [x] Download-Hosts: S3-URLs aus Amazon-Antworten nur per `https` und **ohne** Authorization-Header abrufen (Tokens gehen nie an fremde Hosts,
      Regel aus 0.5). Erlaubte Host-Muster als Konstante.
- [x] Mock-Anbieter erweitern: Entities für die Test-Profile (inkl. großer IDs, Beträge mit vielen Nachkommastellen, archivierter Kampagne,
      Negatives auf beiden Ebenen, Vendor-Profil ohne SKU), Reports als gzip-JSON mit simulierter Verarbeitungszeit, 425 und `FAILURE` auf Wunsch.
- [x] Tests mit msw für jeden Endpunkt (Paginierung, 429, 425, Validierungsfehler, verlustfreie Zahlen).
- [x] Umsetzung (Stand für 1.7 und später):
  - **Doku-Abgleich 2026-09-27** (Guides und OpenAPI-Specs `AmazonAdsAPIExports_prod_3p.json`, `OfflineReport_prod_3p.json`,
    `Portfolios_prod_3p.json`), Abweichungen zur bisherigen Annahme:
    - Export-Status laut Spec `PROCESSING`/`COMPLETED`/`FAILED` (der Guide schreibt `IN_PROGRESS`, wird ebenso als „läuft“ erkannt).
      Report-Status laut Spec `FAILED` (Guide: `FAILURE`, beides erkannt). Unbekannte Status gelten als „läuft“ und werden geloggt;
      die 4-h-Regel aus 1.4 beendet sie.
    - Exports liefern ohne `stateFilter` nur `ENABLED`/`PAUSED`; der Client fordert `ARCHIVED` immer mit an (F10). `GET /exports/{id}`
      braucht den Accept-Header des Export-Typs (sonst 406). Jede Status-Abfrage erzeugt eine neue URL (1 h gültig, bis 24 h nach
      Fertigstellung). **Amazon begrenzt laufende Exports auf 5 je Endpunkt** (FAQ): für 1.7/1.10 relevant, wenn viele Profile
      gleichzeitig synchronisieren.
    - **Ads und SB/SD-Targets tragen im Export keine `campaignId`** (gemeinsames Modell). SP-Targets haben sie. Das Modell hat deshalb
      `amazonCampaignId: string | null` bei Targets, Negatives und Product Ads; **1.7 ergänzt sie beim Batch-Import über die Ad Groups
      desselben Batches** (die DB-Records verlangen sie).
    - Portfolios v3: `POST /portfolios/list`, Content-Type und Accept `application/vnd.spPortfolio.v3+json`, `nextToken`-Paginierung;
      Zustandsfilter nimmt nur einen Wert, v3 kennt nur `ENABLED` (kein Filter gesendet).
    - Reporting v3: 425-Antwort laut Spec nur `{ code, detail }`. Übernommen wird die ID aus dem beobachteten Format
      „… duplicate of : <reportId>“, sonst die erste UUID im Text, sonst `null` (1.10 prüft das echte Format).
    - **`spSearchTerm` hält nur 65 Tage vor**, nicht 95 (Report-Typen-Seite). `REPORT_DEFINITIONS[…].retentionDays` trägt das; 1.7 nutzt es
      für die Historie (F4).
    - `Amazon-Ads-AccountId`: Die Spec nennt den Header optional (DSP), der Guide „erforderlich für alle Ad-Typen“. Der Client sendet ihn
      nicht; bleibt offen für 1.10.
  - **HTTP** (`http.ts`, `client.ts`): Option `decimals: 'string'` je Anfrage (Portfolios nutzen sie). Fehlerantworten übernehmen auch
    `detail` (Reporting v3); `AmazonAdsHttpError.details` trägt den bereinigten Text (höchstens 200 Zeichen).
  - **Downloads** (`download.ts`): `client.downloadFile(url)` für Reports und Exports (ein Aufruf statt `downloadReport`/`downloadExport`).
    Nur `https`, Hosts laut `AMAZON_ADS_DOWNLOAD_HOST_PATTERNS` (`offline-report-storage-*.s3…amazonaws.com`, `snapshots-prod-*.s3…`,
    aus den Doku-Beispielen; 1.10 gleicht die EU-Hosts ab), ohne Authorization- und Amazon-Header, ohne Weiterleitungen, Timeout 5 Min.,
    keine Wiederholung. 403/404 → `{ status: 'expired' }`, andere Status → `AmazonAdsHttpError`. Logs und Fehler nennen nur den Host.
    Downloads zählen nicht im `meter` (keine Ads-API-Anfrage).
  - **Portfolios** (`portfolios.ts`): `client.listPortfolios(connection, amazonProfileId, { meter })` → `AmazonAdsPortfolio[]` (Felder wie
    `PortfolioRecord`). Ein ungültiges Portfolio lässt den ganzen Aufruf scheitern (`AmazonAdsResponseError`), statt es zu überspringen:
    Übersprungene Portfolios gälten in 1.7 sonst als entfernt. Wiederholter `nextToken` oder mehr als 100 Seiten → Fehler.
  - **Exports** (`exports.ts`): `requestExport(connection, { amazonProfileId, exportType, adProduct })` → `{ exportId }`,
    `getExport(connection, { amazonProfileId, exportType, exportId })` → `AmazonAdsAsyncStatus` (404 → `NOT_FOUND`).
    `createExportRowSchema(exportType, { adProduct, logger })` validiert und normalisiert je Zeile:
    - Kampagnen → `AmazonAdsCampaign` (Budget aus `budgetCaps…monetaryBudget`, `budgetType` = `recurrenceTimePeriod`, Gebotsstrategie aus
      `optimization.bidStrategy`; Platzierungs-Anpassungen, `ruleAmount` als `budgetRuleAmount`, Tags, Lieferstatus in `extra`).
    - Targets → `{ kind: 'target', target }` bzw. `{ kind: 'negative', target }` mit `level` `ad_group`/`campaign` (ohne Ad Group).
      `targetType` klein (`KEYWORD` → `keyword`, `PRODUCT_CATEGORY` → `category`, `AUTO` → `auto`, `AUDIENCE` → `audience`, dazu
      `product_audience`, `category_audience`, `theme`, `content_category`; Unbekanntes klein durchgereicht und geloggt). `expression` =
      `targetDetails` unverändert (Dezimalzahlen als Quelltext), `keywordText`/`matchType` daraus.
    - Ads → `AmazonAdsProductAd` (ASIN/SKU aus `creative.products`, `adType` in `extra`). SB/SD-Ads (Video usw.) entscheidet 1.9.
    - Streng geprüft werden nur IDs, Zustand, Name, Beträge und Währungen. Felder, die nur in `extra` landen (Lieferstatus, Tags,
      Platzierungs-Anpassungen, Creative …), nehmen jede Form an; unlesbare Tage und Zeitpunkte werden `null`. Eine unerwartete Form
      kostet so höchstens ein Feld, nie die Entity (fehlende Entities gälten in 1.7 als entfernt). Keyword-Targets ohne Keyword-Text
      loggen einmal `amazon_ads.unexpected_shape` (Hinweis auf eine andere Verschachtelung im echten Export).
    - Zustände und Enum-Werte bleiben in Amazons Schreibweise (`ENABLED` …), wie in den 1.5-Tests. Fehlt `adProduct` in der Zeile,
      gilt der des Auftrags. Unbekannte Werte je Feld und Wert einmal als `amazon_ads.unknown_enum_value`.
  - **Reports** (`reports.ts`): Katalog `REPORT_DEFINITIONS` (Schlüssel = `report_type` der Aufträge): `spCampaigns`, **`spAdGroups`**
    (eigener Schlüssel für `spCampaigns` mit `groupBy: ['campaign', 'adGroup']`, sonst kollidierten beide im Schlüssel offener Aufträge),
    `spTargeting` (`keywordId` = Target-ID), `spAdvertisedProduct`, `spSearchTerm`; je Eintrag `level`, `reportTypeId`, `groupBy`,
    `columns` (Tag, IDs, Namen, Attribution nach F7), `retentionDays`. `reportTypesFor(adProduct)` liefert die Typen in
    Hierarchie-Reihenfolge. `requestReport(connection, { amazonProfileId, reportType, startDate, endDate })` prüft höchstens 31 Tage,
    Name `profitbash <typ> <start>..<ende>` (identisch bei erneutem Anfordern → 425 mit ID); 425 → `AmazonAdsDuplicateReportError`
    (`duplicateOfReportId`). `getReport` → `AmazonAdsAsyncStatus`. `createReportRowSchema(reportType)` → Kennzahlen im eigenen Modell
    (`AmazonAdsCampaignDailyMetric` …, Felder wie die Zeilen von `replaceDailyMetrics`; `unitsSoldClicks*` → `units*`,
    `attributedSalesSameSku*` → `salesSameSku*`); fehlende Attribution `null`, Zähler als sichere Ganzzahlen (auch negativ: eine
    Korrektur soll nicht die Zeile samt Kosten verwerfen), `extra` leer. Aus einem gekürzten 425-Text wird keine abgeschnittene ID
    übernommen (dann `null`).
  - **Mock** (`mock.ts`, `mock-data.ts`): Portfolios (Seiten zu 2), Exports, Reports und S3-Downloads je Mock-Profil, prüft Content-Type
    (415) und Accept (406) wie Amazon. Daten deterministisch: IDs = Profil-ID + Nummer (beim DE-Profil über `MAX_SAFE_INTEGER`), drei
    Kampagnen (eine archiviert), Negatives auf beiden Ebenen, Vendor ohne SKU, Tage ohne Aktivität fehlen, Kampagnen = Summe der Ad Groups,
    am ersten Tag feste Werte `0.005` (Kosten) und `1234567.89` (Umsatz). **Auftrags-IDs kodieren den Auftrag** (`mock_r_…`/`mock_e_…`):
    Auch ein neu gestarteter Prozess holt einen laufenden Report ab (DoD „Neustart“ mit dem Mock vorführbar). Option `simulation`
    (`now`, `processingMs` Standard 5 s, `failingReportTypes`, `duplicatesWithoutId`); 425 kommt bei identischer Anfrage während der
    Verarbeitung (nur im selben Prozess).
  - **Port** (`apps/worker/src/amazon-requests/amazon-port.ts`): `createAmazonRequestPort({ client, connection, amazonProfileIds, meter,
    logger, import })` erfüllt `AmazonRequestPort` aus 1.4. `amazonProfileIds`: interne Profil-ID → Amazon-Profil-ID aller Profile der
    Connection (1.7 lädt sie im Poll-Lauf). `import` liefert 1.7 (Abbildung auf die DB-Typen, `replaceDailyMetrics`, Entity-Upserts).
    Ein Test im Worker prüft per Typecheck, dass das Modell ohne Umbau auf die DB-Typen aus 1.5 passt (bei Targets, Negatives und Product
    Ads mit ergänzter Kampagne).
  - **Für 1.7:**
    - Entity-Batch-Import: Zeilen kommen als `AmazonAdsCampaign`/`…AdGroup`/`AmazonAdsExportedTarget`/`…ProductAd`. Kampagne für Ads
      (und SB/SD-Targets) über die Ad Groups des Batches ergänzen; fehlt die Ad Group im Batch, die Zeile als ungültig zählen oder über
      vorhandene Ad Groups in der DB auflösen (dort entscheiden).
    - Report-Import: `REPORT_DEFINITIONS[reportType].level` wählt `replaceDailyMetrics({ level, rows })`; die Zeilen passen ohne Umbau.
    - Historie (F4): Stücke je Report-Typ nur bis `retentionDays` zurück (`spSearchTerm` 65 Tage).
    - Rund 20 Report-Aufträge beim ersten SP-Sync je Profil und das Export-Limit (5 laufend je Endpunkt) beim Planen berücksichtigen.
    - **Kein `removed_at` aus einem Batch mit ungültigen Zeilen** (wie „kein Löschen bei `invalidRowCount > 0`“ bei Kennzahlen): Eine
      ungültige Zeile ist eine Entity, die im Batch fehlt, obwohl es sie gibt.
    - Programmierfehler im Port (Profil nicht in `amazonProfileIds`, Report- oder Export-Typ nicht im Katalog, Zeitraum über 31 Tage)
      werfen einfache Fehler, die die Zustandsmaschine wie vorübergehende behandelt (10 Versuche, rund 2 h). 1.7 legt Aufträge nur aus dem
      Katalog und in 31-Tage-Stücken an.
  - Review (unabhängig): Übernommen: Felder nur für `extra` tolerant statt streng (sonst verschwänden Entities bei einer anderen Form),
    Log bei Keyword-Targets ohne Keyword-Text, keine abgeschnittene ID aus gekürztem 425-Text, negative Zähler erlaubt, 429-Tests je
    Endpunkt, leerer Download-Body als Fehler, Budget-Tage der Portfolios normalisiert, unbekannte Ad-Typen geloggt, gemeinsamer
    `AdsEndpointDeps`-Typ, Typ-Vertrag zu den DB-Typen, Hinweis zur Bedeutung der Host-Liste. Zurückgewiesen: eigene, nicht wiederholbare
    Fehlerklasse für Programmierfehler im Port (tritt nur bei Fehlern in 1.7 auf, die Tests dort fangen; die Zustandsmaschine müsste dafür
    eine neue Fehlerart kennen). Offen gelassen: Enum-Prüfung für `matchType`, `targetingSettings` und Budget-Wiederholung (viele,
    je Ad-Typ verschiedene Werte; ohne echte Daten eher Rauschen).

### 1.7 Jobs (`apps/worker`)
Alle Datenjobs nehmen die Lease der Connection (1.3) und bleiben **kurz**: Ein Lauf erledigt eine begrenzte Menge Arbeit und plant bei
Bedarf den nächsten ein. `expireInSeconds` bleibt deshalb niedrig (ein verwaister aktiver Job blockiert bei `stately` die Queue der
Connection bis zum Ablauf; Graceful Shutdown wartet nur 30 s).
- [x] `entities-sync` je Connection: für jedes aktive, nicht entfernte Profil (F14) Portfolios lesen und **direkt** upserten (synchroner
      List-Aufruf, eigene Transaktion), dann je Ad-Typ vier Exports mit gemeinsamer `batch_id` anfordern (über 1.4). Der Job endet nach dem
      Anfordern; das Importieren übernimmt der Poll.
- [x] **Import eines Entity-Batches:** sobald Amazon **alle** Exports des Batches als fertig meldet (`completed`), lädt ein Poll-Lauf alle
      herunter und importiert sie in **einer** Transaktion in Hierarchie-Reihenfolge (Kampagnen → Ad Groups → Targets, Negatives, Product Ads).
      Speicher: bis zu 4 Dateien gleichzeitig, der Größendeckel aus 1.4 gilt je Datei. `removed_at` nur für Entities desselben (Profil, Ad-Typ,
      Entity-Typ), die schon **vor** dem Anfordern des Batches existierten und im Batch fehlen (Platzhalter, die währenddessen aus Reports
      entstanden, bleiben). Zähler: `profiles`, `created`, `updated`, `removed`, `placeholders_filled`.
- [x] **Scheitert ein Export des Batches** (`FAILURE`, abgelaufen, Import nach 3 Versuchen fehlgeschlagen), wird der **ganze Batch** `failed`:
      kein Import, kein `removed_at`. Einzelne Exports werden nicht neu angefordert (sonst mischten sich Stände verschiedener Zeitpunkte);
      der nächste `entities-sync` startet einen neuen Batch.
- [x] `reports-sync` je Connection: je Profil, Ad-Typ (F2) und Ebene (F6) einen Report über das rollierende Fenster (F3, F9) anfordern.
      Zähler: `requested`, `reused` (425), `failed_since_last_run` (Aufträge des Profils, die seit dem letzten `reports-sync` auf `failed`
      gingen; so werden Fehler aus dem Poll in einem Lauf mit Healthcheck sichtbar).
- [x] **Historie (F4) mit festem Merker:** Tabelle `amazon_ads_backfills` (`organization_id`, `profile_id`, `ad_product`, `report_type`,
      `from_date`, `completed_at`; zusammengesetzter FK (`profile_id`, `organization_id`)), unique (`profile_id`, `ad_product`, `report_type`).
      `reports-sync` fordert für jede Kombination ohne `completed_at` die fehlenden 31-Tage-Stücke an. Die Stücke enden am Tag **vor** dem
      Beginn des rollierenden Fensters, damit sie sich nicht mit ihm überschneiden. `completed_at` wird erst gesetzt, wenn alle Stücke
      `imported` sind (auch als `superseded`, siehe 1.4). So holt auch 1.9 (SB/SD für schon synchronisierte Profile) die Historie nach, und
      verlorene Stücke werden wiederholt, solange Amazon sie noch vorhält.
- [x] Der Poll zählt `imported`, `rows`, `superseded`, `failed`.
- [x] `amazon-requests-poll` je Connection: fragt fällige Aufträge ab (`next_poll_at <= now()`, Backoff 1 → 2 → 5 → 10 → 15 Min.), lädt
      und importiert höchstens eine begrenzte Zahl je Lauf (z. B. 5) und plant sich neu ein, solange Aufträge offen sind.
- [x] Cron-Auslöser `entities-sync-all` und `reports-sync-all` (F9), wie `profiles-sync-all` nur für aktive Connections. Dazu
      `amazon-requests-poll-all` alle 10 Min.: plant einen Poll für jede Connection mit offenen Aufträgen ein (holt nach Absturz oder Deploy auf).
- [x] **Kette bei „Jetzt synchronisieren“:** Jobdaten mit `chain: true` (nur der manuelle Auslöser setzt es): `profiles-sync` plant am Ende
      `entities-sync` ein, dieser `reports-sync`. Der tägliche Lauf von `profiles-sync` um 05:00 kettet nicht (Entities und Reports haben eigene
      Cron-Zeiten). Weil `entities-sync` nach dem Anfordern endet, können Reports vor den Entities importiert werden; die Platzhalter (1.5)
      sind dafür der vorgesehene Weg.
- [x] Bestehende Queues mit geänderten Optionen über `boss.updateQueue` (siehe `createQueues`).
- [x] Neue Namen in `CONNECTION_JOB_NAMES`, i18n-Keys `sync.job.*` und `sync.counter.*`, Reihenfolge in `COUNTER_ORDER`.
- [x] Healthchecks: `HEALTHCHECKS_ENTITIES_SYNC_URL`, `HEALTHCHECKS_REPORTS_SYNC_URL` (optional, https), in `.env.example` und `docs/deploy.md`.
      `amazon-requests-poll` pingt nicht (läuft oft und kurz); scheiternde Aufträge zeigen sich im Zähler `failed_since_last_run` von
      `reports-sync` und im Sync-Status.
- [x] `reauth_required`-Connections überspringen. Ausgeblendete Profile nach F14, entfernte Profile nicht.

- [x] Umsetzung (Stand für 1.8 und später):
  - **Jobs** (`apps/worker/src/jobs/`), alle mit Lease (`CONNECTION_JOBS` in `worker.ts`), gemeinsamer Aufbau in `amazon-context.ts`
    (Profile der Connection, Port, Zustandsmaschine, Import, Uhr `deps.now`). `ConnectionJobDeps` hat jetzt den vollen Amazon-Client,
    `enqueue` (Folgejobs) und `now`; `ConnectionJobRun` hat `runId` und `extendLease()` (vor jedem Profil bzw. Auftrag; eine verlorene
    Lease beendet den Lauf mit Fehler).
  - **`entities-sync`:** je nicht entferntem Profil (auch ausgeblendete) Portfolios lesen und in einer Transaktion upserten; Portfolios,
    die die (vollständige) Liste nicht mehr enthält und die vor dem Aufruf existierten, bekommen `removed_at` (Erweiterung: die Aufgabe
    nannte `removed_at` nur für Exports). Dann je Ad-Typ aus `ENTITY_AD_PRODUCTS` (heute nur SP, 1.9 ergänzt) ein Export-Batch über
    `submitAmazonExportBatch`. **Export-Plätze:** Laufen an der Connection schon `MAX_RUNNING_EXPORTS_PER_TYPE` (5) Exports eines Typs
    (`requested`), entsteht der Batch nur als Zeilen (`pending_request`, Zähler `exportsWaiting`); der Poll fordert sie an, sobald Platz ist
    (frühestens zum nächsten Termin eines laufenden Exports, mindestens 1 Min. später). Ob Amazons Limit je Profil, Konto oder App gilt, klärt 1.10. Ist für Profil und Ad-Typ noch ein Batch
    offen, entsteht kein neuer (1.4).
  - **Import** (`amazon-requests/import.ts`, das `import` des Ports): Batch in Hierarchie-Reihenfolge; fehlt Targets oder Ads die Kampagne,
    kommt sie von einer Ad Group desselben Batches, sonst von einer vorhandenen Ad Group in der DB (`findAdGroupCampaignIds`; die Exports
    eines Batches können wegen der Export-Plätze zeitversetzt laufen). Nicht auflösbare Zeilen
    werden übersprungen, geloggt (`entities_import.unresolved_campaign`, nur Anzahl) und zählen wie ungültige. `removed_at` nur ohne ungültige
    oder nicht auflösbare Zeilen im ganzen Batch, je Entity-Typ für Entities, die vor dem Anfordern **ihres** Exports (`requested_at`)
    angelegt wurden (`markEntitiesRemoved` in `amazon-ads-entities.ts`, ein Array-Parameter für die gesehenen IDs). Reports:
    `REPORT_DEFINITIONS[typ].level` → `replaceDailyMetrics`. Zähler des Imports (`created`, `updated`, `removed`, `placeholdersFilled`,
    `placeholdersCreated`) übernimmt der Poll nur, wenn der Auftrag danach `imported` ist (sonst rollte die Transaktion zurück).
  - **`reports-sync`:** „Gestern“ in der Zeitzone des Profils (`todayIn`), Fenster `ROLLING_WINDOW_DAYS` (30) Tage bis gestern, je Typ aus
    `reportTypesFor` (Ad-Typen `REPORT_AD_PRODUCTS`, heute SP). **Historie:** Merker `amazon_ads_backfills` (Migration
    `0010_amazon_ads_backfills`, Zugriffe `amazon-backfills.ts`, FK auf das Profil mit `ON DELETE CASCADE` wie die Aufträge). `from_date`
    wird beim ersten Lauf auf den ältesten Tag gesetzt, den Amazon noch vorhält (`retentionDays − 1 − RETENTION_MARGIN_DAYS` vor heute,
    ein Tag Abstand zur Grenze). Nachgeladen wird `[max(from_date, heute vorgehalten), Tag vor dem Fenster]` ohne die Tage importierter oder
    offener Reports, in 31-Tage-Stücken ab vorn. `completed_at`, sobald alle diese Tage importiert sind (auch `superseded`); Tage, die
    Amazon inzwischen nicht mehr hält, gelten dabei als verloren. Der erste SP-Lauf fordert je Profil 19 Reports an (5 Fenster, 4 × 3 bzw.
    2 Stücke). Achtung F5: Die Deckung liest die Auftragszeilen, die nach 30 Tagen gelöscht werden; hängt eine Historie länger, lädt sie
    schon importierte Tage erneut (harmlos, solange Amazon sie hält).
  - **`failedSinceLastRun`:** gescheiterte Aufträge (Reports und Exports) der Connection mit `updated_at` nach dem Ende des vorigen
    `reports-sync`-Laufs (`findPreviousJobRun`), am Anfang des Laufs gezählt (eigene Fehlschläge stehen in `failed`). Ist er größer als 0,
    endet der Lauf nach getaner Arbeit als Fehlschlag (Healthchecks `/fail`), damit gescheiterte Aufträge Alarm schlagen.
  - **`amazon-requests-poll`:** `listDueAmazonRequests` (höchstens 20), je Auftrag `advanceAmazonRequest`, höchstens 5 Downloads und 5 Min.
    je Lauf (`POLL_LIMITS`), danach plant er sich zum frühesten `next_poll_at` der Connection neu ein (`schedulePoll`, mindestens 5 s;
    nichts offen: kein Poll). `entities-sync` und `reports-sync` planen ihn ebenso ein. Zähler `requested`, `reused`, `imported`, `rows`,
    `superseded`, `failed`, `exportsWaiting` plus die des Imports. Pingt keinen Healthcheck.
  - **Kurz bleiben:** `entities-sync` und `reports-sync` enden nach `DATA_JOB_TIME_BUDGET_MS` (5 Min.) vor dem nächsten Profil und planen
    sich mit `resumeFromProfileId` neu ein (Zähler `continued`, `chain` bleibt erhalten; Reihenfolge der Profile nach Anlage). Scheitert ein
    Profil (nicht die Connection), laufen die übrigen weiter (Zähler `profileErrors`, Log `amazon_data_job.profile_failed`), der Lauf endet
    danach als Fehlschlag mit Zählern. Ein Fehler der Connection (`Retry-After`) plant den Job **ab dem betroffenen Profil** neu ein
    (`handleProfileLoopError`, sonst träfen die vorderen Profile bei jedem Versuch erneut die Pause) und behält die Zähler bis dahin;
    `chain` bleibt erhalten. Eine verlorene Lease (`LeaseLostError`) beendet den Lauf sofort. Fällt ein Folgejob weg, weil in der Queue
    schon einer für die Connection wartet (`stately`), loggt `enqueueFollowUp` `job.follow_up_dropped`.
  - **Kette:** `chain` in den Jobdaten; nur `POST /api/connections/:id/sync` setzt es (nicht der OAuth-Callback, nicht der Cron).
    `profiles-sync` → `entities-sync` (`chain: true`) → `reports-sync` (erst nach dem letzten Profil).
  - **Zeitpläne** (`queues.ts`): `entities-sync-all` und `reports-sync-all` um 06:00 Berlin (beide gleichzeitig; die Lease reiht sie),
    `amazon-requests-poll-all` alle 10 Min., plant nur Connections mit fälligen Aufträgen ein (`listConnectionsWithDueAmazonRequests`,
    nur aktive Connections). `createQueues` gleicht bestehende Queues per `updateQueue` an `QUEUE_OPTIONS` an (Policy ausgenommen).
    Hinweis: Der Auslöser des Polls schreibt alle 10 Min. einen plattformweiten `job_runs`-Eintrag (nicht im Sync-Status der Org).
  - **Sync-Status/i18n:** `CONNECTION_JOB_NAMES` um die drei Jobs erweitert, Texte `sync.job.*`/`sync.counter.*`, Reihenfolge in
    `COUNTER_ORDER`. Zählernamen in camelCase wie bisher (`placeholdersFilled`, `failedSinceLastRun` statt der Schreibweise oben).
  - **Healthchecks:** `HEALTHCHECKS_ENTITIES_SYNC_URL`, `HEALTHCHECKS_REPORTS_SYNC_URL` (`.env.example`, `docs/deploy.md`).
  - Review (unabhängig): Übernommen: Alarm bei gescheiterten Aufträgen, Fortsetzen nach `Retry-After` beim betroffenen Profil, Zähler
    bei Abbruch, verlorene Lease als Abbruch, Log bei weggefallener Kette, Text für `continued`, wartende Exports erst zum Termin eines
    laufenden, Kampagne über vorhandene Ad Groups. Nur festgehalten: `created_at` (Uhr der DB) wird mit `requested_at` (Uhr des Workers)
    verglichen (in Produktion dieselbe Zeit; im DoD-Test mit fester Uhr kann deshalb nichts entfernt werden, `removed_at` testet
    `import.test.ts`); ein neuer Auftrag kann bis zum schon eingeplanten nächsten Poll warten (höchstens 15 Min.); `PROFILE_PAUSED` gilt
    weiter für die ganze Connection (1.3). **Offen:** pg-boss arbeitet je Queue und Prozess einen Job gleichzeitig ab (`localConcurrency`
    1), ein langer Poll einer Connection verzögert also die anderen. Erhöhen, sobald mehrere Connections laufen (Speicher bei `inline`
    beachten: bis zu 50 MB je Datei).
  - **DoD-Test** `apps/worker/src/jobs/data-sync.test.ts` (Mock, nur das DE-Profil): füllt alle Entity- und Kennzahl-Tabellen (große IDs,
    `0.005`, `1234567.89`), zweiter Lauf ohne Änderungen, lokal veränderte Werte kommen per Upsert zurück (der Mock hat keine veränderbaren
    Daten, daher so), Neustart (neuer Client) während laufender Reports verliert nichts.

### 1.8 Sichtbares (`apps/api`, `apps/web`)
Nach F11.
- [x] Sync-Status zeigt die neuen Jobs und Zähler (mit 1.7 erledigt: Namen, i18n-Keys, `COUNTER_ORDER`).
- [x] Connections-Seite: Profiltabelle mit Spalte „Daten bis“ (der Ablauf der Einwilligung ist mit 1.2 erledigt) aus einer neuen Spalte
      `amazon_ads_profiles.metrics_imported_through` (date), die der Import eines Kampagnen-Reports auf `max(end_date)` setzt (nicht
      `max(date)` der Kennzahlen: ein pausiertes Profil hätte sonst ein altes Datum; nicht aus den Auftragszeilen: die werden nach 30 Tagen
      gelöscht). Endpunkt begrenzt die Profile über `visibleProfilesScope`.
- [x] Optional aus dem Review-Backlog: Sync-Status „läuft seit“ für laufende Jobs (hilft beim Erkennen hängender Jobs und belegter Leases).
- [x] Umsetzung (Stand für 1.9 und später):
  - **Merker** (seit 1.9 je Ad-Typ in eigener Tabelle, siehe dort): Spalte `amazon_ads_profiles.metrics_imported_through` (`date`, Migration `0011_amazon_ads_profiles_metrics_imported_through`,
    ohne Nachbefüllung: bestehende Profile zeigen „–“ bis zum nächsten Kampagnen-Report). `markMetricsImportedThrough` in
    `amazon-ads-metrics.ts` setzt `greatest(alt, Tag)` (rückt nur vor, ein Stück der Historie setzt nicht zurück), lässt `updated_at`
    unverändert (Datenstand, keine Stammdaten) und prüft die Organisation (`ProfileNotFoundError`). `importReport` (`import.ts`) ruft sie für
    Report-Typen der Ebene `campaign` mit dem **`end_date` des Auftrags** auf, nicht mit dem Ende der `ranges`: Tage außerhalb der `ranges`
    deckt ein neuerer, schon importierter Report desselben Typs ab. Läuft in der Import-Transaktion (ein gescheiterter Import setzt nichts);
    überholte Aufträge importieren nicht, der neuere hat den Merker gesetzt. Auch ein Report ohne Zeilen setzt ihn (Profil ohne Aktivität).
  - **API:** `metricsImportedThrough` (`YYYY-MM-DD` oder `null`) im `Profile`-Schema, also in `GET /api/connections/:id/profiles`
    (weiter über `visibleProfilesScope`) und in der Antwort von `PATCH /api/profiles/:id`; OpenAPI und `schema.gen.ts` neu erzeugt.
  - **Web:** Spalte „Daten bis“ in `ProfileGrid.vue` über den neuen Helfer `formatDay` (`packages/shared`): Kalendertag ohne Umrechnung in
    die Zeitzone des Browsers, numerisch mit fester Breite in jeder Sprache (`25.09.2026`, `09/25/2026`). Spaltenbreiten so gewählt, dass
    die Tabelle bei 1440 px mit ausgeklappter Sidebar ohne Scrollen passt (Summe 1120; die Mindestbreite berechnet
    `useGridMinWidth` in `apps/web/src/grid/min-width.ts` aus den Spalten, siehe Nachtrag unten).
  - **Sync-Status:** Die Spalte „Dauer“ zeigt bei laufenden Jobs die bisherige Dauer (ohne „seit“: Der Status daneben sagt „Läuft“, die
    Mono-Spalte bliebe sonst zu schmal). Sie zählt jede Sekunde weiter: `DurationCell` rechnet mit einer Uhr im reaktiven Grid-Kontext,
    die nur tickt, solange ein Job läuft. Neue Daten allein zeichnen nicht neu (Structural Sharing der Abfrage, AG Grid aktualisiert nur
    geänderte Zeilen; `api.refreshCells` bräuchte das nicht registrierte `RenderApiModule`). Geht die Uhr des Browsers nach, zeigt ein
    gerade gestarteter Lauf 0 statt „–“.
  - Review (unabhängig): Übernommen: weiterzählende Dauer (vorher eingefroren), Breiten bei 1440 px und veraltete Mindestbreiten beider
    Tabellen, englische Datumsformate zu breit, negative Dauer bei Uhrabweichung, Jahre unter 100 in `formatDay`. Nur festgehalten:
    lange Job-Namen („Amazon-Aufträge abholen“) und die Startzeit werden im Sync-Status schon seit 1.7 knapp abgeschnitten (eigene
    Aufgabe, Umbruch sah schlechter aus).

  - **Nachtrag Spaltenbreiten (nach 1.8):** Der Sync-Status passt Status, Job, Start und Dauer nach neuen Zeilen an ihren Inhalt an
    (`autoSizeColumns`, `ColumnAutoSizeModule` und `ColumnApiModule` registriert, Zeilen-Virtualisierung aus, Mono-Schrift vorher
    geladen); Amazon-Konto und Ergebnis kürzen mit nativem `title` (auf Touch nicht erreichbar, vorerst akzeptiert). Beide Tabellen
    bekommen ihre Mindestbreite aus `useGridMinWidth` (feste Breiten + Mindestbreiten der Flex-Spalten), darunter scrollt der Container.
    Dauer hat `minWidth` 160 („12 Std. 59 Min.“ passt, obwohl zwischen zwei Anpassungen weiterzählt; ab 100 Std. wird sie bis zur
    nächsten Anpassung knapp), Amazon-Konto 180, Ergebnis 280. Bei 1440 px mit ausgeklappter Sidebar: Sync 1122, Profile 1120 von
    1128 px. Gemessen mit Overlay-Scrollbars (macOS); mit klassischer Scrollbar (~15 px) scrollen beide Tabellen waagerecht, ohne
    etwas abzuschneiden.

### 1.9 Weitere Ad-Typen (nach F2)
- [x] **Offen aus 1.8:** „Daten bis“ ist heute das Maximum über alle Kampagnen-Reports des Profils. Mit `sbCampaigns`/`sdCampaigns`
      (ebenfalls Ebene `campaign`) zeigte ein Profil den Stand von SP, auch wenn SB/SD hängen. Vor dem Umsetzen entscheiden: Merker je
      Ad-Typ oder Minimum über die aktiven Ad-Typen des Profils.
      **Entschieden (Dominik, 2026-09-27): Merker je Ad-Typ, angezeigt wird das Minimum über die synchronisierten Ad-Typen.**
  - Umsetzung: Tabelle `amazon_ads_profile_metrics_imported_through` (Organisation, Profil, `ad_product`, `imported_through`;
    Schlüssel Profil + Ad-Typ, Migration `0012_amazon_ads_profile_metrics_imported_through`) ersetzt die Spalte
    `amazon_ads_profiles.metrics_imported_through` (ohne Übernahme: noch kein Deploy, lokal füllt der nächste Kampagnen-Report sie).
    `markMetricsImportedThrough` nimmt `adProduct` (Upsert mit `greatest`, fremdes Profil → `ProfileNotFoundError`); `importReport`
    übergibt den Ad-Typ des Auftrags. `metricsImportedThroughSql(adProducts)` liefert für ein `select` über die Profile das Minimum
    über die übergebenen Ad-Typen und `null`, solange einem davon ein Tag fehlt (ein neuer Ad-Typ zeigt also „–“, bis sein erster
    Kampagnen-Report importiert ist; ein dauerhaft scheiternder Ad-Typ fällt zusätzlich über die Alarme aus 1.7 auf). Die API
    (`GET /api/connections/:id/profiles`, `PATCH /api/profiles/:id`) rechnet über `REPORT_AD_PRODUCTS`, das jetzt in
    `@profitbash/amazon-ads` liegt (Schlüssel von `REPORT_TYPES_BY_AD_PRODUCT`) und das `reports-sync` ebenso nutzt: Ein Ad-Typ,
    den der Sync anfordert, zählt automatisch für „Daten bis“. API-Form unverändert (`metricsImportedThrough`).
- [x] **Offen für SB und SD (aus dem Review des ersten Punkts):** `REPORT_AD_PRODUCTS` gilt für alle Profile. Lehnt Amazon SB- oder
      SD-Reports für ein Profil dauerhaft ab (z. B. ohne Brand Registry, SD im Marktplatz nicht verfügbar, Kontotyp), zeigt es „Daten
      bis“ für immer „–“, obwohl SP aktuell ist. Beim Umsetzen entscheiden: Ad-Typen, die ein Profil nicht nutzen kann, im Sync
      überspringen und „Daten bis“ über die für dieses Profil synchronisierten Ad-Typen rechnen (mit Dominik abstimmen).
      **Entschieden (Dominik, 2026-09-28): nach Kampagnen.** SP wird immer angefordert. SB (später SD) nur für Profile mit mindestens
      einer Kampagne dieses Ad-Typs in der DB (aus dem Entity-Sync, auch archivierte, entfernte und Platzhalter). „Daten bis“ ist das
      Minimum über genau diese Ad-Typen. Neue SB-Kampagnen bekommen Reports ab dem nächsten `reports-sync`, die Historie holt der
      Merker aus 1.7 nach. Verworfen: Ad-Typ nach Amazon-Fehler abschalten (Fehlercodes vor 1.10 unbekannt).
- [x] SB: Entities (Exports decken SB ab) und Reports (`sbCampaigns`, `sbAdGroup`, `sbTargeting`, `sbAds`); Hinweis auf die v3-Preview-Lücke
      (SB-Kampagnen ohne Multi-Ad-Group fehlen) in der UI-Doku von Phase 2 vermerken.
  - **Doku-Abgleich 2026-09-28** (Report-Typ-Seiten Campaign, Ad group, Targeting, Ad, Search term, Spalten-Seite, Exports-Guide;
    die OpenAPI-Spec nennt keine Spalten je Typ): `sbCampaigns` (groupBy `campaign`), `sbAdGroup` (`adGroup`), `sbTargeting`
    (`targeting`), `sbAds` (`ads`), `sbSearchTerm` (`searchTerm`), alle 60 Tage Aufbewahrung, höchstens 31 Tage je Anfrage.
    `sales`, `purchases`, `unitsSold` zählen 14 Tage nach Klick **oder View**, `salesClicks`, `purchasesClicks`, `unitsSoldClicks` nur
    nach Klick. `salesPromoted`/`purchasesPromoted` sind laut Doku dasselbe wie `…SameSku14d` (Einheiten ohne Same-SKU). Widerspruch:
    `unitsSoldClicks` fehlt auf der Seite von `sbTargeting`, die Spalten-Seite nennt `sbTargeting` dort aber; `sbSearchTerm` hat es
    nirgends, dazu kein `…Promoted`. Angefordert werden nur Spalten, die auf beiden Seiten stehen (eine falsche Spalte ließe jeden
    Report mit 400 scheitern).
  - **Entschieden (Dominik, 2026-09-28):**
    - Attribution: `*_14d` = Klick + View (`sales`, `purchases`, `unitsSold`, wie die Konsole). Neue Spalten `sales_clicks_14d`,
      `purchases_clicks_14d`, `units_clicks_14d` in allen Kennzahl-Tabellen für den Klick-Anteil (SP bleibt dort `null`, SP ist nur
      klick-basiert; SD nutzt sie später auch). Same-SKU aus `salesPromoted`/`purchasesPromoted`, `units_same_sku_14d` bleibt `null`.
    - SB-Ads (`VIDEO`, `PRODUCT_COLLECTION`, `STORE_SPOTLIGHT`, 0–n ASINs, keine SKU) in `amazon_ads_product_ads`, `sbAds` in deren
      Kennzahlen. `asin` nur bei genau einem Produkt, sonst `null`; alle ASINs in `extra.asins`.
    - `sbSearchTerm` kommt mit (Begründung wie F6: nach 60 Tagen weg).
  - **Target-IDs:** `sbTargeting` liefert `keywordId` („keyword or targeting expression“) und `targetingId` getrennt, der Export legt
    beide in `targetId` zusammen. Abbildung: `keywordId`, sonst `targetingId`; weicht `targetingId` ab, steht sie in `extra`. 1.10 prüft
    das gegen echte Daten.
  - **Hinweis für die UI-Doku von Phase 2** (Verweis auch in `docs/plan.md` §5): SB-Reports in v3 sind „Preview“: Kampagnen mit `isMultiAdGroupsEnabled=false` (ältere
    SB-Kampagnen) fehlen in den Reports. Ihre Entities kommen über den Export, Kennzahlen nicht; die UI muss das bei SB-Summen erklären.
  - Umsetzung (Stand für SD und 1.10):
    - **Klick-Spalten:** `sales_clicks_14d` (`numeric`), `purchases_clicks_14d`, `units_clicks_14d` (`bigint`) in allen fünf
      Kennzahl-Tabellen (Migration `0013_amazon_ads_metrics_clicks_14d`), in `DailyMetricValues` (`packages/db`) und
      `AmazonAdsDailyMetricValues` (`packages/amazon-ads`) als `salesClicks14d` usw.; SP setzt sie `null`. SD kann sie übernehmen.
    - **Reports** (`reports.ts`): Katalog-Schlüssel = Amazons `reportTypeId` (`sbCampaigns`, `sbAdGroup`, `sbTargeting`, `sbAds`,
      `sbSearchTerm`), Ebenen `campaign`, `adGroup`, `target`, `productAd`, `searchTerm`, `retentionDays` 60. Spalten siehe
      Doku-Abgleich oben; ein Test prüft die Listen genau. Zeilen-Schemas: `sales`/`purchases`/`unitsSold` → `*14d`, `…Clicks` →
      `*Clicks14d`, `salesPromoted`/`purchasesPromoted` → `*SameSku14d`, alles andere `null`. `sbAds` liefert keine ASIN (Platzhalter
      ohne ASIN; der Export füllt sie). `sbTargeting` ohne `keywordId` und `targetingId` ist ungültig.
    - **Ad-Typen je Profil:** `REPORT_AD_PRODUCT_SELECTION` (`@profitbash/amazon-ads`: `always` SP, `withCampaigns` SB) steuert beides:
      `selectReportAdProducts` (`amazon-ads-metrics.ts`, prüft die Organisation) liefert die Ad-Typen, für die `reports-sync` ein Profil
      anfordert; `metricsImportedThroughSql(selection)` rechnet „Daten bis“ über dieselben (SQL mit ausdrücklich qualifizierten
      Spalten: In `select`-Feldern rendert Drizzle Spalten ohne Tabelle, ein `"id"` in einer Unterabfrage träfe sonst die falsche;
      `exists` je Ad-Typ statt aller Kampagnen des Profils).
      `REPORT_AD_PRODUCTS` bleibt die Liste aller Ad-Typen im Katalog.
    - **Entities:** `ENTITY_AD_PRODUCTS` = SP und SB, für **jedes** Profil (erst der Export zeigt, ob es SB nutzt). Folgen: je Profil
      täglich ein zweiter Export-Batch; das Limit `MAX_RUNNING_EXPORTS_PER_TYPE` (5 je Connection) greift ab dem dritten Profil, die
      übrigen Batches warten (`exportsWaiting`) und laufen über den Poll. Weil `entities-sync` vor dem Import endet, fordert erst der
      **nächste** `reports-sync` SB an (bei „Jetzt synchronisieren“ also erst am Folgetag oder beim nächsten manuellen Lauf); bis dahin
      zeigt „Daten bis“ „–“, danach holt der Merker die Historie (60 Tage) nach.
    - **SB-Ads** (`exports.ts`): `asin`/`sku` nur bei genau einem Produkt dieses Typs, mehrere ASINs in `extra.asins`; `adType`, `name`,
      `headline` wie bisher in `extra`. Gilt unverändert für SP (ein Produkt).
    - **Mock** (`mock-data.ts`): SB nur für das DE-Profil (zwei Kampagnen, Ad Groups ohne Standardgebot, Keyword-, Themen- und
      Produkt-Target, ein Negative, ein Video- und ein Kollektions-Ad); SB-Targets im Export ohne `campaignId`; SB-Reports mit
      View-Anteil (`sales` > `salesClicks` an manchen Tagen); `sbTargeting` nennt Keywords per `keywordId`, Themen/Produkte per
      `targetingId`. Report-Zeilen enthalten nur die angeforderten Spalten (gilt auch für SP; der Mock-Test prüft das).
    - **DoD-Test** (`data-sync.test.ts`): SB-Entities kommen mit dem ersten Lauf, SB-Kennzahlen in allen fünf Tabellen mit dem nächsten
      `reports-sync`, „Daten bis“ wartet bis dahin (`null`).
    - Test-Stabilität: `entities-sync.test.ts` prüft das erste Profil in Job-Reihenfolge, nicht DE (Profile aus einer Transaktion
      sortieren nach zufälliger UUID). `data-sync.test.ts` scheiterte im vollen Lauf ab und zu auf Dateiebene: `DROP DATABASE … WITH (FORCE)`
      beim Aufräumen des Klons durfte als `profitbash` (kein Superuser) einen Autovacuum-Worker nicht beenden (`42501`, „permission
      denied to terminate process“, im Server-Log belegt; trifft schreiblastige Testdateien). `dropDatabaseForce` in `testing.ts`
      wiederholt das `DROP` bei `42501` (bis zu 10 Versuche, kurze Pausen), auch beim Neuaufbau der Template-DB. Vermutlich war das
      auch die Ursache des einmal roten `worker.test.ts`.
    - Review (unabhängig): keine kritischen oder wichtigen Befunde. Übernommen: `exists` statt Lesen aller Kampagnen, Spalten der
      „Daten bis“-SQL über Drizzle statt als Text, API-Test mit SB-Kampagne (`null`, dann Minimum), 1.10-Punkte zu `sbSearchTerm` und
      SB-Negatives, Verweis in `plan.md`. Flake von `data-sync.test.ts` danach behoben (siehe oben).
- [x] SD: Entities und Reports (`sdCampaigns`, `sdAdGroup`, `sdTargeting`, `sdAdvertisedProduct`); SD-Metriken sind klick- **und**
      view-basiert, Spalten entsprechend (`extra` oder eigene Spalten, beim Umsetzen entscheiden).
  - **Doku-Abgleich 2026-09-28** (Report-Typ-Seiten Campaign, Ad group, Targeting, Advertised product, Spalten-Seite, Exports-Guide):
    `sdCampaigns` (groupBy `campaign`), `sdAdGroup` (`adGroup`), `sdTargeting` (`targeting`), `sdAdvertisedProduct` (`advertiser`),
    alle 65 Tage Aufbewahrung, höchstens 31 Tage je Anfrage; `matchedTarget` bewusst nicht. Die Spalten-Seite schreibt
    `sdAdGroups` (wie `sbAdGroups`), gemeint ist `sdAdGroup`. Auf beiden Seiten für alle vier Typen: `impressions`, `clicks`,
    `cost`, `sales`, `salesClicks`, `salesPromotedClicks`, `purchases`, `purchasesClicks`, `purchasesPromotedClicks`, `unitsSold`,
    `unitsSoldClicks`, `impressionsViews`, `date`, `campaignId`, `campaignName`; `adGroupId`/`adGroupName` außer bei `sdCampaigns`;
    `targetingId` nur `sdTargeting` (kein `keywordId`); `adId`, `promotedAsin`, `promotedSku` nur `sdAdvertisedProduct` (nicht
    `advertisedAsin` wie SP). `sales`/`purchases`/`unitsSold` zählen Klick **oder** View, `…Clicks` nur Klick, `…PromotedClicks`
    = Same-SKU **nur nach Klick**. Eigene `…Views`-Spalten gibt es für SD nicht (View-Anteil = gesamt − Klick). `costType`
    (CPC/VCPM) steht nur in `sdCampaigns`, kommt aber schon über den Export (`extra.costType`).
    Export: Kampagnen `targetingSettings` = Taktik (`T00020`/`T00030`), Targets ohne `campaignId`, `targetId` = SD-`targetId`
    (entspricht `targetingId` im Report), Ads `PRODUCT_AD`/`IMAGE`/`VIDEO` mit ASIN **oder** SKU.
  - **Entschieden (Dominik, 2026-09-28):**
    - `impressionsViews` (sichtbare Impressionen nach MRC, Abrechnungsbasis bei vCPM) in allen vier SD-Reports, neue Spalte
      `viewable_impressions` (`bigint`) in allen fünf Kennzahl-Tabellen (SP/SB `null`). Mehr View-Kennzahlen nicht.
    - SD-Same-SKU (`salesPromotedClicks`, `purchasesPromotedClicks`) in `sales_same_sku_14d`/`purchases_same_sku_14d`; bei SD
      klick-basiert, also gegen `*_clicks_14d` zu lesen (Hinweis in `plan.md` §5). `units_same_sku_14d` bleibt `null`.
  - Umsetzung (Stand für 1.10 und Phase 2):
    - **Sichtbare Impressionen:** `viewable_impressions` (`bigint`) in allen fünf Kennzahl-Tabellen (Migration
      `0014_amazon_ads_metrics_viewable_impressions`), in `DailyMetricValues` und `AmazonAdsDailyMetricValues` als
      `viewableImpressions`; SP und SB setzen `null`.
    - **Reports** (`reports.ts`): `sdCampaigns`, `sdAdGroup`, `sdTargeting`, `sdAdvertisedProduct` (Ebenen `campaign`, `adGroup`,
      `target`, `productAd`, kein Suchbegriff-Report), `retentionDays` 65, Spalten siehe Doku-Abgleich; ein Test prüft die Listen
      genau. Zeilen-Schemas: `sales`/`purchases`/`unitsSold` → `*14d`, `…Clicks` → `*Clicks14d`, `…PromotedClicks` →
      `*SameSku14d`, `impressionsViews` → `viewableImpressions`; `targetingId` ist die Target-ID (Pflicht), `promotedAsin`/
      `promotedSku` → `asin`/`sku`. Gemeinsame Ad-Group-Spalten von SB und SD heißen jetzt `AD_GROUP_REPORT_COLUMNS`.
    - **Ad-Typen je Profil:** SD in `REPORT_AD_PRODUCT_SELECTION.withCampaigns` (wie SB: Reports und „Daten bis“ nur für Profile mit
      SD-Kampagne) und in `ENTITY_AD_PRODUCTS` (für jedes Profil). Folge: je Profil täglich drei Export-Batches; das Limit
      `MAX_RUNNING_EXPORTS_PER_TYPE` (5 je Connection) greift schon ab dem zweiten Profil, die übrigen warten auf den Poll. Die
      Historie (65 Tage) braucht zwei 31-Tage-Stücke je Typ, zusammen mit dem Fenster zwölf SD-Reports beim ersten Lauf.
    - **Exports:** keine Code-Änderung nötig; ein Test belegt Taktik als `targetingType`, `costType` in `extra`, Targets ohne
      `campaignId` (Zielgruppe, Produkt, Kategorie, Negative auf Ad-Group-Ebene), Product-Ads nur mit SKU (`asin` `null`) und
      Bild-Ads mit mehreren ASINs (`extra.asins`). Kommentare in `exports.ts` nennen SD.
    - **Mock** (`mock-data.ts`): SD nur für das DE-Profil (vCPM-Kampagne `T00030` mit Zielgruppe, CPC-Kampagne `T00020` mit
      Produkt- und Kategorie-Target, ein Negative, ein Product-Ad nur mit SKU, ein Bild-Ad mit zwei ASINs). SD-Reports mit
      View-Anteil, Same-SKU als Teil des Klick-Anteils und sichtbaren Impressionen (Kampagne = Summe der Ad Groups).
    - **DoD-Test** (`data-sync.test.ts`): SD-Entities mit dem ersten Lauf, SD-Kennzahlen in vier Tabellen (keine Suchbegriffe) mit dem
      nächsten `reports-sync`, `viewable_impressions` nur bei SD; „Daten bis“ wartet auf SB und SD.
    - **Bekannte Lücke (1.10 prüfen):** Der Export überschreibt die ASIN, die ein Report-Platzhalter mitgebracht hat. Nennt Amazon
      bei SD-Product-Ads von Sellern nur die SKU, bleibt `asin` in `amazon_ads_product_ads` leer, obwohl `sdAdvertisedProduct` sie
      liefert. Falls ja: ASIN aus dem Report übernehmen, wenn der Export keine nennt.
    - Review (unabhängig): keine kritischen oder wichtigen Befunde. Übernommen: Kommentare in `reports-sync.ts` und
      `connections.ts` nennen SD, der zweite DoD-Lauf vergleicht auch Same-SKU, Klick-Anteil, sichtbare Impressionen und die
      Zeilen aller Kennzahl-Tabellen, der Warte-Test in `entities-sync.test.ts` rechnet aus den vorbelegten Batches, der
      DB-Test „außerhalb der Auswahl“ nutzt einen fiktiven Ad-Typ statt SD, vCPM-Gebote in `plan.md` §5. Die ASIN-Lücke
      bleibt bewusst offen (Verhalten des echten Exports unbekannt, Kennzahlen gehen nicht verloren); der DoD-Test hält sie
      sichtbar fest.

### 1.10 Erster echter Lauf (nach der Freigabe)
- [ ] Ein Profil mit echten Kampagnen synchronisieren, Zählwerte gegen die Amazon-Konsole abgleichen (Stichprobe: Kosten und Klicks einer
      Kampagne an drei Tagen). Abweichungen und Überraschungen hier festhalten: Header `Amazon-Ads-AccountId`,
      Content-Types, Laufzeiten, 429-Quote, ob Amazon offene Reports je Profil begrenzt (der erste SP-Sync fordert rund 20 an), ob `targetId`
      im Export der `keywordId` bzw. `targetId` in `spTargeting`/`spSearchTerm` entspricht, ob sich Amazon-IDs über Ad-Typen eines Profils
      überschneiden können. Aus 1.6: Download-Hosts der EU (`AMAZON_ADS_DOWNLOAD_HOST_PATTERNS`), Format des 425-Texts (Report-ID),
      Export-Status-Schreibweise, ob SP-Product-Ads im Export ASIN und SKU tragen, Limit von 5 laufenden Exports je Endpunkt,
      Form von `targetDetails` (flach oder verschachtelt, Log `amazon_ads.unexpected_shape`), `startDate` vs. `startDateTime` bei Kampagnen,
      ob `spSearchTerm` für Auto- und Produkt-Targets immer `keywordId` liefert, ob Vendor-Profile `advertisedSku` und die Same-SKU-Spalten
      in `spAdvertisedProduct` annehmen (ein 400 dort ließe Vendor-Reports dauerhaft scheitern). Aus 1.7: ob die Aufbewahrungsgrenze
      (`retentionDays`, ein Tag Abstand) hält (sonst scheitert das älteste Stück der Historie täglich), für wen das Export-Limit gilt
      (`MAX_RUNNING_EXPORTS_PER_TYPE` je Connection), Laufzeiten von `entities-sync`/`reports-sync` mit echtem Budget. Aus 1.9 (SB): ob
      Amazon SB-Exports für Profile ohne SB (ohne Brand Registry, Vendor) leer liefert oder ablehnt (Ablehnung ließe den SB-Batch täglich
      scheitern und Alarm schlagen; dann SB-Exports je Profil abschalten), wie sich der zweite Export-Batch je Profil auf das Export-Limit
      auswirkt, ob `sbTargeting` `keywordId` und `targetingId` wie angenommen füllt und welche davon der Export-`targetId` entspricht
      (`extra.targetingId` bei Abweichung), ob `sbTargeting` `unitsSoldClicks` doch annimmt (Doku widersprüchlich, heute nicht
      angefordert), ob SB-Kennzahlen (`sales` inkl. Views) zur Konsole passen, ob SB-Ads im Export `creative.products` tragen, ob
      `sbSearchTerm` für Themen- und Produkt-Targets immer `keywordId` liefert (sonst zählen die Zeilen als ungültig: kein Löschen im
      Fenster, bei nur ungültigen Zeilen Ablehnung), ob SB-Exports Negatives ohne Ad Group (Kampagnenebene) enthalten und ob sie dann
      `campaignId` tragen (sonst nicht auflösbar: der SB-Batch setzt nie `removed_at`). Aus 1.9 (SD): ob Amazon SD-Exports und
      -Reports für Profile ohne SD (Vendor ohne SD, Marktplatz ohne SD) leer liefert oder ablehnt (wie bei SB), wie sich der dritte
      Export-Batch je Profil auf das Export-Limit und die Laufzeit auswirkt, ob `sdTargeting` `targetingId` der Export-`targetId`
      entspricht, ob SD-Product-Ads im Export ASIN und SKU tragen (siehe bekannte Lücke in 1.9), ob `sdAdvertisedProduct` je Ad und
      Tag genau eine Zeile liefert (Bild-/Video-Ads mit mehreren ASINs; doppelte Zeilen lassen den Import scheitern), ob Vendor-
      Profile `promotedSku` annehmen (ein 400 ließe SD-Reports dauerhaft scheitern), ob `sales` inkl. Views und
      `impressionsViews` zur Konsole passen und `vCPM`-Kosten sich aus `cost` und `viewable_impressions` nachrechnen lassen. Aus
      Phase 2 (`phase-2.md` F4): ob die Konsole bei Agency-Profilen SP mit 7 Tagen zeigt (wie bei Sellern) und welche Einheiten sie
      bei SB-Targets zählt (`unitsSoldClicks` fehlt dort).
- [ ] Keine Kundennamen, IDs oder Werte in Commits, Tests oder Actions-Logs.

### 1.11 Datei-Import (optional, nur mit Auslöser)
**Entschieden (Dominik, 2026-09-27):** Wird nur gebaut, wenn Phase 2 fertig ist und die Ads-API-Freigabe dann immer noch fehlt
(Dominik kann den Stichtag ändern). Sonst nicht bauen.
**Ausgelöst (Dominik, 2026-09-29):** Phase 2 ist fertig, die Freigabe fehlt weiter; 1.11 kommt vor Phase 3 (`phase-3.md` F1).
Die Schreibschicht bleibt quellenneutral: Phase 3 übermittelt Änderungen bis zur Freigabe als Bulk-Datei (`phase-3.md` F2).
Beim Umsetzen zuerst in Teilaufgaben zerlegen (Formate der Bulk-Datei und der Reports prüfen, Profil ohne Connection,
Upload, Import-Job) und Fragen an Dominik sammeln (u. a. welche Reports er herunterladen kann und wie oft).
- Entities aus der Bulk-Datei der Werbekonsole, Tageskennzahlen aus den täglichen Sponsored-Ads-Reports der Konsole.
- Profile von Hand anlegen (Profil ohne Connection).
- Upload und Import-Job über `runJob`; geschrieben wird über dieselbe Schreibschicht wie der API-Sync (1.5, normalisierte Datensätze).
- Hintergrund: Bulk-Dateien tragen dieselben IDs wie die API (ein späterer API-Sync setzt nahtlos fort), enthalten aber nur
  Zeitraumsummen; Tageswerte kommen aus den separaten Reports. Wegwerf-Anteil: Parser, Upload, Job.
- Testdaten nur synthetisch (öffentliches Repo).

**Doku-Abgleich 2026-09-29** (öffentliche Amazon-Doku: Bulksheets-Guides unter `advertising.amazon.com/API/docs/en-us/no-code-tools/bulksheets/…`
samt Release Notes, Hilfe-Artikel zu den Sponsored-Ads-Berichten und zu den neuen Berichten):
- **Bulk-Datei** (Kampagnenmanager → Bulk-Vorgänge): Excel, Blätter „Portfolios“, „Sponsored Products Campaigns“, „SB multi-ad group
  campaigns“ (ältere SB-Kampagnen vor 11/2022 im Blatt „Sponsored Brands“), ein SD-Blatt, optional Suchbegriffe (SP, SB). Kennzahlen
  nur als **Summe über den gewählten Zeitraum** (höchstens 60 Tage), keine Tageswerte; ein Schalter „Leistungsdaten“ kann sie
  weglassen, „nur bestimmte Kampagnen“ liefert eine Teilmenge. Spalten: `Product`, `Entity`, `Operation`, `Campaign ID`, `Ad Group ID`,
  `Portfolio ID`, `Ad ID`, `Keyword ID`, `Product Targeting ID` (SD: `Targeting Id`), Namen, `State`, Budget, Gebote, `Keyword Text`,
  `Match Type`, `Bidding Strategy`, Ausdrücke u. a. Die Schreibweise wechselt („Campaign Id“ vs. „Campaign ID“, Zusätze wie
  „(Read only)“, „(Informational only)“), und **Kopfzeilen und Enum-Werte sind in der Sprache des Werbekontos** (Deutsch übersetzt).
  Datum `YYYYMMDD`, Dezimalpunkt, keine Tausendertrennzeichen; keine Währungsspalte (außer Portfolios). Laut Doku unterscheiden sich
  die Bulk-IDs von den IDs in der URL der Konsole; dass sie den API-IDs entsprechen, steht nicht wörtlich da (Annahme wie bisher, mit
  1.10 prüfen).
- **Alte Sponsored-Ads-Berichte** enden am **31.12.2026** (ab 17.12.2026 keine neuen). Sie tragen nur Namen, keine IDs.
- **Neue Berichte** („Berichte“/Unified Reporting, Nachfolger): Zeitdimension Tag, Detailstufen Kampagne, Ad Group, Target mit
  **IDs** (`campaign.id` = `campaignId` usw.), Währungscode, bis 24 Monate zurück, höchstens **120 Tage je Download**, Versand als
  E-Mail (einmalig, täglich, wöchentlich). Für Sponsored-Ads-Anzeigen keine Ad-ID. Attribution: SP 7 Tage (Seller) bzw. 14 Tage
  (Vendor), sonst 14 Tage, Metriknamen ohne „7 Day“-Präfix. Ältere SB-Kampagnen ohne Ad Groups fehlen (wie die v3-Preview-Lücke).
  Genaue Spaltennamen und Dateiformat (CSV/XLSX) stehen nicht in der Doku.

**Befund aus einer echten Bulk-Datei** (Dominik, 2026-09-29, deutsches Konto, SP; ausgewertet wurden nur Blattnamen, Kopfzeilen,
Zelltypen und Werte-Listen, keine Datenzeilen; die Datei liegt nicht im Repo):
- Blätter: „Portfolios“, „Sponsored Products-Kampagnen“, „Sponsored Brands-Kampagnen“ (älteres SB), „SB Anzeigengruppe Kampagnen“,
  „Sponsored Display-Kampagnen“, „SP Bericht „Suchbegriff““, „SB Bericht „Suchbegriff““, dazu versteckt „Config“ (Listen der
  **englischen** API-Werte je Entity und Operation, `veryHidden`) und „Sheet8“ (`Version (1.0)`). Dateiname
  `bulk-<konto-id>-<von>-<bis>-<zeitstempel>.xlsx` (Konto-ID klein geschrieben, Zeitraum `YYYYMMDD`).
- Kopfzeilen deutsch, z. B. SP: `Produkt`, `Entität`, `Operation`, `Kampagnen-ID`, `Anzeigengruppen-ID`, `Portfolio-ID`,
  `Anzeigen-ID`, `Keyword-ID`, `Produkt-Targeting-ID`, `Kampagnenname`, `Name der Anzeigengruppe`, `Startdatum`, `Enddatum`,
  `Targeting-Typ`, `Zustand`, `Tagesbudget`, `SKU`, `ASIN (Nur zu Informationszwecken)`, `Standardgebot für die Anzeigengruppe`,
  `Gebot`, `Keyword-Text`, `Übereinstimmungstyp`, `Gebotsstrategie`, `Platzierung`, `Prozentsatz`, `Ausdruck für Produkt-Targeting`,
  Kennzahlen `Impressions`, `Klicks`, `Ausgaben`, `Verkäufe`, `Bestellungen`, `Einheiten` (plus abgeleitete). SD zusätzlich `Taktik`,
  `Kostenart`, `Targeting-ID`, `Targeting-Ausdruck`, `Sichtbare Impressions`, `… (Aufrufe und Klicks)`. Portfolios `Budget-Betrag`,
  `Budgetwährungscode`, `Budget-Linie`.
- **Werte ebenfalls deutsch:** Entität `Kampagne`, `Anzeigengruppe`, `Produktanzeige`, `Keyword`, `Negatives Keyword`,
  `Produkt-Targeting`, `Negatives Produkt-Targeting`, `Gebotsanpassung` (Platzierung); Zustand `Aktiviert`, `Angehalten`;
  Targeting-Typ `Manuell`, `Automatisch`; Match-Typ `Genau Passend`, `Wortgruppe`, `Negativ Genau Passend`, `Negative Wortgruppe`;
  Gebotsstrategie `Dynamische Gebote – nur senken` (mit geschütztem Leerzeichen), `Feste Gebote`; Platzierungen `Top-Platzierung`,
  `Platzierung Rest der Suche`, `Platzierung Produktseite`, `Platzierung für Amazon Business`; Budget-Linie `Keine Obergrenze`.
  Auto-Targets kommen als `Produkt-Targeting` mit Ausdrücken wie `close-match`/`substitutes`, Produkt-Targets als `asin="…"`.
- **Zellen:** Texte als `inlineStr` (auch alle IDs, 12–15 Ziffern, und `Startdatum` `YYYYMMDD`), Zahlen als `n` in
  Gleitkomma-Darstellung mit Rundungsresten (z. B. `…99999999999999`): Beträge beim Lesen auf 15 signifikante Stellen normalisieren,
  nie über `number` rechnen.
- Das Suchbegriff-Blatt trägt Kampagnen-, Ad-Group-, Keyword- und Produkt-Targeting-ID, aber nur Zeitraumsummen.

**Entschieden (Dominik, 2026-09-29):**
- Tagesdaten aus den **neuen Berichten mit IDs** (nicht aus den alten ohne IDs).
- Rhythmus **wöchentlich** je Profil: eine Bulk-Datei (Struktur, Gebote, Budgets) und ein Tagesbericht über die letzten 30 Tage
  (Amazon korrigiert jüngere Tage; ersetzt wird wie beim API-Sync genau der Zeitraum der Datei).
- Datei-Profile werden **später mit der API-Connection zusammengeführt** (gleiche IDs, Historie bleibt). Deshalb dieselben Tabellen und
  Schlüssel wie der API-Sync.
- Der Import liest **deutsche und englische** Kopfzeilen und Werte.
- Bibliothek für Excel: **fflate + saxes** mit eigenem schmalem Leser (auch für das Schreiben in Phase 3).
- Dominik schickt die echten Kopfzeilen (nur Spaltennamen) je Blatt der Bulk-Datei und eines neuen Tagesberichts, Deutsch und
  Englisch. Bis dahin gilt die Doku; die Namen werden danach abgeglichen (Offen, siehe 1.11d/1.11e).

Teilaufgaben (Reihenfolge):

#### 1.11a Profil ohne Connection
- [x] Migration: `amazon_ads_profiles.connection_id` und `amazon_profile_id` nullable (die Konsole zeigt die Profil-ID nicht); CHECK:
      mit Connection auch Amazon-Profil-ID. Der Unique-Index (Organisation, Amazon-Profil-ID) bleibt (NULL zählt nicht doppelt).
- [x] Anlegen durch Org-Admins: `POST /api/profiles` (Name, Land, Währung, Zeitzone mit Vorschlag aus dem Land, Kontotyp), zod,
      `audit_event` `profile.create`; Liste `GET /api/profiles/file` (Profile ohne Connection, über `visibleProfilesScope`).
- [x] Bestehende Stellen null-sicher (Profil-Sync, Jobs je Connection, „Zuletzt synchronisiert“, Connections-Seite); Dashboard und
      Explorer zeigen Datei-Profile wie andere.
- [x] Connections-Seite: Abschnitt „Profile ohne Connection (Datei-Import)“ mit Anlegen-Dialog, Kunde zuordnen, Ausblenden.
- [x] Umsetzung (Stand für 1.11b und später):
  - **Schema:** Migration `0018_file_profiles` (beide Spalten nullable, CHECK `amazon_ads_profiles_connection_amazon_id_ck`). Der
    zusammengesetzte FK (`connection_id`, `organization_id`) greift bei NULL nicht (MATCH SIMPLE). Alle Jobs wählen Profile über
    `connection_id = …`, Datei-Profile erreichen also keinen Sync. `withAmazonProfileId` (`system-access.ts`) macht aus der
    Amazon-Profil-ID der Connection-Profile wieder `string` und wirft, falls der CHECK je verletzt wäre.
  - **Vorgaben:** `AMAZON_MARKETPLACES`/`marketplaceFor` (`packages/shared/src/marketplaces.ts`: EU-Marktplätze, UK, TR, US, CA mit
    Währung, Zeitzone, Marktplatz-ID wie in den Amazon-Profilen). `fileProfileCreateSchema` (strikt): Name 1–120 Zeichen, bekannter
    Marktplatz, **Währung = Währung des Marktplatzes**, Zeitzone nur als kanonischer IANA-Name (`isCanonicalTimeZone` über
    `Intl.supportedValuesOf`; Offsets wie `+01:00` liest Postgres mit umgekehrtem Vorzeichen, Kürzel und Kleinschreibung ebenso
    abgelehnt), Kontotyp `seller` | `vendor` | `agency`. Die Marktplatz-ID setzt der Server.
  - **DB:** `createFileProfile` (`packages/db/src/file-profiles.ts`) prüft die Admin-Rolle, legt an und schreibt `profile.create`
    (`source: 'file'`, `after` mit Marktplatz-ID) in einer Transaktion.
  - **API:** `POST /api/profiles` (201, `Profile`) und `GET /api/profiles/file` (Liste über `visibleProfilesScope` mit ausgeblendeten
    und entfernten, `connection_id is null`), beide `orgAdminOnly`. `Profile.connectionId` und `.amazonProfileId` (auch in den
    Filter-Optionen) sind jetzt nullable. Zuordnen und Ausblenden über das bestehende `PATCH /api/profiles/:id`.
  - **Datenstand:** „Letzter Sync“ im Dashboard übergeht Profile ohne Connection (bis 1.11c zählen dort nur Report-Syncs). „Daten
    bis“ zeigt für ein Datei-Profil ohne Import „noch kein Datenstand“, wie bei einem neuen API-Profil.
  - **Web:** `FileProfilesCard.vue` (eigene Kachel unter den Connections, auch ohne Connection und bei deren Ladefehler; Skelett,
    Leer- und Fehlerzustand; `ProfileGrid` wiederverwendet), `CreateFileProfileDialog.vue` (Marktplatz, Kontotyp, Zeitzone mit
    Suche als Auswahl, Währung nur als Anzeige). Query-Key `['profiles', org, 'file']` unter `allProfiles`, damit die optimistischen
    Profil-Änderungen auch hier greifen. Im Browser-Pane geprüft (Anlegen, Anzeige, Dashboard und Explorer ohne Konsolenfehler).
  - Review (unabhängig): keine kritischen Befunde. Übernommen: Zeitzone nur kanonisch (vorher `Intl`-Prüfung, die `+01:00`
    zuließ), Währung an den Marktplatz gebunden, Abschnitt unabhängig vom Laden der Connections, Marktplatz-ID im Audit, Hinweis
    zu 1.11g. Bewusst so: Marktplatz und Kontotyp tragen sichtbare Überschriften plus `aria-label` am Select (wie die Auswahl der
    Clients); `GET /api/profiles/file` neben `PATCH /api/profiles/{id}` (ein künftiges `GET /api/profiles/{id}` darf `file` nicht
    als ID lesen).

#### 1.11b Tabellen-Leser (`packages/sheets`)
- [x] XLSX gestreamt (fflate entpackt, saxes liest `sharedStrings` und die Blätter Zeile für Zeile), Blattnamen, Zellen als Text
      (Zahlen verlustfrei als Quelltext, keine Umwandlung über `number`), Größendeckel entpackt. CSV (RFC 4180, Trennzeichen `,`/`;`,
      BOM). Tests nur mit synthetischen Dateien, die der Test selbst erzeugt.
- [x] Umsetzung (Stand für 1.11c und später):
  - **Paket** `@profitbash/sheets` (nur Server, Abhängigkeiten `fflate` 0.8.3 und `saxes` 6.0.0, exakt gepinnt).
    `openXlsx(datei, { maxUncompressedBytes, maxCells })` → `{ sheets: [{ name, state }], forEachRow(blatt, cb) }`;
    `forEachCsvRow(text | bytes, cb, { maxBytes })` → `{ delimiter }`; Fehler als `SheetReadError` mit `code`
    (`NOT_XLSX`, `INVALID_XML`, `TOO_LARGE`, `SHEET_NOT_FOUND`, `INVALID_CSV`); Meldungen nennen Teil, Zeile und Spalte, nie
    Inhalte der Datei. Test-Baustein `buildXlsx` unter `@profitbash/sheets/testing` (synthetische Dateien, auch unkomprimiert).
  - **XLSX:** eigenes Zentralverzeichnis der ZIP (verlässliche Größen auch bei Data Descriptors; Zip64 und Verschlüsselung
    abgelehnt), Entpacken in 8-KB-Schritten (ein Stück höchstens rund 8 MB, bevor das Budget greift), UTF-8 streng, saxes
    (keine Entities aus DTDs, externe DOCTYPEs werden nicht geladen). `sharedStrings`, `inlineStr` samt Rich Text (ohne
    `rPh`), Typen `s`/`str`/`b`/`e`/`n` als Text, Zahlen als Quelltext (Gleitkomma-Reste wie `123.45000000000002` bleiben stehen:
    Normalisieren ist Sache der Abbildung in 1.11d/e). Spalte aus der Adresse (sonst fortlaufend), Lücken als `''`, fehlende
    Zeilen als `[]` (Zeilennummern bleiben richtig). Abgelehnt: Zeilen über 1 048 576 oder nicht aufsteigend, Spalten jenseits
    XFD oder doppelt, Verweise auf fehlende gemeinsame Texte; mehr als `maxCells` (Standard 30 Mio., Lücken mitgezählt) oder
    `maxUncompressedBytes` (Standard 500 MB über die ganze Datei) → `TOO_LARGE`. Zeilen vor einem Fehler sind schon geliefert:
    Aufrufer schreiben erst nach dem Ende des Blatts.
  - **CSV:** RFC 4180, Trennzeichen `,`/`;`/Tab aus der Kopfzeile (außerhalb von Anführungszeichen), BOM, CRLF, Zeilennummern wie
    in Excel (leere Zeilen zählen mit, werden nicht geliefert), Text nach schließendem Anführungszeichen abgelehnt, Standardgrenze
    200 MB (als Text im Speicher).
  - **Gemessen** (lokal): echte Bulk-Datei (Dominik, SP, 9 Blätter) 52 ms, Zeilenzahlen wie eine unabhängige Auswertung;
    synthetisch 200 000 Zeilen × 11 Spalten (10 MB gepackt) 2,2 s bei 72 MB Heap; CSV 400 000 Zeilen (45 MB) 0,6 s.
  - Review (unabhängig): Übernommen: Grenzen für Zeilennummern, Spalten und Zellen (vorher legte eine winzige Datei mit
    `r="30000000"` den Prozess lahm), Ablehnung doppelter und rückwärts laufender Zeilen und fehlender gemeinsamer Texte (vorher
    still umnummeriert bzw. leer), kleinere Entpack-Schritte, Fehler ohne saxes-Text, Tests für unkomprimierte Teile, Umlaute
    über Stückgrenzen und das Trennzeichen in Anführungszeichen, CSV-Zeilennummern und Text nach Anführungszeichen. Bewusst so:
    doppelte Namen im ZIP-Verzeichnis (der letzte gilt), `xl/workbook.xml` fest statt über `_rels/.rels`, eine Signatur im
    Archiv-Kommentar (Amazon erzeugt nichts davon).

#### 1.11c Upload und Import-Job
- [ ] Tabelle `file_imports` (Organisation, Profil, Art `bulk` | `daily_report`, Dateiname, Größe, SHA-256, Status, Zähler, Fehler,
      hochgeladen von/am); Inhalt nur bis zum Import (danach gelöscht, F5: keine Rohdateien).
- [ ] `POST /api/profiles/:id/file-imports` (Multipart, Größendeckel, Org-Admin bzw. `write`), Audit, Job `file-import` über `runJob`
      (eine Datei je Profil gleichzeitig), sichtbar im Sync-Status.

#### 1.11d Bulk-Datei → Entities
- [ ] Kopfzeilen über Aliasse (DE/EN, alte und neue Schreibweisen), Blätter SP, SB, SD, Portfolios auf die normalisierten Datensätze
      (1.5) und dieselben Upserts. `removed_at` nur aus vollständigen Dateien (keine Teilmenge, keine ungültigen Zeilen). Zeitraumsummen
      nicht als Tageswerte speichern.

#### 1.11e Tagesbericht → Kennzahlen
- [ ] Neue Berichte (Tag, Kampagne/Ad Group/Target mit IDs) auf `replaceDailyMetrics` (Ebenen `campaign`, `adGroup`, `target`),
      Zeitraum der Datei ersetzen, Attribution je Ad-Typ und Kontotyp, Währung prüfen, „Daten bis“. Product Ads (keine Ad-ID) und
      Suchbegriffe erst nach Sichtung der echten Spalten entscheiden.

#### 1.11f Oberfläche
- [ ] Hochladen je Profil (welche Datei, welcher Zeitraum), Verlauf der Importe mit Ergebnis und Fehlern, Hinweis bei veralteten Daten.

#### 1.11g Zusammenführen mit der API (nach der Freigabe, mit 1.10)
- [ ] Datei-Profil mit dem API-Profil zusammenführen, danach übernimmt der API-Sync dieselben Zeilen.
  - **Achtung (Review 1.11a):** Der OAuth-Callback plant sofort `profiles-sync`; der legt für dasselbe Amazon-Profil eine **neue**
    Zeile an (die Amazon-Profil-ID des Datei-Profils ist leer, der Upsert findet keinen Konflikt). Nachträglich die ID am
    Datei-Profil setzen scheitert am Unique-Index. Also entweder vor dem ersten Sync zuordnen (Callback bzw. Profil-Sync kennt die
    Zuordnung, z. B. über Land und Konto-ID) oder die Zeilen des neuen Profils zusammenführen (Entities und Kennzahlen hängen je
    `profile_id`; Entities über die Amazon-IDs abgleichen). Beim Umsetzen entscheiden.

## `.env.example`

Neu in Phase 1 (Vorschlag): `HEALTHCHECKS_ENTITIES_SYNC_URL`, `HEALTHCHECKS_REPORTS_SYNC_URL` (1.7), optional `AMAZON_ADS_REQUESTS_PER_SECOND` (1.3).

## Bewusst nicht in Phase 1

- Keine Datenansichten: kein Explorer, kein Dashboard, keine Charts (Phase 2)
- Keine Wechselkurse und keine EUR-Summen (Phase 2, siehe F8)
- Keine Writes an Amazon, keine Gebots- oder Budgetänderungen (Phase 3)
- Kein Amazon Marketing Stream, keine stündlichen Daten (Dayparting ist Phase 5; Stream bräuchte eine eigene AWS-Infrastruktur)
- Keine Benachrichtigung zum Token-Ablauf (Phase 5), nur die Anzeige
- Keine Placement-Reports (F6, erst bei Bedarf)
- Kein Sponsored TV, kein DSP, keine SP-API-Daten (Phase 7)
- Keine Profil-Freigaben oder Kundenzugänge (Phase 6); neue Tabellen folgen ADR 002 ohne Vorgriff darauf

## Reihenfolge für Claude Code

1.1 → 1.2 → 1.3 → 1.4 → 1.5 → 1.6 (SP) → 1.7 → 1.8 → 1.9 (nach F2) → 1.10 (nach der Freigabe). 1.11 nur mit Auslöser (siehe dort).

Eine frische Session je Aufgabe (1.5 und 1.6 ggf. in Entities und Reports geteilt). Nach jedem Schritt: Tests grün, kleiner Commit,
Häkchen in dieser Datei, Umsetzungsnotizen unter der Aufgabe („Umsetzung (Stand für …)“ wie in Phase 0).
