# ADR 005 – Amazon-Ads-API für Schreibaufträge

- **Status:** angenommen
- **Datum:** 2026-10-08 (Start von Phase 3, Doku-Stand vom selben Tag), am 2026-10-09 um Sponsored Brands und
  Sponsored Display ergänzt (3.2c), am selben Tag um Anlagen über die API (4.4), am 2026-10-10 um Anlagen für
  Sponsored Display (4.9)
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

### Anlagen über die API (Phase 4, 4.4)

Neue Kampagnen-Strukturen (aus Preset und Produktgruppe, `docs/tasks/phase-4.md`) legt für Sponsored Products (seit 4.9
auch Sponsored Display, siehe unten) `applyCreates` in `packages/amazon-ads/src/creates.ts` an: eigenes Modell `AmazonAdsCreateOperation`, Eltern über
`campaignRef`/`adGroupRef` (eine `ref` derselben Eingabe oder aus `created`, ref → Amazon-ID eines früheren Laufs).
Geprüft am 2026-10-09 gegen die OpenAPI-Spec `SponsoredProducts_prod_3p.json`.

| Anlage | Endpunkt | Content-Type / Accept | Pflichtfelder laut Spec | ID in der Antwort |
|---|---|---|---|---|
| Kampagne | `POST /sp/campaigns` | `application/vnd.spCampaign.v3+json` | `name`, `targetingType`, `state`, `budget` | `campaignId` |
| Ad Group | `POST /sp/adGroups` | `application/vnd.spAdGroup.v3+json` | `campaignId`, `name`, `defaultBid`, `state` | `adGroupId` |
| Product Ad | `POST /sp/productAds` | `application/vnd.spProductAd.v3+json` | `campaignId`, `adGroupId`, `state` (+ `sku` bzw. `asin`) | `adId` |
| Keyword | `POST /sp/keywords` | `application/vnd.spKeyword.v3+json` | `campaignId`, `adGroupId`, `keywordText`, `matchType`, `state` | `keywordId` |
| Produkt- / Kategorie-Target | `POST /sp/targets` | `application/vnd.spTargetingClause.v3+json` | `campaignId`, `adGroupId`, `expression`, `expressionType`, `state` | `targetId` |
| Negatives Keyword (Ad Group) | `POST /sp/negativeKeywords` | `application/vnd.spNegativeKeyword.v3+json` | `campaignId`, `adGroupId`, `keywordText`, `matchType`, `state` | `negativeKeywordId` |
| Negative ASIN (Ad Group) | `POST /sp/negativeTargets` | `application/vnd.spNegativeTargetingClause.v3+json` | `campaignId`, `adGroupId`, `expression`, `state` | `targetId` |

Befunde aus der Spec:

- **Höchstzahl je Aufruf 1000** (`maxItems`) bei allen sieben Endpunkten; Antwort `207` mit
  `{ <liste>: { success: [{ index, <id>, <entity> }], error: [{ index, errors: [{ errorType, errorValue }] }] } }`
  wie bei Updates (`indexedReader`). Die Liste heißt bei Targets `targetingClauses`, bei negativen Targets
  `negativeTargetingClauses`. Mit `Prefer: return=representation` käme die ganze Entity zurück; der Client braucht nur
  die ID und schickt den Header nicht.
- **IDs sind Text** (`campaignId`, `adGroupId`, `portfolioId`: `type: string`), Beträge `double`
  (`budget.budget`, `defaultBid`, `bid`): geschrieben als Zahl-Literal über `jsonDecimal`.
- **Kampagne:** `budget: { budgetType: DAILY, budget }` (beides Pflicht). `startDate` und `endDate` im Format
  `YYYY-MM-DD` (`format: date`), `startDate` optional mit Voreinstellung „heute“; der Client schickt es immer.
  `dynamicBidding: { strategy, placementBidding: [{ placement, percentage }] }` ist optional (ohne Angabe
  `LEGACY_FOR_SALES`), beim Anlegen ist `strategy` Pflicht, sobald `dynamicBidding` gesendet wird; der Client schickt
  Strategie und Platzierungen immer (Abbildung und Platzierungen wie bei Updates, ganze Prozent 0–900).
  `targetingType` `AUTO` | `MANUAL`, Zustand `ENABLED` | `PAUSED` (dazu `PROPOSED`, nicht genutzt).
