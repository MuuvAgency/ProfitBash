# Phase 7 – Profit

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap samt „Hinweis TACoS“, §3 Zeilen „Profit“, §4, §5 samt
> „Festlegungen für Phase 1 und später“), `docs/decisions/` (001 Stack, 002 Mandanten-Modell, 003 Decimal, 006 Automatik
> ohne API als Muster für „Quelle austauschbar“), `docs/tasks/phase-0.md` (0.3 OAuth, 0.5 Jobs), `docs/tasks/phase-1.md`
> (1.3 Lease und Anfrage-Budget, 1.5 Report-Anfragen, 1.11 Datei-Import), `docs/tasks/phase-6.md` (6.3a/6.3b: Seiten
> „kundensicher“ machen), `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` (Abschnitt G), `design/DESIGN.md`.
>
> **Status: verfeinert (2026-10-12), Fragen F1–F8 entschieden (die Nummern gelten nur in dieser Datei). Fertig: nichts.
> Nächste Aufgabe: 7.1.** Offen bei Dominik: F1 (Art des Zugangs) und F2 (Rollen prüfen); beides hält 7.1–7.4 nicht auf,
> weil bis dahin gegen Mocks gebaut wird.
>
> **Ausgangslage (Stand Code, 2026-10-12):**
> - `connection_provider` kennt nur `amazon_ads`; `connections` (Region, externes Konto, verschlüsseltes Refresh-Token,
>   `consented_at`) ist anbieterneutral angelegt (`plan.md` §5 Punkt 2).
> - `packages/amazon-ads` enthält LwA (`lwa.ts`, `access-token.ts`), HTTP mit Rate-Limit (`http.ts`, `rate-limit.ts`),
>   verlustfreies JSON (`json.ts`), Regionen und einen Mock-Server (`mock.ts`). Die SP-API nutzt dasselbe LwA.
> - Der Feature-Key `profit` existiert, sechs Routen unter `/profit/*` sind Platzhalterseiten. Design-Referenzen
>   (`plan.md` §3) liegen unter `design/`.
> - Tageskurse (EZB) und die Umrechnung in die Anzeigewährung gibt es seit 2.2; Ziele kennen ACoS/ROAS, kein TACoS.
> - Der Datei-Import (1.11) kennt die Arten `bulk` und `daily_report`.
> - **Kein echter Zugang geprüft:** Dominik nennt einen SP-API-Zugang als vorhanden, die Art ist unklar (F1). Wie bei
>   der Ads-API entsteht alles gegen msw-Mocks; der Test mit echten Konten kommt zuletzt (7.12).

## Ziel

Je Client sehen, **was nach allen Kosten übrig bleibt**:
- Seller-Konten per SP-API verbinden und Bestellungen, Gebühren, Erstattungen und Retouren täglich laden.
- **Echtes TACoS** (Werbekosten ÷ Gesamtumsatz) und organischer Umsatz im Dashboard.
- Kosten pflegen, die Amazon nicht kennt: Einkaufspreise (COGS), Versand, indirekte Ausgaben (OPEX).
- **P&L** je Client, Marktplatz, Produkt und Zeitraum: Umsatz → Amazon-Gebühren → Werbung → Wareneinsatz → Versand →
  Deckungsbeitrag → OPEX → Netto-Gewinn.

## Definition of Done

- [ ] Ein Seller-Konto lässt sich verbinden (gegen Mocks; echter Test in 7.12), Marktplätze erscheinen als Konten am
      Client; Neu-Verbinden und Trennen wie bei Ads. Refresh-Token nur verschlüsselt, nie im Log.
- [ ] Täglicher Import mit rollierendem Fenster und Upsert; ein Neustart verliert keine Report-Anfrage; Jobs über
      `runJob`, je Connection nacheinander (Lease), Anfrage-Budget je Konto.
- [ ] **Keine personenbezogenen Käuferdaten** in der DB (kein Name, keine Adresse, keine E-Mail); nur Berichte und
      Endpunkte ohne „restricted data token“. Test: Parser verwerfen solche Spalten.
- [ ] Geld als `numeric` mit Währung, Rechnen mit `decimal.js`; Steuerbeträge getrennt gespeichert (F6). Amazon-IDs
      (Bestellnummer, ASIN, SKU, Seller-ID) als Text.
