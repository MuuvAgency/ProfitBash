# ADR 005 – Amazon-Ads-API für Schreibaufträge

- **Status:** angenommen
- **Datum:** 2026-10-08 (Start von Phase 3, Doku-Stand vom selben Tag), am 2026-10-09 um Sponsored Brands und
  Sponsored Display ergänzt (3.2c)
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

Umgesetzt in zwei Schritten: **Sponsored Products v3** mit 3.2a, **Sponsored Brands und Sponsored Display** mit 3.2c
(wie in Phase 1: SP zuerst vollständig, SB und SD danach). Andere Ad-Typen lehnt `applyChanges` je Änderung ab
(`AD_PRODUCT_NOT_SUPPORTED`).

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

### Sponsored Brands (geprüft am 2026-10-09 gegen `SponsoredBrands_prod_3p.json` für v4 und die Spec `sponsored-brands/3-0`)

| Änderung | Endpunkt | Hinweis |
|---|---|---|
| Zustand, Tagesbudget der Kampagne | `PUT /sb/v4/campaigns` | `budget` als Zahl; **höchstens 10 je Aufruf** |
| Zustand der Ad Group, Zustand der Anzeige | `PUT /sb/v4/adGroups`, `PUT /sb/v4/ads` | höchstens 10 je Aufruf |
| Archivieren von Kampagne, Ad Group, Anzeige | `POST /sb/v4/<entity>/delete` | ID-Filter wie bei SP, höchstens 10 IDs |
| Zustand, Gebot eines Keywords | `PUT /sb/keywords` (v3) | Liste; `keywordId`, `adGroupId`, `campaignId` als **JSON-Zahl**, Zustand klein |
| Zustand, Gebot eines Produkt-Targets | `PUT /sb/targets` (v3) | `{ targets: [...] }` |
| Archivieren von Keywords, Targets, Negatives | dieselben `PUT`-Endpunkte bzw. `PUT /sb/negativeKeywords`, `PUT /sb/negativeTargets` | Zustand `archived` |
| Negatives Keyword bzw. negative ASIN in der Ad Group | `POST /sb/negativeKeywords`, `POST /sb/negativeTargets` | `negativeExact` \| `negativePhrase`; `expressions: [{ type: asinSameAs, value }]` |

- **v4** antwortet wie SP v3 (`207`, `success`/`error` je `index`), Content-Type
  `application/vnd.sb<campaign|adgroup|ad>resource.v4+json`, IDs als Text.
- **v3** (Keywords, Targets, Negatives): `application/json`, höchstens 100 je Aufruf, **IDs als `integer`**. Der
  Client schreibt die Ziffern der ID als Zahl-Literal (`jsonDecimal`) und liest Antworten verlustfrei
  (`parseJsonLossless`); intern bleiben IDs Strings. Kampagne und Ad Group stehen in jedem Eintrag, deshalb tragen
  die Schreibaufträge für Keywords, Targets und das Archivieren optional `amazonCampaignId` und `amazonAdGroupId`
  (der Job liefert sie immer mit).
- **Reihenfolge:** Archivieren über den Zustand `archived` nutzt den Update-Endpunkt, geht aber als eigener
  Aufruf nach den Updates raus (gilt auch für SD); dieselbe Entity in Update und Archivieren eines Aufrufs wird
  abgelehnt (`DUPLICATE_OPERATION`).
- **Themen-Targets** (`targetType: theme`) haben einen eigenen Endpunkt (`/sb/themes`); der Job lehnt Änderungen
  daran ab (`TARGET_TYPE_NOT_SUPPORTED`).
- **Antwortformen v3:** Keywords und negative Keywords als Liste `{ keywordId, code, description }` in der
  **Reihenfolge der Anfrage** (`code: SUCCESS` = angenommen); Targets und negative Targets als
  `{ updateTarget|createTarget SuccessResults: [{ targetId, targetRequestIndex }], …ErrorResults: [{ code, details,
  targetRequestIndex }] }`.
