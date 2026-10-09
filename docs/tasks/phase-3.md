# Phase 3 – Ändern

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5 inkl. „Kennzahlen je Ad-Typ“),
> `docs/tasks/phase-2.md` (Definition of Done, Umsetzungsnotizen 2.4–2.13), `docs/tasks/phase-1.md` (1.5 Schreibschicht,
> 1.10, 1.11, F12), `docs/decisions/` (001–004), `design/DESIGN.md`.
>
> **Status: abgeschlossen (2026-10-09) bis auf drei Punkte, die nicht am Code hängen bzw. eigene Aufgaben sind:**
> (1) der **echte Upload** der Bulk-Datei in der Werbekonsole durch Dominik (offene Punkte in 3.2b, dazu der Befund aus dem
> „Config“-Blatt unten; **Stand 2026-10-09: ein Upload der SP-Datei ging ohne Fehler durch**, siehe 3.2b), (2) dasselbe für die **Blätter für Sponsored Brands und Sponsored Display** (3.9 ist gebaut, aber ohne echte
> SB- oder SD-Daten ungeprüft), (3) der **erste echte Lauf über die API** (`phase-1.md` 1.10, offene Punkte in ADR 005).
> Entschieden: F1, F2 (2026-09-29), **F3–F10** (2026-10-08, die Nummern gelten nur in dieser Datei). `phase-1.md` 1.11 und
> `phase-2b.md` sind bis auf die Themen ohne Berichte abgeschlossen. Zusätzlich in Phase 3: Suchbegriff-Aktionen aus 2b
> (Negativ anlegen, Harvest vormerken, F9), siehe `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` Abschnitt B.
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

## Definition of Done