- [ ] Perioden (Tag, Monat) in der Zeitzone des Marktplatzes; Zeitpunkte in UTC gespeichert.
- [ ] Alle Zugriffe über den Access-Layer (ADR 002): Sichtbarkeit von Seller-Konten folgt dem Client (Freigaben je
      Mitglied, Kunden-Org). Test je Endpunkt (fremde Organisation, fremder Client, entzogene Freigabe, nicht gebucht).
- [ ] Kunden-Logins lesen genau die freigegebenen Profit-Seiten ihres Clients (F7); `customer-org.test.ts` bleibt grün,
      schreibende Routen und Kosten-Pflege bleiben für Kunden zu.
- [ ] Jede Kennzahl sagt, **worauf sie beruht**: fehlende Einkaufspreise, noch nicht abgerechnete Bestellungen
      (geschätzte Gebühren) und umgerechnete Währungen („≈“) sind sichtbar, nie stillschweigend 0.
- [ ] Jede schreibende Aktion erzeugt ein `audit_event` (Connection, Kosten, Einstellungen).
- [ ] Jede Datenansicht mit Skeleton, Empty- und Error-Zustand; Zahlen in JetBrains Mono über die Format-Helper;
      Texte über i18n.
- [ ] Browser-Pane geprüft (1440 px, Tablet, Handy, Hell/Dunkel, Konsole) mit echten Bedienelementen; Testdaten über die
      Oberfläche entfernt oder benannt.
- [ ] `pnpm test`, `typecheck`, `lint`, `build`, beide Smoke-Tests und CI grün.

## Stand der SP-API (geprüft am 2026-10-12)

Quellen: developer-docs.amazon.com/sp-api („Connect to the SP-API“, „Usage Plans and Rate Limits“, „SP-API Endpoints“,
„Marketplace IDs“, „Seller Central URLs“, „Roles in the SP-API“, „Report Type Values – Order“, „Retrieve a report“)
und Amazons OpenAPI-Modelle `reports_2021-06-30.json` und `sellers.json` (github.com/amzn/selling-partner-api-models).

- **Aufruf:** kein AWS-SigV4 und kein IAM mehr. Header: `x-amz-access-token` (LwA-Access-Token), `x-amz-date`,
  `user-agent`. Token: `POST https://api.amazon.com/auth/o2/token` mit `grant_type=refresh_token`, Client-ID und
  Secret der App (ein Host für alle Regionen, anders als bei Ads).
- **Hosts:** `sellingpartnerapi-eu.amazon.com`, `-na`, `-fe`. Ein Refresh-Token gilt für eine Region.
- **Rate-Limits:** Token-Bucket je Operation und je Paar aus Verkäufer und App. `x-amzn-RateLimit-Limit` nennt die
  Rate nur „when available“ (nur bei 20x, 400, 404; Amazon: „must not depend on this header“). Deshalb die
  dokumentierten Standardraten als Budget je Operation, 429 halbiert (wie 1.3). Standard (Rate/s, Burst):
  `createReport` 0,0167/15, `getReport` 2/15, `getReportDocument` 0,0167/15, `getReports` 0,0222/10,
  `getMarketplaceParticipations` 0,016/15.
- **Reports-API 2021-06-30:** `POST /reports/2021-06-30/reports` (`reportType`, `marketplaceIds` 1–25,
  `dataStartTime`, `dataEndTime`) → `reportId`; `GET …/reports/{reportId}` → `processingStatus` (`IN_QUEUE`,
  `IN_PROGRESS`, `DONE`, `FATAL`, `CANCELLED`) und `reportDocumentId`; `GET …/documents/{reportDocumentId}` → `url`
  (signiert, **läuft nach 5 Minuten ab**) und optional `compressionAlgorithm: GZIP`. Der Zeichensatz der Datei steht
  im `Content-Type` des Downloads. Fehlerformat: `{ errors: [{ code, message, details }] }`.
- **Bericht „Alle Bestellungen“:** `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL` (nach Änderungsdatum) und
  `…_BY_ORDER_DATE_GENERAL` (nach Kaufdatum). Rolle u. a. **„Inventory and Order Tracking“**, nur Seller, nur auf
  Anfrage (nicht planbar), Tab-getrennt, MFN und FBA, **höchstens 30 Tage je Bericht**. Laut Doku ohne
  Käufer-Identität; die Spalten `ship-city`, `ship-state`, `ship-postal-code`, `ship-country` sind aber enthalten und
  werden beim Einlesen verworfen (7.3). Spalten u. a. `amazon-order-id`, `purchase-date`, `last-updated-date`,
  `order-status`, `fulfillment-channel`, `sales-channel`, `sku`, `asin`, `item-status`, `quantity`, `currency`,
  `item-price`, `item-tax`, `shipping-price`, `shipping-tax`, `gift-wrap-price`, `gift-wrap-tax`,
  `item-promotion-discount`, `ship-promotion-discount`, `is-business-order`. Selbst versandte Bestellungen im Status
  „Pending“ haben keinen Preis.