- **Nicht abgebildet** (Ablehnung `NOT_SUPPORTED` je Änderung, ohne Amazon zu fragen): Gebotsstrategie und
  Platzierungen (SB kennt `bidOptimization` und eigene Platzierungen `HOME`, `DETAIL_PAGE`, `OTHER`,
  `TOP_OF_SEARCH`; die Schreibschicht bietet beides nur für SP an), Standardgebot der Ad Group (gibt es bei SB
  nicht), Negatives auf Kampagnenebene.

### Sponsored Display (geprüft am 2026-10-09 gegen die Spec `sponsored-display/3-0`)

| Änderung | Endpunkt | Hinweis |
|---|---|---|
| Zustand, Tagesbudget der Kampagne | `PUT /sd/campaigns` | Liste; `budget` als Zahl |
| Zustand, Standardgebot der Ad Group | `PUT /sd/adGroups` | |
| Zustand, Gebot eines Targets | `PUT /sd/targets` | bei `costType` vCPM je 1000 sichtbare Impressionen |
| Zustand einer Product Ad | `PUT /sd/productAds` | |
| Archivieren (Kampagne, Ad Group, Target, Product Ad, negatives Target) | dieselben `PUT`-Endpunkte, `PUT /sd/negativeTargets` | Zustand `archived` (laut Doku gleichwertig zu `DELETE /sd/<entity>/{id}`) |
| Negative ASIN in der Ad Group | `POST /sd/negativeTargets` | `expressionType: manual`, `expression: [{ type: asinSameAs, value }]`, `state: enabled` |

- Alles `application/json`, Listen von Einträgen, **IDs als `integer`**, Zustände klein (`enabled`, `paused`,
  `archived`). Antwort `207` als Liste `{ code, description, <id> }` in der Reihenfolge der Anfrage.
- **Nicht vorhanden:** Keywords, negative Keywords, Negatives auf Kampagnenebene, Gebotsstrategie und Platzierungen.
- Die Spec nennt 100 je Aufruf für Targets und negative Targets, für Kampagnen, Ad Groups und Product Ads keine
  Höchstzahl; der Client schickt überall höchstens 100 (beim ersten echten Lauf prüfen).
- Die Spec beschreibt `code` auch als HTTP-Status: `SUCCESS` oder ein 2xx-Wert gilt als angenommen, ein Eintrag
  ohne Code als unklar (nicht als gescheitert, sonst würde eine Anlage doppelt angelegt).

### Grenzen für SB und SD

Aus derselben Doku-Seite wie bei SP („Limits, constraints, and quotas“, gelesen am 2026-10-09): Gebote je
**Kostenart** (CPC, vCPM) und Marktplatz, dazu Tagesbudgets. Amazon unterscheidet bei SB zusätzlich Bild und Video
und bei vCPM zwei Kampagnenziele; diese Merkmale kennt ProfitBash nicht. `limits.ts` prüft deshalb gegen die
**weiteste** Spanne je Ad-Typ, Kostenart und Marktplatz (sperrt nie einen gültigen Wert), ohne bekannte Kostenart
gegen die Spanne über beide. Die Kostenart kommt aus `extra.costType` der Kampagne. Für SD in Irland nennt Amazon
keine Grenzen; für SD-Budgets von Vendoren gilt in einigen Marktplätzen ein kleineres Maximum, das die Prüfung
nicht kennt (Amazon entscheidet).

### Verhalten des Clients

- Ergebnis **je Änderung**: `applied` (mit ID), `failed` (Grund und Text von Amazon), `unsent` (gedrosselt, später
  erneut senden) oder `unknown` (5xx, Netzwerkfehler, unlesbare Antwort: kann angewendet sein).
- Wiederholt werden 429 immer, 5xx und Netzwerkfehler nur bei Updates und beim Archivieren (sie setzen denselben
  Zielwert). **Anlagen werden nicht wiederholt**, sonst entstünden doppelte Negatives.
