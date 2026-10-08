# Phase 3 – Ändern

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5 inkl. „Kennzahlen je Ad-Typ“),
> `docs/tasks/phase-2.md` (Definition of Done, Umsetzungsnotizen 2.4–2.13), `docs/tasks/phase-1.md` (1.5 Schreibschicht,
> 1.10, 1.11, F12), `docs/decisions/` (001–004), `design/DESIGN.md`.
>
> **Status: in Arbeit (2026-10-08).** Entschieden: F1, F2 (2026-09-29), **F3–F10** (2026-10-08, die Nummern gelten nur in
> dieser Datei). `phase-1.md` 1.11 und `phase-2b.md` sind bis auf die Themen ohne Berichte abgeschlossen. Zusätzlich in
> Phase 3: Suchbegriff-Aktionen aus 2b (Negativ anlegen, Harvest vormerken, F9), siehe
> `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` Abschnitt B.
>
> **Ausgangslage:** Es gibt weiterhin keinen Ads-API-Zugang (`phase-1.md` F12: das Partner Network nimmt keine
> Einzelunternehmen an). Mit dem Abschluss von Phase 2 ist der Auslöser für den Datei-Import (`phase-1.md` 1.11) erreicht.

## Ziel

Die Agentur ändert ihre Amazon-Werbung aus ProfitBash heraus, nachvollziehbar und umkehrbar:
- **Warenkorb** („Ausstehend“): Änderungen aus dem Explorer sammeln, prüfen, gemeinsam übermitteln.
- **Übermittlungen** mit Ergebnis je Änderung (auch Teilfehler), **Verlauf** und **Revert**.
- **Bulk-Dialoge** für markierte Zeilen (Gebote, Budgets, Status).
- **Tags** zum Gruppieren von Kampagnen und weiteren Entities, filterbar im Explorer.

Navigation (`plan.md` §3): „Änderungen (Ausstehend · Übermittlungen)“ unter `/ads/changes` (Feature `changes`), „Tags“ unter
`/ads/tags/*` (Feature `tags`). Schreiben nur mit Recht `write` (Admin, Editor).

## Definition of Done (Entwurf)

- [ ] Jede Änderung läuft über den Warenkorb und eine Übermittlung (`runJob`, `job_runs`), nie direkt aus der Oberfläche an Amazon.
- [ ] Je Änderung stehen vorher/nachher, Ergebnis von Amazon (Erfolg, Fehler mit Text) und der handelnde Nutzer fest (`audit_event`).
- [ ] Teilfehler brechen die Übermittlung nicht ab; fehlgeschlagene Änderungen lassen sich erneut versuchen oder verwerfen.
- [ ] Revert setzt auf den Wert vor der Übermittlung zurück und prüft vorher, ob sich der Wert bei Amazon seitdem geändert hat.
- [ ] Beträge (Gebote, Budgets) bleiben Decimal-Strings mit Währung; Grenzen von Amazon je Ad-Typ und Marktplatz werden vor dem
      Übermitteln geprüft (Test je Grenze).
- [ ] Alle Zugriffe über den Access-Layer (ADR 002); Test je Endpunkt (fremde Organisation, ausgeblendetes Profil, Recht `write`).
- [ ] Tests gegen den Mock-Anbieter (msw bzw. `mock.ts`), keiner gegen echte Amazon-Endpunkte.
- [ ] Browser-Pane geprüft wie in Phase 2 (1440 px, Tablet, Handy, Hell/Dunkel, Konsole).
- [ ] `pnpm test`, `typecheck`, `lint`, `build`, beide Smoke-Tests und CI grün.

## Fragen an Dominik

Jede Frage mit Empfehlung. Antworten werden hier mit Datum eingetragen („Entschieden (Dominik, …)“).

- **F1 – Reihenfolge ohne API-Zugang.** Der Auslöser für 1.11 (Datei-Import aus Bulk-Datei und Konsolen-Reports) ist erreicht.
  Erst 1.11 bauen (echte Daten der Kunden in Dashboard und Explorer, ohne API), dann Phase 3? Oder Phase 3 gegen den Mock und
  1.11 später bzw. gar nicht? Empfehlung: **erst 1.11**. Ohne echte Daten ist ProfitBash für die Agentur noch nicht nutzbar,
  und Phase 3 lässt sich ohne API nur gegen den Mock prüfen.
  **Entschieden (Dominik, 2026-09-29): erst 1.11 (Datei-Import), dann Phase 3.**
- **F2 – Übermitteln ohne API.** Solange die API fehlt, kann eine Übermittlung nicht an Amazon gehen. Empfehlung: Die Schreibschicht
  quellenneutral bauen (wie 1.5) und als zweiten Weg **„als Bulk-Datei herunterladen“** anbieten (Upload in der Werbekonsole von
  Hand, Ergebnis per nächstem Datei-Import bestätigt). Der API-Weg wird gegen den Mock gebaut und mit 1.10 scharf geschaltet.
  **Entschieden (Dominik, 2026-09-29): wie empfohlen, Bulk-Datei als zweiter Weg.**
- **F3 – Umfang der Änderungen.** Empfehlung für Phase 3: Status (aktiv/pausiert/archiviert) für Kampagnen, Ad Groups, Targets und
  Product Ads; Tagesbudget der Kampagne; Gebot von Targets und Standardgebot von Ad Groups; Negatives anlegen und archivieren.
  Nicht in Phase 3: neue Kampagnen, Ad Groups oder Keywords (Phase 4, Kampagnen-Setup), Placement-Anpassungen, Gebotsstrategie.
  **Entschieden (Dominik, 2026-10-08): wie empfohlen, zusätzlich Placement-Anpassungen** (Gebotsanpassung je Platzierung) **und
  die Gebotsstrategie der Kampagne.** Neue Kampagnen, Ad Groups und Keywords bleiben in Phase 4.
- **F4 – Warenkorb je Nutzer oder je Organisation?** Empfehlung: **je Nutzer** (jeder sammelt und übermittelt seine eigenen
  Änderungen), Übermittlungen und Verlauf sieht die ganze Organisation. Zwei offene Änderungen verschiedener Nutzer an derselben
  Entity: Hinweis beim Hinzufügen und beim Übermitteln.
  **Entschieden (Dominik, 2026-10-08): je Nutzer, wie empfohlen.**
- **F5 – Freigabe (Vier-Augen-Prinzip)?** Empfehlung: **nein** in Phase 3. Editoren und Admins übermitteln direkt; eine Freigabe
  durch Admins lässt sich später als Einstellung je Organisation nachrüsten.
  **Entschieden (Dominik, 2026-10-08): keine Freigabe in Phase 3.**
- **F6 – Sicherheitsgrenzen.** Empfehlung: Warnung (mit Bestätigung) bei Gebots- oder Budgetänderungen über ±50 % und bei mehr als
  200 Änderungen in einer Übermittlung; harte Grenzen nur dort, wo Amazon sie vorgibt (Mindest- und Höchstgebote je Marktplatz).
  **Entschieden (Dominik, 2026-10-08): wie empfohlen** (Warnung mit Bestätigung ab ±50 % und ab mehr als 200 Änderungen).
