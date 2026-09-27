# Phase 1 – Daten

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§5 „Festlegungen für Phase 1 und später“), `docs/tasks/phase-0.md`
> (Umsetzungsnotizen 0.5–0.7), `docs/decisions/` (001 Stack, 002 Mandanten-Modell, 003 Decimal-Library, 004 Amazon-API).
>
> **Status: abgestimmt (2026-09-26), in Umsetzung.** Entscheidungen stehen als **F1–F14** unter „Fragen an Dominik“.
> Entschieden: F1–F11, F13, F14. Offen: F12 (betrifft nur die Doku in `phase-0.md`, nicht den Code; Stand 2026-09-27 unter F12).
> Aufgaben, die von einer Frage abhängen, verweisen darauf.

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
- [ ] Neue Jobs laufen über `runJob`, schreiben `job_runs` mit Zählern, erscheinen im Sync-Status (i18n-Keys) und pingen Healthchecks (außer `amazon-requests-poll`, siehe 1.7).
- [ ] Jede neue Tabelle trägt `organization_id`, jede Tabelle mit Profildaten zusätzlich `profile_id` (die Lease-Tabelle aus 1.3 gilt je
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
- [ ] Tabelle `amazon_ads_report_requests` (gilt auch für Exports, Spalte `kind`):
  - `organization_id`, `profile_id`, `kind` (`report` | `export`), `ad_product` (**ein** Ad-Typ je Auftrag, auch bei Exports),
    `report_type` (z. B. `spCampaigns`, bei Exports `campaigns`/`adGroups`/`targets`/`ads`), `start_date`, `end_date` (nur Reports),
    `batch_id` (Exports eines Entity-Syncs gehören zusammen, siehe 1.7), `amazon_request_id` (Text, leer bis zur Antwort von Amazon)
  - `status`: `pending_request` → `requested` → `completed` → `imported`, oder `failed`
  - `attempts` (Status-Abfragen), `import_attempts`, `next_poll_at`, `requested_at`, `completed_at`, `imported_at`,
    `failure_reason` (gekürzt, ohne URLs), `row_count`, `invalid_row_count`
  - Die Download-URL wird **nicht** gespeichert (signiert, läuft ab); sie wird beim Abholen frisch per Status-Abfrage gelesen.
  - Unique (`profile_id`, `kind`, `ad_product`, `report_type`, `start_date`, `end_date`) mit **`NULLS NOT DISTINCT`** als partieller Index auf
    offene Aufträge (`status` nicht `imported`/`failed`): kein doppelter offener Auftrag, auch bei Exports (Daten leer) und nach Neustart.
- [ ] **Erst schreiben, dann anfordern:** Zeile mit `pending_request` anlegen, dann Amazon aufrufen, dann `amazon_request_id` speichern.
      Stirbt der Prozess dazwischen, findet der nächste `amazon-requests-poll` die Zeile ohne ID (sie zählt als offener Auftrag, auch für den
      Dispatcher in 1.7) und fordert erneut an. Antwortet Amazon dann mit 425
      (identische Anfrage läuft noch): die Report-ID aus der Fehlerantwort übernehmen, falls Amazon sie liefert (beim Umsetzen prüfen),
      sonst `next_poll_at` in 15 Min. und dann erneut anfordern.
- [ ] **Abbruchregel:** `failed` erst, wenn Amazon bei einer Abfrage noch `PENDING`/`PROCESSING` meldet und der Auftrag älter als 4 h ist,
      oder wenn Amazon `FAILURE` meldet. Ein Auftrag, den nur wir nicht abgefragt haben (Absturz, Deploy), wird beim nächsten Poll normal abgeholt.
- [ ] **Download:** Entpacken gestreamt mit Größendeckel (z. B. 50 MB entpackt, sonst `failed` mit Hinweis), dann `parseJsonLossless`
      über den ganzen Text (der Parser arbeitet nicht auf Streams). Der Deckel schützt den Speicher bei `WORKER_MODE=inline`; bei Bedarf
      später ein verlustfreier Streaming-Parser (neue Abhängigkeit, ADR-Notiz). zod-Validierung je Zeile; ungültige Zeilen zählen
      (`invalid_row_count`) und ohne Werte loggen.
- [ ] **Import:** Reports je Auftrag in **einer** Transaktion (Regeln in 1.5), danach `imported`. **Ausnahme Exports:** Sie werden je
      `batch_id` gemeinsam importiert, Importversuche zählen je Batch (Regeln in 1.7). Scheitert der Import, bleibt der Auftrag
      `completed` und wird beim nächsten Poll erneut geladen; nach 3 Importversuchen `failed` (sonst lädt ein Fehler die Datei endlos).
      Ist die URL abgelaufen, frisch per Status-Abfrage holen; liefert Amazon die Datei nicht mehr, neu anfordern.
- [ ] **Reihenfolge:** Ein Report-Auftrag importiert nur die Tage, die kein **später angeforderter**, schon importierter Auftrag desselben
      Profils, Ad-Typs und Report-Typs abdeckt (sonst überschrieben ältere Werte neuere); das Ersetzen des Ausschnitts (1.5) gilt dann nur für
      diese Tage. Deckt ein neuerer Auftrag alle Tage ab, endet der Auftrag als `imported` mit Zähler `superseded` (seine Tage sind ja durch den
      neueren importiert; für den Historien-Merker in 1.7 zählt er als importiert).
- [ ] Wartung: `job-runs-cleanup` löscht abgeschlossene Aufträge älter als 30 Tage (F5).
- [ ] Tests (gegen die Fake-Schnittstelle): Absturz vor und nach dem Anfordern, 425 mit und ohne ID, 429 beim Status, `FAILURE`,
      abgelaufene URL, Datei über dem Deckel, kaputte Zeile, dreimal scheiternder Import, überholter Auftrag.

### 1.5 Schema für Entities und Kennzahlen (`packages/db`)
Allgemeine Regeln für alle Tabellen dieser Aufgabe:
- `id` (uuid), `organization_id`, `profile_id`; zusammengesetzter FK (`profile_id`, `organization_id`) → `amazon_ads_profiles`
  (dafür unique (`id`, `organization_id`) an `amazon_ads_profiles` ergänzen, wie bei Clients/Connections).
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
- [ ] `amazon_ads_portfolios`: Name, Status, Budget (`budget_amount`, `budget_currency_code`, Budget-Typ, Zeitraum), `in_budget`.
- [ ] `amazon_ads_campaigns`: `portfolio_id` (nullable), Name, Status, Targeting-Typ (manuell/auto), Budget (Betrag, Währung, Typ),
      Gebotsstrategie, Start-/Enddatum, Platzierungs-Anpassungen in `extra`.
- [ ] `amazon_ads_ad_groups`: `campaign_id`, Name, Status, Standardgebot (`default_bid`, Währung).
- [ ] `amazon_ads_targets`: `campaign_id`, `ad_group_id` (nullable bei SB-Kampagnen-Targets), Art (`keyword` | `product` | `category` |
      `auto` | `audience`), Ausdruck (Keyword-Text + Match-Typ bzw. Target-Ausdruck als jsonb), Status, Gebot.
- [ ] `amazon_ads_negative_targets`: Ebene (`campaign` | `ad_group`), `campaign_id`, `ad_group_id` (nullable), Art, Ausdruck, Match-Typ, Status.
      Eigene Tabelle, weil Negatives kein Gebot und keine Kennzahlen haben. Quelle: voraussichtlich `/targets/export` mit Negativ-Kennzeichen
      (kein eigener Endpunkt; beim Umsetzen prüfen).
- [ ] `amazon_ads_product_ads`: `campaign_id`, `ad_group_id`, ASIN, SKU (nullable, Vendoren haben keine), Status.

Kennzahlen (je Tag, Datum in der Zeitzone des Profils, so liefert Amazon es):
- [ ] `amazon_ads_campaign_daily_metrics`, `amazon_ads_ad_group_daily_metrics`, `amazon_ads_target_daily_metrics`,
      `amazon_ads_product_ad_daily_metrics`, `amazon_ads_search_term_daily_metrics` (F6; Schlüssel zusätzlich Suchbegriff-Text, bezogen auf das Target).
- [ ] Gemeinsame Spalten: `organization_id`, `profile_id`, FK auf die Entity, `date`, `ad_product`, `currency_code`, `impressions`, `clicks`,
      `cost`, dazu Attribution nach F7 (`sales_7d`, `sales_14d`, `purchases_7d`, `purchases_14d`, `units_7d`, `units_14d`, `…_same_sku_…`),
      `extra` (jsonb) für weitere Spalten, `imported_at`.
  - `currency_code` kommt aus `amazon_ads_profiles.currency_code` (v3-Reports liefern je Zeile keine Währung, außer bei Budget-Spalten).
  - SB/SD liefern ein Fenster ohne Suffix (14 Tage) → `*_14d`; `*_7d` bleibt dort leer (`NULL`), nicht 0.
- [ ] Schlüssel: `id` (uuid) als Primärschlüssel, unique (`profile_id`, `date`, Entity-FK) für den Upsert (Suchbegriffe zusätzlich mit
      dem Text); Index (`profile_id`, `date`).
- [ ] **Platzhalter:** Taucht in einem Report eine Entity auf, die der Entity-Sync (noch) nicht kennt (gerade angelegt oder schon entfernt),
      legt der Import sie als Platzhalter an, **Eltern zuerst** aus den IDs der Report-Zeile (Kampagne → Ad Group → Target/Product Ad).
      Platzhalter haben `synced_at = null`; Name, Status, Gebot, Budget und Währung sind dafür nullable (keine Ersatzwerte). Report-Spalten
      wie `campaignName` dürfen den Namen vorbelegen. Der nächste Entity-Sync füllt sie. So geht keine Kennzahl verloren und der FK bleibt hart.
- [ ] **Neu geladenes Fenster ersetzen:** Amazon liefert nur Tage mit Aktivität; fehlende Zeilen bedeuten 0. Der Import ersetzt deshalb in
      derselben Transaktion genau den Ausschnitt (Profil, Ad-Typ, Tabelle, `start_date`–`end_date` **dieses** Auftrags): Upsert der gelieferten
      Zeilen, Löschen der übrigen in diesem Ausschnitt. **Kein Löschen**, wenn der Auftrag ungültige Zeilen hatte, oder wenn er 0 Zeilen liefert,
      der Ausschnitt aber Zeilen hat (dann Import `failed` mit Hinweis, kein stiller Datenverlust). Tests für alle drei Fälle und dafür, dass
      ein SP-Import keine SB/SD-Zeilen löscht.
- [ ] Keine Partitionierung im Pilot (Volumen je Profil und Tag: einige Tausend Zeilen). Wiedervorlage bei Stufe C.
- [ ] Systemzugriffe (Upserts, Platzhalter) in `packages/db/src/system-access.ts` bzw. einer neuen Datei daneben. Sie schreiben **keine**
      `audit_events` (wie `profiles-sync` in 0.7): Nachvollziehbar sind sie über `job_runs` und ihre Zähler; Audit gilt für Aktionen von
      Nutzern und Änderungen an Connections. Nutzerseitige Lesezugriffe
      gibt es in Phase 1 nicht (außer „Daten bis“ je Profil, 1.8, über `visibleProfilesScope`); der Access-Layer bekommt dafür keine neuen Regeln.
- Umsetzung (Vorgabe aus 1.11, entschieden 2026-09-27, gilt auch für 1.7): Die Upserts für Entities und Kennzahlen nehmen **normalisierte
  Datensätze** entgegen (eigene Typen in `packages/db` bzw. das Modell aus 1.6), nie Antworttypen der Amazon-API. So kann ein späterer
  Datei-Import (1.11) dieselbe Schreibschicht nutzen. Der Datei-Import selbst wird hier **nicht** gebaut.

### 1.6 Amazon-Client: Entities und Reports (`packages/amazon-ads`)
Endpunkte nach F1 (a), siehe ADR 004.
- [ ] Exports: `requestExport(profile, 'campaigns' | 'adGroups' | 'targets' | 'ads', { adProducts, states })`, `getExport(id)`,
      `downloadExport(url)`. Content-Types laut Doku (`application/vnd.campaignsexport.v1+json` usw., beim Umsetzen prüfen).
- [ ] Portfolios: `listPortfolios(profile)` mit Paginierung.
- [ ] Reports: `requestReport(profile, { reportTypeId, adProduct, groupBy, columns, startDate, endDate })`, `getReport(id)`,
      `downloadReport(url)`. 425 als eigener Fehler mit Hinweis „läuft bereits“.
- [ ] Normalisierung in ein eigenes Modell (`AmazonAdsCampaign` …) mit zod; IDs und Beträge als Strings (Beträge und alle gebrochenen
      Werte über `amazonDecimalSchema`, Währungen über `currencyCodeSchema`). Unbekannte Enum-Werte und unbekannte Währungscodes
      (`isKnownCurrencyCode`) durchreichen und loggen.
- [ ] Download-Hosts: S3-URLs aus Amazon-Antworten nur per `https` und **ohne** Authorization-Header abrufen (Tokens gehen nie an fremde Hosts,
      Regel aus 0.5). Erlaubte Host-Muster als Konstante.
- [ ] Mock-Anbieter erweitern: Entities für die Test-Profile (inkl. großer IDs, Beträge mit vielen Nachkommastellen, archivierter Kampagne,
      Negatives auf beiden Ebenen, Vendor-Profil ohne SKU), Reports als gzip-JSON mit simulierter Verarbeitungszeit, 425 und `FAILURE` auf Wunsch.
- [ ] Tests mit msw für jeden Endpunkt (Paginierung, 429, 425, Validierungsfehler, verlustfreie Zahlen).

### 1.7 Jobs (`apps/worker`)
Alle Datenjobs nehmen die Lease der Connection (1.3) und bleiben **kurz**: Ein Lauf erledigt eine begrenzte Menge Arbeit und plant bei
Bedarf den nächsten ein. `expireInSeconds` bleibt deshalb niedrig (ein verwaister aktiver Job blockiert bei `stately` die Queue der
Connection bis zum Ablauf; Graceful Shutdown wartet nur 30 s).
- [ ] `entities-sync` je Connection: für jedes aktive, nicht entfernte Profil (F14) Portfolios lesen und **direkt** upserten (synchroner
      List-Aufruf, eigene Transaktion), dann je Ad-Typ vier Exports mit gemeinsamer `batch_id` anfordern (über 1.4). Der Job endet nach dem
      Anfordern; das Importieren übernimmt der Poll.
- [ ] **Import eines Entity-Batches:** sobald Amazon **alle** Exports des Batches als fertig meldet (`completed`), lädt ein Poll-Lauf alle
      herunter und importiert sie in **einer** Transaktion in Hierarchie-Reihenfolge (Kampagnen → Ad Groups → Targets, Negatives, Product Ads).
      Speicher: bis zu 4 Dateien gleichzeitig, der Größendeckel aus 1.4 gilt je Datei. `removed_at` nur für Entities desselben (Profil, Ad-Typ,
      Entity-Typ), die schon **vor** dem Anfordern des Batches existierten und im Batch fehlen (Platzhalter, die währenddessen aus Reports
      entstanden, bleiben). Zähler: `profiles`, `created`, `updated`, `removed`, `placeholders_filled`.
- [ ] **Scheitert ein Export des Batches** (`FAILURE`, abgelaufen, Import nach 3 Versuchen fehlgeschlagen), wird der **ganze Batch** `failed`:
      kein Import, kein `removed_at`. Einzelne Exports werden nicht neu angefordert (sonst mischten sich Stände verschiedener Zeitpunkte);
      der nächste `entities-sync` startet einen neuen Batch.
- [ ] `reports-sync` je Connection: je Profil, Ad-Typ (F2) und Ebene (F6) einen Report über das rollierende Fenster (F3, F9) anfordern.
      Zähler: `requested`, `reused` (425), `failed_since_last_run` (Aufträge des Profils, die seit dem letzten `reports-sync` auf `failed`
      gingen; so werden Fehler aus dem Poll in einem Lauf mit Healthcheck sichtbar).
- [ ] **Historie (F4) mit festem Merker:** Tabelle `amazon_ads_backfills` (`organization_id`, `profile_id`, `ad_product`, `report_type`,
      `from_date`, `completed_at`; zusammengesetzter FK (`profile_id`, `organization_id`)), unique (`profile_id`, `ad_product`, `report_type`).
      `reports-sync` fordert für jede Kombination ohne `completed_at` die fehlenden 31-Tage-Stücke an. Die Stücke enden am Tag **vor** dem
      Beginn des rollierenden Fensters, damit sie sich nicht mit ihm überschneiden. `completed_at` wird erst gesetzt, wenn alle Stücke
      `imported` sind (auch als `superseded`, siehe 1.4). So holt auch 1.9 (SB/SD für schon synchronisierte Profile) die Historie nach, und
      verlorene Stücke werden wiederholt, solange Amazon sie noch vorhält.
- [ ] Der Poll zählt `imported`, `rows`, `superseded`, `failed`.
- [ ] `amazon-requests-poll` je Connection: fragt fällige Aufträge ab (`next_poll_at <= now()`, Backoff 1 → 2 → 5 → 10 → 15 Min.), lädt
      und importiert höchstens eine begrenzte Zahl je Lauf (z. B. 5) und plant sich neu ein, solange Aufträge offen sind.
- [ ] Cron-Auslöser `entities-sync-all` und `reports-sync-all` (F9), wie `profiles-sync-all` nur für aktive Connections. Dazu
      `amazon-requests-poll-all` alle 10 Min.: plant einen Poll für jede Connection mit offenen Aufträgen ein (holt nach Absturz oder Deploy auf).
- [ ] **Kette bei „Jetzt synchronisieren“:** Jobdaten mit `chain: true` (nur der manuelle Auslöser setzt es): `profiles-sync` plant am Ende
      `entities-sync` ein, dieser `reports-sync`. Der tägliche Lauf von `profiles-sync` um 05:00 kettet nicht (Entities und Reports haben eigene
      Cron-Zeiten). Weil `entities-sync` nach dem Anfordern endet, können Reports vor den Entities importiert werden; die Platzhalter (1.5)
      sind dafür der vorgesehene Weg.
- [ ] Bestehende Queues mit geänderten Optionen über `boss.updateQueue` (siehe `createQueues`).
- [ ] Neue Namen in `CONNECTION_JOB_NAMES`, i18n-Keys `sync.job.*` und `sync.counter.*`, Reihenfolge in `COUNTER_ORDER`.
- [ ] Healthchecks: `HEALTHCHECKS_ENTITIES_SYNC_URL`, `HEALTHCHECKS_REPORTS_SYNC_URL` (optional, https), in `.env.example` und `docs/deploy.md`.
      `amazon-requests-poll` pingt nicht (läuft oft und kurz); scheiternde Aufträge zeigen sich im Zähler `failed_since_last_run` von
      `reports-sync` und im Sync-Status.
- [ ] `reauth_required`-Connections überspringen. Ausgeblendete Profile nach F14, entfernte Profile nicht.

### 1.8 Sichtbares (`apps/api`, `apps/web`)
Nach F11.
- [ ] Sync-Status zeigt die neuen Jobs und Zähler.
- [ ] Connections-Seite: Profiltabelle mit Spalte „Daten bis“ (der Ablauf der Einwilligung ist mit 1.2 erledigt) aus einer neuen Spalte
      `amazon_ads_profiles.metrics_imported_through` (date), die der Import eines Kampagnen-Reports auf `max(end_date)` setzt (nicht
      `max(date)` der Kennzahlen: ein pausiertes Profil hätte sonst ein altes Datum; nicht aus den Auftragszeilen: die werden nach 30 Tagen
      gelöscht). Endpunkt begrenzt die Profile über `visibleProfilesScope`.
- [ ] Optional aus dem Review-Backlog: Sync-Status „läuft seit“ für laufende Jobs (hilft beim Erkennen hängender Jobs und belegter Leases).

### 1.9 Weitere Ad-Typen (nach F2)
- [ ] SB: Entities (Exports decken SB ab) und Reports (`sbCampaigns`, `sbAdGroup`, `sbTargeting`, `sbAds`); Hinweis auf die v3-Preview-Lücke
      (SB-Kampagnen ohne Multi-Ad-Group fehlen) in der UI-Doku von Phase 2 vermerken.
- [ ] SD: Entities und Reports (`sdCampaigns`, `sdAdGroup`, `sdTargeting`, `sdAdvertisedProduct`); SD-Metriken sind klick- **und**
      view-basiert, Spalten entsprechend (`extra` oder eigene Spalten, beim Umsetzen entscheiden).

### 1.10 Erster echter Lauf (nach der Freigabe)
- [ ] Ein Profil mit echten Kampagnen synchronisieren, Zählwerte gegen die Amazon-Konsole abgleichen (Stichprobe: Kosten und Klicks einer
      Kampagne an drei Tagen). Abweichungen und Überraschungen hier festhalten: Header `Amazon-Ads-AccountId`,
      Content-Types, Laufzeiten, 429-Quote, ob Amazon offene Reports je Profil begrenzt (der erste SP-Sync fordert rund 20 an), ob `targetId`
      im Export der `keywordId` bzw. `targetId` in `spTargeting`/`spSearchTerm` entspricht, ob sich Amazon-IDs über Ad-Typen eines Profils
      überschneiden können.
- [ ] Keine Kundennamen, IDs oder Werte in Commits, Tests oder Actions-Logs.

### 1.11 Datei-Import (optional, nur mit Auslöser)
**Entschieden (Dominik, 2026-09-27):** Wird nur gebaut, wenn Phase 2 fertig ist und die Ads-API-Freigabe dann immer noch fehlt
(Dominik kann den Stichtag ändern). Sonst nicht bauen.
- Entities aus der Bulk-Datei der Werbekonsole, Tageskennzahlen aus den täglichen Sponsored-Ads-Reports der Konsole.
- Profile von Hand anlegen (Profil ohne Connection).
- Upload und Import-Job über `runJob`; geschrieben wird über dieselbe Schreibschicht wie der API-Sync (1.5, normalisierte Datensätze).
- Hintergrund: Bulk-Dateien tragen dieselben IDs wie die API (ein späterer API-Sync setzt nahtlos fort), enthalten aber nur
  Zeitraumsummen; Tageswerte kommen aus den separaten Reports. Wegwerf-Anteil: Parser, Upload, Job.
- Testdaten nur synthetisch (öffentliches Repo).

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