- **Steuer je Position:** `item-tax` usw. sind Spalten des Berichts. **Nicht aus der Doku zu klären:** ob `item-price`
  auf EU-Marktplätzen brutto ist und ob `item-tax` dort immer gefüllt ist (die Doku nennt `vat-exclusive-item-price`
  nur für andere Berichte). Bleibt offen bis 7.12 (echte Datei); 7.3 speichert Preis und Steuer getrennt, wie geliefert.
- **Marktplatz-Teilnahmen:** `GET /sellers/v1/marketplaceParticipations` → je Marktplatz `id`, `countryCode`,
  `defaultCurrencyCode`, `domainName`, `storeName`, `isParticipating`. Rolle **„Selling Partner Insights“** (steht
  nicht in F2). Die Antwort enthält **keine Seller-ID**: Bei „Token eintragen“ gibt der Nutzer sie mit an (bei OAuth
  kommt sie als `selling_partner_id`).
- **Nicht geprüft:** Host der Download-URL (die Doku nennt kein Beispiel; erlaubt sind S3-Hosts unter
  `amazonaws.com`, ohne Zugangsdaten), Aufbewahrung fertiger Berichte.

## Fragen an Dominik

Gestellt zu Beginn der Session (2026-10-12), jede mit Empfehlung.

- **F0 – Datenquelle.** Empfehlung: Dateien aus Seller Central (wie ADR 006), solange kein Zugang da ist.
  **Entschieden (Dominik, 2026-10-12): SP-API-Zugang vorhanden**, Phase 7 wird auf die API geplant.
- **F1 – Art des Zugangs** (private App fürs eigene Konto, Public App mit OAuth, je Kunde eigene private App).
  **Antwort (Dominik, 2026-10-12): noch unklar.** Folge: 7.2 baut zuerst **„Token eintragen“** (Client-ID, Secret und
  Refresh-Token je Connection, deckt private Apps und Kunden-Apps ab) und danach den **OAuth-Weg** der Public App
  hinter derselben Schnittstelle. **Offen bei Dominik:** im Entwicklerprofil (Seller Central → „Apps entwickeln“ bzw.
  Solution Provider Portal) nachsehen, welche Art App existiert und ob sie fremde Verkäuferkonten autorisieren darf.
  Eine private App gilt nur für das eigene Konto; für Kundenkonten braucht es eine Public App oder je Kunde eine eigene.
- **F2 – Rollen der App.** **Antwort (Dominik, 2026-10-12): „Finanzen und Buchhaltung“, „Bestand und
  Auftragsverfolgung“, „Brand Analytics“ – aber ungeprüft** („weiß ich nicht“ ebenfalls gewählt). Folge: Die Aufgaben
  nennen je Import die nötige Rolle; fehlt sie, meldet der Import das als eigenen Fehler (`SP_ROLE_MISSING`) statt zu
  scheitern. **Offen bei Dominik:** Rollen im Entwicklerprofil bestätigen. Keine Rolle für personenbezogene Daten
  beantragen (wird nicht gebraucht).
- **F3 – Kontotypen.** **Entschieden (Dominik, 2026-10-12): nur Seller**, wie empfohlen. Vendoren später bei Bedarf.
- **F4 – Reihenfolge.** **Entschieden (Dominik, 2026-10-12): schmaler Sales-Import zuerst**, wie empfohlen
  (Connection → Umsatz je ASIN und Tag → TACoS und Verkaufsanalyse → Gebühren und Retouren → Kosten → P&L).