- **F7 – Tags.** Amazon kennt Tags an Kampagnen (`extra.tags` aus dem Export), aber nicht an Targets. Empfehlung: **eigene Tags**
  in ProfitBash (je Organisation, Name und Farbe) für Kampagnen, Ad Groups, Targets und Product Ads, getrennt von den Amazon-Tags
  (die nur angezeigt werden). Filter „Tag“ im Explorer und in der Filterleiste des Dashboards.
  **Entschieden (Dominik, 2026-10-08): eigene Tags für alle vier Ebenen, wie empfohlen.**
- **F8 – Revert.** Empfehlung: Revert einer ganzen Übermittlung oder einzelner Änderungen als neue Übermittlung (mit eigenem
  Verlaufseintrag). Hat sich der Wert bei Amazon seit der Übermittlung geändert (nächster Sync), fragt die App nach, statt still
  zu überschreiben.
  **Entschieden (Dominik, 2026-10-08): wie empfohlen** (ganze Übermittlung oder einzelne Änderungen, als neue Übermittlung,
  Rückfrage bei zwischenzeitlich geändertem Wert).
- **F9 – Suchbegriff-Aktionen aus 2b.** Wie kommen „Negativ anlegen“ und „Harvest vormerken“ in den Warenkorb?
  **Entschieden (Dominik, 2026-10-08):** **Negativ** kommt als Änderung in den Warenkorb, Standard „negativ exakt“ in der
  Ad Group der Zeile, vor dem Hinzufügen umstellbar (Kampagnenebene, Wortgruppe). **Harvest** kommt auf eine **Merkliste**
  ohne Änderung bei Amazon; die Exakt-Kampagne dazu baut Phase 4 (Kampagnen-Setup). Kein neues Keyword in Phase 3.
- **F10 – Amazon-Schnittstelle fürs Schreiben** (ADR 004 hatte das auf den Start von Phase 3 vertagt).
  **Entschieden (Dominik, 2026-10-08): die bisherigen APIs je Anzeigentyp** (SP v3, SB v4, SD; fertige Schnittstellen, die alle
  drei Anzeigentypen abdecken), hinter einem eigenen Modell in `packages/amazon-ads`. Mit 3.2a den Doku-Stand prüfen und als
  **ADR 005** festhalten. Gebaut wird bis zum Zugang nur gegen den Mock (msw).

## Aufgaben (verfeinert am 2026-10-08 nach F3–F10)

**Begriffe:** Eine **Änderung** ist ein Feld einer Entity (z. B. Gebot eines Targets) mit Wert vorher und nachher, oder das
Anlegen eines Negatives. Der **Warenkorb** eines Nutzers sind seine Änderungen im Status `pending`. Eine **Übermittlung**
bündelt Änderungen **eines Profils** über einen Weg (`api` oder `bulk_file`, F2): Die Bulk-Datei der Werbekonsole gilt je
Konto und Marktplatz, und die Jobs laufen je Connection.

**Felder (F3):** `state` (Kampagne, Ad Group, Target, Product Ad; Negative nur → archiviert), `budget` (Kampagne, nur
Tagesbudget), `biddingStrategy` und die Gebotsanpassung je Platzierung (Kampagne), `defaultBid` (Ad Group), `bid` (Target);
dazu das Anlegen von Negatives (Keyword exakt/Wortgruppe oder ASIN, auf Kampagnen- oder Ad-Group-Ebene).

### 3.1 Schreibschicht für Änderungen (`packages/shared`, `packages/db`)
- [x] Schemas und Konstanten in `@profitbash/shared` (Entity-Typen, Felder je Entity, Wertebereiche ohne Amazon-Grenzen).
- [x] Tabellen `ad_changes` (Warenkorb und Verlauf: Entity, Feld, vorher/nachher, Status, Fehlertext von Amazon, Herkunft) und
      `ad_change_submissions` (je Profil und Weg, Status des Laufs); Migration.
- [x] Warenkorb über den Access-Layer: Änderungen vormerken (mehrere auf einmal, „vorher“ liest der Server aus der Entity,
      nie aus der Anfrage), auflisten (mit Hinweis auf offene Änderungen anderer Nutzer an derselben Stelle, F4), verwerfen.
- [x] Übermitteln: Warenkorb → eine Übermittlung je Profil, „vorher“ wird dabei neu gelesen; Übermittlungen auflisten und
      einzeln lesen. Audit-Events in derselben Transaktion.
- Nicht in 3.1: Abholen und Ergebnis durch den Job, erneuter Versuch, Verwerfen fehlgeschlagener Änderungen und Revert (3.3);
  Grenzen von Amazon (3.2a); Warnungen nach F6 (3.4); Merkliste und Tags (3.8, 3.7).
