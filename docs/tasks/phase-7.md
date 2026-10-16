# Phase 7 – Profit

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap samt „Hinweis TACoS“, §3 Zeilen „Profit“, §4, §5 samt
> „Festlegungen für Phase 1 und später“), `docs/decisions/` (001 Stack, 002 Mandanten-Modell, 003 Decimal, 006 Automatik
> ohne API als Muster für „Quelle austauschbar“), `docs/tasks/phase-0.md` (0.3 OAuth, 0.5 Jobs), `docs/tasks/phase-1.md`
> (1.3 Lease und Anfrage-Budget, 1.5 Report-Anfragen, 1.11 Datei-Import), `docs/tasks/phase-6.md` (6.3a/6.3b: Seiten
> „kundensicher“ machen), `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` (Abschnitt G), `design/DESIGN.md`.
>
> **Status: verfeinert (2026-10-12), Fragen F1–F8 entschieden (die Nummern gelten nur in dieser Datei). Fertig: 7.1, 7.2 (ohne 7.2b),
> 7.3, 7.4. Nächste Aufgabe: 7.5.** Offen bei Dominik (nachgefragt am 2026-10-16, weiter offen): F1 (Art des Zugangs) und F2
> (Rollen prüfen); beides hält 7.5–7.9 nicht auf, weil bis dahin gegen Mocks gebaut wird.
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
- [x] Paket anlegen: Regionen und Endpunkte (eu/na/fe), Marktplatz-Liste (ID, Land, Währung, Zeitzone, Seller-Central-
      Domain) – vorhandene Marktplatz-Daten aus `@profitbash/shared` wiederverwenden und nur ergänzen.
- [x] Client mit LwA-Token aus `packages/amazon-ads`, Rate-Limit je Operation nach den dokumentierten Standardraten
      (der Header `x-amzn-RateLimit-Limit` ist laut Amazon nicht verlässlich), Fehlerabbildung (401/403 → Neu-Verbinden bzw. `SP_ROLE_MISSING`, 429 → Backoff),
      zod an jeder Antwort, verlustfreies JSON.
- [x] Operationen: Marktplatz-Teilnahmen des Kontos (Sellers-API), Reports-API (anlegen, Status, Dokument laden und
      entpacken). Mock-Server (msw) mit kleinen, erfundenen Daten für beide.
- [x] ADR 007 beginnen: Paketgrenzen, Wiederverwendung von LwA, Umgang mit Rollen, keine Käuferdaten.