- **F5 – Einkaufspreise.** **Entschieden (Dominik, 2026-10-12): Eingabe in der Oberfläche und CSV-Import**, wie empfohlen.
- **F6 – Umsatzsteuer.** Empfehlung: netto. **Entschieden (Dominik, 2026-10-12): umschaltbar** (abweichend). Folgen:
  Beträge und Steuer werden getrennt gespeichert; die Umschaltung „netto/brutto“ ist eine persönliche Einstellung
  (Standard netto) und wirkt in Verkaufsanalyse, Bestellungen und P&L auf Umsatz und Erstattungen. Werbekosten,
  Gebühren und eigene Kosten bleiben netto; die Ansicht „brutto“ sagt das. TACoS rechnet immer mit Netto-Umsatz.
- **F7 – Kundensicht.** Empfehlung: nur Agentur. **Entschieden (Dominik, 2026-10-12): Kunden lesen mit** (abweichend).
  Folgen: `profit` wird für Kunden-Orgs buchbar (`CUSTOMER_ORG_FEATURES`), aber nicht automatisch gebucht; freigegeben
  werden P&L, Verkaufsanalyse, Produkte, Retouren und Bestellungen ihres Clients, **nicht** die Kosten-Pflege. Jede
  Seite wird wie in 6.3b einzeln freigegeben (Pfad-Liste, Test mit zweitem Client). Siehe Festlegung „OPEX“ unten.
- **F8 – Historie beim ersten Verbinden.** **Entschieden (Dominik, 2026-10-12): 12 Monate**, wie empfohlen.

## Aufgaben (nach F0–F8, 2026-10-12)

**Begriffe:** **Seller-Konto** = ein Verkäuferkonto auf einem Marktplatz (`amazon_sp_accounts`, intern `sellerAccountId`,
bei Amazon `amazonSellerId` + `marketplaceId`), Gegenstück zum Ads-Profil. **Produkt** = SKU eines Seller-Kontos mit ASIN.
**Abgerechnet** = die Bestellung steht in einem Finanzereignis von Amazon; davor sind Gebühren **geschätzt**.

**Festlegungen von Claude (2026-10-12; Dominik kann widersprechen):**
- **Paket `packages/amazon-sp`** (`plan.md` §5 Punkt 3). LwA, Token-Cache, Rate-Limit und verlustfreies JSON werden aus
  `packages/amazon-ads` wiederverwendet (Import, kein drittes Paket; erst teilen, wenn es klemmt). Die SP-API braucht
  keine AWS-Signatur mehr, nur das LwA-Token (bestätigt, siehe „Stand der SP-API“).
- **Provider `amazon_sp`** in `connection_provider` (Enum-Migration). Eigene Zugangsdaten je Connection (F1) liegen
  verschlüsselt in einer eigenen Tabelle neben der Connection, nicht in `.env`; die App-Zugangsdaten einer Public App
  kommen aus `.env` (`AMAZON_SP_CLIENT_ID`, `…_SECRET`, `…_APP_ID`, `AMAZON_SP_USE_MOCK`).
- **Seller-Konto ↔ Client:** `amazon_sp_accounts.client_id` wie bei Ads-Profilen, Zuordnung unter „Clients &
  Connections“. Der Access-Layer bekommt `visibleSellerAccountsScope()` mit denselben Regeln wie
  `visibleProfilesScope()` (Mitgliedschaft, Freigaben je Client, Kunden-Org, ausgeblendet/entfernt); keine Abfrage
  filtert selbst.
- **Quelle des Umsatzes:** Bestellpositionen aus dem Bericht „Alle Bestellungen“ ohne Käuferdaten
  (`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL`, Rolle „Bestand und Auftragsverfolgung“ = „Inventory and
  Order Tracking“; höchstens 30 Tage je Bericht, Backfill nach Kaufdatum mit `…_BY_ORDER_DATE_GENERAL`), verdichtet zu
  Tageswerten je SKU. Kein Abruf einzelner Bestellungen (Rate-Limit, personenbezogene Daten). Der Bericht „Umsatz und
  Traffic“ (Sitzungen, Buy-Box) kommt erst in 7.10 dazu, falls die Rolle da ist.
- **Quelle der Gebühren:** Finanzereignisse (Finances-API, Rolle „Finanzen und Buchhaltung“) je Bestellposition:
  Verkaufsgebühr, FBA-Gebühren, Erstattungen, Gutschriften, sonstige Posten (Lager, Abos) ohne Bestellung. Welche
  Version der Finances-API und ob stattdessen der Abrechnungsbericht (Settlement) trägt, entscheidet 7.6 nach einem
  Blick in die Doku und wird als ADR 007 festgehalten.