- [x] Umsetzung (Stand für 3.2a und später):
  - **Shared** (`packages/shared/src/ad-changes.ts`, browserfähig): `AD_CHANGE_ENTITY_TYPES` (`campaign`, `ad_group`,
    `target`, `product_ad`, `negative_target`), `AD_CHANGE_FIELDS` und `AD_CHANGE_FIELDS_BY_ENTITY` (Kampagne: `state`,
    `budget`, `bidding_strategy`, `placement_top`/`_rest_of_search`/`_product_page`/`_amazon_business`; Ad Group: `state`,
    `default_bid`; Target: `state`, `bid`; Product Ad und Negative: `state`), `adChangeFieldKind` (`enum` | `money` |
    `percent`), `AD_CHANGE_PLACEMENTS` (Feld → Platzierung wie in `extra.placementBidAdjustments`), `adChangeValueIssue`
    (Zustand `ENABLED`/`PAUSED`/`ARCHIVED`, bei Negatives nur `ARCHIVED`; Strategie `SALES_DOWN_ONLY`/`SALES_UP_AND_DOWN`/
    `NONE`; Beträge als Decimal-String größer 0 mit höchstens zwei Nachkommastellen; Platzierung ganze Prozent 0–900),
    `adChangeInputSchema` (`update` bzw. `create_negative` mit Keyword exakt/Wortgruppe oder ASIN; strikt, die Anfrage nennt
    kein „vorher“), `stageAdChangesRequestSchema` (Herkunft `explorer` | `search_terms`, höchstens 5000 Änderungen je
    Anfrage), Status (`pending` → `submitted` → `applied` | `failed`, `dismissed`), Wege (`api`, `bulk_file`), Status der
    Übermittlung (`pending`, `running`, `finished`, `failed`), Ablehnungsgründe (`AD_CHANGE_REJECTIONS`).
  - **Schema** (Migration `0025_ad_changes`, `packages/db/src/schema/ad-changes.ts`): `ad_changes` (eine Zeile je Feld
    einer Entity bzw. je neuem Negative: Profil, Status, Übermittlung, Herkunft samt `origin_change_id` für Revert und
    Retry, `entity_type`/`entity_id`, Kampagne und Ad Group, Feld, `old_value`/`new_value` für Texte, `old_amount`/
    `new_amount` als `numeric` für Beträge und Prozente, `currency_code`, `payload` für das neue Negative,
    `amazon_entity_id`, `error_code`/`error_message`, `resolved_at`, `created_by`) und `ad_change_submissions` (Profil,
    Weg, Status, `attempts`, `error`, `job_run_id`, `created_by`, Zeitpunkte). Fremdschlüssel auf Profil, Kampagne,
    Ad Group und Übermittlung jeweils zusammen mit dem Profil, `ON DELETE NO ACTION` wie die Entities (Verlauf ist nicht
    wiederbeschaffbar; die Organisation lässt sich löschen, getestet). `entity_id` ohne Fremdschlüssel (fünf Tabellen,
    Entities werden nie gelöscht); bei Kampagne und Ad Group erzwingt ein CHECK die Gleichheit mit `campaign_id` bzw.
    `ad_group_id`. CHECKs für Status, Herkunft, Entity-Typ, Form je Operation, Art des Werts je Feld und „`pending` genau
    ohne Übermittlung“. Partieller Unique-Index je Nutzer, Entity und Feld für offene Feldänderungen.
  - **Vormerken** (`packages/db/src/ad-changes.ts`, `stageAdChanges`): je Eingabe ein Ergebnis `created` | `updated` |
    `removed` | `unchanged` | `rejected` (mit Grund), dazu Zähler. Gültige Änderungen werden übernommen, auch wenn andere
    derselben Anfrage abgelehnt werden. „Vorher“ und die Währung liest der Server aus der Entity (Betrag ohne eigene
    Währung: Währung des Profils; Platzierung aus `extra.placementBidAdjustments`, ohne Eintrag gilt 0 %). Derselbe Wert
    wie der Stand der Entity nimmt eine vorgemerkte Änderung zurück (`removed`); Beträge werden als Zahl verglichen
    (`0.5` = `0.50`, `compareDecimal`). Nennt eine Anfrage dieselbe Stelle mehrfach, gilt die letzte Angabe. Abgelehnt
    werden: nicht sichtbare oder unbekannte Entities (`notFound`, auch fremde Organisation und ausgeblendetes Profil),
    entfernte und archivierte, Budgets, die kein Tagesbudget sind, Gebotsstrategie und Platzierungen außerhalb von SP,
    Negatives, die es an der Stelle schon gibt (ohne Groß/Klein, archivierte zählen nicht). Ein Audit-Event
    `ad_changes.stage` je Anfrage (Herkunft, Zähler, Profile), nur wenn sich der Warenkorb geändert hat.
  - **Warenkorb** (`listPendingAdChanges`): eigene offene Änderungen in sichtbaren Profilen mit Profil, Kampagne, Ad Group,
    Angaben zur Entity (Keyword bzw. Ausdruck, ASIN/SKU) und `otherUsers` (andere Nutzer mit offener Änderung an derselben
    Stelle, F4; beim Vormerken als Zahl). `discardPendingAdChanges`: genannte oder alle eigenen offenen Änderungen, Audit
    `ad_changes.discard`.
  - **Übermitteln** (`submitAdChanges`): ganzer Warenkorb, ein Profil oder genannte Änderungen; je Profil eine
    Übermittlung, Änderungen wechseln auf `submitted`. „Vorher“ wird neu gelesen; entspricht der Wert inzwischen dem
    Stand, entfällt die Änderung (`dropped`); lässt sie sich nicht mehr übermitteln (z. B. inzwischen archiviert), bleibt
    sie im Warenkorb (`blocked` mit Grund). Weg `api` nur für Profile mit Connection, sonst `AdChangeError`
    `PROFILE_HAS_NO_CONNECTION` und nichts wird übermittelt. Audit `ad_change_submission.create` je Übermittlung;
    `enqueue(tx, submissions)` plant in derselben Transaktion ein (3.3 übergibt pg-boss).
  - **Lesen** (`listAdChangeSubmissions`, `getAdChangeSubmission`): Übermittlungen der sichtbaren Profile für die ganze
    Organisation, neueste zuerst (höchstens 100), mit Zählern je Status; eine Übermittlung mit ihren Änderungen.
  - Das Recht (`write` bzw. `view` im Feature `changes`) prüft die API (3.4), wie bei den Suchbegriff-Regeln.
  - Review (unabhängig): keine kritischen Befunde; Mandantentrennung über alle sechs Funktionen, Sperren beim
    Übermitteln, Upsert über den partiellen Index, Migration und Decimal-Rechnung bestätigt. Übernommen: Das Zurücknehmen
    löscht nur noch, was offen ist und dem Nutzer gehört (vorher konnte ein gleichzeitiges Vormerken eine eben
    übermittelte Änderung löschen; Test über den `enqueue`-Hook), `created`/`updated` kommt aus dem Upsert selbst;
    Negatives werden je Nutzer und Kampagne nacheinander geprüft und angelegt (`pg_advisory_xact_lock`, vorher zwei
    Zeilen bei gleichzeitigen Anfragen möglich); `enqueue` wird nur für den Weg `api` aufgerufen; verwaiste Zeilen ohne
    Nutzer zählen nicht als „anderer Nutzer“; Index `(entity_id, entity_type)`; Schema-Tests prüfen den Namen des
    Constraints; Tests für negative ASINs, Hinweise bei Negatives, Platzierung als Zahl in `extra`, ein inzwischen
    vorhandenes Negative beim Übermitteln.
  - **Für 3.3 festgehalten (aus dem Review):**
    - „Vorher“ kennt nur den Stand der Entity, nicht eine noch offene Übermittlung an derselben Stelle (Bulk-Datei wartet
      auf den Import; zwei Übermittlungen kurz nacheinander): Die zweite Änderung trüge ein veraltetes „vorher“. Der Job
      setzt „vorher“ deshalb beim Anwenden endgültig (API) bzw. die Bestätigung durch den Import (Bulk-Datei); bis dahin
      weist die Oberfläche auf offene Übermittlungen an derselben Stelle hin (3.4 liefert sie mit).
    - Ein Revert auf „kein Wert“ (Target ohne eigenes Gebot, Platzierung ohne Eintrag) lässt sich nicht als Änderung
      abbilden (der CHECK verlangt einen neuen Wert, Amazon kann ein Gebot nicht leeren): Platzierungen gehen auf 0 %,
      Gebote ohne „vorher“ lehnt der Revert mit Hinweis ab.
    - Eine Anlage trägt nie `entity_id`, nach Erfolg nur `amazon_entity_id`: Der Revert eines Negatives sucht die Entity
      über Profil und Amazon-ID.
  - **Bewusst so bzw. offen für später:** Frühere Angaben zur selben Stelle in einer Anfrage zählen als `unchanged`, auch
    wenn die letzte abgelehnt wird. Änderungen in einem später ausgeblendeten Profil bleiben unsichtbar offen und
    erscheinen nach dem Einblenden wieder (beim Übermitteln wird „vorher“ neu gelesen). `changeIds` begrenzt die API
    (3.4, `MAX_AD_CHANGES_PER_REQUEST`); Negatives werden einzeln geprüft (einige Abfragen je Negative, für eine
    Mehrfachauswahl in 3.8 bündeln); Listen ohne Blättern (Übermittlungen höchstens 100, Verlauf und Filter mit 3.4).
    Die Schicht vertraut auf geprüfte Eingaben (`adChangeInputSchema` an der API). Der Stand des Elternteils wird nicht geprüft (ein Gebot in einer pausierten
    oder archivierten Kampagne lässt sich vormerken; Amazon entscheidet). Offene Änderungen eines Nutzers, der die
    Organisation verlässt, bleiben unsichtbar liegen (3.3 bzw. die Mitgliederverwaltung räumt sie bei Bedarf ab). Ob
    Negatives für SB und SD zulässig sind, prüft 3.2a. Eine Liste offener Änderungen je Entity für das Grid (3.5) und
    der Verlauf je Entity kommen mit 3.4.