- [x] Umsetzung (Stand für 7.2 und 7.3):
  - **Paket** `@profitbash/amazon-sp`: `AMAZON_SP_REGIONS` (API-Host je Region, Token immer `api.amazon.com`),
    `spMarketplaceFor(marketplaceId)` (Marktplatz aus `@profitbash/shared` plus Region und Seller-Central-Adresse;
    `undefined` für unbekannte Marktplätze, die 7.2 überspringt und meldet), `createAmazonSpClient`,
    `createMockAmazonSpClient`, `AmazonSpRoleMissingError`. ADR 007 begonnen.
  - **Client:** `createAmazonSpClient({ credentialsFor, store, logger, http })`; `ConnectionRef` und
    `RefreshTokenStore` wie bei Ads (der Token-Store aus `@profitbash/db` passt unverändert). `credentialsFor`
    liefert Client-ID und Secret je Connection (7.2 liest sie aus der verschlüsselten Tabelle bzw. aus `.env`); je
    Connection ein eigener Token-Cache, `invalidateAccessToken(connectionId)` nach Neu-Verbinden und Trennen aufrufen.
    Methoden: `getMarketplaceParticipations`, `createReport`, `getReport` (`IN_QUEUE`/`IN_PROGRESS`/`DONE` mit
    `reportDocumentId`/`FATAL`/`CANCELLED`/`NOT_FOUND`), `getReportDocument`, `downloadReportDocument(document,
    { maxBytes })` → Text (gzip entpackt, Zeichensatz aus dem `Content-Type`, ohne Angabe UTF-8) oder `expired`.
    Alle nehmen `{ meter }` für `job_runs.counters`.
  - **Für 7.2:** Die Teilnahmen nennen keine Seller-ID; „Token eintragen“ fragt sie ab. Das Budget der Teilnahmen ist
    0,016/s mit Burst 10 (seit 7.2, Option `burst` im Anfrage-Budget): Die ersten zehn Aufrufe gehen sofort.
  - **Für 7.3:** `CANCELLED` meldet Amazon auch bei einem Bericht ohne Daten (als leer behandeln, nicht als Fehler).
    Die Dokument-URL läuft nach 5 Minuten ab: erst unmittelbar vor dem Download holen, bei `expired` neu holen.
    `createReport` hat 0,0167/s mit Burst 10: zehn Berichte sofort, danach einer je Minute und Connection.
  - **Fehler:** 401/403 → einmal frisches Token (höchstens einmal je Minute und Connection), danach 403 →
    `AmazonSpRoleMissingError` (`SP_ROLE_MISSING`, erbt von `AmazonAdsHttpError`); `invalid_grant` bei LwA →
    `AmazonAdsReauthRequiredError`; 429 → Backoff und halbierte Rate.
  - **Mock:** der echte Client mit `fetch` im Prozess. Refresh-Token `MOCK_AMAZON_SP_REFRESH_TOKEN`, jeder andere
    gilt als widerrufen. Teilnahmen: eu DE und FR aktiv, UK inaktiv; na US. Bestellberichte (beide Typen) mit
    erfundenen Positionen je Tag: zwei versendete (eine um 22:30 UTC), regelmäßig storniert, „Pending“ ohne Preis
    (selbst versandt) und B2B; Datei gzip in Cp1252 mit Adressspalten. Die Bericht-ID kodiert den Auftrag
    (Neustart-fest), fertig nach `processingMs` (5 s).
  - **Im Ads-Paket geändert:** `parseErrorBody` liest `errors[0]`; `downloadFile` mit `allowedHosts` und
    `contentType`; neu `collectDownload` (mit und ohne gzip, mit Deckel); Exporte für die Bausteine.
  - **Nicht gebaut:** Auswertung von `x-amzn-RateLimit-Limit`, Env-Schema (`AMAZON_SP_*`, kommt mit der
    Verdrahtung in 7.2), `getReports`/Zeitpläne, Marktplätze außerhalb von `@profitbash/shared` (JP, AU, MX …).

### 7.2 Connection und Seller-Konten
- [x] Migration: Provider `amazon_sp`; `amazon_sp_accounts` (Connection, Client, `amazon_seller_id`, `marketplace_id`,
      Währung, Zeitzone, ausgeblendet/entfernt wie bei Profilen); verschlüsselte Zugangsdaten je Connection (F1).
- [x] Access-Layer: `visibleSellerAccountsScope()`, `canSeeSellerAccount()`; Tests wie `access.test.ts`,
      `access-grants.test.ts`, `access-client-org.test.ts`.
- [x] API hinter `orgAdminOnly`: Connection anlegen über **„Token eintragen“** (Zugangsdaten prüfen durch einen
      Aufruf der Marktplatz-Teilnahmen, nie zurückgeben), Konten synchronisieren, Client zuordnen, ausblenden;
      Audit je Aktion. **Trennen ist nicht gebaut** (siehe Umsetzung).
- [x] Oberfläche unter „Clients & Connections“: Kachel „Seller-Konten“ neben den Ads-Connections.
- [ ] **7.2b OAuth-Weg der Public App** (Start in Seller Central, Rückkehr mit `spapi_oauth_code`, `state` signiert wie
      bei Ads): erst bauen, wenn F1 „Public App“ ergibt.
