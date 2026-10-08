# ADR 005 – Amazon-Ads-API für Schreibaufträge

- **Status:** angenommen
- **Datum:** 2026-10-08 (Start von Phase 3, Doku-Stand vom selben Tag)
- **Beteiligte:** Dominik
- **Bezug:** ADR 004 hatte das Schreiben offen gelassen („beim Start von Phase 3 als eigene Entscheidung prüfen“).

## Kontext

Phase 3 ändert Zustand, Tagesbudget, Gebote, Gebotsstrategie und Platzierungen und legt Negatives an bzw. archiviert sie
(`docs/tasks/phase-3.md`, F3). Amazon bietet dafür weiter zwei Generationen an:

- **Produktspezifisch:** Sponsored Products v3, Sponsored Brands v4 (Keywords und Targets dort noch v3), Sponsored Display.
  Alles GA, deckt SP, SB und SD ab.
- **Amazon Ads API v1** (Campaign Management, `/adsApi/v1/...`): ein Modell für alle Anzeigentypen, GA für SP und SB;
  Sponsored Display fehlte beim Stand von ADR 004 (2026-09-26).

Es gibt weiterhin keinen API-Zugang (`phase-1.md` F12). Gebaut und geprüft wird gegen msw und den Mock-Anbieter; der zweite
Weg ist die Bulk-Datei (`phase-3.md` F2).

## Entscheidung

**Geschrieben wird über die produktspezifischen APIs** (Dominik, 2026-10-08, `phase-3.md` F10), hinter einem eigenen,
schmalen Modell in `packages/amazon-ads` (`AmazonAdsWriteOperation` → `applyChanges`). Jobs und Datenbank kennen die
Endpunkte nicht; ein späterer Wechsel auf v1 bleibt auf das Paket begrenzt (wie beim Lesen, ADR 004).

Umgesetzt wird in zwei Schritten: **Sponsored Products v3** mit 3.2a, **Sponsored Brands und Sponsored Display** mit 3.2c
(wie in Phase 1: SP zuerst vollständig, SB und SD danach). Bis dahin lehnt `applyChanges` andere Ad-Typen je Änderung ab
(`AD_PRODUCT_NOT_SUPPORTED`); der Weg über die Bulk-Datei ist davon unabhängig.

### Sponsored Products v3 (geprüft am 2026-10-08 gegen die OpenAPI-Spec `SponsoredProducts_prod_3p.json`)

| Änderung | Endpunkt | Hinweis |
|---|---|---|
| Zustand, Tagesbudget, Gebotsstrategie, Platzierungen der Kampagne | `PUT /sp/campaigns` | `budget: { budgetType: DAILY, budget }`; `dynamicBidding: { strategy, placementBidding[] }` |
| Zustand, Standardgebot der Ad Group | `PUT /sp/adGroups` | |
| Zustand, Gebot eines Keywords | `PUT /sp/keywords` | |
| Zustand, Gebot eines Produkt-, Kategorie- oder Auto-Targets | `PUT /sp/targets` | Liste `targetingClauses` |
| Zustand einer Product Ad | `PUT /sp/productAds` | |
| Archivieren (alle Entities, auch Negatives) | `POST /sp/<entity>/delete` | ID-Filter `{ <x>IdFilter: { include: [...] } }` |
| Negatives Keyword in Ad Group bzw. Kampagne | `POST /sp/negativeKeywords`, `/sp/campaignNegativeKeywords` | `matchType` `NEGATIVE_EXACT` \| `NEGATIVE_PHRASE` |
| Negative ASIN in Ad Group bzw. Kampagne | `POST /sp/negativeTargets`, `/sp/campaignNegativeTargets` | `expression: [{ type: ASIN_SAME_AS, value }]` |

- **Zustände beim Update sind nur `ENABLED` und `PAUSED`** (dazu `PROPOSED`). `ARCHIVED` gibt es nur über die
  `delete`-Endpunkte. Die Schreibschicht (3.1) führt Archivieren als Feld `state = ARCHIVED`; 3.3 bildet das auf
  `archive` ab.