### 3.2 Schreib-Client (`packages/amazon-ads`), geteilt in 3.2a und 3.2b
#### 3.2a Schreib-Client gegen den Mock (Sponsored Products)
- [x] ADR 005 (F10): Endpunkte je Anzeigentyp nach Doku-Stand, eigenes normalisiertes Modell für Schreibaufträge.
- [x] Updates für Status, Budget, Gebote, Gebotsstrategie und Platzierungen, Negatives anlegen und archivieren für
      **Sponsored Products**; Ergebnis **je Änderung** (Erfolg, Fehler mit Code und Text von Amazon, neue ID bei Anlage),
      Teilfehler, Rate-Limits (`Retry-After`, Anfrage-Budget wie beim Lesen); msw-Tests. Mock-Anbieter nimmt Änderungen an.
- [x] Grenzen von Amazon je Marktplatz für SP (Mindest- und Höchstgebot, Tagesbudget, Platzierung 0–900 %, Länge und
      Wortzahl negativer Keywords) als Daten mit einer Prüffunktion ohne I/O; Test je Grenze.
- [x] Umsetzung (Stand für 3.2b, 3.3 und später):
  - **Doku-Stand** (2026-10-08, über den Browser gelesen): OpenAPI-Spec `SponsoredProducts_prod_3p.json` (Endpunkte,
    Content-Types, 1000 Einträge je Aufruf, Antwort `207` mit Erfolg und Fehler je `index`) und die Seite „Limits,
    constraints, and quotas“ (Gebote und Budgets je Marktplatz, Keywords). Einzelheiten in
    `docs/decisions/005-amazon-ads-write-api.md`.
  - **Modell** (`packages/amazon-ads/src/writes.ts`): `AmazonAdsWriteOperation` mit `ref` des Aufrufers und drei Arten:
    `update` (Entity `campaign` mit `state`, `dailyBudget`, `bidding` = Strategie **und** alle Platzierungen; `adGroup`
    mit `state`, `defaultBid`; `keyword` bzw. `target` mit `state`, `bid`; `productAd` mit `state`), `archive` (neun
    Entities, auch die vier Arten von Negatives) und `createNegative` (Keyword exakt/Wortgruppe oder ASIN, in Ad Group
    oder Kampagne). `client.applyChanges(connection, { amazonProfileId, adProduct, operations }, { meter })` →
    `{ results, throttled, retryAfterMs }`, je Änderung `applied` (mit ID) | `failed` (Code und Text) | `unsent` |
    `unknown`, in der Reihenfolge der Eingabe.
  - **Ablauf:** je Endpunkt Stücke zu 1000 (`MAX_WRITE_BATCH_SIZE`), erst Updates (Kampagne vor ihren Kindern), dann
    Archivieren, zuletzt Anlagen. Zuordnung der Antwort über `index`; fehlt ein Eintrag in der Antwort: `unknown`. Ein
    abgelehnter Aufruf (400) macht sein Stück `failed`, die übrigen Endpunkte laufen weiter. Hält die Drosselung an
    (429 nach den Wiederholungen bzw. `Retry-After` über 60 s), hört der Client auf: alles Weitere ist `unsent`,
    `retryAfterMs` nennt die Wartezeit. 5xx und Netzwerkfehler: Updates und Archivieren werden wiederholt, Anlagen nicht
    (`unknown`). **Abbruch:** 401, 403, ein abgelehnter oder nicht erneuerbarer Token und unerwartete Fehler enden als
    `AmazonAdsWriteAbortedError` mit `results` (was bis dahin feststeht, der Rest `unsent`) und `cause`; der Job hält
    die Teilergebnisse fest, bevor er die Ursache behandelt.
  - **Eingaben und Antworten:** Ungültige Werte und IDs (kein Decimal-String ohne führende Nullen, ID nicht nur
    Ziffern, Prozentsatz nicht ganz) werden je Änderung `failed` (`INVALID_VALUE`), der Rest geht raus. Dieselbe Entity
    zweimal am selben Endpunkt: die zweite `failed` (`DUPLICATE_OPERATION`). Nennt die Antwort für ein Update oder
    Archivieren eine andere ID, oder einen Index doppelt: `unknown`. Fehler-Einträge `throttledError` → `unsent`,
    `internalServerError` → `unknown`. Als Code gilt nur ein einfacher Bezeichner (`reason`, sonst `errorType`), Texte
    von Amazon gehen ohne Steuerzeichen und Token-Muster und auf 300 Zeichen gekürzt ins Ergebnis.
  - **Beträge** gehen als JSON-Zahl mit den Ziffern des Decimal-Strings raus (`jsonDecimal`/`stringifyJsonLossless` in
    `json.ts`, `JSON.rawJSON`); IDs bleiben Strings, neue IDs kommen verlustfrei zurück.
  - **Grenzen** (`limits.ts`): `SP_BID_LIMITS`, `SP_DAILY_BUDGET_LIMITS` für die 13 Marktplätze aus
    `AMAZON_MARKETPLACES`, `PLACEMENT_PERCENTAGE_LIMIT`, `amazonAdsValueLimitIssue({ adProduct, countryCode, field,
    value })` → `belowMinimum` | `aboveMaximum` mit den Grenzen, `negativeKeywordLimitIssue` (80 Zeichen; 4 Wörter bei
    Wortgruppe, 10 bei exakt). Ohne bekannte Grenze (anderer Ad-Typ, anderer Marktplatz) `null`: Amazon entscheidet.
  - **Mock** (`mock-writes.ts`): alle SP-Schreib-Endpunkte mit Content-Type-Prüfung und `207`-Antwort; Gebote und
    Budgets außerhalb der Grenzen werden je Eintrag abgelehnt (Teilfehler vorführbar), neue Negatives bekommen IDs,
    `simulation.throttledWrites` drosselt die ersten Aufrufe. **Der Mock merkt sich Änderungen nicht:** Nach einer
    Übermittlung liefert der nächste Entity-Sync wieder die alten Werte. Für 3.3 entscheiden (Überlagerung im Mock
    oder Hinweis in der Demo).
  - **Für 3.3:** `state = ARCHIVED` aus 3.1 wird zu `archive`; ein Target mit `target_type = keyword` ist `keyword`,
    sonst `target`; Negatives je Ebene und Art auf die vier Entities; Änderungen an Strategie oder einer Platzierung
    schicken immer `bidding` mit dem vollständigen Stand (Strategie und alle Platzierungen aus der Entity plus die
    Änderungen); mehrere Felder einer Entity gehören in **eine** Operation (scheitert sie, scheitern alle ihre Felder).
    `unknown` nicht blind wiederholen: erst den Stand per Sync prüfen. Die Prüfung der Grenzen vor dem Übermitteln
    hängt 3.4 ein (`amazonAdsValueLimitIssue` mit dem Land des Profils).
  - Review (unabhängig): keine kritischen Befunde; Abbildung, Endpunkt-Tabellen, Wiederholungsregeln, Decimal-Ausgabe
    (kein Betrag über `number`, keine Injection über `JSON.rawJSON`) und Logging (keine Bodies, keine Tokens) bestätigt.
    Übernommen: Abbruch mit Teilergebnissen statt nacktem Fehler (vorher gingen schon angewendete Änderungen eines
    Laufs verloren), ungültige Werte je Änderung statt Abbruch des ganzen Aufrufs, Fehler beim Holen des Tokens als
    „nicht gesendet“ (vorher `unknown` bzw. `failed`), Duplikate und abweichende IDs, Fehlertypen je Eintrag,
    Antwort über den Schlüssel des Endpunkts gelesen (zusätzliche Felder stören nicht), `throttled` als eigenes Feld,
    `amazonAdsValueLimitIssue` wirft bei Werten, die keine einfache Dezimalzahl sind, Test-IDs als Ziffern (die ID kommt
    jetzt wirklich aus der Antwort), Tests für Abbruch, anhaltende 5xx, Netzwerkfehler bei Anlagen, leere Liste.
  - **Für 3.3 zusätzlich (aus dem Review):** `bidding` lässt sich nur bilden, wenn die Kampagne eine der drei
    Strategien trägt; bei `RULE_BASED` oder leerer Strategie lehnt 3.3 Änderungen an Platzierungen ab. Archivieren
    lässt sich bei Amazon nicht zurücknehmen (kein Revert). Ein wiederholtes Archivieren nach Timeout kann je Eintrag
    einen Fehler liefern, obwohl der erste Versuch gewirkt hat: fehlgeschlagenes Archivieren gegen den nächsten Sync
    prüfen. Die Pause des Anfrage-Budgets nach `Retry-After` gilt für Lese- und Schreibaufrufe des Profils gemeinsam.
  - **Bewusst so:** `placement` und `adProduct` bleiben `string` (wie im Lese-Modell); der Mock ist großzügiger als
    Amazon (unbekannte IDs und Archivieren gelingen immer, Platzierungen und Stückgröße prüft er nicht); die Länder in
    `limits.ts` sind nicht gegen `AMAZON_MARKETPLACES` getestet (das Paket hängt nicht an `@profitbash/shared`).
  - **Nicht enthalten:** Sponsored Brands und Sponsored Display (3.2c; bis dahin `AD_PRODUCT_NOT_SUPPORTED` je Änderung,
    die Bulk-Datei geht trotzdem), Bulk-Datei (3.2b).