- [x] Umsetzung (Stand für 7.3):
  - **Schema** (Migration `0050_amazon_sp_accounts`, `schema/amazon-sp.ts`): `amazon_sp_accounts` (unique je
    Organisation, Seller-ID und Marktplatz; unique (`id`, `organization_id`) als Ziel der FKs ab 7.3; Connection mit
    `ON DELETE CASCADE`) und `amazon_sp_credentials` (Client-ID, Secret verschlüsselt mit eigener AAD
    `spClientSecretAad`). Die Connection trägt die Seller-ID als `external_account_id`; dieselbe Seller-ID in
    derselben Region verbindet neu (Upsert). Die Schlüsselrotation verschlüsselt auch das App-Secret neu.
  - **DB** (`seller-accounts.ts`): `saveSpConnection` (Connection, Zugangsdaten, Konten und Audit
    `connection.create`/`connection.reconnect` in einer Transaktion), `syncSellerAccounts` (Upsert; Client und
    „ausgeblendet“ bleiben; was Amazon nicht mehr liefert, bekommt `removed_at`; unbekannte Marktplätze werden
    übersprungen und genannt), `getSpCredentials`. Zeitzone und Währung kommen aus `AMAZON_MARKETPLACES`.
  - **Access-Layer:** `visibilityConditions` nimmt die Tabelle als Parameter; Seller-Konten folgen exakt den Regeln
    der Profile (Mitgliedschaft, Freigaben je Client, Kunden-Org, ausgeblendet/entfernt nur für Admins).
  - **Abgrenzung zu Ads:** `listActiveConnections`, `listOtherActiveConnections`, `GET /api/connections`,
    `findConnection` und die Erinnerung „Einwilligung läuft ab“ gelten nur für `amazon_ads`. **Für 7.3:** Jobs für
    SP-Connections brauchen eine eigene Planung (nicht `listActiveConnections`).
  - **API** (`routes/seller-connections.ts`, alle hinter `orgAdminOnly`, für Kunden-Logins geschlossen):
    `GET /api/seller-connections` (mit Konten, nie mit Zugangsdaten), `POST /api/seller-connections` (prüft mit einem
    Wegwerf-Client, speichert erst danach; 201 neu, 200 neu verbunden), `POST /api/seller-connections/{id}/sync`,
    `PATCH /api/seller-accounts/{id}` (Audit `seller_account.update` mit vorher/nachher). Fehlercodes:
    `SP_TOKEN_REJECTED`, `SP_CREDENTIALS_REJECTED`, `SP_ROLE_MISSING`, `AMAZON_ERROR`, `CONNECTION_REAUTH_REQUIRED`
    (der Abgleich setzt dann `reauth_required`).
  - **Verdrahtung:** `createAmazonSpDeps` (`apps/api/src/amazon-sp.ts`), `AppDeps.amazonSp`, `AMAZON_SP_USE_MOCK`
    (`.env.example`, `docs/deploy.md`). Der Worker kennt die SP-API noch nicht (kommt mit 7.3).
  - **Anfrage-Budget:** Option `burst` in `createProfileRateLimiter` (Ads unverändert 1), der SP-Client nutzt 10.
  - **Oberfläche:** `SellerAccountsCard.vue` und `SellerConnectionDialog.vue`; eigene Abfrage mit Skeleton, leerem
    Zustand und Fehler; „Entfernte anzeigen“ der Seite gilt mit. Geprüft im Browser gegen den Mock bei 1440 px,
    Tablet, Handy und dunkel (Tabelle scrollt in der Kachel, Seite nicht), Konsole ohne Fehler außer dem erwarteten
    400 beim abgelehnten Token. Die Pane war dabei verdeckt: Bedienung per DOM-Klick auf die echten Bedienelemente,
    keine Screenshots.
  - **Rest in der Dev-DB:** eine SP-Connection des Mock-Verkäufers `A1MOCKSELLER01` (Region Europa) mit den Konten
    DE und FR; ohne „Trennen“ nicht über die Oberfläche entfernbar, als Demo für 7.3 brauchbar.
  - **Nicht gebaut, offen:** „Trennen“ (auch Ads-Connections haben es nicht; Löschen nähme ab 7.3 alle Verkaufsdaten
    mit – Frage an Dominik unter „Offen vor dem Bau“); der Abgleich läuft direkt in der Anfrage statt über `runJob`
    (ein Aufruf; der tägliche Abgleich kommt mit den Jobs in 7.3); ob die eingetragene Seller-ID zum Token gehört,
    kann die SP-API nicht bestätigen.