- **Off-Amazon:** `offAmazonSettings.offAmazonBudgetControlStrategy` mit `MAXIMIZE_REACH` (Platzierungen auf und
  außerhalb von Amazon) und `MINIMIZE_SPEND` (nur Amazon-eigene Seiten), optional beim Anlegen und Ändern. Das Modell
  bildet `increaseReach` → `MAXIMIZE_REACH` und `limitSpend` → `MINIMIZE_SPEND` ab; `null` lässt das Feld weg.
  Davon getrennt gibt es `siteRestrictions` (`AMAZON_BUSINESS`, `AMAZON_HAUL`; nach dem Anlegen nicht änderbar, nicht
  mit `offAmazonSettings` kombinierbar): nicht abgebildet.
- **Product Ads:** `sku` ist laut Spec „nur für Seller“, `asin` „nur für Vendoren“. Der Client verlangt genau eins von
  beiden (den Kontotyp kennt der Aufrufer); der Mock lehnt die falsche ID je Kontotyp ab (`productIdentifierError`
  `INVALID_ASIN` bzw. `INVALID_SKU`). `customText` und `globalStoreSetting` sind nicht abgebildet.
- **Produkt-Targets:** `expression: [{ type, value }]` mit `expressionType: MANUAL` (Pflicht beim Anlegen).
  `ASIN_SAME_AS` (genau diese ASIN), `ASIN_EXPANDED_FROM` (ähnliche Produkte zur ASIN), `ASIN_CATEGORY_SAME_AS`
  (`value` = Kategorie-ID). Weitere Verfeinerungen (Marke, Preis, Bewertung, Prime) sind nicht abgebildet.
  Negative Targets kennen nur `ASIN_SAME_AS` und `ASIN_BRAND_SAME_AS`, ohne `expressionType`.
- **Keywords:** `matchType` `EXACT` | `PHRASE` | `BROAD`, `bid` optional (ohne Gebot gilt das Standardgebot der
  Ad Group). Negative Keywords zusätzlich mit `NEGATIVE_BROAD` in der Spec; das Modell nutzt nur `NEGATIVE_EXACT`
  und `NEGATIVE_PHRASE`.
- Fehlertypen je Eintrag u. a. `parentEntityError` (`PARENT_ENTITY_NOT_FOUND`, `PARENT_ENTITY_ARCHIVED`),
  `duplicateValueError`, `entityQuotaError`, `productIdentifierError`, `rangeError`, `biddingError`,
  `throttledError`, `internalServerError`; gelesen wie bei Updates.

Verhalten:

- **Reihenfolge:** Kampagnen → Ad Groups → Product Ads, Keywords, Targets, negative Keywords, negative Targets; die
  IDs der Eltern kommen aus der Antwort der vorigen Stufe.
- **Kaskade:** Kinder einer gescheiterten oder unklaren Elternanlage sind `failed` mit `PARENT_NOT_CREATED` (ohne
  Amazon zu fragen), Kinder eines nicht gesendeten Elternteils bleiben `unsent`. Eine Anlage, die Amazon ohne ID
  bestätigt, gilt als `unknown` (sie gibt es vermutlich, ihre Kinder lassen sich aber nicht anlegen).
- **Nie wiederholt** (5xx, Netzwerkfehler → `unknown`); 429 → Rest `unsent`, `throttled`, `retryAfterMs`; der nächste
  Lauf übergibt das schon Angelegte in `created` und sendet es nicht erneut. 401/403 → `AmazonAdsWriteAbortedError`
  mit den Teilergebnissen.
- **Ungültige Werte** je Eintrag `failed` `INVALID_VALUE` ohne Amazon zu fragen: Betrag kein Decimal-String, Datum
  ungültig, leerer Text, ASIN nicht 10 Zeichen A–Z/0–9, Kategorie-ID nicht nur Ziffern, Platzierung unbekannt,
  doppelt oder außerhalb von 0–900, Product Ad ohne bzw. mit beiden Produkt-IDs, unbekannte oder unpassende
  Eltern-ref (Ad Group einer anderen Kampagne). Eine doppelte `ref` ist `DUPLICATE_OPERATION`.