- **Geschätzte Gebühren:** Für noch nicht abgerechnete Bestellungen gilt der Durchschnitt der abgerechneten Gebühren
  je SKU der letzten 30 Tage (kein Aufruf der Gebühren-Vorschau); ohne Historie bleibt der Wert leer und die Ansicht
  sagt es.
- **Datum einer Bestellung** ist das Kaufdatum in der Zeitzone des Marktplatzes; Erstattungen und Retouren zählen an
  ihrem eigenen Datum (wie Seller Central), nicht rückwirkend zur Bestellung.
- **Organischer Umsatz** = Gesamtumsatz − den Anzeigen zugeschriebener Umsatz (SP 7 Tage, SB/SD 14 Tage Klicks, siehe
  `plan.md` §5 „Kennzahlen je Ad-Typ“), je Tag und Marktplatz, nie unter 0 angezeigt, mit Hinweis auf die
  unterschiedlichen Zeitbezüge (Anzeigen-Umsatz zählt am Klicktag). **TACoS** = Werbekosten ÷ Gesamtumsatz (netto).
  Für Datei-Profile ohne Tageswerte (ADR 006) gibt es TACoS nur über den Datei-Zeitraum.
- **Verknüpfung Ads ↔ Seller-Konto:** über Client und Marktplatz (ein Ads-Profil und ein Seller-Konto desselben
  Clients auf demselben Marktplatz gehören zusammen); Produkte über die ASIN.
- **Kosten mit „gültig ab“:** Einkaufspreis je SKU, Versandprofil je SKU (nur FBM bzw. Einlieferung), OPEX je Client
  und Monat; alle in eigener Währung, nie rückwirkend überschrieben, sondern als neue Zeile.
- **OPEX und Kundensicht (F7):** Kunden sehen im P&L alle Zeilen ihres Clients einschließlich der OPEX, die für
  diesen Client erfasst sind. Kosten der Agentur selbst (Honorar an Muuv, interne Kosten) gehören nicht in OPEX des
  Clients, außer Dominik will es so. **Frage an Dominik vor 7.8** (siehe „Offen vor dem Bau“).
- **Nicht in dieser Phase:** siehe „Bewusst nicht in Phase 7“.

### 7.1 Paket `packages/amazon-sp` und Mock
- [ ] Paket anlegen: Regionen und Endpunkte (eu/na/fe), Marktplatz-Liste (ID, Land, Währung, Zeitzone, Seller-Central-
      Domain) – vorhandene Marktplatz-Daten aus `@profitbash/shared` wiederverwenden und nur ergänzen.
- [ ] Client mit LwA-Token aus `packages/amazon-ads`, Rate-Limit je Operation nach den dokumentierten Standardraten
      (der Header `x-amzn-RateLimit-Limit` ist laut Amazon nicht verlässlich), Fehlerabbildung (401/403 → Neu-Verbinden bzw. `SP_ROLE_MISSING`, 429 → Backoff),
      zod an jeder Antwort, verlustfreies JSON.
- [ ] Operationen: Marktplatz-Teilnahmen des Kontos (Sellers-API), Reports-API (anlegen, Status, Dokument laden und
      entpacken). Mock-Server (msw) mit kleinen, erfundenen Daten für beide.
- [ ] ADR 007 beginnen: Paketgrenzen, Wiederverwendung von LwA, Umgang mit Rollen, keine Käuferdaten.

### 7.2 Connection und Seller-Konten
- [ ] Migration: Provider `amazon_sp`; `amazon_sp_accounts` (Connection, Client, `amazon_seller_id`, `marketplace_id`,
      Währung, Zeitzone, ausgeblendet/entfernt wie bei Profilen); verschlüsselte Zugangsdaten je Connection (F1).
- [ ] Access-Layer: `visibleSellerAccountsScope()`, `canSeeSellerAccount()`; Tests wie `access.test.ts`,
      `access-grants.test.ts`, `access-client-org.test.ts`.
- [ ] API hinter `orgAdminOnly`: Connection anlegen über **„Token eintragen“** (Zugangsdaten prüfen durch einen
      Aufruf der Marktplatz-Teilnahmen, nie zurückgeben), Konten synchronisieren, Client zuordnen, ausblenden, trennen;
      Audit je Aktion.
- [ ] Oberfläche unter „Clients & Connections“: Kachel „Seller-Konten“ neben den Ads-Connections.
- [ ] **7.2b OAuth-Weg der Public App** (Start in Seller Central, Rückkehr mit `spapi_oauth_code`, `state` signiert wie
      bei Ads): erst bauen, wenn F1 „Public App“ ergibt.