#### 3.2b Bulk-Datei erzeugen (F2)
- [x] XLSX-Schreiber in `@profitbash/sheets` (fflate, schmal wie der Leser) und Abbildung der Änderungen eines Profils auf das
      Blatt und die Spalten der Werbekonsole für **Sponsored Products** (Operation `Update`/`Create`/`Archive`, IDs als
      Text, Beträge ohne Umweg über `number`). Rundlauf-Test: erzeugte Datei mit dem Import-Leser lesen.
- **Befund aus der Amazon-Doku** (Bulksheets-Guides unter `advertising.amazon.com/API/docs/en-us/no-code-tools/bulksheets/…`,
  gelesen am 2026-10-08: Überblick, „Update campaigns“, „How to update/create Sponsored Products campaigns“, „Language
  guide“):
  - **Sprache:** Beim Hochladen nimmt Amazon jede unterstützte Sprache an, unabhängig von der Sprache des Kontos
    („When you upload the file, you can use any supported language“). Die Datei wird deshalb **englisch** erzeugt
    (Kopfzeilen, Entity-Namen, Werte); die Annahme „Kopfzeilen in der Sprache des Kontos“ aus dem Ideen-Dokument (C.3)
    entfällt. Deutsche Operation-Werte wären `Erstellen`/`Aktualisieren`/`Archivieren`.
  - **Blatt und Spalten (SP):** Blatt „Sponsored Products Campaigns“; Spalten der Vorlage: `Product`, `Entity`,
    `Operation`, `Campaign Id`, `Ad Group Id`, `Portfolio Id`, `Ad Id`, `Keyword Id`, `Product Targeting Id`, `Campaign
    Name`, `Ad Group Name`, `Start Date`, `End Date`, `Targeting Type`, `State`, `Daily Budget`, `SKU`, `ASIN`, `Ad Group
    Default Bid`, `Bid`, `Keyword Text`, `Match Type`, `Bidding Strategy`, `Placement`, `Percentage`, `Product Targeting
    Expression` (dazu optional `Audience ID`, `Shopper Cohort Percentage`, `Shopper Cohort Type`, `Sites`, `Off-Amazon ad
    serving`). Zeilen ohne `Operation` werden ignoriert; zusätzliche Spalten stören nicht.
  - **Entities (Spalte B):** `Campaign`, `Ad group`, `Product ad`, `Keyword`, `Negative keyword`, `Bidding adjustment`,
    `Campaign negative keyword`, `Product targeting`, `Negative product targeting`. Ein negatives Produkt-Target **auf
    Kampagnenebene** nennt die Doku nicht: per Bulk-Datei nicht anbieten, bis eine echte Datei es belegt.
  - **Operationen:** `Create`, `Update`, `Archive`. Archivieren braucht nur die IDs der Entity; wer ein Elternteil
    archiviert, archiviert die Kinder mit (Kinder nicht zusätzlich nennen, sonst Fehlerzeilen).
  - **Achtung beim Kampagnen-Update:** Ohne `Portfolio Id` fällt die Kampagne **aus ihrem Portfolio**, ein leeres `End
    Date` **entfernt das Enddatum**. Alle übrigen Felder dürfen leer bleiben („you can leave all other fields either
    unchanged or blank“). Die Kampagnenzeile trägt deshalb immer Portfolio-ID und Enddatum, sonst nur die geänderten
    Felder.
  - **Werte:** `State` `enabled` | `paused`; Gebotsstrategie `Dynamic bids - down only` | `Dynamic bids - up and down` |
    `Fixed bid`; Platzierung `placementTop` | `placementProductPage` | `placementRestOfSearch` |
    `placementAmazonBusiness` (Groß/Klein egal); `Percentage` ganze Zahl bis 900 ohne Zeichen; Datum `YYYYMMDD`; Beträge
    ohne Tausendertrennzeichen, höchstens zwei Nachkommastellen (mehr rundet Amazon).
  - **Negatives anlegen:** `Negative keyword` mit `Campaign Id`, `Ad Group Id`, `State`, `Keyword Text`, `Match Type`
    (`negativeExact` | `negativePhrase`); `Campaign negative keyword` ohne `Ad Group Id`; `Negative product targeting`
    mit `Campaign Id`, `Ad Group Id`, `State`, `Product Targeting Expression` (`asin="…"`).
  - **Gebotsanpassung:** Entity `Bidding adjustment` mit `Campaign Id`, `Placement`, `Percentage` (die Doku nennt
    `Bidding Strategy` einmal als Pflicht und einmal als „leer lassen“; die heruntergeladene Datei trägt sie in der
    Zeile). **Offen:** ob eine bisher nicht gesetzte Platzierung `Update` oder `Create` braucht (die heruntergeladene
    Datei zeigt je Platzierung eine Zeile, deshalb zunächst `Update`); mit einer echten Datei von Dominik prüfen.
  - Die IDs der Bulk-Datei sind laut Doku nicht die der Werbekonsole (URL); sie stammen aus unserem Bulk-Import (1.11d).