### 7.3 Bestellungen laden (Sales-Import)
- [x] Tabellen: Report-Anfragen (Zustand in der DB wie `amazon_ads_report_requests`; prüfen, ob die Tabelle
      verallgemeinert oder gespiegelt wird – die kleinere Änderung gewinnt), Bestellpositionen (Bestellnummer, SKU,
      ASIN, Menge, Preis, Steuer, Rabatt, Versanderlös, Status, Kanal FBA/FBM, B2B-Kennzeichen, Zeitpunkte) und
      Tageswerte je Seller-Konto und SKU.
- [x] Job je Seller-Konto über `runJob`: täglich das Fenster der zuletzt geänderten Bestellungen laden (rollierend
      30 Tage, Upsert je Bestellposition), Tageswerte neu verdichten; Backfill 12 Monate in Monatsscheiben (F8).
- [x] Parser verwirft Spalten mit Käuferdaten (Test); stornierte Bestellungen zählen nicht zum Umsatz.
- [x] Sync-Status zeigt Seller-Konten mit letztem Lauf und Fehler.
- [x] Umsetzung (Stand für 7.4 und später):
  - **Gespiegelt statt verallgemeinert:** eigene Tabelle `amazon_sp_report_requests` (Migration `0051_amazon_sp_orders`,
    `schema/amazon-sp.ts`) mit dem Status-Enum der Ads-Aufträge. Die Ads-Zustandsmaschine hängt an Profilen,
    JSON-Downloads, Export-Batches und Datumsbereichen; sie zu verallgemeinern wäre größer gewesen als ein schlanker
    eigener Ablauf. Wiederverwendet: `isConnectionError`, Backoff, Grenzen und Texthilfen aus
    `apps/worker/src/amazon-requests/state-machine.ts`, `handleAmazonError`, Lease und `runJob`.
  - **Tabellen:** `amazon_sp_order_items` (PK Konto + Bestellnummer + SKU; Beträge `numeric` wie geliefert, `null`
    wenn leer; Kaufzeitpunkt UTC und Kaufdatum in der Zeitzone des Marktplatzes; FK auf das Konto **ohne** Cascade, weil
    Historie), `amazon_sp_daily_sales` (PK Konto + Tag + SKU; Stück, Bestellungen, `unpriced_units` = Stück ohne
    Preis, Summen aller Betragsspalten, ohne Stornierte), Spalte `amazon_sp_accounts.orders_history_requested_at`.
  - **Upsert nach Änderungsdatum:** Eine Position wird nur überschrieben, wenn `last_updated_at` der neuen nicht älter
    ist. Damit spielt die Reihenfolge der Berichte keine Rolle (kein „überholt“ wie bei Ads). Danach werden die
    Tageswerte der betroffenen Kaufdaten gelöscht und aus den Positionen neu verdichtet (`importSpOrderItems`).
  - **Storno:** zählt nicht, wenn `order-status` oder `item-status` `Cancelled` ist. Selbst versandte „Pending“-Positionen
    zählen als Stück, ihr Umsatz fehlt (`unpriced_units`; 7.4 sagt das an).
  - **Parser** (`parseOrdersReport` in `@profitbash/amazon-sp`): liest nur eine feste Spaltenliste (nie Adressteile oder den
    Produktnamen), fasst doppelte Zeilen derselben Bestellung und SKU zusammen, zählt ungültige Zeilen; fehlen
    Pflichtspalten, scheitert der Import (3 Versuche).
  - **Job `sp-orders-sync`** (je SP-Connection, Lease wie Ads): plant je Konto (auch ausgeblendete, nicht entfernte)
    einmal die Historie nach Kaufdatum in **30-Tage-Scheiben** (Amazon erlaubt höchstens 30 Tage; Kalendermonate passen
    nicht) von 365 bis 30 Tage zurück, und das rollierende Fenster nach Änderungsdatum (30 Tage), sobald das letzte
    über 20 h alt ist. Danach höchstens 20 fällige Aufträge, 5 Downloads, 5 Min. je Lauf, je Konto die jüngsten Daten
    zuerst; der Job plant sich zum nächsten Termin neu ein. Ein Bericht je Konto und Marktplatz (`marketplaceIds` mit
    genau einer ID). `CANCELLED` = leer, `FATAL` = gescheitert, `NOT_FOUND` und zweimal abgelaufene Dokument-URL =
    neu anfordern (höchstens 3-mal), 4xx (auch `SP_ROLE_MISSING`) = gescheitert. Gescheiterte Berichte beenden den Lauf
    als Fehler mit dem ersten Grund (Sync-Status).
  - **Auslöser:** `sp-orders-sync-all` täglich 06:00 Berlin (alle aktiven SP-Connections), `sp-orders-poll-all` alle
    10 Min. (nur mit fälligen Berichten). `dispatchConnectionJobs` wählt die Connections jetzt nach dem Namen des
    Auslösers. Aufräumen nach 30 Tagen wie bei Ads (`job-runs-cleanup`).
  - **Verdrahtung:** `ConnectionJobDeps.amazonSp` (optional, nur dieser Job), `StartWorkerOptions.amazonSp`; der Worker liest
    `AMAZON_SP_USE_MOCK` und baut den Client wie `createAmazonSpDeps` (Zugangsdaten je Connection aus der DB).
  - **Sync-Status:** Jobname „Bestellungen (Seller)“, Konto = Seller-ID der Connection, Zähler `planned`, `requested`,
    `imported`, `rows`, `invalidRows`, `failed`; keine eigene Ansicht je Seller-Konto (reicht bis 7.12).
  - **Geprüft:** Tests gegen den Mock (Historie und Fenster, Import, 22:30 UTC = nächster Tag in Berlin im Sommer, keine
    Adressen in der DB, Tageswerte = nicht stornierte Positionen) und Grenzfälle mit Stub-Client; Lauf im Dev-Server
    gegen den Mock.
  - **Shortcuts:** Eine endgültig gescheiterte Scheibe der Historie wird nicht nachgeholt (sichtbar im Sync-Status);
    vorübergehende Fehler beim Holen des Dokuments zählen als Importversuch.
  - **Offen bis 7.12 (echte Datei):** ob `item-price` in der EU brutto ist und `item-tax` immer gefüllt; Vorzeichen der
    Rabattspalten (gespeichert wie geliefert); ob Amazon den Bericht im EU-Konto wirklich auf die angefragte
    Marktplatz-ID beschränkt (sonst landen FR-Bestellungen im DE-Konto; dann über `sales-channel` filtern).