### 7.3 Bestellungen laden (Sales-Import)
- [ ] Tabellen: Report-Anfragen (Zustand in der DB wie `amazon_ads_report_requests`; prüfen, ob die Tabelle
      verallgemeinert oder gespiegelt wird – die kleinere Änderung gewinnt), Bestellpositionen (Bestellnummer, SKU,
      ASIN, Menge, Preis, Steuer, Rabatt, Versanderlös, Status, Kanal FBA/FBM, B2B-Kennzeichen, Zeitpunkte) und
      Tageswerte je Seller-Konto und SKU.
- [ ] Job je Seller-Konto über `runJob`: täglich das Fenster der zuletzt geänderten Bestellungen laden (rollierend
      30 Tage, Upsert je Bestellposition), Tageswerte neu verdichten; Backfill 12 Monate in Monatsscheiben (F8).
- [ ] Parser verwirft Spalten mit Käuferdaten (Test); stornierte Bestellungen zählen nicht zum Umsatz.
- [ ] Sync-Status zeigt Seller-Konten mit letztem Lauf und Fehler.

### 7.4 Echtes TACoS und Verkaufsanalyse (`/profit/sales`)
- [ ] Leseschicht: Umsatz, Stück, Bestellungen je Tag, Marktplatz, SKU/ASIN; organischer Umsatz und TACoS nach der
      Festlegung oben; Umrechnung in die Anzeigewährung wie im Dashboard („≈“).
- [ ] Dashboard: Kennzahlen TACoS und organischer Umsatz, nur wenn `profit` gebucht ist und der Client ein Seller-Konto
      auf dem Marktplatz hat; sonst der bisherige Stand.
- [ ] Seite Verkaufsanalyse: Zeitraum und Vergleich, Chart, Tabelle je Produkt, Umschaltung netto/brutto (F6).
- [ ] Kundensicht (F7): Endpunkte freigeben, Tests mit zweitem Client.

### 7.5 Bestellungen (`/profit/orders`) und Produkte (`/profit/products`)
- [ ] Bestellliste mit Cursor (nie alles laden), Filter Zeitraum, Marktplatz, Status, Kanal; Detail mit Positionen.
- [ ] Produkte: SKU, ASIN, Titel und Marke (Katalog- bzw. Listings-Bericht; nötige Rolle beim Bau prüfen), Kennzahlen
      je Produkt; Verknüpfung zu Produktgruppen (Phase 4) über die ASIN.

### 7.6 Gebühren und Erstattungen
- [ ] Quelle festlegen (Finances-API oder Abrechnungsbericht), ADR 007 ergänzen.
- [ ] Tabellen für Finanzereignisse je Bestellposition und für Posten ohne Bestellung; täglicher Import mit
      rollierendem Fenster, Upsert, Backfill 12 Monate.
- [ ] Engine: Gebühren je Position (abgerechnet) bzw. geschätzt nach der Festlegung oben; Tests je Fall.
- [ ] Seite „Kosten → Gebühren“ (`/profit/costs/*`): Gebühren je Art und Produkt, Anteil geschätzt sichtbar.

### 7.7 Retouren (`/profit/returns`)
- [ ] FBA-Retourenbericht (und FBM, falls verfügbar) laden: Datum, SKU, Menge, Grund, Zustand.
- [ ] Seite: Retourenquote je Produkt und Zeitraum, Gründe, Erstattungsbetrag aus 7.6.

### 7.8 Kosten: Einkaufspreise, Versand, OPEX (`/profit/costs/*`)
- [ ] Tabellen mit „gültig ab“; API mit Schreibrecht über `profit`; Audit.
- [ ] Oberfläche: Einkaufspreise je SKU (fehlende hervorgehoben), Versandprofile, OPEX je Client und Monat.
- [ ] CSV-Import für Einkaufspreise über den Datei-Import aus 1.11 (neue Art `cogs`, Vorlage zum Herunterladen,
      Fehler je Zeile) (F5).

### 7.9 P&L (`/profit/pnl`)
- [ ] Engine ohne I/O: P&L-Zeilen aus Tageswerten, Gebühren, Erstattungen, Werbekosten, Kosten; Tests je Zeile und
      Grenzfall (fehlender Einkaufspreis, geschätzte Gebühren, gemischte Währungen, netto/brutto).