- [x] Umsetzung (Stand für 3.3, 3.4 und später):
  - **Schreiber** (`packages/sheets/src/write-xlsx.ts`): `writeXlsx([{ name, rows }])` → Bytes einer `.xlsx`. Zellen:
    Text (`inlineStr`, wie in den Dateien der Konsole; wird nie als Formel gelesen), `null` (leer) oder
    `{ number: '0.75' }` (Zahlzelle mit genau den Ziffern des Decimal-Strings, nie über `number`). Enthält die fünf
    Teile einer gültigen Arbeitsmappe (`[Content_Types].xml`, `_rels/.rels`, Arbeitsmappe, deren Beziehungen, Blätter),
    keine Formate und keine Formeln. XML-Zeichen maskiert, in XML unzulässige Steuerzeichen entfernt. `TypeError` bei
    ungültigen oder doppelten Blattnamen (31 Zeichen, ohne `[ ] : * ? / \`), ohne Blatt und bei Zahlen, die kein
    einfacher Decimal-String sind.
  - **Zeilen** (`packages/amazon-ads/src/bulk-file.ts`): `buildSpBulkSheet(changes)` → `{ sheetName, rows, skipped }`
    für das Blatt „Sponsored Products Campaigns“ mit den 26 Spalten der Vorlage (`SP_BULK_COLUMNS`), englisch, Kopfzeilen
    und Entity-Namen in der Schreibweise der heruntergeladenen Datei (`Campaign ID`, `Ad Group`, `Bidding Adjustment`).
    Eigenes Eingabemodell `BulkFileChange` (die Datei braucht anderes als der API-Weg: Eltern-IDs in jeder Zeile):
    `campaign` (`BulkFileCampaign` = Amazon-ID, Portfolio-ID, Enddatum, Zustand; `set` mit `state`, `dailyBudget`,
    `biddingStrategy`; die Zeile trägt immer Portfolio-ID und Enddatum und sonst nur die geänderten Felder: Der Stand
    in der Datenbank kann älter sein als der in der Werbekonsole), `placement` (Entity `Bidding Adjustment`, Operation
    `Update`, mit der geltenden Strategie; ändert dieselbe Datei die Strategie der Kampagne, gilt die neue), `adGroup`,
    `keyword`, `productTarget`, `productAd` (nur IDs und geänderte Felder), `archive` (Operation `Archive`),
    `createNegative` (Keyword `negativeExact`/`negativePhrase` in Ad Group oder Kampagne, ohne Ränder; ASIN als
    `asin="…"` in der Ad Group). IDs als Text, Beträge und Prozente als Zahlzelle, Datum `YYYYMMDD`, Zustand
    `enabled`/`paused`, Platzierungen als „Placement Top“ usw. (Amazon nimmt auch `placementTop`).
  - **Übersprungen** (`skipped` mit `ref` und Grund, die Zeile fehlt in der Datei): `duplicate` (für dieselbe Entity
    bzw. dieselbe Platzierung steht schon eine Zeile: Eine zweite überschriebe beim Hochladen die erste),
    `parentArchived` (dieselbe Datei archiviert die Kampagne bzw. Ad Group), `entityArchived` (Update einer
    archivierten Kampagne), `notSupportedInBulkFile` (negative ASIN auf Kampagnenebene anlegen oder archivieren),
    `invalidValue` (ID nicht nur Ziffern, Betrag 0, kein Decimal-String oder mehr als zwei Nachkommastellen, Tag, den es
    nicht gibt, unbekannte Platzierung oder Strategie, Prozentsatz außerhalb 0–900, ASIN, Keyword leer oder mit
    Steuerzeichen), `nothingToChange`.
  - **Rundlauf** (`apps/worker/src/file-import/bulk-export-roundtrip.test.ts`): Die erzeugte Datei wird mit `openXlsx`
    und den Abbildungen des Bulk-Imports gelesen (Blatt als SP erkannt, alle Kopfzeilen bekannt, alle neun
    Entity-Namen, Zustand, Strategie, Platzierung, Match-Typ, Datum, Betrag, IDs als Text, Ausdruck `asin="…"`). Das
    belegt, dass Schreiben und unser (toleranter) Leser zusammenpassen, nicht, was die Werbekonsole annimmt.
  - Review (unabhängig): keine kritischen Befunde; Arbeitsmappe wohlgeformt (alle Teile mit `xmllint` geprüft),
    Escaping, keine Formel- oder Zahl-Deutung von Texten, kein Betrag über `number`, IDs in den richtigen Spalten
    bestätigt. Übernommen: Die Kampagnenzeile trägt nur noch geänderte Felder plus Portfolio-ID und Enddatum (vorher
    der ganze, bis zu eine Woche alte Stand: Eine Zustandsänderung hätte ein inzwischen geändertes Budget
    zurückgesetzt), je Entity eine Zeile, Kinder archivierter Eltern, Strategie der Platzierungszeile aus der
    Kampagnenzeile, archivierte Kampagne am Stand statt am neuen Zustand erkannt, Kalenderprüfung, Betrag größer 0,
    Keyword ohne Ränder und Steuerzeichen, Schreibweise der heruntergeladenen Datei, Blattname gegen unzulässige
    Zeichen geprüft, Wagenrücklauf entfernt, Tests je Ablehnungsgrund und für alle Entities im Rundlauf.
  - **Für 3.3/3.4:** 3.4 liefert die Datei beim Download (Übermittlung mit Weg `bulk_file` → Änderungen laden, mit
    Amazon-IDs und dem Stand der Kampagne zu `BulkFileChange` zusammenführen: mehrere Felder einer Entity in **eine**
    Änderung, `state = ARCHIVED` zu `archive`, Negatives auf Kampagnenebene mit ASIN als
    `campaignNegativeProductTarget`). Übersprungene Änderungen zeigt die Oberfläche mit Grund; sie gelten nicht als
    übermittelt. Portfolio-ID und Enddatum stammen aus dem letzten Bulk-Import: 3.4 zeigt dessen Alter am Download
    (ein inzwischen in der Konsole geändertes Portfolio oder Enddatum würde sonst zurückgesetzt). Dateiname frei,
    Vorschlag `profitbash-aenderungen-<konto>-<land>-<datum>.xlsx`.
  - **Offen (braucht einen echten Upload von Dominik, sobald 3.4–3.6 stehen):** ob die Werbekonsole die Datei so annimmt
    (nur ein Blatt, `inlineStr`-Texte, ohne Formate und ohne das versteckte „Config“-Blatt; Öffnen in Excel bzw.
    LibreOffice ist ebenfalls ungeprüft), ob sie bei Kopfzeilen und Entity-Namen auf die Schreibweise achtet, ob
    `Bidding Adjustment` für eine bisher nicht gesetzte Platzierung `Update` oder `Create` braucht und ob die Strategie
    in der Zeile stehen darf, ob beim Kampagnen-Update leere Spalten wirklich „unverändert“ heißen (auch die Spalten,
    die die Datei nicht schreibt: „Sites“, „Off-Amazon ad serving“), ob Vendor-Konten dieselben Zeilen annehmen.
  - **Bewusst so:** keine Grenzen im Schreiber (Excel: 1 048 576 Zeilen, 16 384 Spalten, 32 767 Zeichen je Zelle; das
    Blatt entsteht als ein Text im Speicher, für einige Tausend Zeilen unkritisch, für Phase 4 vormerken).
  - **Nicht enthalten:** Sponsored Brands und Sponsored Display (eigene Blätter und Spalten, mit 3.2c), Portfolios,
    neue Kampagnen, Ad Groups und Keywords (Phase 4 nutzt denselben Schreiber).

#### 3.2c Schreib-Client für Sponsored Brands und Sponsored Display
- [ ] Abbildung von `AmazonAdsWriteOperation` auf SB v4 (Keywords und Targets v3) und SD samt deren Antwortformen, Grenzen
      je Kostenart (CPC, vCPM) und Marktplatz; Doku-Stand prüfen und ADR 005 ergänzen. Kann nach 3.3 kommen: Die Kunden
      nutzen heute fast nur SP, und die Bulk-Datei deckt SB und SD ab.

### 3.3 Übermitteln, Wiederholen, Revert (`apps/worker`, `packages/db`)
- [x] Job über `runJob` mit Lease je Connection (wie die Datenjobs): Übermittlung abholen, über den Schreib-Client senden,
      Ergebnis je Änderung festhalten (Teilfehler brechen nicht ab), Entity-Tabellen nach Erfolg nachziehen.
- [x] Weg `bulk_file`: Übermittlung bleibt offen, bis der nächste Bulk-Import die Werte bestätigt (nachher = neuer Stand →
      angewendet) oder der Nutzer sie von Hand abschließt.
- [x] Fehlgeschlagene Änderungen erneut versuchen (neue Änderung mit Verweis) oder verwerfen.
- [x] Revert einer Übermittlung oder einzelner Änderungen als neue Übermittlung; weicht der Stand der Entity vom „nachher“
      der Änderung ab, Rückfrage statt stillem Überschreiben (F8).
- **Entschieden (Dominik, 2026-10-08):**
  - **Mock:** merkt sich angenommene Änderungen **im Speicher** des laufenden Prozesses (kein eigener Speicherort); nach
    einem Neustart liefert er wieder die erzeugten Daten.
  - **Bulk-Weg:** Eine Änderung gilt als angewendet, sobald der nächste Import den neuen Wert zeigt; zusätzlich lässt sich
    eine Übermittlung von Hand abschließen.
  - **Revert auf „kein Wert“** (Target ohne eigenes Gebot): wird mit Hinweis übersprungen, der Rest geht zurück.
- [x] Umsetzung (Stand für 3.4 und später):
  - **Operationen** (`apps/worker/src/ad-changes/operations.ts`, ohne I/O): `buildWriteOperations(rows)` →
    `{ batches, changeIdsByRef, rejected }`. Je Entity eine Operation (`ref` = `<entityType>:<entityId>`, bei Anlagen
    `create:<changeId>`), je Ad-Typ ein Aufruf. `state = ARCHIVED` → `archive` (weitere Felder derselben Entity in
    derselben Übermittlung scheitern mit `ENTITY_ARCHIVED`), Target mit `target_type = keyword` → `keyword`, sonst
    `target`, Negatives je Ebene und Art. Strategie oder Platzierung geändert → `bidding` mit Strategie (neu oder aus
    der Kampagne) und allen Platzierungen aus `extra.placementBidAdjustments` plus den Änderungen; trägt die Kampagne
    keine der drei Strategien und setzt die Übermittlung keine, scheitern die Platzierungen mit
    `BIDDING_STRATEGY_NOT_SUPPORTED`. Unbekannte oder entfernte Entities: `ENTITY_NOT_FOUND`.
  - **Datenbank für den Job** (`packages/db/src/ad-change-processing.ts`, Systemzugriff ohne Nutzer, an Organisation
    und Connection bzw. Profil gebunden): `claimNextAdChangeSubmission` (älteste offene Übermittlung über die API für
    ein Profil der Connection → `running`, `attempts + 1`; eine vom vorigen Lauf unterbrochene wird wieder aufgenommen,
    Anlagen ohne Ergebnis scheitern dabei als `UNKNOWN_OUTCOME`, Updates gehen erneut raus), `prepareAdChangeSubmission`
    (noch offene Änderungen mit Amazon-IDs und Kampagnenstand; setzt **„vorher“ endgültig** auf den Stand der Entity),
    `recordAdChangeResults` (Ergebnis je Änderung und Nachziehen der Entities in einer Transaktion),
    `finishAdChangeSubmission` (`finished`, mit offenen Änderungen zurück auf `pending`, mit `failRemaining` → `failed`),
    `failOpenAdChangeSubmissions`, `listConnectionsWithOpenAdChangeSubmissions`, `confirmBulkFileAdChanges`.
  - **Entities nachziehen** (`applyAdChangeToEntity`): Zustand, Budget, Gebot, Standardgebot (Währung ergänzt, wo sie
    fehlte), Strategie, Platzierung in `extra.placementBidAdjustments` (ersetzt bzw. ergänzt, nach Platzierung
    sortiert, übrige Felder von `extra` bleiben); ein neues Negative entsteht als Zeile in
    `amazon_ads_negative_targets` mit der ID von Amazon (`synced_at` leer, der nächste Sync füllt sie). Kinder einer
    archivierten Entity bleiben unberührt (der nächste Sync bzw. Import liefert sie).
  - **Job `ad-changes-submit`** (`apps/worker/src/jobs/ad-changes-submit.ts`, `CONNECTION_JOB_NAMES`, mit Lease): je
    Lauf alle offenen Übermittlungen der Connection, älteste zuerst, höchstens 5 Min. (dann neu eingeplant, Zähler
    `continued`). `applied` → angewendet (bei Anlagen mit neuer ID), `failed` → fehlgeschlagen mit Code und Text von
    Amazon, `unknown` → fehlgeschlagen mit `UNKNOWN_OUTCOME` (nicht blind wiederholen; der erneute Versuch liest den
    Stand neu und entfällt, wenn der Wert schon stimmt), `unsent` → bleibt `submitted`: Die Übermittlung geht zurück auf
    `pending`, der Job plant sich nach `Retry-After` (mindestens 60 s, höchstens 1 h) neu ein und endet. Nach
    `MAX_SUBMISSION_ATTEMPTS` (5) scheitert der Rest als `NOT_SENT`. **Abbruch** (`AmazonAdsWriteAbortedError`): erst
    die Teilergebnisse festhalten, dann scheitert der Rest als `NOT_SENT` und die Übermittlung als `failed`; bei
    abgelehntem Refresh-Token zusätzlich alle offenen Übermittlungen der Connection, die Connection geht auf
    `reauth_required`. Bei 401/403 laufen die Übermittlungen anderer Profile weiter, der Lauf endet danach als
    Fehlschlag. Eine Connection mit `reauth_required` sendet nichts: Ihre offenen Übermittlungen scheitern sofort
    (sie gingen sonst Tage später unerwartet raus). Zähler `submissions`, `changesApplied`, `changesFailed`,
    `changesUnsent`; Texte im Sync-Status. Kein Healthcheck.
  - **Einplanen:** `jobs.enqueueAdChangesSubmit({ organizationId, connectionId }, { tx })` für die API (3.4, im
    `enqueue` von `submitAdChanges`, `retryAdChanges`, `revertAdChanges`); Auslöser `ad-changes-submit-all` alle
    10 Min. für Connections mit offenen Übermittlungen (nach Absturz oder Deploy).
  - **Bulk-Datei** (`confirmBulkFileAdChanges`, aufgerufen am Ende des Bulk-Imports und des Entity-Exports, Zähler
    `changesConfirmed`): Entspricht der Stand dem neuen Wert, gilt die Änderung als angewendet; Archivieren auch,
    wenn die Entity nicht mehr geliefert wird; ein neues Negative, wenn es an der Stelle eines mit demselben Inhalt
    gibt (dessen Amazon-ID wird übernommen). Sind alle Änderungen entschieden, ist die Übermittlung `finished`. Nicht
    bei einer fremd wirkenden Datei. `closeBulkFileSubmission` (`outcome: applied | discarded`) schließt von Hand ab:
    `applied` zieht die Entities nach, `discarded` setzt die offenen Änderungen auf `dismissed`.
  - **Nutzer-Aktionen** (`packages/db/src/ad-change-actions.ts`, über `visibleProfilesScope()`, Recht prüft 3.4):
    `retryAdChanges({ changeIds, channel, enqueue })`, `revertAdChanges({ submissionId | changeIds, channel,
    overwriteChanged, enqueue })`, `dismissFailedAdChanges`, `closeBulkFileSubmission`. Erneuter Versuch und Revert
    entstehen **direkt als neue Übermittlung** des handelnden Nutzers (nicht über dessen Warenkorb), mit `origin`
    `retry` bzw. `revert` und `origin_change_id`; das Original bleibt stehen. Übersprungenes kommt mit Grund zurück
    (`notFound`, `notFailed`, `notApplied`, `alreadyRetried`, `alreadyReverted`, `archiveNotRevertible`,
    `noPreviousValue`, `nothingToChange` und die Gründe aus 3.1). **Revert:** Ziel ist „vorher“ (Platzierung ohne
    Eintrag: 0 %); ein angelegtes Negative wird archiviert (gefunden über die Amazon-ID, sonst über denselben Inhalt
    an derselben Stelle). Weicht der Stand vom „nachher“ ab, kommt `{ status: 'conflict', conflicts }` zurück und
    nichts wird übermittelt; erst mit `overwriteChanged` wird überschrieben (F8). Audit:
    `ad_change_submission.create` (mit `origin`), `ad_changes.dismiss`, `ad_change_submission.close`.
    `getAdChangeSubmission` nennt je Änderung den letzten Folgeschritt (`followUp`).
  - **Mock** (`mock-writes.ts`): angenommene Updates, Archivierungen und neue Negatives liegen je Profil im Speicher
    und überlagern Exports und Reports (`overlay`); abgelehnte Änderungen nicht.
  - **Tests:** `operations.test.ts` (rein), `ad-change-processing.test.ts`, `ad-change-actions.test.ts`,
    `ad-changes-submit.test.ts` (Client als Stub), `ad-changes-flow.test.ts` (Ende-zu-Ende gegen den Mock-Anbieter:
    Warenkorb → Übermittlung → Job → Sync → Revert → Sync), dazu Bulk-Import, Entity-Import, Auslöser und Mock.
    Stammdaten für diese Tests: `seedAdChangeFixture` (`@profitbash/db/testing`).
  - **Für 3.4:** `enqueue` an `jobs.enqueueAdChangesSubmit` hängen (Connection je Übermittlung über das Profil);
    Endpunkte für erneut versuchen, verwerfen, Revert (erst ohne, nach Rückfrage mit `overwriteChanged`), Abschließen
    von Hand; `channel` für Retry und Revert wählt der Nutzer (Standard: Weg der ursprünglichen Übermittlung). Beim
    Download der Bulk-Datei dieselbe Zusammenführung je Entity wie `buildWriteOperations` (dort für
    `BulkFileChange`). Offene Übermittlungen an derselben Stelle als Hinweis im Warenkorb (aus 3.1).
  - **Bewusst so bzw. offen:** Zwei offene Bulk-Übermittlungen an derselben Stelle: Der Import bestätigt nur die,
    deren Wert steht; die überholte schließt der Nutzer von Hand. „Vorher“ einer Bulk-Änderung bleibt der Stand beim
    Übermitteln (der Import überschreibt die Entity, bevor er bestätigt). Eine fehlgeschlagene Änderung mit
    Folgeversuch bleibt `failed` (die Oberfläche liest `followUp`). Revert und erneuter Versuch prüfen weder die
    Grenzen von Amazon noch die Warnungen nach F6 (Amazon entscheidet; 3.4 kann die Grenzen davor hängen). Der Job
    arbeitet die Übermittlungen einer Connection nacheinander ab und hört bei Drosselung ganz auf, obwohl die Pause
    nur das Profil betrifft.

### 3.4 API (`apps/api`)
- [ ] Endpunkte für Warenkorb, Übermittlungen (inkl. Download der Bulk-Datei) und Verlauf hinter
      `requireFeature('changes', 'write')` bzw. `'view'`; zod; OpenAPI; Test je Endpunkt (fremde Organisation, ausgeblendetes
      Profil, Recht `write`).
- [ ] Prüfungen vor dem Übermitteln: Grenzen von Amazon (hart, 3.2a) und Warnungen nach F6 (Gebot oder Budget über ±50 %, mehr
      als 200 Änderungen; Übermitteln erst mit Bestätigung), als Engine-Funktion ohne I/O.

### 3.5 Bearbeiten im Explorer
- [ ] Inline-Bearbeitung (Status, Budget, Gebot), Dialog für Gebotsstrategie und Platzierungen der Kampagne, Bulk-Dialoge für
      markierte Zeilen (Gebote, Budgets, Status), Anzeige offener Änderungen im Grid (eigene und fremde, F4).

### 3.6 Seite „Änderungen“ (`/ads/changes`)
- [ ] Ausstehend (Warenkorb prüfen, Warnungen bestätigen, über API übermitteln oder als Bulk-Datei herunterladen, verwerfen)
      und Übermittlungen (Ergebnis je Änderung, erneut versuchen, verwerfen, Revert).

### 3.7 Tags (`/ads/tags/*`, F7)
- [ ] Eigene Tags je Organisation (Name, Farbe) für Kampagnen, Ad Groups, Targets und Product Ads: verwalten, zuweisen (auch per
      Bulk), Filter im Explorer und in der Filterleiste des Dashboards; Amazon-Tags nur anzeigen.

### 3.8 Suchbegriff-Aktionen (F9)
- [ ] „Negativ anlegen“ in der Suchbegriff-Analyse: Dialog mit Standard „negativ exakt“ in der Ad Group der Zeile, umstellbar
      auf Kampagnenebene und Wortgruppe; legt die Änderung in den Warenkorb. Hinweis, wenn der Begriff dort schon negiert ist;
      geschützte Begriffe nur mit Bestätigung.
- [ ] „Harvest vormerken“: Merkliste je Profil (Suchbegriff, Quelle, Kennzahlen zum Zeitpunkt des Vormerkens), ansehen und
      wieder entfernen; keine Änderung bei Amazon. Phase 4 (Kampagnen-Setup) liest die Merkliste.

## Bewusst nicht in Phase 3

- Keine neuen Kampagnen, Ad Groups oder Keywords (Phase 4, Kampagnen-Setup)
- Keine Regeln, keine automatischen Änderungen, keine Budget-Caps (Phase 5)
- Keine Profil-Freigaben je Mitglied (Phase 6)

## Reihenfolge für Claude Code

3.1 → 3.2a → 3.2b → 3.3 → 3.4 → 3.5 → 3.6 → 3.8 → 3.7 → 3.2c (die Suchbegriff-Aktionen vor den Tags: Sie schließen die tägliche
Arbeit aus 2b ab, Tags sind unabhängig). Bis zu drei Aufgaben je Session (`CLAUDE.md`), nach jedem Schritt Tests grün, Commit,
Häkchen und „Umsetzung“-Notiz.