- **Bis zu 1000 Einträge je Aufruf**, Content-Type und Accept je Entity (`application/vnd.sp<Entity>.v3+json`).
- **Antwort `207`** mit `{ <entities>: { success: [{ index, <id> }], error: [{ index, errors: [...] }] } }`: Erfolg und
  Fehler je Eintrag, `index` zeigt in das Array der Anfrage. Fehler tragen `errorType` und darunter `reason` und
  `message` (z. B. `biddingError` / `BID_OUT_OF_MARKET_PLACE_RANGE` mit `lowerLimit`/`upperLimit`).
- **Gebote und Budgets sind JSON-Zahlen** (`double`). Der Client schreibt den Decimal-String unverändert als
  Zahl-Literal (`jsonDecimal`, `JSON.rawJSON`), nie über `number`.
- **Gebotsstrategie:** eigenes Modell `SALES_DOWN_ONLY` / `SALES_UP_AND_DOWN` / `NONE` (wie der Export und die DB) →
  `LEGACY_FOR_SALES` / `AUTO_FOR_SALES` / `MANUAL`. `RULE_BASED` wird nicht gesetzt.
- **Platzierungen:** `PLACEMENT_TOP`, `PLACEMENT_REST_OF_SEARCH`, `PLACEMENT_PRODUCT_PAGE`, `SITE_AMAZON_BUSINESS`, ganze
  Prozent 0–900.
- **Drosselung:** `429` mit `{ code: THROTTLED }`; Rate-Limits sind dynamisch (wie beim Lesen: Anfrage-Budget je Profil,
  `Retry-After`).

### Verhalten des Clients

- Ergebnis **je Änderung**: `applied` (mit ID), `failed` (Grund und Text von Amazon), `unsent` (gedrosselt, später
  erneut senden) oder `unknown` (5xx, Netzwerkfehler, unlesbare Antwort: kann angewendet sein).
- Wiederholt werden 429 immer, 5xx und Netzwerkfehler nur bei Updates und beim Archivieren (sie setzen denselben
  Zielwert). **Anlagen werden nicht wiederholt**, sonst entstünden doppelte Negatives.
- 401, 403 und ein abgelehnter Refresh-Token sind Fehler der Connection und werden geworfen, nicht je Änderung gemeldet.
- **Grenzen von Amazon** (Mindest- und Höchstgebot, Tagesbudget je Marktplatz, Wortzahl negativer Keywords) liegen als
  Daten in `limits.ts`, Quelle: Amazon-Doku „Limits, constraints, and quotas“, gelesen am 2026-10-08.

## Begründung

- Nur GA-Schnittstellen, und alle drei Anzeigentypen sind abgedeckt (v1 ohne SD bräuchte einen zweiten Weg).
- Die IDs und Werte entsprechen dem, was Exports und Bulk-Dateien liefern (Phase 1 und 1.11).
- Die Antwortform mit Erfolg und Fehler je Eintrag passt zum Ziel „Teilfehler brechen die Übermittlung nicht ab“.

## Konsequenzen

- Je Anzeigentyp eine eigene Abbildung (SP in `writes.ts`, SB und SD mit 3.2c: eigene Endpunkte, Body- und Antwortformen).
- **Offen für 1.10 (erster echter Lauf):** ob `dynamicBidding` als Ganzes ersetzt wird (der Client schickt Strategie und
  alle Platzierungen deshalb immer zusammen), ob ein Budget-Update `budgetType` verlangt (die Spec sagt ja), ob die
  `delete`-Endpunkte je ID ein Ergebnis mit `index` liefern, welche Fehlercodes in der Praxis vorkommen, wie streng die
  Drosselung beim Schreiben ist, ob Vendor-Profile dieselben Endpunkte annehmen.
- **Wiedervorlage:** Wechsel auf die Amazon Ads API v1, sobald sie SD abdeckt und stabil ist oder Amazon die
  produktspezifischen Schreib-Endpunkte abkündigt.

## Verworfene Alternativen

- **Amazon Ads API v1:** ein Modell und die Richtung von Amazon, aber SD fehlte; zwei Wege für eine Aufgabe.
- **Erst mit Zugang entscheiden** (nur eigenes Modell, Mock im Prozess, Bulk-Datei): weniger Arbeit auf Verdacht, aber
  Teilfehler und Rate-Limits blieben ungeprüft, und Phase 3 hätte beim Zugang einen offenen Baustein.
