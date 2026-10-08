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
    `{ results, retryAfterMs }`, je Änderung `applied` (mit ID) | `failed` (Code und Text) | `unsent` | `unknown`, in
    der Reihenfolge der Eingabe.
  - **Ablauf:** je Endpunkt Stücke zu 1000 (`MAX_WRITE_BATCH_SIZE`), erst Updates (Kampagne vor ihren Kindern), dann
    Archivieren, zuletzt Anlagen. Zuordnung der Antwort über `index`; fehlt ein Eintrag in der Antwort: `unknown`. Ein
    abgelehnter Aufruf (400) macht sein Stück `failed`, die übrigen Endpunkte laufen weiter. Hält die Drosselung an
    (429 nach den Wiederholungen bzw. `Retry-After` über 60 s), hört der Client auf: alles Weitere ist `unsent`,
    `retryAfterMs` nennt die Wartezeit. 5xx und Netzwerkfehler: Updates und Archivieren werden wiederholt, Anlagen nicht
    (`unknown`). 401, 403 und Re-Auth werden geworfen.
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
  - **Nicht enthalten:** Sponsored Brands und Sponsored Display (3.2c; bis dahin `AD_PRODUCT_NOT_SUPPORTED` je Änderung,
    die Bulk-Datei geht trotzdem), Bulk-Datei (3.2b).

#### 3.2b Bulk-Datei erzeugen (F2)
- [ ] XLSX-Schreiber in `@profitbash/sheets` (fflate, schmal wie der Leser) und Abbildung der Änderungen eines Profils auf die
      Blätter und Spalten der Werbekonsole (Operation `Update`/`Create`, IDs als Text, Kopfzeilen in der Sprache des Kontos,
      Werte englisch, zentrale Abbildung wie im Import, Ideen-Dokument C.3). Rundlauf-Test: erzeugte Datei mit dem Import-Leser
      lesen.

#### 3.2c Schreib-Client für Sponsored Brands und Sponsored Display
- [ ] Abbildung von `AmazonAdsWriteOperation` auf SB v4 (Keywords und Targets v3) und SD samt deren Antwortformen, Grenzen
      je Kostenart (CPC, vCPM) und Marktplatz; Doku-Stand prüfen und ADR 005 ergänzen. Kann nach 3.3 kommen: Die Kunden
      nutzen heute fast nur SP, und die Bulk-Datei deckt SB und SD ab.

### 3.3 Übermitteln, Wiederholen, Revert (`apps/worker`, `packages/db`)
- [ ] Job über `runJob` mit Lease je Connection (wie die Datenjobs): Übermittlung abholen, über den Schreib-Client senden,
      Ergebnis je Änderung festhalten (Teilfehler brechen nicht ab), Entity-Tabellen nach Erfolg nachziehen.
- [ ] Weg `bulk_file`: Übermittlung bleibt offen, bis der nächste Bulk-Import die Werte bestätigt (nachher = neuer Stand →
      angewendet) oder der Nutzer sie von Hand abschließt.
- [ ] Fehlgeschlagene Änderungen erneut versuchen (neue Änderung mit Verweis) oder verwerfen.
- [ ] Revert einer Übermittlung oder einzelner Änderungen als neue Übermittlung; weicht der Stand der Entity vom „nachher“
      der Änderung ab, Rückfrage statt stillem Überschreiben (F8).

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