- 401, 403 und ein abgelehnter oder nicht erneuerbarer Token sind Fehler der Connection: Der Lauf bricht mit
  `AmazonAdsWriteAbortedError` ab, der die bis dahin feststehenden Ergebnisse trägt (der Rest ist `unsent`).
- Ungültige Werte und IDs sowie doppelte Entities je Endpunkt werden je Änderung abgelehnt, ohne Amazon zu fragen. Die
  Antwort wird über `index` zugeordnet und über die zurückgegebene ID gegengeprüft; Widersprüche gelten als `unknown`.
- **Grenzen von Amazon** (Mindest- und Höchstgebot, Tagesbudget je Marktplatz, Wortzahl negativer Keywords) liegen als
  Daten in `limits.ts`, Quelle: Amazon-Doku „Limits, constraints, and quotas“, gelesen am 2026-10-08.

## Begründung

- Nur GA-Schnittstellen, und alle drei Anzeigentypen sind abgedeckt (v1 ohne SD bräuchte einen zweiten Weg).
- Die IDs und Werte entsprechen dem, was Exports und Bulk-Dateien liefern (Phase 1 und 1.11).
- Die Antwortform mit Erfolg und Fehler je Eintrag passt zum Ziel „Teilfehler brechen die Übermittlung nicht ab“.

## Konsequenzen

- Je Anzeigentyp eine eigene Abbildung (`WriteDialect`): SP in `writes.ts`, SB und SD in `writes-sb-sd.ts`; die
  Antwortformen liest je Endpunkt eine eigene Funktion (`write-endpoints.ts`). Senden, Stückeln, Wiederholen und
  Abbruch sind für alle gleich.
- **Offen für 1.10 bei SB und SD:** ob v3 IDs oberhalb von 2^53 als Zahl annimmt und so zurückgibt, ob die
  v3-Antworten wirklich in der Reihenfolge der Anfrage kommen (bei abweichender ID gilt der Ausgang als unklar),
  ob `PUT /sb/keywords` eine Liste oder (wie das Schema der Spec sagt) ein
  einzelnes Objekt liefert (der Client liest beides), ob Fehler negativer Targets `targetRequestIndex` oder
  `negativeTargetRequestIndex` tragen (beides wird gelesen), welche `code`-Werte außer `SUCCESS` vorkommen (der Client wertet Codes mit „throttl“ als gedrosselt, mit
  „internal“/„server“ als unklar), die Höchstzahl je Aufruf bei SD, ob `PUT /sb/v4/campaigns` ein Tagesbudget ohne
  `budgetType` annimmt, ob Vendor-Profile dieselben Endpunkte nutzen.
- **Offen für 1.10 (erster echter Lauf):** ob `dynamicBidding` als Ganzes ersetzt wird (der Client schickt Strategie und
  alle Platzierungen deshalb immer zusammen), ob ein Budget-Update `budgetType` verlangt (die Spec sagt ja), ob die
  `delete`-Endpunkte je ID ein Ergebnis mit `index` liefern, welche Fehlercodes in der Praxis vorkommen, wie streng die
  Drosselung beim Schreiben ist, ob Vendor-Profile dieselben Endpunkte annehmen, wie Amazon auf ein wiederholtes
  Archivieren antwortet (Fehler je Eintrag trotz Wirkung des ersten Versuchs?) und ob die Fehlertypen `throttledError`
  und `internalServerError` je Eintrag in der Praxis vorkommen.
- **Wiedervorlage:** Wechsel auf die Amazon Ads API v1, sobald sie SD abdeckt und stabil ist oder Amazon die
  produktspezifischen Schreib-Endpunkte abkündigt.

## Verworfene Alternativen

- **Amazon Ads API v1:** ein Modell und die Richtung von Amazon, aber SD fehlte; zwei Wege für eine Aufgabe.
- **Erst mit Zugang entscheiden** (nur eigenes Modell, Mock im Prozess, Bulk-Datei): weniger Arbeit auf Verdacht, aber
  Teilfehler und Rate-Limits blieben ungeprüft, und Phase 3 hätte beim Zugang einen offenen Baustein.