- [ ] API und Seite: je Client, Marktplatz und Zeitraum mit Vergleich; Aufriss je Produkt; Hinweise aus der Definition
      of Done („beruht auf“); Break-even-ACoS je Produkt als Brücke zu den Zielen (Phase 5).
- [ ] Kundensicht (F7) für P&L, Produkte, Retouren, Bestellungen; `CUSTOMER_ORG_FEATURES` um `profit` erweitern.

### 7.10 Optional, nur mit passender Rolle
- [ ] Bericht „Umsatz und Traffic“ (Sitzungen, Conversion, Buy-Box) in der Verkaufsanalyse.
- [ ] SQP per SP-API als zweite Quelle für 2b.3 (statt CSV) – erst nachdem 2b.3–2b.5 gebaut sind.

### 7.11 Rechner aus dem Ideen-Dokument (Abschnitt G)
- [ ] Deal & Coupon (Deckungsbeitrag nach Rabatt, nötiger Mehrabsatz) auf Basis der P&L-Werte je Produkt.
- [ ] LTV und B2B-Inkrementalität nur, wenn die Daten aus 7.3 dafür reichen; sonst hier als offen notieren.

### 7.12 Abschluss
- [ ] Test mit einem echten Seller-Konto (braucht F1/F2 von Dominik): Verbinden, erster Import, Summen eines Monats
      gegen Seller Central prüfen (Umsatz, Gebühren, Erstattungen).
- [ ] Definition of Done belegen, `plan.md` und ADRs auf den Stand bringen, „Offen nach Phase 7“.

## Offen vor dem Bau

- **Dominik, vor 7.2b:** Art des Zugangs (F1). **Vor 7.12:** Rollen bestätigen (F2).
- **Dominik, vor 7.8:** Gehört das Honorar der Agentur in die OPEX des Clients (und damit in die Kundensicht)?
  Empfehlung: nein, OPEX enthält nur Kosten des Kunden; ein Honorar kann er selbst als Posten wollen.
- **Dominik, vor 7.12:** Die App braucht zusätzlich die Rolle **„Selling Partner Insights“** (Marktplatz-Teilnahmen);
  ohne sie scheitert schon das Verbinden mit `SP_ROLE_MISSING`.
- **Claude, erledigt am 2026-10-12** (siehe „Stand der SP-API“): Aufruf ohne SigV4, Rate-Limits, Reports-API,
  Name, Rolle und Höchstfenster von „Alle Bestellungen“. **Weiter offen:** brutto/netto und Steuer je Position auf
  EU-Marktplätzen (7.12, echte Datei), Host der Download-URL, Aufbewahrung der Berichte, Version der Finances-API
  (7.6), Berichte für 7.5 und 7.7.
- **Feature-Key `organic`** fehlt in `FEATURE_KEYS`, weil 2b.3–2b.5 (SQP, Organic) nie gebaut wurden
  (`phase-2b.md`). Er kommt mit 2b.3; kein Thema dieser Phase.

## Bewusst nicht in Phase 7

- Vendor-Konten (F3), Otto, eBay, Shopify.
- Käuferdaten, Rechnungen, Umsatzsteuer-Meldungen, Buchhaltungs-Export (DATEV).
- Bestandsplanung, Nachbestellung, Absatzprognose mit Bestand als Gebots-Leitplanke (Ideen-Dokument G; eigene Phase).
- Preisverlauf, Wettbewerber-Katalogdaten, automatische Conquesting-Kriterien.
- Schreiben an Amazon über die SP-API (Preise, Listings).
- Benachrichtigungen per SQS/EventBridge (keine zusätzlichen Konten); Berichte werden abgefragt.
- TACoS als Ziel oder Leitplanke der Automatik (erst wenn die Zahlen geprüft sind).

## Reihenfolge für Claude Code

7.1 → 7.2 → 7.3 → 7.4 → 7.5 → 7.6 → 7.7 → 7.8 → 7.9 → 7.11 → 7.12; 7.2b und 7.10 nur nach den genannten
Voraussetzungen. 7.4 braucht 7.3; 7.9 braucht 7.6 und 7.8; 7.7 und 7.8 hängen nicht voneinander ab. Bis zu drei
Aufgaben je Session (`CLAUDE.md`), nach jedem Schritt Tests grün, Commit, Häkchen und „Umsetzung“-Notiz.