Geprüft am 2026-10-09 gegen Code und Tests (Stand `main` nach #68), je Punkt mit Beleg.

- [x] Jede Änderung läuft über den Warenkorb und eine Übermittlung (`runJob`, `job_runs`), nie direkt aus der Oberfläche an Amazon.
      Beleg: `applyChanges` ruft nur der Job `ad-changes-submit` auf (`apps/worker/src/jobs/ad-changes-submit.ts`, über
      `runJob` mit Lease); die API plant nur ein (`enqueue` in der Transaktion der Übermittlung), das Web spricht nur mit
      `/api/ads/changes`. Ende-zu-Ende: `ad-changes-flow.test.ts`.
- [x] Je Änderung stehen vorher/nachher, Ergebnis von Amazon (Erfolg, Fehler mit Text) und der handelnde Nutzer fest (`audit_event`).
      Beleg: `ad_changes` (`old_*`/`new_*`, `error_code`/`error_message`, `created_by`), Audit `ad_changes.stage`,
      `.discard`, `.dismiss`, `ad_change_submission.create` und `.close`; `ad-changes.test.ts`, `ad-change-processing.test.ts`.
- [x] Teilfehler brechen die Übermittlung nicht ab; fehlgeschlagene Änderungen lassen sich erneut versuchen oder verwerfen.
      Beleg: `writes.test.ts` (207 mit Erfolg und Fehler je Eintrag, Abbruch mit Teilergebnissen), `ad-changes-submit.test.ts`,
      `ad-change-actions.test.ts` (`retryAdChanges`, `dismissFailedAdChanges`), API `/retry`, `/dismiss`.
- [x] Revert setzt auf den Wert vor der Übermittlung zurück und prüft vorher, ob sich der Wert bei Amazon seitdem geändert hat.
      Beleg: `revertAdChanges` (`conflict` ohne `overwriteChanged`), Test „nimmt Änderungen zurück und fragt bei abweichendem
      Stand nach (F8)“ in API und DB, Rückfrage in `ChangesPage.test.ts`. Grenzen: Archivieren ist nicht umkehrbar, ein
      Revert auf „kein Wert“ wird übersprungen (3.3).
- [x] Beträge (Gebote, Budgets) bleiben Decimal-Strings mit Währung; Grenzen von Amazon je Ad-Typ und Marktplatz werden vor dem
      Übermitteln geprüft (Test je Grenze).
      Beleg: `limits.test.ts` (SP, SB, SD je Marktplatz und Kostenart, Platzierung, negative Keywords),
      `packages/engine/src/ad-changes.test.ts`, API „übermittelt nichts, solange ein Wert außerhalb der Grenzen von Amazon
      liegt“. Kein Betrag läuft über `number` (`jsonDecimal`, Zahlzelle der Bulk-Datei aus dem Decimal-String).
- [x] Alle Zugriffe über den Access-Layer (ADR 002); Test je Endpunkt (fremde Organisation, ausgeblendetes Profil, Recht `write`).
      Beleg: `ad-changes.ts`, `ad-change-actions.ts`, `ad-change-queries.ts`, `tags.ts`, `search-term-harvest.ts` gehen über
      `visibleProfilesScope()`, keiner filtert selbst nach `organization_id` (der Job arbeitet als Systemzugriff, gebunden
      an Organisation und Connection). API-Tests: Liste aller schreibenden und lesenden Endpunkte gegen 401, Viewer (403) und
      Entitlement, dazu „Fremde Organisation und ausgeblendete Profile“ (`ad-changes.test.ts`), `tags.test.ts`,
      `search-term-harvest.test.ts`.
- [x] Tests gegen den Mock-Anbieter (msw bzw. `mock.ts`), keiner gegen echte Amazon-Endpunkte.
      Beleg: Alle Tests, die Amazon-Adressen nennen, laufen mit msw und `onUnhandledRequest: 'error'`; der Job-Test nutzt
      einen Stub, der Ablauf-Test den Mock-Anbieter im Prozess.
- [x] Browser-Pane geprüft wie in Phase 2 (1440 px, Tablet, Handy, Hell/Dunkel, Konsole).
      Beleg: Notizen je Aufgabe (3.5–3.8) und die Nachprüfung vom 2026-10-09 unten.
- [x] `pnpm test`, `typecheck`, `lint`, `build`, beide Smoke-Tests und CI grün.
      Beleg: Lauf vom 2026-10-09 auf dem Stand nach #68: 179 Testdateien, 2408 Tests grün; `typecheck`, `lint`, `build`,
      `smoke-bundles.sh` und `smoke-db-backup.sh` ohne Fehler; CI auf `main` grün.

**Nachprüfung im Browser (2026-10-09, Demo-Daten, Profil „Demo Lumen SE“):**
- **CSV-Download der Suchbegriff-Analyse** (offen seit 2b.2e): Die Datei kommt mit BOM, 18 Spalten und 1320 Zeilen (so viele
  wie die Auswahl nennt), ohne die Spalte „Aktionen“, mit der neuen Spalte „Merkliste“; Dateiname
  `profitbash-search-term-analysis-demo-lumen-se-se-2026-08-01_2026-09-29.csv`. Quoten (CTR, ACoS, ROAS, CVR) stehen
  ungerundet mit bis zu 34 Nachkommastellen in der Datei (dieselben Helfer wie der Explorer-Export, keine Rundung).
- **Währung nach dem Sprung in den Explorer:** Der Link der Kampagne landet auf ihren Ad Groups, mit Client, Datei-Zeitraum
  und „Entfernte anzeigen“. Die Zeilen zeigen die Währung des Profils (SEK). **Die Summenzeile zeigt „≈ … €“**: Der Link
  nennt den Client, und der hat Profile in zwei Währungen (GBP, SEK); mit Währung „Automatisch“ rechnet der Explorer die
  Summe dann in EUR um, obwohl der Drill-Down nur eine Kampagne in SEK zeigt. Gekennzeichnet und rechnerisch richtig, aber
  unnötig. **Offen (klein):** bei einem Drill-Down auf eine Kampagne die Währung ihres Profils nehmen.
- **Regel-Dialog schließen:** „Schließen“ (X), Escape und „Abbrechen“ schließen den Dialog, der Fokus geht zurück auf „Regeln
  ändern“, eine nicht gespeicherte Eingabe ist nach dem erneuten Öffnen weg. Ein Klick neben den Dialog schließt ihn nicht
  (bewusst, schützt die Eingaben). Bei geringer Fensterhöhe rollt der Inhalt im Dialog (höchstens 90 % der Höhe).
- **Tablet (768 px), Hell-Modus:** Suchbegriff-Aktionen (Leiste, Auswahl, Spalte „Aktionen“ rechts fest, Dialog „Negativ
  anlegen“ samt Ergebnis), „Änderungen“ (Ausstehend mit drei Negatives; als Bulk-Datei übermittelt; Übermittlungen mit Liste,
  geöffneter Übermittlung, Hinweis zum Stand; „Nicht hochladen“ mit Rückfrage) und „Tags“ (leer, Dialog „Neues Tag“, Liste,
  Löschen mit Rückfrage; auch bei 375 px): kein waagerechtes Scrollen, Kontraste in Ordnung, Konsole ohne Fehler.
  Testdaten danach verworfen bzw. gelöscht. Beobachtung (kosmetisch): Unter „Ausstehend“ ist die Spalte mit Name und Lage
  bei 768 px schmal (Namen brechen um), obwohl rechts Platz bleibt.

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
  - **Befund aus einer echten Datei (2026-10-09, drei Downloads von Dominik, nur Kopfzeilen und das versteckte Blatt
    „Config“ gelesen):** Die Schreibweise der Kopfzeilen und Entity-Namen des Schreibers stimmt mit der englischen Datei
    überein (`Campaign ID`, `Ad Group`, `Bidding Adjustment`, `Placement Top` …). Das Blatt „Config“ nennt je Entity und
    Operation Pflicht- und Kann-Spalten. Abweichungen zu dem, was die Datei heute schreibt:
    - **Kampagne, `Update`:** Pflicht laut Config sind `Campaign Id`, `Campaign Name`, `Daily Budget`, `State`, `Start
      Date`, `Bidding Strategy` (Kann: `Portfolio Id`, `End Date`, `Off-Amazon ad serving`). Die Datei schreibt nur die
      geänderten Felder plus Portfolio und Enddatum (nach dem Guide „leer = unverändert“). **Beim echten Upload zuerst
      prüfen:** Meldet die Konsole fehlende Pflichtfelder, muss die Kampagnenzeile Name, Budget, Zustand, Startdatum und
      Strategie aus dem Stand tragen (dann mit dem Alter des Stands als Risiko, siehe Review-Befund oben).
    - **Ad Group, `Update`:** Pflicht `Ad Group Id`, `Ad Group Name`, `Ad Group Default Bid`, `State` (die Datei schreibt
      nur Geändertes).
    - **Keyword, Produkt-Target, Product Ad, Negatives, `Update`:** Pflicht nur ID und `State` (die Datei lässt `State`
      weg, wenn nur das Gebot geändert wird).
    - **`Bidding Adjustment`:** `Create` und `Update` gibt es beide, Pflicht `Campaign Id` und `Placement`, Kann
      `Percentage`; `Bidding Strategy` gehört nicht dazu. Zustände beim Update schließen `archived` ein; ein negatives
      Keyword der Kampagne kennt beim Update nur `archived`.
    - Match-Typen und Platzierungen stehen in der Config in der Form der API (`negativeExact`, `placementTop`), in den
      Datenzeilen in der Anzeigeform („Negative Exact“, „Placement Top“); die Datei schreibt `negativeExact` bzw.
      „Placement Top“.
    Ob die Konsole die Pflichtspalten beim Hochladen wirklich erzwingt oder nur die Excel-Vorlage sie so führt, zeigt erst
    der Upload. Bis dahin bleibt der Schreiber, wie er ist.
  - **Echter Upload (Dominik, 2026-10-09):** Eine Bulk-Datei für Sponsored Products aus ProfitBash hat die Werbekonsole
    ohne Fehler angenommen; fehlende Pflichtfelder hat sie nicht gemeldet. Der Schreiber bleibt deshalb, wie er ist.
    Nicht festgehalten ist, welche Arten von Änderungen die Datei enthielt; Kampagnen-Updates ohne Name, Budget und
    Startdatum sowie Platzierungen, die neu gesetzt werden, bleiben bis zu einem gezielten Upload ungeprüft.
  - **Bewusst so:** keine Grenzen im Schreiber (Excel: 1 048 576 Zeilen, 16 384 Spalten, 32 767 Zeichen je Zelle; das
    Blatt entsteht als ein Text im Speicher, für einige Tausend Zeilen unkritisch, für Phase 4 vormerken).
  - **Nicht enthalten:** Sponsored Brands und Sponsored Display (eigene Blätter und Spalten, mit 3.2c), Portfolios,
    neue Kampagnen, Ad Groups und Keywords (Phase 4 nutzt denselben Schreiber).

#### 3.2c Schreib-Client für Sponsored Brands und Sponsored Display
- [x] Abbildung von `AmazonAdsWriteOperation` auf SB v4 (Keywords und Targets v3) und SD samt deren Antwortformen, Grenzen
      je Kostenart (CPC, vCPM) und Marktplatz; Doku-Stand prüfen und ADR 005 ergänzen. Kann nach 3.3 kommen: Die Kunden
      nutzen heute fast nur SP.
- [x] Umsetzung (Stand für 1.10 und später):
  - **Doku-Stand** (2026-10-09): OpenAPI-Specs von Amazon, `SponsoredBrands_prod_3p.json` (v4: Kampagnen, Ad Groups,
    Ads), `sponsored-brands/3-0/openapi.yaml` (Keywords, Targets, Negatives) und `sponsored-display/3-0/openapi.yaml`,
    dazu die Seite „Limits, constraints, and quotas“. Endpunkte, Formen und offene Punkte in ADR 005.
  - **Aufbau** (`packages/amazon-ads/src`): `write-endpoints.ts` (Form eines Endpunkts mit `batchSize` und `read`,
    `WriteDialect` je Anzeigentyp, Lesen der Antwortformen: `indexedReader` für SP v3 und SB v4,
    `collectOutcomes`), `writes.ts` (Modell, SP, Senden und Stückeln für alle), `writes-sb-sd.ts` (SB und SD).
    `applyChanges` wählt die Abbildung über `adProduct`; unbekannte Ad-Typen: `AD_PRODUCT_NOT_SUPPORTED`.
  - **Modell:** `update` für `keyword`/`target` und `archive` tragen optional `amazonCampaignId` und
    `amazonAdGroupId` (SB v3 verlangt Kampagne und Ad Group in jedem Eintrag; fehlen sie dort: `INVALID_VALUE`).
    Der Job liefert sie immer mit (`apps/worker/src/ad-changes/operations.ts`, `parentIds`).
  - **Sponsored Brands:** Kampagne (Zustand, Tagesbudget), Ad Group und Anzeige (Zustand) über v4 mit höchstens 10
    Einträgen je Aufruf, Archivieren über `.../delete`; Keywords und Produkt-Targets (Zustand, Gebot) und das
    Archivieren von Keywords, Targets und Negatives über v3 (höchstens 100, IDs als JSON-Zahl, Zustand klein,
    Archivieren als Zustand `archived`); Negatives (Keyword exakt/Wortgruppe, ASIN) in der Ad Group.
  - **Sponsored Display:** Kampagne (Zustand, Tagesbudget), Ad Group (Zustand, Standardgebot), Target (Zustand,
    Gebot), Product Ad (Zustand), Archivieren als Zustand `archived`, negative ASIN in der Ad Group.
  - **Nicht vorhanden** (je Änderung `NOT_SUPPORTED` mit Grund, ohne Amazon zu fragen): bei SB Gebotsstrategie und
    Platzierungen, Standardgebot der Ad Group, Negatives auf Kampagnenebene; bei SD Keywords und negative Keywords,
    Negatives auf Kampagnenebene, Gebotsstrategie und Platzierungen.
  - **Antwortformen:** `success`/`error` je `index` (SB v4 wie SP v3); Liste `{ code, description, <id> }` in der
    Reihenfolge der Anfrage (SB-Keywords v3, SD); Erfolgs- und Fehlerlisten je `targetRequestIndex` (SB-Targets
    v3). Fehlende Einträge, abweichende IDs und doppelt genannte Einträge gelten wie bei SP als unklar. Anlagen
    werden nach 5xx nicht wiederholt.
  - **Grenzen** (`limits.ts`): `SB_BID_LIMITS`, `SD_BID_LIMITS` je Kostenart (CPC, vCPM) und
    `SB_DAILY_BUDGET_LIMITS`, `SD_DAILY_BUDGET_LIMITS` für die Marktplätze aus `AMAZON_MARKETPLACES` (SD ohne
    Irland), `amazonAdsValueLimit({ adProduct, countryCode, field, costType })`. Geprüft wird gegen die weiteste
    Spanne, die Amazon für Ad-Typ, Kostenart und Marktplatz annimmt (Bild/Video und die vCPM-Ziele von SB kennt
    ProfitBash nicht); ohne Kostenart gegen die Spanne über beide. Die **Kostenart** der Kampagne
    (`extra.costType`) geht jetzt durch Warenkorb und Prüfung beim Übermitteln (`AdChangeRecord.costType`,
    `AdChangeReviewRow.costType`, `checkAdChanges`); die API nutzt `amazonAdsValueLimit` direkt (die doppelte
    Tabelle aus 3.4 entfällt).
  - **Mock:** bildet Schreiben weiter nur für SP nach; SB und SD beantwortet er mit `400 MOCK_NOT_SUPPORTED` und
    klarem Text (je Änderung fehlgeschlagen). Getestet sind SB und SD mit msw (`writes-sb-sd.test.ts`).
  - Review (unabhängig): keine kritischen Befunde; SP nach dem Umbau unverändert (Endpunkte, Reihenfolge,
    Wiederholen, Abbruch), Abbildung gegen die drei Specs, IDs nie über `number` und alle Grenzwerte für die 13
    Marktplätze gegen die Doku-Seite bestätigt. Übernommen: Themen-Targets von SB lehnt der Job ab
    (`TARGET_TYPE_NOT_SUPPORTED`; sie wären am falschen Endpunkt gelandet); ein Eintrag der Antwort ohne Code gilt
    als unklar statt gescheitert, 2xx als angenommen (die SD-Spec beschreibt `code` auch als HTTP-Status; eine
    Anlage wäre sonst doppelt angelegt worden); Archivieren geht bei SB v3 und SD als eigener Aufruf nach den
    Updates raus; einzelne Keyword-Antwort als Objekt und `negativeTargetRequestIndex` werden gelesen; fehlende
    Eltern-IDs mit eigenem Code (`PARENT_IDS_MISSING`), das Archivieren negativer SB-Targets braucht nur die
    Ad Group; Tests für Codes, Reihenfolge, Stücke zu 100.
  - **Offen bzw. bewusst so:** Die Bulk-Datei kannte hier nur SP; **SB und SD kamen mit 3.9 dazu.** Die ±50-%-Warnung
    und die Anzeige im Explorer unterscheiden vCPM nicht von CPC (nur die Grenzen). SB-Platzierungen und
    `bidOptimization` lassen sich nicht ändern. Die offenen Punkte zum echten Verhalten der v3-Endpunkte stehen in
    ADR 005 (IDs über 2^53 als Zahl, Reihenfolge der Antworten, Codes, Höchstzahl bei SD).

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
    `pending`, der Job plant sich nach `Retry-After` (mindestens 60 s, höchstens 10 Min., weil er den einzigen Warteplatz der
    Connection belegt) neu ein und arbeitet die übrigen Übermittlungen noch ab. Nach
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
    `noPreviousValue`, `nothingToChange`, `superseded`, `outcomeUnknown`, `alreadySubmitted` und die Gründe aus 3.1). **Revert:** Ziel ist „vorher“ (Platzierung ohne
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
  - Review (unabhängig): keine kritischen Befunde; Mandantentrennung, CHECK-Constraints, Decimal-Behandlung und Audit
    bestätigt. Übernommen: doppelte Felder einer Entity in einer Übermittlung (es gilt die letzte Angabe, frühere
    scheitern als `SUPERSEDED`; vorher blieb eine ohne Ergebnis und ging später allein raus), Retry nur für den
    jüngsten Fehlschlag je Stelle und Revert mehrerer Änderungen an einer Stelle gemeinsam (Ziel „vorher“ der
    ältesten, Vergleich mit „nachher“ der jüngsten); eine Anlage mit unklarem Ausgang ist erst nach dem nächsten Sync
    bzw. Import der Kampagne wiederholbar (`outcomeUnknown`), dasselbe Negative nie zweimal gleichzeitig
    (`alreadySubmitted`); Sperre je Profil (`lockProfileAdChanges`) am Anfang von Import und Abschließen von Hand
    (vorher umgekehrte Sperrreihenfolge, Deadlock möglich); nach Drosselung gehen die übrigen Übermittlungen noch
    raus, Wartezeit höchstens 10 Min.; unterbrochene Übermittlungen einer Connection ohne Einwilligung scheitern als
    `UNKNOWN_OUTCOME` statt `NOT_SENT`; „vorher“ bleibt bei der Wiederaufnahme, wenn der Stand schon dem neuen Wert
    entspricht, und wird beim Abschließen von Hand auf den Stand davor gesetzt; Lease auch zwischen den Aufrufen
    verlängert; nach mehr als 5 Abholungen scheitert der Rest als unklar (kein endloses Neu-Senden); Negatives mit
    anderem Zustand als archiviert werden abgelehnt (`NOT_SUPPORTED`); neue IDs des Mocks tragen den Startzeitpunkt
    (kein Zusammenstoß nach Neustart); IDs sortiert gesperrt.
  - **Offen (aus dem Review, nicht umgesetzt):** Ein vor dem Anwenden angeforderter Entity-Export überschreibt den
    nachgezogenen Stand bis zum nächsten Sync (Revert meldet dann eine Abweichung). Bulk-Änderungen an inzwischen
    archivierten oder entfernten Entities und überholte Bulk-Änderungen bleiben offen, bis jemand von Hand abschließt;
    „als erledigt“ schreibt dabei den überholten Wert lokal zurück (der nächste Import korrigiert). Eine ältere
    Bulk-Datei, die zufällig den neuen Wert trägt, bestätigt die Änderung. Fehlgeschlagenes Archivieren wird nicht
    gegen den nächsten Sync geprüft (Vorgabe aus 3.2a; der erneute Versuch lehnt archivierte Entities ab). Mit
    `failRemaining` heißt die Übermittlung `failed`, auch wenn keine Änderung mehr offen war. Bei langer Drosselung
    (über 10 Min.) zählt jeder Lauf als Versuch. Der Mock archiviert Kinder nicht mit. Nicht getestet: gleichzeitige
    Aufrufe (Doppelklick, Abschließen während eines Imports), Zeitbudget des Jobs.
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
    arbeitet die Übermittlungen einer Connection nacheinander ab.

### 3.4 API (`apps/api`)
- [x] Endpunkte für Warenkorb, Übermittlungen (inkl. Download der Bulk-Datei) und Verlauf hinter
      `requireFeature('changes', 'write')` bzw. `'view'`; zod; OpenAPI; Test je Endpunkt (fremde Organisation, ausgeblendetes
      Profil, Recht `write`).
- [x] Prüfungen vor dem Übermitteln: Grenzen von Amazon (hart, 3.2a) und Warnungen nach F6 (Gebot oder Budget über ±50 %, mehr
      als 200 Änderungen; Übermitteln erst mit Bestätigung), als Engine-Funktion ohne I/O.
- [x] Umsetzung (Stand für 3.5, 3.6 und später):
  - **Endpunkte** (`apps/api/src/routes/ad-changes.ts`, alle unter `/api/ads/changes`, Schemas in
    `packages/shared/src/ad-changes-api.ts`). Lesen mit `view`, alles andere mit `write`:

    | Methode und Pfad | Zweck |
    |---|---|
    | `GET /pending` | eigener Warenkorb mit `otherUsers` (F4) und `check` (Prüfungen) |
    | `POST /pending` | vormerken (`stageAdChangesRequestSchema`), Ergebnis je Änderung |
    | `POST /pending/discard` | genannte oder alle eigenen Änderungen verwerfen |
    | `POST /submit` | übermitteln: `channel`, optional `profileId`, `changeIds`, `confirmWarnings` |
    | `GET /open?profileId=` | offene Änderungen aller Nutzer (vorgemerkt oder übermittelt ohne Ergebnis) für das Grid, neueste zuerst |
    | `POST /history` | Verlauf einer Entity, eines Profils oder aller sichtbaren Profile (höchstens 200) |
    | `GET /submissions`, `GET /submissions/{id}` | Übermittlungen der Organisation; eine mit Änderungen, `followUp` und `entitiesSyncedAt` |
    | `GET /submissions/{id}/bulk-file` | die `.xlsx` für die Werbekonsole (`write`) |
    | `POST /submissions/{id}/close` | Bulk-Übermittlung von Hand abschließen (`applied` \| `discarded`) |
    | `POST /retry`, `POST /dismiss`, `POST /revert` | Folgeschritte aus 3.3 |

  - **Übermitteln:** Die Antwort hat einen `status`: `limitsExceeded` (ein Wert liegt außerhalb der Grenzen von
    Amazon, nichts wird übermittelt), `needsConfirmation` (Warnungen nach F6, erneut mit `confirmWarnings` senden) oder
    `submitted` (Übermittlungen je Profil, `dropped`, `blocked`, `bulkFileSkipped`). Die Prüfung läuft **in der
    Transaktion des Übermittelns** (`review` von `submitAdChanges`): mit dem dabei neu gelesenen „vorher“ und über
    genau die Zeilen, die übermittelt würden; meldet sie etwas, wird alles zurückgerollt. Für den Weg `api`
    plant `enqueue` je Connection `ad-changes-submit` in der Transaktion der Übermittlung ein. Revert antwortet mit
    `conflict` (Rückfrage, F8) oder `submitted`.
  - **Prüfungen** (`packages/engine/src/ad-changes.ts`, `checkAdChanges`, ohne I/O): `violations` (unter Minimum,
    über Maximum mit den Grenzen; negatives Keyword zu lang oder mit zu vielen Wörtern), `largeChanges` (Gebot,
    Standardgebot oder Budget ändert sich um mehr als 50 %, genau 50 % nicht; ohne Wert vorher keine Warnung;
    Platzierungen und Zustände nie), `tooMany` (mehr als 200 Änderungen für ein Profil, also in einer Übermittlung). Werte, die keine einfache
    Dezimalzahl sind, werden übergangen. Die Grenzen selbst kommen
    aus `limits.ts` (`@profitbash/amazon-ads`) über `limitFor`; für andere Ad-Typen und unbekannte Marktplätze gibt
    es keine (Amazon entscheidet). Die Engine liest `@profitbash/shared/ad-changes` (eigener Einstiegspunkt).
  - **Bulk-Datei** (`apps/worker/src/ad-changes/bulk-file.ts`): `buildBulkFileChanges` führt wie beim API-Weg je
    Entity zusammen (Kampagnenzeile mit Portfolio, Enddatum und Zustand aus dem Stand; jede Platzierung als eigene
    Zeile mit der Strategie der Kampagne; Archivieren je Entity; Negatives je Ebene und Art), `buildSubmissionBulkFile`
    liefert die `.xlsx` und die übersprungenen Änderungen mit Code und Text (`AD_PRODUCT_NOT_SUPPORTED` für SB und SD
    bis 3.2c, `ENTITY_NOT_FOUND`, `SUPERSEDED`, `BULK_FILE_NOT_SUPPORTED`, `BULK_FILE_PARENT_ARCHIVED` …).
    **Übersprungene Änderungen scheitern mit diesem Code** (`settleBulkFile`, wiederholbar): gleich nach dem
    Übermitteln (auch bei Retry und Revert als Bulk-Datei), vor jedem Download und vor dem Abschließen als
    „hochgeladen“ (eine Entity kann inzwischen entfernt oder archiviert sein); bleibt nichts offen, ist die
    Übermittlung abgeschlossen. Der Download ist damit ein `GET`, das den Status von Änderungen ändern kann.
    Der Download baut die Datei jedes Mal neu aus den Änderungen, die als übermittelt oder angewendet gelten
    (Dateiname `profitbash-aenderungen-<konto>-<land>-<datum>.xlsx`); ohne Zeile `409 BULK_FILE_EMPTY`.
    `entitiesSyncedAt` der Übermittlung nennt den ältesten Stand ihrer Kampagnen (von ihm stammen Portfolio und
    Enddatum).
  - **Datenbank** (`packages/db/src/ad-change-queries.ts`): `listOpenAdChanges` (höchstens 5000, neueste zuerst,
    `truncated`; `mine`, `userName`, Weg der Übermittlung, bei Anlagen das Negative), `listAdChangeHistory`,
    `getBulkFileSubmissionRows`, `listSubmissionConnections`, `getSubmissionEntitiesSyncedAt`; Migration
    `0026_ad_changes_profile_indexes` (offene Änderungen und Verlauf je Profil); `loadAdChangeJobRows` liest die Zeilen für Job und
    Bulk-Datei (nur der Job setzt dabei „vorher“).
  - **Body-Limit:** Die schreibenden Sammel-Endpunkte (`pending`, `pending/discard`, `submit`, `retry`, `dismiss`,
    `revert`) nehmen bis 2 MB an (bis 5000 Änderungen je Anfrage), alle anderen bleiben bei 64 KB.
  - Review (unabhängig): keine kritischen Befunde; Rechte, Mandantentrennung (auch `settleBulkFile`), Body-Limit vor
    Session und zod, Dateiname und Decimal-Behandlung bestätigt. Übernommen: Prüfung in der Transaktion statt davor
    (vorher rechnete die Warnung mit dem „vorher“ vom Vormerken, und ein zweites Vormerken zwischen Prüfung und
    Übermitteln kam ungeprüft durch), „mehr als 200“ je Profil, Bulk-Schritt auch bei Download und Abschließen,
    `/open` neueste zuerst mit Filter nach Profil, Negative und zwei Indizes, `truncated` erst über der Grenze,
    Platzierung bei nicht setzbarer Strategie mit eigenem Code (`BIDDING_STRATEGY_NOT_SUPPORTED`),
    `entitiesSyncedAt` je Übermittlung, Schutz vor Nicht-Dezimalwerten in der Engine, Tests für ausgeblendete
    Profile und fremde Organisation je Endpunkt, 413, leeren Warenkorb, Auswahl per `changeIds`.
  - **Offen bzw. bewusst so (aus dem Review):** `confirmWarnings` bestätigt pauschal, auch Warnungen, die seit der
    Rückfrage dazukamen (3.6 kann die bestätigten Änderungen mitsenden). Ein Target ohne eigenes Gebot bekommt
    keine ±50-%-Warnung (kein Vergleichswert; möglich wäre das Standardgebot der Ad Group; **so umgesetzt mit 3.5**). Ein leerer Warenkorb
    antwortet mit `submitted` und leerer Liste. `limitFor` und die Grenzen negativer Keywords stehen doppelt
    (Route bzw. Engine und `limits.ts`). Der Verlauf je Entity zeigt neue Negatives nicht (ohne `entityId`; über
    Profil oder Übermittlung sichtbar). Ein Warenkorb mit mehr als rund 65 000 Änderungen sprengt die
    Parametergrenze beim Übermitteln (bisher keine Obergrenze). Nicht getestet: „mehr als 200“ über die API
    (die Engine testet es), Retry und Revert als Bulk-Datei mit übersprungenen Änderungen.
  - **Fehler:** `404 SUBMISSION_NOT_FOUND` (auch fremd oder ausgeblendet), `409 PROFILE_HAS_NO_CONNECTION`,
    `409 SUBMISSION_NOT_OPEN`, `409 SUBMISSION_NOT_BULK_FILE`, `409 BULK_FILE_EMPTY`.

### 3.5 Bearbeiten im Explorer
- [x] Inline-Bearbeitung (Status, Budget, Gebot), Dialog für Gebotsstrategie und Platzierungen der Kampagne, Bulk-Dialoge für
      markierte Zeilen (Gebote, Budgets, Status), Anzeige offener Änderungen im Grid (eigene und fremde, F4).
- **Entschieden (Dominik, 2026-10-08):**
  - **Inline:** Der Wert geht **sofort** in den Warenkorb (Enter oder Verlassen der Zelle), die Zelle zeigt ihn mit
    Markierung und lässt ihn dort zurücknehmen. An Amazon geht erst etwas beim Übermitteln (3.6).
  - **Bulk-Dialog für Gebote und Budgets:** fester Wert, ±Prozent und ±Betrag.
  - **Warenkorb-Zähler:** am Sidebar-Eintrag „Änderungen“ **und** als Link „Ausstehend (N)“ im Kopf des Explorers.
  - **±50-%-Warnung bei Targets ohne eigenes Gebot:** Vergleich mit dem Standardgebot der Ad Group (offener Punkt aus
    3.4).
- [x] Umsetzung (Stand für 3.6 und später):
  - **Vergleichswert** (`comparisonBefore`): `checkAdChanges` rechnet die ±50-%-Warnung ohne „vorher“ gegen
    `comparisonBefore`; die Datenbankschicht liefert dafür das Standardgebot der Ad Group (`loadComparisonBids`) im
    Warenkorb (`GET /pending`, Feld `comparisonBefore` je Änderung) und in den Review-Zeilen beim Übermitteln. Grenzen
    von Amazon und alle anderen Warnungen bleiben unberührt.
  - **Anpassen** (`operation: 'adjust'` in `adChangeInputSchema`, `POST /pending`): `entityType`, `entityId`, `field`
    (`budget` | `default_bid` | `bid`), `mode` (`percent` | `amount`), `value` als Decimal-String mit Vorzeichen (höchstens
    zwei Nachkommastellen, nicht 0, Prozent über −100; `adChangeAdjustmentIssue`). **Der Server rechnet**
    (`resolveAdjustments`): Ausgangswert ist der Stand der Entity, nie ein schon vorgemerkter Wert (dieselbe Anpassung
    zweimal ergibt denselben Wert), bei einem Target ohne eigenes Gebot das Standardgebot der Ad Group; kaufmännisch
    auf zwei Nachkommastellen gerundet, danach wie eine Feldänderung vorgemerkt („vorher“ bleibt der Stand der Entity,
    also leer beim Target ohne Gebot). Neue Ablehnungsgründe: `noCurrentValue` (kein Ausgangswert),
    `resultOutOfRange` (Ergebnis kein Betrag über 0 bzw. zu groß). Das Web rechnet nie (kein `decimal.js`).
  - **Explorer-Zeilen:** Kampagnen tragen `placementBidAdjustments` (aus `extra`) in den Attributen.
  - **Logik ohne I/O** (`apps/web/src/explorer/editing.ts`): `editIssue(level, row, field)` (wie die Ablehnungen des
    Servers: Summenzeile und Platzhalter, entfernt, archiviert, kein Tagesbudget, Strategie und Platzierungen nur SP),
    `currentFieldValue`, `indexOpenChanges`/`openEntry` (je Stelle: eigene Vormerkung, fremde Vormerkungen,
    Übermitteltes ohne Ergebnis), `parseMoneyInput`, `parsePercentInput`, `bulkInputs` (Eingaben der Bulk-Dialoge,
    übersprungene Zeilen mit Grund), `fieldCurrency`.
  - **Zelle** (`EditCell.vue`, Spalten Status, Budget, Standardgebot, Gebot auf den Ebenen Kampagnen, Ad Groups,
    Targets, Product Ads, Negatives): zeigt den Stand von Amazon bzw. die eigene Vormerkung (violett, Punkt,
    „Zurücknehmen“ über `POST /pending/discard`), dazu Hinweise auf Vormerkungen anderer (mit Name und Wert) und auf
    Übermitteltes ohne Ergebnis (mit Weg). Klick oder Enter auf der Zelle öffnet die Eingabe (Betrag mit Komma oder
    Punkt, Status als Auswahl; Negatives nur „Archiviert“); Enter oder Verlassen legt den Wert in den Warenkorb, Escape
    bricht ab, ungültige Eingaben bleiben mit Hinweis offen. Sortierung, Filter und CSV bleiben beim Stand von Amazon.
    Ohne Recht `write` nur die Anzeige; die Spalten nutzen die Zelle ab Recht `view` im Feature `changes`. Eine
    abgelehnte Änderung meldet die Seite über dem Grid mit dem Grund.
  - **Markierte Zeilen** (Leiste über dem Grid, nur mit `write`): „Status ändern“, je Ebene „Budget“/„Standardgebot“/
    „Gebot ändern“ (`BulkEditDialog.vue`: fester Wert bzw. Betrag je Währung der markierten Zeilen, Prozent mit
    Richtung; gesperrte Zeilen werden mit Hinweis übersprungen; Archivieren mit Warnung) und bei genau einer
    SP-Kampagne „Strategie & Platzierungen“ (`CampaignBiddingDialog.vue`: Strategie und vier Platzierungen, 0–900 %;
    gesendet werden alle Felder, was dem Stand entspricht, nimmt der Server zurück bzw. lässt es weg). Beide Dialoge
    zeigen das Ergebnis des Vormerkens (`changes/StageResult.vue`: vorgemerkt, zurückgenommen, unverändert, abgelehnt
    je Grund) und heben die Markierung auf.
  - **Offene Änderungen** (`changes/queries.ts`): `GET /open`, mit `profileId` nur, wenn genau ein Profil gewählt ist;
    Hinweis bei mehr als 5000 (`truncated`), eigener Fehlerzustand mit „Erneut versuchen“ (das Grid bleibt nutzbar).
    Nach jedem Vormerken oder Verwerfen werden Warenkorb und offene Änderungen neu geladen (Schlüssel `ad-changes`
    mit Organisation).
  - **Zähler:** `usePendingCount` (Länge von `GET /pending`, nur mit `view`): Zahl am Sidebar-Eintrag „Änderungen“
    (eingeklappt als kleine Marke, im `aria-label`), Link „Ausstehend (N)“ im Kopf des Explorers nach `/ads/changes`.
    Scheitert die Abfrage, fehlt der Zähler still.
  - **Tests:** `editing.test.ts`, `pages/ExplorerEditing.test.ts` (Inline, Markierungen, Bulk, Strategie, Rechte),
    `layouts/AppShell.test.ts` (Zähler), dazu Engine, DB und API für Vergleichswert und Anpassen.
  - Review (unabhängig): keine kritischen Befunde; Mandantentrennung von `resolveAdjustments` und
    `loadComparisonBids`, Rundung, Ergebnisse je Index, Audit, Rechte und Query-Keys bestätigt. Übernommen: Die
    Kopf-Checkbox markiert nur gefilterte Zeilen und ein Filterwechsel hebt die Markierung auf (vorher hätte ein
    Bulk-Dialog auch ausgeblendete Zeilen geändert); Vormerken in Stücken zu 5000 (`changes/stage.ts`; der Explorer
    lädt bis 10 000 Zeilen); der Fokus bleibt nach der Eingabe in der Zelle; der Status wird per Tastatur erst mit
    Enter oder beim Verlassen übernommen (Pfeiltasten blättern nur), mit der Maus sofort; der Dialog „Strategie &
    Platzierungen“ sendet nur geänderte Felder und sperrt das Speichern, solange die offenen Änderungen fehlen oder
    gekürzt sind (vorher konnte er eine eigene Vormerkung zurücknehmen) und solange keine setzbare Strategie gewählt
    ist; eine abgelehnte Anpassung gilt als letzte Angabe ihrer Stelle; Prozent ohne führende Nullen; Hinweise zu
    ungültigen Eingaben im Bulk-Dialog, Felder beim Wechsel der Art geleert; Tests dazu (Verlassen der Zelle, Fokus,
    Filter, Fehler von `/open`, gerundetes Ergebnis gleich Stand).
  - **Offen bzw. bewusst so:** Jedes Vormerken lädt den ganzen Warenkorb (für den Zähler) und die offenen Änderungen
    neu; bei sehr großem Warenkorb wird die Zelle träge (später ein schlanker Zähler-Endpunkt). Scheitert `/open`,
    zeigt die Zelle den Stand von Amazon ohne die eigene Vormerkung (Hinweis über dem Grid). Scheitert beim Vormerken
    in Stücken ein späteres Stück, sind die früheren schon vorgemerkt. Feste Maße der Zelle (Symbolgröße, Mindestbreite
    132 px) wie in `NameCell.vue`. Für Prozent nach oben gibt es keine eigene Obergrenze (Grenzen von Amazon und die
    ±50-%-Warnung greifen beim Übermitteln). Nicht getestet: Bulk-Dialog mit gemischten Währungen in der Oberfläche
    (`bulkInputs` ist getestet), Fehler beim Zurücknehmen.
  - Browser-Pane geprüft (Demo-Daten, 2026-10-09): Gebot in der Zelle geändert (Markierung, Zähler in Sidebar und
    Kopf), drei Gebote um −10 % (2,36 → 2,12; archivierte Zeile übersprungen), Dialog Strategie und Platzierungen mit
    den Werten der Kampagne; 1440 px dunkel, Tablet und Handy hell, kein waagerechtes Scrollen, Konsole ohne Fehler.

### 3.6 Seite „Änderungen“ (`/ads/changes`)
- [x] Ausstehend (Warenkorb prüfen, Warnungen bestätigen, über API übermitteln oder als Bulk-Datei herunterladen, verwerfen)
      und Übermittlungen (Ergebnis je Änderung, erneut versuchen, verwerfen, Revert).
- [x] Umsetzung (Stand für 3.8 und später):
  - **Seite** `pages/ChangesPage.vue` (Route `changes`), Bausteine in `apps/web/src/changes/`. Zwei Reiter, Zustand in
    der URL: `/ads/changes` (Ausstehend), `?tab=submissions` und `&submission=<id>` für die geöffnete Übermittlung.
  - **Ausstehend** (`PendingPanel.vue`): der eigene Warenkorb aus `GET /pending`, **je Profil** gruppiert (eine
    Übermittlung gilt je Profil). Je Änderung: Art, Name und Lage der Entity (`labels.ts`, `changeSubject`), Feld,
    vorher → nachher (`changeValueText`: Betrag mit Währung, Platzierung in Prozent, Zustand und Strategie
    übersetzt), dazu die Prüfungen des Servers: Verstoß gegen Grenzen von Amazon (mit der Grenze), große Änderung
    („+60 % gegenüber vorher“ bzw. „gegenüber dem Standardgebot der Ad Group“), Vormerkungen anderer (F4), Hinweis
    bei mehr als 200 Änderungen. Je Profil „Über API übermitteln“ und „Als Bulk-Datei“; ein Verstoß sperrt beide.
    Einzelne Änderung verwerfen, „Alle verwerfen“ mit Rückfrage.
  - **Übermitteln:** gesendet werden die **gezeigten** Änderungen des Profils (`changeIds`; über 5000 das ganze
    Profil per `profileId`). `needsConfirmation` öffnet die Rückfrage (Zahl großer Änderungen, „mehr als 200“);
    „Trotzdem übermitteln“ sendet dieselbe Anfrage mit `confirmWarnings`. Damit deckt die Bestätigung nichts, was
    nach dem Laden dazukam (offener Punkt aus 3.4). `limitsExceeded` und `409 PROFILE_HAS_NO_CONNECTION` als Meldung.
    Nach `submitted` springt die Seite zur ersten Übermittlung und nennt, was nicht mitging (`dropped`, `blocked`
    mit Grund, `bulkFileSkipped`).
  - **Übermittlungen** (`SubmissionsPanel.vue`): Liste der Organisation (Zeit, Nutzer, Profil, Weg, Status, Zähler
    je Ergebnis), darunter die geöffnete Übermittlung mit dem Ergebnis je Änderung (Fehlertext von Amazon mit Code;
    eigene Codes wie `NOT_SENT`, `UNKNOWN_OUTCOME` übersetzt) und dem letzten Folgeschritt (`followUp`, Link zur
    neuen Übermittlung). Aktionen mit `write`: „Erneut versuchen“ und „Verwerfen“ für fehlgeschlagene Änderungen
    ohne Folgeschritt, „Zurücknehmen“ je angewendeter Änderung und „Alles zurücknehmen“ (nicht für Archivieren; bei
    `conflict` Rückfrage mit übermitteltem und jetzigem Wert, erst dann `overwriteChanged`, F8), für den Weg
    Bulk-Datei „Bulk-Datei herunterladen“, „Als hochgeladen abschließen“ und „Nicht hochladen“, dazu der Hinweis,
    von welchem Stand Portfolio und Enddatum stammen (`entitiesSyncedAt`). Der Weg für Folgeschritte ist wählbar
    (Standard: Weg der Übermittlung). Übersprungenes erscheint mit Grund.
  - **Nachfragen:** Solange eine Übermittlung über die API oder ein Folgeschritt auf sein Ergebnis wartet, fragt die
    Seite alle 5 s nach (`refetchInterval`); jede Aktion lädt Warenkorb, offene Änderungen und Übermittlungen neu.
  - **Download:** `api.adChanges.bulkFile` holt die Datei als Blob (Fehler wie `BULK_FILE_EMPTY` als Meldung),
    Dateiname aus `Content-Disposition`.
  - **Tests:** `pages/ChangesPage.test.ts` (Warenkorb mit Prüfungen, leer, Fehler, verwerfen, Rückfrage und
    Bestätigung, Grenzen, Profil ohne Connection, Viewer; Liste, Ergebnis je Änderung, Folgeschritte, Revert mit
    Rückfrage, Bulk-Datei, unbekannte Übermittlung), `changes/labels.test.ts`.
  - Review (unabhängig): keine kritischen Befunde; Anfragen und Antworten gegen die Schemas, alle dynamischen
    i18n-Keys, Rechte, Invalidierung und die Darstellung von Servertexten (nur als Text) bestätigt. Übernommen: Ein
    Folgeschritt sperrt nur, solange er offen oder angewendet ist (ein verworfener Revert bzw. Versuch gibt die
    Änderung wieder frei; vorher Sackgasse), „Verwerfen“ für jede fehlgeschlagene Änderung, kein erneuter Versuch für
    überholte (`SUPERSEDED`: er trüge den älteren Wert über den neueren), Fehler nach bestätigtem Überschreiben
    schließt die Rückfrage, „Als hochgeladen abschließen“ und „Nicht hochladen“ mit Rückfrage, Nachfragen nur für
    Folgeschritte über die API (einer per Bulk-Datei wartet Tage), Wartegrund einer Übermittlung als Hinweis statt
    als Fehler, Download startet ohne auf das Neuladen zu warten, die geöffnete Übermittlung wird auch nach dem
    Übermitteln und bei Links ins Bild geholt und fokussiert, Hinweis nach dem Übermitteln verschwindet beim
    Weitergehen, „Verwerfen“ nennt die Entity, Zahlen formatiert.
  - **Offen bzw. bewusst so:** Die Bestätigung der Warnungen deckt die gezeigten Änderungen (IDs), nicht ihre Werte:
    Wer zwischen Rückfrage und Bestätigung in einem zweiten Fenster einen Wert ändert, bestätigt ihn mit; über 5000
    Änderungen gilt sie für das ganze Profil. Die Liste zeigt höchstens 100 Übermittlungen ohne Blättern und ohne
    Filter (3.1). Nach dem Verwerfen einer Zeile fällt der Fokus auf die Seite. Der Verlauf je Entity
    (`POST /history`) hat noch keine Oberfläche. Nicht getestet: das Nachfragen (`refetchInterval`), Download mit
    `BULK_FILE_EMPTY`, Rückfall auf `profileId` über 5000 Änderungen, `blocked` und `bulkFileSkipped` im Hinweis.
  - Browser-Pane geprüft (Demo-Daten gegen den Mock, 2026-10-09): vier Gebote um +80 % vorgemerkt, Warenkorb je
    Profil mit Warnungen, Rückfrage, über die API übermittelt (drei angewendet), „Alles zurücknehmen“ als neue
    Übermittlung, zweites Profil als Bulk-Datei (Datei `profitbash-aenderungen-…-it-2026-10-09.xlsx` mit 200 und
    richtigem Typ ausgeliefert), „Nicht hochladen“; 1440 px dunkel, Handy hell, kein waagerechtes Scrollen.

### 3.7 Tags (`/ads/tags/*`, F7)
- [x] Eigene Tags je Organisation (Name, Farbe) für Kampagnen, Ad Groups, Targets und Product Ads: verwalten, zuweisen (auch per
      Bulk), Filter im Explorer und in der Filterleiste des Dashboards; Amazon-Tags nur anzeigen.
- **Entschieden (Dominik, 2026-10-09):** Farben aus einer **festen Palette** der Design-Tokens (kein freier Farbwähler).
- [x] Umsetzung (Stand für 3.2c, Phase 4 und später):
  - **Shared** (`packages/shared/src/tags.ts`, browserfähig): `TAG_COLORS` (`violet`, `lime`, `amber`, `red`, `ink`,
    `grey`: die sechs Farbtöne der Design-Tokens), `TAG_ENTITY_TYPES` (`campaign`, `ad_group`, `target`,
    `product_ad`), `normalizeTagName` (Ränder weg, Leerraum zusammengefasst, NFC), Grenzen (Name 40 Zeichen, 200 Tags
    je Organisation, 1000 Entities und 50 Tags je Zuweisung, 50 Tags im Filter) und die Schemas der API.
  - **Schema** (Migration `0028_tags`, `packages/db/src/schema/tags.ts`): `tags` (Organisation, Name, Farbe als Text
    ohne CHECK, damit eine neue Farbe keine Migration braucht; Unique je Organisation auf `lower(name)`) und
    `tag_assignments` (Primärschlüssel Tag, Art und ID der Entity; Profil der Entity; Fremdschlüssel auf Tag und
    Profil jeweils zusammen mit der Organisation, `ON DELETE CASCADE`; `entity_id` ohne Fremdschlüssel wie bei
    `ad_changes`; Index über Entity und über Profil).
  - **Access-Layer** (`packages/db/src/tags.ts`): `listTags` (nach Name, Zähler je Art nur über sichtbare Profile),
    `createTag`, `updateTag`, `deleteTag` (löscht alle Zuweisungen, auch in ausgeblendeten Profilen; das Tag gehört
    der Organisation), `assignTags({ entityType, entityIds, addTagIds, removeTagIds })`: nur Entities sichtbarer
    Profile (`loadEntities` über `visibleProfilesScope()`), unbekannte und unsichtbare zählt `skippedEntities`; ein
    Tag, das nicht der Organisation gehört, bricht mit `NOT_FOUND` ab, ohne etwas zu ändern; schon Vorhandenes zählt
    nicht. Fehler `TagError` (`NOT_FOUND`, `NAME_TAKEN`, `LIMIT_REACHED`). Audit `tag.create`, `tag.update` (vorher
    und nachher), `tag.delete` (Name, Zahl der Zuweisungen), `tags.assign` (nur bei Änderung). ADR 002 ergänzt.
  - **Filter in den Auswertungen** (`packages/db/src/ads-analytics.ts`, `tagIds` in `analyticsSelectionSchema`):
    mehrere Tags als ODER, leer = kein Filter. **Ein Tag gilt für seine Entity und alles darunter, nicht nach oben:**
    Ad Groups, Targets, Suchbegriffe, Product Ads und Negatives erben von Ad Group und Kampagne; Dashboard, Kampagnen
    und Portfolios zählen nur Kampagnen, die das Tag selbst tragen (ein Tag nur an Targets lässt das Dashboard leer;
    die Filterleiste sagt das). Gilt für Explorer-Zeilen, Summenzeile, Tagesreihe, Dashboard und Negatives. Die
    Zeilen der vier Ebenen tragen `attributes.tagIds`, Kampagnen dazu `attributes.amazonTags` (`extra.tags` aus dem
    Export, nur Anzeige).
  - **Nebenbei behoben:** Die Tagesreihe der Ebene Portfolios und der Drill-Down auf ein Portfolio in dieser Ebene
    scheiterten mit einem SQL-Fehler (eine einzelne Tabelle in Klammern ist kein gültiger Join; `entityJoinSql`).
    Mit Test.
  - **API** (`apps/api/src/routes/tags.ts`, Feature `tags`): `GET /api/ads/tags` (`view`), `POST /api/ads/tags`
    (`201`), `PATCH`/`DELETE /api/ads/tags/{id}` (`204`), `POST /api/ads/tags/assign` (alle `write`). Fehler:
    `404 TAG_NOT_FOUND` (auch fremde Organisation), `409 TAG_NAME_TAKEN`, `409 TAG_LIMIT_REACHED`.
  - **Seite „Tags“** (`pages/TagsPage.vue`, Route `tags`): Liste mit Farbpunkt, Name und Zuweisungen je Art,
    „Neues Tag“ und Ändern im Dialog (Name mit Label, Farbe als Auswahl aus der Palette), Löschen mit Rückfrage und
    Zahl der Zuweisungen; Skeleton, Leerzustand, Fehler mit „Erneut versuchen“; Viewer nur lesend.
  - **Explorer:** Spalte „Tags“ auf den Ebenen Kampagnen, Ad Groups, Targets und Product Ads (`tags/TagsCell.vue`:
    eigene Tags als Marke mit Farbpunkt, Amazon-Tags gedämpft mit Umriss; der Wert der Spalte ist der Text der Namen,
    also filter- und sortierbar und im CSV), nur mit Recht `view` im Feature `tags`. Leiste der markierten Zeilen:
    „Tags zuweisen“ (`tags/AssignTagsDialog.vue`, nur mit `write`): je Tag ein Häkchen, vorbelegt mit dem, was alle
    markierten Zeilen tragen, „bei manchen“ als Strich; geändert wird nur Angefasstes (Häkchen setzen hängt an alle,
    entfernen löst von allen), in Stücken zu 1000 Zeilen. Die Leiste erscheint jetzt auch nur mit dem Recht auf Tags
    (die Knöpfe für Status, Budget und Gebote hängen weiter an `changes`).
  - **Filterleiste** (`analytics/FilterBar.vue`, Dashboard und Explorer): Feld „Tags“ (Mehrfachauswahl, höchstens 10,
    nur mit Recht `view` und wenn es Tags gibt) mit dem Hinweis zur Vererbung. Zustand `tagIds` in `FilterState`: in
    der URL als `tags=<id>,<id>` und in der gespeicherten Auswahl (ältere Einträge ohne das Feld gelten als „kein
    Filter“). Tags, die der Nutzer nicht auflösen kann (gelöscht, fremder Link, kein Recht), gelten nicht
    (`useAnalyticsFilters`, sonst blieben die Auswertungen ohne sichtbaren Grund leer); mit Tag-Filter warten die
    Auswertungen auf die Tags.
  - **Farben** (`tags/colors.ts`): Palette → Klassen der Tokens (`bg-violet`, `bg-lime-deep`, `bg-warn`, `bg-loss`,
    `bg-ink`, `bg-ink-tertiary`) als Punkt; der Text bleibt in Tintenfarbe (lesbar in Hell und Dunkel).
  - **Tests:** `tags.test.ts` in `packages/db` und `apps/api` (Rechte, fremde Organisation, ausgeblendetes Profil,
    Entitlement), `ads-analytics.test.ts` (Tags je Zeile, Filter je Ebene samt Vererbung, ODER, Dashboard gleich
    Explorer, Portfolios, Tagesreihe, Negatives, fremdes Tag), `analytics/filters.test.ts`, `tags/row-tags.test.ts`,
    `pages/TagsPage.test.ts`, `pages/ExplorerEditing.test.ts` (Spalte, Zuweisen mit „manche“, Lösen, Filter aus der
    URL, Viewer, ohne Feature).
  - Review (unabhängig): keine kritischen Befunde; Mandantentrennung (Zuweisen, Zähler, Filter je Ebene und
    Dashboard, Tags je Zeile), SQL der Vererbung, Migration, Rechte und i18n-Keys bestätigt. Übernommen: Der
    Tag-Filter gehört zu gespeicherten Ansichten (`savedViewFiltersSchema.tagIds`, nur mit Filter gesetzt; vorher
    ließ eine Ansicht ihn fallen und galt trotz Filter als aktiv); scheitert der Abruf der Tags, gilt kein
    Tag-Filter (vorher gefilterte Auswertungen ohne sichtbares Feld); `tagIds` der Zeilen werden erst an den
    gelieferten Zeilen gelesen (nach `limit`, vorher für jede Entity der Ebene); Portfolios zählen entfernte
    Kampagnen mit Tag nur mit „Entfernte anzeigen“; Anlegen je Organisation nacheinander (Höchstzahl), Zuweisungen
    in fester Reihenfolge (kein Deadlock zweier Bulk-Anfragen), kein Audit-Event ohne Änderung; Text der
    Lösch-Rückfrage („überall gelöst“, Zahl nur der eigenen Profile); Merker `singleTable` statt Vergleich der
    Ebene; Tests für Ad-Group-Vererbung und Ansichten.
  - **Offen bzw. bewusst so:** Der Filter `tagIds` und `attributes.tagIds` hängen nicht am Feature `tags` (jede
    Auswertung nimmt sie an; ohne das Feature sieht die Oberfläche weder Namen noch Feld). Wer seine Spalten im
    Explorer schon einmal gewählt hat, muss „Tags“ unter „Spalten“ selbst einschalten (die gespeicherte Auswahl kennt
    die Spalte nicht). Ein angefasstes Häkchen im Zuweisen-Dialog lässt sich nicht auf „unverändert“ zurückstellen
    (abbrechen und neu öffnen). Ein Farbwechsel zeichnet schon sichtbare Zellen erst nach dem Neuladen der Zeilen
    neu. Tags an Portfolios, Negatives und Suchbegriffen gibt es nicht (F7). Die gespeicherte Ansicht prüft Tags
    nicht gegen die Organisation (die Oberfläche lässt unbekannte weg). Nicht getestet: Tag-Filter zusammen mit
    Ad-Typ, Portfolio mit einer Kampagne mit und einer ohne Tag, `ready` und gescheiterter Tag-Abruf in
    `useAnalyticsFilters`, die Mehrfachauswahl der Filterleiste, gleichzeitiges Anlegen und Zuweisen.
  - Browser-Pane geprüft (Demo-Daten, 2026-10-09): zwei Tags angelegt, zwei Kampagnen im Explorer zugewiesen
    („2 Zuweisungen hinzugefügt“), Filter über die URL: 2 Kampagnen, 101 Targets darunter, Dashboard mit Feld
    „Tags“ und Hinweis; Konsole ohne Fehler, kein waagerechtes Scrollen. Test-Tags danach gelöscht.

### 3.8 Suchbegriff-Aktionen (F9)
- [x] „Negativ anlegen“ in der Suchbegriff-Analyse: Dialog mit Standard „negativ exakt“ in der Ad Group der Zeile, umstellbar
      auf Kampagnenebene und Wortgruppe; legt die Änderung in den Warenkorb. Hinweis, wenn der Begriff dort schon negiert ist;
      geschützte Begriffe nur mit Bestätigung.
- [x] „Harvest vormerken“: Merkliste je Profil (Suchbegriff, Quelle, Kennzahlen zum Zeitpunkt des Vormerkens), ansehen und
      wieder entfernen; keine Änderung bei Amazon. Phase 4 (Kampagnen-Setup) liest die Merkliste.
- **Entschieden (Dominik, 2026-10-09):**
  - **Mehrfachauswahl:** Zeilen per Checkbox markieren, ein Dialog legt alle als Negativ in den Warenkorb; dazu die Aktion
    je Zeile.
  - **Merkliste:** dritte Ansicht „Merkliste“ auf der Seite der Suchbegriff-Analyse (kein eigener Eintrag in der Sidebar).
- [x] Umsetzung (Stand für 3.7, Phase 4 und später):
  - **Negatives gebündelt** (`packages/db/src/ad-change-entities.ts`, `checkNegatives`; `stageAdChanges`): Kampagnen,
    Ad Groups, vorhandene Negatives und die offenen Anlagen aller betroffenen Kampagnen werden je Anfrage einmal
    gelesen (vorher einige Abfragen je Negative, offener Punkt aus 3.1), die Sperren je Nutzer und Kampagne sortiert
    genommen, die Anlagen in Stücken zu 500 eingefügt. Verhalten wie bisher: Ergebnis je Eingabe in derselben
    Reihenfolge, dasselbe Negative zweimal (auch in einer Anfrage) ist `unchanged`, `otherUsers` zählt andere Nutzer mit
    demselben offenen Negative. `checkNegative` (Übermitteln, erneuter Versuch) ruft dieselbe Prüfung für eine Eingabe.
  - **Geschützte Begriffe** (Server): `create_negative` nimmt `confirmProtected` (`adChangeInputSchema`). Enthält das
    Keyword bzw. die ASIN einen geschützten Begriff des Clients (`clients.protected_terms`, `createProtectedTermMatcher`
    aus der Engine: ganze Wortfolge, Satzzeichen trennen), lehnt das Vormerken ohne Bestätigung mit dem neuen Grund
    `protectedTerm` ab; das gilt für jede Herkunft, auch den Explorer. Reihenfolge: erst Kampagne, Ad Group und „gibt
    es schon“ (`alreadyExists`), dann der eigene Warenkorb (`unchanged`), dann der Schutz. Geprüft wird beim
    Vormerken; Übermitteln, erneuter Versuch und Revert prüfen ihn nicht noch einmal.
  - **Merkliste** (Migration `0027_search_term_harvest_marks`, `packages/db/src/schema/search-terms.ts`,
    `packages/db/src/search-term-harvest.ts`): `search_term_harvest_marks`, je Profil und Begriff ein Eintrag
    (`term_key` = `comparableSearchTerm`: klein, NFC, Leerraum zusammengefasst; Unique je Profil). Felder: Suchbegriff
    in der Schreibweise der Quelle, **Quelle** als Amazon-IDs von Kampagne, Ad Group und Target samt Ad-Typ (die Zeile
    des Begriffs mit dem höchsten Spend; Namen kommen beim Lesen über die IDs, fehlende Entities bleiben leer),
    Datei-Zeitraum, `source_rows`, **Kennzahlen** (Impressionen, Klicks, Spend, Umsatz, Käufe, Einheiten als Summe über
    **alle** Zeilen des Begriffs im Zeitraum, Währung des Profils), wer und wann. Fremdschlüssel auf Profil und
    Organisation mit `ON DELETE CASCADE` (wie die Regeln je Profil). `markSearchTermsForHarvest` liest Quelle und
    Kennzahlen selbst aus den Zeilen des Zeitraums (die Anfrage nennt nur Begriffe), Ergebnis je Begriff `added` |
    `alreadyMarked` (die Kennzahlen von damals bleiben) | `notFound`; `listHarvestMarks` (sichtbare Profile, optional
    eines, neueste zuerst, höchstens 5000), `removeHarvestMarks`, `listMarkedHarvestTermKeys` (für die Kennzeichnung
    in der Analyse). Alles über `visibleProfilesScope()`; Audit `search_term_harvest.add` bzw. `.remove`, nur wenn
    sich etwas geändert hat. ADR 002 ergänzt.
  - **API** (`routes/search-terms.ts`, Feature `sp-explorer`, Schemas in `packages/shared/src/search-terms.ts`):
    `POST /api/ads/search-terms/harvest` (`write`; `profileId`, `periodStart`, `periodEnd`, `searchTerms` mit
    höchstens 80 Begriffen je Anfrage, wegen des Body-Limits von 64 KB; nicht sichtbares Profil `404
    PROFILE_NOT_FOUND`), `POST …/harvest/list` (`view`; optional `profileId`; Kennzahlen mit ACoS, CVR usw. wie die
    Analyse; `truncated`, `maxMarks`), `POST …/harvest/remove` (`write`; `ids`, höchstens 1000). Die Analyse nennt je
    Zeile `harvestMarked`. Negatives gehen über den vorhandenen Endpunkt `POST /api/ads/changes/pending` mit
    `origin: 'search_terms'` (Recht `write` im Feature `changes`).
  - **Logik ohne I/O** (`apps/web/src/search-terms/actions.ts`): `negativeInputs(rows, { level, matchType,
    confirmProtected })` (dieselbe Stelle nur einmal; ASIN-Suchbegriffe werden zu negativen Produkt-Targets;
    übersprungen werden Zeilen ohne bekannte Kampagne bzw. Ad Group, geschützte ohne Bestätigung und Begriffe über 80
    Zeichen), `harvestTerms`, `isAsinSearchTerm`.
  - **Oberfläche** (`pages/SearchTermAnalysisPage.vue`): Im Grid der Suchbegriffe lassen sich Zeilen markieren
    (`SearchTermGrid` mit `selectable`; die Kopf-Checkbox meint die gefilterten Zeilen, ein Wechsel von Filter,
    Ansicht, Profil oder Zeitraum hebt die Markierung auf). Leiste über dem Grid: „n markiert“, „Negativ anlegen“ (nur
    mit `write` im Feature `changes`) und „Harvest vormerken“ (nur mit `write` in `sp-explorer`); dieselben Aktionen
    je Zeile in der Spalte „Aktionen“ (`RowActionsCell.vue`, rechts fest, nie im CSV). **Dialog**
    (`NegativeDialog.vue`): „Wo“ (Ad Group der Zeile | Kampagne der Zeile), „Wie“ (negativ exakt | Wortgruppe),
    Hinweis auf geschützte Begriffe mit Häkchen „trotzdem negieren“ (ohne Häkchen bleiben sie weg), Hinweise auf
    übersprungene Zeilen, Zahl der Negatives; danach das Ergebnis des Vormerkens (`StageResult.vue`, mit „gibt es dort
    schon“ und „geschützter Begriff“ als Ablehnungsgründe). **Harvest vormerken** geht ohne Dialog (in Stücken zu 80),
    das Ergebnis steht über dem Grid („2 Suchbegriffe vorgemerkt“, „stand schon auf der Merkliste“) mit Sprung zur
    Merkliste. Neue Spalte „Merkliste“ („Vorgemerkt“, filter- und sortierbar, auch im CSV). **Ansicht „Merkliste“**
    (`view=harvest`): Einträge des gewählten Profils mit Quelle, Datei-Zeitraum, Kennzahlen, „Vorgemerkt am“ und
    „Von“; markieren und „Von der Merkliste entfernen“; Skeleton, Leerzustand, Fehler mit „Erneut versuchen“, CSV.
    Viewer sehen weder Auswahl noch Aktionen.
  - **Tests:** `ad-changes.test.ts` (gebündelte Negatives, Schutz mit und ohne Bestätigung, Reihenfolge der Gründe),
    `search-term-harvest.test.ts` in `packages/db` und `apps/api` (fremde Organisation, ausgeblendetes Profil, Recht
    `write`, Entitlement, Kennzeichnung in der Analyse), `search-terms/actions.test.ts`,
    `pages/SearchTermAnalysisPage.test.ts` (Auswahl, Dialog, Ebene und Match-Typ, geschützte Begriffe, Ergebnis,
    Aktion je Zeile, Vormerken, Merkliste mit Entfernen, Leer- und Fehlerzustand, Viewer).
  - Review (unabhängig): keine kritischen Befunde; Mandantentrennung aller neuen Wege, Gleichwertigkeit der
    gebündelten Prüfung mit der alten Schleife, Sperrreihenfolge, Decimal-Summen, Migration (nur additiv), Rechte und
    i18n-Keys bestätigt. Übernommen: Der Wechsel von Filter, Ansicht, Profil oder Zeitraum hebt die Markierung auch
    im Grid auf (vorher blieben Zeilen angehakt, die Leiste zeigte „0 markiert“); eine negative **Wortgruppe**, die in
    einem geschützten Begriff steckt („nordwind“ bei geschütztem „nordwind jacke“), gilt als geschützt, und der
    Dialog lässt vom Server als geschützt abgelehnte Negatives nach dem Ergebnis bestätigen („Trotzdem in den
    Warenkorb“); die IDs neuer Negatives vergibt der Server vor dem Einfügen (keine Zuordnung über die Reihenfolge von
    `RETURNING`); `confirmedProtected` im Audit-Event `ad_changes.stage`; höchstens 80 Begriffe je Anfrage (vorher
    200: Begriffe voller Länge in Schriften mit drei Bytes je Zeichen sprengten das Body-Limit); die Aktion einer
    einzelnen Zeile lässt die Markierung der anderen stehen; die Merkliste zeigt beim Profilwechsel keine Einträge des
    vorigen Profils mehr; eigenes `aria-label` für schon vorgemerkte Zeilen; Tests dazu.
  - **Offen bzw. bewusst so:** Die Merkliste hängt an der Auswahl der Analyse: Hat ein Profil keinen Datei-Zeitraum
    mehr (2b.2d) oder lädt die Analyse nicht, ist seine Merkliste in der Oberfläche nicht erreichbar (die Einträge
    bleiben, Phase 4 liest sie je Profil; dort bzw. mit einer eigenen Profil-Auswahl lösen). **Gelöst in 4.6:** Der Setup-Assistent zeigt die Merkliste jedes Profils. „Von der Merkliste
    entfernen“ fragt nicht nach (ein erneutes Vormerken trägt dann die Kennzahlen des gewählten Zeitraums). Die
    Zeilenkennung `protected` der Analyse kennt den Fall „Wortgruppe steckt im geschützten Begriff“ nicht (der Server
    lehnt ab, der Dialog fragt danach). Ob ein geschützter Begriff bestätigt wurde, steht nur als Zahl im Audit-Event,
    nicht an der Änderung. `checkNegatives` liest alle Negatives der betroffenen Kampagnen (auch für die Einzelprüfung
    beim Übermitteln und beim erneuten Versuch, dort je Zeile); das Vormerken für den Harvest liest je Anfrage alle
    Zeilen des Zeitraums (bei 5000 markierten Begriffen über 60 Anfragen). `truncated` der Merkliste ist bei genau
    5000 Einträgen schon wahr. Die Audit-Events der Merkliste nennen Zahlen, keine Begriffe. Negatives für SB und SD
    scheitern über die API bis 3.2c mit `AD_PRODUCT_NOT_SUPPORTED`; eine negative ASIN auf Kampagnenebene geht nicht
    per Bulk-Datei (3.2b). Nicht getestet: Stücke über 80 Begriffe und ein Fehler mittendrin, Fehlermeldung beim
    Vormerken in der Oberfläche, gleichzeitiges Vormerken, Reihenfolge der Merkliste bei mehreren Einträgen.
  - Browser-Pane geprüft (Demo-Daten, 2026-10-09): drei Zeilen markiert, Dialog mit den Standardwerten, drei
    Negatives im Warenkorb (Zähler in der Sidebar), dieselben noch einmal: „3 unverändert“; zwei Suchbegriffe
    vorgemerkt (Spalte „Merkliste“, Ansicht „Merkliste“ mit Quelle), entfernt; 1440 px dunkel und Handy ohne
    waagerechtes Scrollen, Konsole ohne Fehler. Testdaten danach verworfen.

### 3.9 Bulk-Datei für Sponsored Brands und Sponsored Display
- [x] Blätter und Spalten für SB und SD nach den Bulksheets-Guides, Abbildung in `packages/amazon-ads/src/bulk-file.ts`,
      Zusammenführung in `apps/worker/src/ad-changes/bulk-file.ts` (bisher `AD_PRODUCT_NOT_SUPPORTED`), Rundlauf-Test mit
      dem Import-Leser. Offener Punkt aus 3.2b und 3.2c: Ohne das ließen sich SB und SD ohne API-Zugang nicht ändern.
- **Entschieden (Dominik, 2026-10-09):** jetzt bauen, vor Phase 4. Drei echte Bulk-Dateien bereitgestellt (deutsch und
  englisch; die Blätter für SB und SD enthalten nur die Kopfzeile, der Kunde nutzt nur SP).
- **Quellen** (2026-10-09): Kopfzeilen der Blätter „Sponsored Brands Campaigns“, „SB Multi Ad Group Campaigns“ und
  „Sponsored Display Campaigns“ aus der echten englischen Datei; Entities, Pflichtangaben und Werte aus den Guides
  `sb-legacy/sb-examples/update-sb-campaigns` und `…/create-sb-campaign`, `sb/sb-examples/update-sb-campaigns` und
  `…/create-sb-campaign` (mehrere Ad Groups), `sd/sd-examples/update-sd-campaigns` und `…/create-sd-campaign`. Das
  versteckte Blatt „Config“ der echten Datei nennt Pflichtspalten nur für SP (Befund in 3.2b).
- [x] Umsetzung (Stand für Phase 4 und später):
  - **Blätter** (`buildBulkSheet(kind, changes)`, `kind` = `sp` | `sb` | `sbMultiAdGroup` | `sd`; `buildSpBulkSheet`
    bleibt): je Blatt Name, Wert der Spalte `Product` und die Spalten der echten Datei ohne „Informational only“ und
    ohne Kennzahlen (`SB_BULK_COLUMNS`, `SB_MULTI_AD_GROUP_BULK_COLUMNS`, `SD_BULK_COLUMNS`). Abweichungen je Blatt:
    Budget in `Budget` (SP: `Daily Budget`), bei SD `Targeting ID` und `Targeting Expression` (sonst `Product Targeting
    ID` bzw. `… Expression`). Die Regeln aus 3.2b gelten für alle Blätter: englisch, IDs als Text, Beträge als
    Zahlzelle, je Entity eine Zeile, Kinder archivierter Eltern entfallen, die Kampagnenzeile trägt immer Portfolio-ID
    und Enddatum und sonst nur Geändertes (der SD-Guide sagt ausdrücklich, dass ein leeres `End Date` das Enddatum
    entfernt; für SB steht es nicht da, die Zeile trägt es trotzdem). Schreibt eine Zeile in eine Spalte, die ihr Blatt
    nicht hat, wirft der Schreiber (Programmierfehler, kein stilles Weglassen).
  - **Sponsored Brands, älteres Blatt** (`sb`, Kampagnen ohne eigene Ad-Group-Zeilen): `Campaign` (Zustand, Budget,
    Archivieren), `Keyword` und `Product Targeting` (Zustand, Gebot, Archivieren; die Ad Group darf fehlen),
    `Negative Keyword` und `Negative Product Targeting` anlegen und archivieren, auch auf Ebene der Kampagne (dort
    der Normalfall: Der Import liest Negatives ohne Ad Group als „Kampagne“).
  - **Sponsored Brands mit mehreren Ad Groups** (`sbMultiAdGroup`): zusätzlich `Ad Group` (Zustand, Archivieren);
    Targets und Negatives brauchen die Ad Group.
  - **Sponsored Display** (`sd`): `Campaign` (Zustand, Budget), `Ad Group` (Zustand, Standardgebot), `Product Ad`
    (Zustand), Targets als `Contextual Targeting` bzw. `Audience Targeting` (Zustand, Gebot), `Negative Product
    Targeting` (ASIN) in der Ad Group anlegen, alles archivieren.
  - **Nicht im Blatt** (`notSupportedInBulkFile` → `BULK_FILE_NOT_SUPPORTED`, in der Werbekonsole ändern): bei SB
    Anzeigen (im Blatt heißen sie je Format anders, „Store spotlight ad“ …; das Format kennt ProfitBash nicht), das
    Standardgebot der Ad Group, Ad Groups im älteren Blatt, Negatives der Kampagne im Blatt mit mehreren Ad Groups;
    bei SD Keywords und negative Keywords, Negatives der Kampagne; bei beiden Gebotsstrategie und Platzierungen
    (lehnt schon das Vormerken ab).
  - **Welches SB-Blatt?** Eine SB-Kampagne steht in genau einem der beiden Blätter. Der Bulk-Import merkt es sich an
    der Kampagne (`extra.multiAdGroups`, `isSbMultiAdGroupSheet`), der Job reicht es durch
    (`AdChangeJobRow.campaignMultiAdGroups`). Fehlt die Angabe (Kampagne aus dem API-Export oder vor diesem Stand
    importiert), scheitert die Änderung mit `BULK_FILE_SHEET_UNKNOWN` („zuerst eine aktuelle Bulk-Datei importieren“).
  - **Zusammenführung** (`buildBulkFileChanges`, `buildSubmissionBulkFile`): Blatt je Änderung (`sheetByRef`) aus dem
    Ad-Typ der Kampagne; andere Ad-Typen weiter `AD_PRODUCT_NOT_SUPPORTED`. Die Art eines SD-Targets kommt aus
    `targetType` (`audience`, `product_audience` … → Zielgruppe; `product`, `category` → kontextbezogen), unbekannte
    Arten und Themen-Targets von SB scheitern mit `TARGET_TYPE_NOT_SUPPORTED`. Die Datei enthält nur Blätter mit
    Zeilen, in der Reihenfolge der Werbekonsole (SP, SB, SB mit mehreren Ad Groups, SD).
  - **Rundlauf** (`bulk-export-roundtrip.test.ts`): eine Arbeitsmappe mit den drei Blättern, gelesen mit `openXlsx` und
    den Abbildungen des Bulk-Imports (Blätter erkannt, das Blatt mit mehreren Ad Groups unterschieden, alle
    gebrauchten Kopfzeilen bekannt, Entity-Namen, IDs als Text, Beträge, Datum, Zustand, Match-Typ, Ausdruck
    `asin="…"`). Wie bei SP belegt das den Gleichlauf von Schreiben und Lesen, nicht die Annahme durch die Konsole.
  - **Tests:** `bulk-file-sb-sd.test.ts` (je Blatt: Zeilen, was übersprungen wird, gemeinsame Regeln),
    `ad-changes/bulk-file.test.ts` (Blatt je Änderung, unbekanntes SB-Blatt, Targets ohne Ad Group, Art des
    SD-Targetings, mehrere Blätter in einer Datei), Import (`multiAdGroups`), `ad-change-queries.test.ts`.
  - Review (unabhängig): keine kritischen Befunde; alle Pfade je Entity und Operation gegen die vier Spaltenlisten
    geprüft (keine Zelle in einer Spalte, die das Blatt nicht hat), SP unverändert, keine Änderung geht still
    verloren, `settleBulkFile`, Download, Abschließen, Retry, Revert und die Bestätigung durch den Import nehmen SB und
    SD an. Übernommen: Ein SD-Target der Entity „Audience Targeting“ gilt beim Import als Zielgruppe, auch wenn der
    Leser den Ausdruck nicht kennt (sonst wäre es als „Contextual Targeting“ in die Datei gekommen);
    `extra.multiAdGroups` bleibt erhalten, wenn eine spätere Quelle (Export über die API) es nicht nennt
    (`upsertCampaigns`, vorher wäre das Blatt nach jedem Sync wieder unbekannt gewesen); Themen-Targets werden nur für
    SB abgelehnt (SP wie bisher); ändert eine Übermittlung Zustand und Standardgebot einer SB-Ad-Group, entfällt nur
    das Standardgebot; die Reihenfolge der Blätter ist über den Typ vollständig; Tests für das ältere SB-Blatt im
    Import, `product_audience` und `category_audience`, unbekannte SD-Arten.
  - **Bewusst so (aus dem Review):** `isSbMultiAdGroupSheet` schließt über den Namen aus (alles, was als SB gilt und
    nicht „Sponsored Brands“ heißt); ein künftig anders benanntes Blatt gälte als das ältere (robuster wäre die
    Kopfzeile: `Draft Campaign ID` gibt es nur im älteren). Im älteren SB-Blatt trägt ein neues Negative die Ad
    Group, wenn die Änderung eine nennt; liest der nächste Import die Zeile ohne Ad Group, findet die Bestätigung sie
    nicht und die Änderung bleibt offen, bis jemand von Hand abschließt. Nicht getestet: der Wächter gegen Spalten,
    die ein Blatt nicht hat (kein erreichbarer Pfad), `campaignMultiAdGroups` `true`/`false` über die Datenbank
    (nur `null`; die Abbildung selbst testet der Worker).
  - **Offen (braucht echte Daten bzw. einen echten Upload):** Die Blätter für SB und SD in Dominiks Dateien sind leer:
    Schreibweise der Entity-Namen („Ad Group“, „Product Targeting“, „Contextual Targeting“ in der Großschreibung des
    SP-Blatts; die Guides schreiben „Ad group“, „Product targeting“) und die Werte von `State` sind dort unbelegt. Ob
    die Konsole Zeilen mit nur den geänderten Feldern annimmt (Pflichtspalten wie bei SP, Befund in 3.2b), ob im
    älteren SB-Blatt Negatives mit Ad Group angenommen werden, ob ein leeres `Portfolio ID` bei SB und SD die
    Kampagne aus dem Portfolio nimmt. SB-Kampagnen, die nur der API-Export kennt, tragen `multiAdGroups` nicht
    (mit 1.10 aus dem Export ableiten); der Mock liefert es deshalb auch nicht, die Demo zeigt für SB
    `BULK_FILE_SHEET_UNKNOWN`.
  - Browser-Pane geprüft (Demo-Daten, 2026-10-09): Standardgebot einer SD-Ad-Group geändert, als Bulk-Datei
    übermittelt („Wartet auf den Upload“ statt wie bisher abgelehnt), Datei geladen und gelesen: ein Blatt „Sponsored
    Display Campaigns“ mit den 22 Spalten und der Zeile `Ad Group`/`Update` mit Kampagnen- und Ad-Group-ID und dem
    Gebot als Zahl. Danach „Nicht hochladen“.

## Bewusst nicht in Phase 3

- Keine neuen Kampagnen, Ad Groups oder Keywords (Phase 4, Kampagnen-Setup)
- Keine Regeln, keine automatischen Änderungen, keine Budget-Caps (Phase 5)
- Keine Profil-Freigaben je Mitglied (Phase 6)

## Reihenfolge für Claude Code

3.1 → 3.2a → 3.2b → 3.3 → 3.4 → 3.5 → 3.6 → 3.8 → 3.7 → 3.2c → 3.9 (die Suchbegriff-Aktionen vor den Tags: Sie schließen die tägliche
Arbeit aus 2b ab, Tags sind unabhängig). Bis zu drei Aufgaben je Session (`CLAUDE.md`), nach jedem Schritt Tests grün, Commit,
Häkchen und „Umsetzung“-Notiz.
