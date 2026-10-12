# ADR 007 – Amazon SP-API: Paket, Zugang und Datenschutz

- **Status:** begonnen (Phase 7, Aufgabe 7.1); die Quelle der Gebühren folgt in 7.6
- **Datum:** 2026-10-12 (Doku-Stand vom selben Tag, `docs/tasks/phase-7.md` „Stand der SP-API“)
- **Beteiligte:** Dominik (F0–F8 in `docs/tasks/phase-7.md`)

## Kontext

Phase 7 liest Bestellungen, Gebühren und Retouren aus der Selling Partner API. Sie nutzt dasselbe Login with Amazon wie
die Ads-API, unterscheidet sich aber in Aufruf (Token im Header `x-amz-access-token`, keine AWS-Signatur mehr),
Rate-Limits (je Operation) und Berechtigung (Rollen der App). Es gibt noch keinen geprüften Zugang; gebaut wird gegen
Mocks.

## Entscheidung

1. **Eigenes Paket `packages/amazon-sp`** (`plan.md` §5 Punkt 3) für Regionen, Marktplätze, Client und Mock.
2. **Wiederverwendung statt drittem Paket:** LwA (`createLwaClient`), Token-Cache (`createAccessTokenProvider`),
   HTTP-Kern mit Retry, verlustfreiem JSON und zod (`createHttpClient`), Anfrage-Budget (`createProfileRateLimiter`)
   und Download (`downloadFile`, `collectDownload`) kommen aus `@profitbash/amazon-ads`. Die Fehlerklassen heißen
   deshalb auch für die SP-API `AmazonAds…`, Logs `amazon_ads.*` (mit dem SP-Host). Ein gemeinsames Basispaket
   entsteht erst, wenn die Kopplung stört (z. B. mit einem dritten Amazon-Dienst).
3. **Zugangsdaten je Connection** (F1): Der Client fragt Client-ID und Secret je Connection ab (`credentialsFor`).
   Das deckt private Apps, je Kunde eigene Apps und eine Public App (dann dieselben Werte für alle) ab.
4. **Rate-Limits:** Budget je Operation und Connection nach den dokumentierten Standardraten; 429 halbiert die Rate.
   Der Header `x-amzn-RateLimit-Limit` wird nicht ausgewertet (laut Amazon nicht verlässlich). Burst 10 (Amazon
   nennt 15); das Anfrage-Budget aus `amazon-ads` kennt dafür die Option `burst` (7.2).
5. **Rollen:** Ein 403 nach einem frischen Token wird zu `AmazonSpRoleMissingError` (Code `SP_ROLE_MISSING`); Importe
   melden das als eigenen Fehler. Ein widerrufener Refresh-Token scheitert vorher bei LwA (Neu-Verbinden).
   Gebraucht werden bisher „Selling Partner Insights“ (Marktplatz-Teilnahmen) und „Inventory and Order Tracking“
   (Bestellberichte).
6. **Keine Käuferdaten:** Nur Berichte und Endpunkte ohne „restricted data token“; keine Rolle für personenbezogene
   Daten. Adressteile, die ein Bericht trotzdem enthält (`ship-city`, `ship-postal-code` …), verwirft der Import vor
   dem Speichern (7.3). Signierte Download-URLs werden weder gespeichert noch geloggt.

## Folgen

- `packages/amazon-ads` exportiert seine Bausteine; `http.ts` liest zusätzlich das Fehlerformat der SP-API
  (`errors[0]`), `downloadFile` nimmt eigene Hosts und nennt den `Content-Type`.
- Erlaubte Download-Hosts sind „S3 unter amazonaws.com“, weil die Doku keinen festen Host nennt; beim ersten echten
  Lauf (7.12) eingrenzen.

## Offen

- Quelle der Gebühren: Finances-API oder Abrechnungsbericht (7.6).
- OAuth-Weg der Public App (7.2b), sobald F1 geklärt ist.