- Grenzen des Marktplatzes (Gebote, Budgets, Länge und Wortzahl der Keywords) prüft der Client nicht; Amazon bzw. der
  Mock lehnen je Eintrag ab. Der Mock merkt sich Anlagen im Prozess und liefert sie im nächsten Export mit.

Offen für den ersten echten Lauf (1.10):

- ob ein `startDate` in der Vergangenheit oder „heute“ in der Zeitzone des Marktplatzes abgelehnt wird (der Client
  schickt das Datum unverändert);
- ob `offAmazonSettings` in allen Marktplätzen angenommen wird und was Amazon ohne Angabe voreinstellt;
- ob Product Ads von Sellern mit `asin` bzw. von Vendoren mit `sku` wirklich abgelehnt werden und ob Vendor-Profile
  dieselben Endpunkte annehmen;
- ob Amazon die ID im Erfolgseintrag immer nennt (ohne ID gilt die Anlage als unklar);
- ob eine Anlage mit gleichem Namen (Kampagne, Ad Group) als `duplicateValueError` abgelehnt wird und wie man sie nach
  einem unklaren Ausgang (5xx) wiederfindet (Abgleich über den nächsten Export und den Namen);
- wie streng die Drosselung bei großen Strukturen ist (bis zu 1000 Einträge je Aufruf) und ob `throttledError` je
  Eintrag vorkommt;
- ob Keywords und Targets in Auto-Kampagnen sauber je Eintrag abgelehnt werden (der Client prüft das nicht).

### Anlagen für Sponsored Display (Phase 4, 4.9; geprüft am 2026-10-10 gegen die Spec `sponsored-display/3-0`)

- `applyCreates` (vorher `applySpCreates`) nimmt neben den SP-Entities `sdCampaign`, `sdAdGroup`, `sdProductAd`,
  `sdTarget` und `sdNegativeTarget`. Reihenfolge, Eltern-refs, Kaskade, Drosselung und „nie wiederholen“ wie bei SP;
  SD-Kinder brauchen SD-Eltern (eine SP-Ad-Group unter einer SD-Kampagne ist `INVALID_VALUE`).
- `POST /sd/campaigns` | `adGroups` | `productAds` | `targets` | `negativeTargets`, `application/json`, Liste ohne
  Hülle, Antwort als Liste `{ code, description, <id> }` in der Reihenfolge der Anfrage (wie die SD-Updates aus 3.2c),
  100 je Aufruf.
- Kampagne: `name`, `state` klein, `budgetType: daily`, `budget`, `startDate` als `YYYYMMDD`, `tactic` (`T00020`
  kontextbezogen, `T00030` Zielgruppen), `costType` (`cpc`; `vcpm` nur freigeschaltet, F-S7), `portfolioId` als
  Zahl. Ad Group: `campaignId`, `name`, `defaultBid`, `bidOptimization` (`clicks` | `conversions`; `reach` nur mit
  vCPM, geprüft gegen die Kampagne derselben Eingabe), `state`. Product Ad: `campaignId`, `adGroupId`, `sku`
  (Seller) bzw. `asin` (Vendor). Ziele und Negatives nennen laut Spec nur die `adGroupId`, `expressionType: manual`.
- Ausdrücke: Kontext `asinSameAs` bzw. `asinCategorySameAs`; Zielgruppe `views` bzw. `purchases` mit
  `[{ type: exactProduct }, { type: lookback, value: "30" }]` (wer die beworbenen Produkte selbst angesehen bzw.
  gekauft hat); Rückblick nur 7, 14, 30, 60, 90, 180 oder 365 Tage (Spec). Negatives: `asinSameAs`.
- Der Mock nimmt SD-Anlagen an (Gebote und Budgets gegen die Grenzen) und liefert sie im nächsten Export; SD-Updates
  bleiben dort `MOCK_NOT_SUPPORTED`.

Offen für den ersten echten Lauf: ob `exactProduct` für Ansichten so angenommen wird (die Spec nennt es, das
Beispiel des Bulk-Guides zeigt `similar-product`); ob die Kampagne mit `T00030` und nur Zielgruppen ohne weitere
Angaben (`creativeType`) angelegt wird; ob die Antwort die neue ID als Zahl oder Text liefert (beides wird gelesen).

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