### 7.4 Echtes TACoS und Verkaufsanalyse (`/profit/sales`)
- [x] Leseschicht: Umsatz, Stück, Bestellungen je Tag, Marktplatz, SKU/ASIN; organischer Umsatz und TACoS nach der
      Festlegung oben; Umrechnung in die Anzeigewährung wie im Dashboard („≈“).
- [x] Dashboard: Kennzahlen TACoS und organischer Umsatz, nur wenn `profit` gebucht ist und der Client ein Seller-Konto
      auf dem Marktplatz hat; sonst der bisherige Stand.
- [x] Seite Verkaufsanalyse: Zeitraum und Vergleich, Chart, Tabelle je Produkt, Umschaltung netto/brutto (F6).
- [x] Kundensicht (F7): Endpunkte freigeben, Tests mit zweitem Client.
- [x] Umsetzung (Stand für 7.5 und später):
  - **Festlegung Umsatz (Claude, 2026-10-16; Dominik kann widersprechen):** Umsatz = `item-price` − Aktionsrabatt (Betrag,
    Vorzeichen egal), **ohne** Versand und Geschenkverpackung (wie „Umsatz bestellter Produkte“). Brutto/netto: Außer in
    **US und CA** enthalten Amazon-Preise die Steuer (netto = Preis − `item-tax`); dort kommt sie dazu (brutto = Preis +
    `item-tax`). Als `shortcut:` im Code (`TAX_EXCLUSIVE_COUNTRIES`), mit echten Dateien in 7.12 prüfen.
  - **Leseschicht** `querySales` (`packages/db/src/sp-sales.ts`): sichtbare Konten über `visibleSellerAccountsScope` plus
    Client-Filter; mit `profileIds` nur Konten, deren Client und Marktplatz zu einem gewählten Profil passen. Umrechnung
    über `fxSql` aus `ads-analytics` (exportiert), Summen auf 12 Nachkommastellen. Eine Abfrage mit `grouping sets`
    (gesamt, je Tag, je Konto und SKU); **Bestellungen gesamt** zählt Bestellnummern ohne Doppel aus den Positionen
    (je Tag/SKU wäre eine Bestellung mit zwei SKUs doppelt). Produkte höchstens 10 000 (`truncated`).
  - **Werbung:** Profile desselben Clients und Marktplatzes (`amazon_ads_profiles.marketplace_id`), sichtbar über den
    Access-Layer, Summen über `queryDashboard` in derselben Anzeigewährung. Kein passendes Profil → `ads: null`, TACoS
    und organischer Umsatz fehlen (Hinweis auf der Seite, keine Kacheln im Dashboard).
  - **Engine** `salesMetrics`: TACoS = Werbekosten ÷ Netto-Umsatz (immer netto), organisch = Umsatz − Anzeigen-Umsatz,
    nie unter 0, je für netto und brutto.
  - **API** `POST /api/profit/sales` (Feature `profit`, nur lesen), Antwort mit beiden Umsätzen; die Oberfläche wählt.
    Für Kunden-Logins in `CUSTOMER_ORG_PATHS`, Test mit zweitem Client (`routes/profit-sales.test.ts`); gebucht wird
    `profit` für Kunden-Orgs erst in 7.9. `POST /api/ads/filter-options` öffnet jetzt auch `profit` (die Seite nutzt
    die Filterleiste des Dashboards).
  - **Oberfläche:** `SalesPage.vue` mit Filterleiste, fünf KPI-Kacheln (Umsatz, Bestellungen, Stück, TACoS, organisch),
    Hinweisen (TACoS-Definition, Stück ohne Preis, kein Ads-Profil), Tagesverlauf (Umsatz und Stück) und den 100
    umsatzstärksten Produkten (alle: `/profit/products`, 7.5). Netto/brutto über `useVatMode` (UI-State `profit/vat`,
    Standard netto), gilt auch im Dashboard. Die Farbe der Veränderung folgt den Ads-Kennzahlen (TACoS wie ACoS).
  - **Geprüft:** Tests in Engine, DB (Rechenregeln, Vergleich, Sichtbarkeit), API und Web; im Browser gegen den Mock
    (1440 px, Tablet hell, Handy dunkel, kein seitliches Scrollen; Umschalter mit echtem Bedienelement, bleibt nach
    Neuladen; Dashboard zeigt TACoS). **Rest in der Dev-DB:** die Mock-Seller-Konten DE und FR hängen am Client
    „Waldkauz (Demo)“ (für die Prüfung zugeordnet).
  - **Nicht gebaut:** organischer Umsatz je Tag im Chart (nur Summen; der Zeitbezug von Klick- und Kauftag macht
    Tageswerte wenig aussagekräftig), Vergleichsreihe im Chart, Spalten Vergleich je Produkt.
  - **Offen bis 7.12:** ob Amazon-Anzeigen-Umsatz in der EU brutto ist (organisch mischt sonst brutto und netto).

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
- **„Trennen“ für Seller-Connections: entschieden (Dominik, 2026-10-16): nur den Abruf stoppen, Daten behalten** (wie
  empfohlen). Noch nicht gebaut; bis dahin reicht „Ausblenden“ je Konto. Passt zum FK ohne Cascade an den Positionen.
- **Honorar in OPEX: entschieden (Dominik, 2026-10-16): nein** (wie empfohlen). OPEX enthält nur Kosten des Kunden (7.8).
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
