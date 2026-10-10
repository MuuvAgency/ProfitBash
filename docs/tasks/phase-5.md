# Phase 5 – Automatisieren

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5 inkl. „Kennzahlen je Ad-Typ“),
> `docs/tasks/phase-4.md` (Definition of Done, 4.11 „Offen nach Phase 4“), `docs/tasks/phase-3.md` (3.1, 3.3, 3.4: Warenkorb,
> Übermittlung, Grenzen und Warnungen), `docs/tasks/phase-1.md` (1.11c/d: Datei-Import, 1.11e: entfallen),
> `docs/decisions/` (001–005), `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` (Abschnitte E und F, F-S6),
> `design/DESIGN.md`.
>
> **Status: verfeinert (2026-10-10), Fragen F1–F8 entschieden (die Nummern gelten nur in dieser Datei), Plan nach einem
> unabhängigen Review überarbeitet (Festlegungen unter „Aufgaben“). Fertig: 5.1, 5.2a. Als Nächstes: 5.2b.**
>
> **Ausgangslage:** Es gibt weiterhin keinen Ads-API-Zugang. Daten kommen nur aus der **Bulk-Datei**, die Dominik
> wöchentlich je Profil lädt (`phase-1.md` 1.11); Tagesberichte sind entfallen (1.11e, 2026-10-07). Datei-Profile haben
> damit **keine Tageskennzahlen**, und bisher übernimmt der Import aus der Bulk-Datei nur Struktur, Gebote, Budgets und die
> Suchbegriff-Blätter. Die Kennzahlen-Spalten der Kampagnen-Blätter (`Impressions`, `Clicks`, `Spend`, `Sales`, `Orders`,
> `Units`, SD zusätzlich `Viewable Impressions` und „(Views & Clicks)“) werden bisher ignoriert. Geschrieben wird wie in
> Phase 3 und 4 über Warenkorb, Übermittlung und Bulk-Datei, die Dominik von Hand hochlädt. Stündliche Daten gibt es
> nicht (bräuchten API und Amazon Marketing Stream).
>
> **Was daraus folgt:** Phase 5 baut die Automatik so, dass sie auf **Zeitraumsummen** rechnet (F1) und alles, was sie
> ändern will, als **Vorschlag** ablegt (F3): im Schattenmodus nur im Protokoll, freigeschaltet im Warenkorb. Der Takt ist
> „täglich, aber nur bei neuen Daten“: Der Lauf startet nach jedem Import und einmal am Tag, und er tut nichts, wenn seit
> dem letzten Lauf keine neuen Daten kamen. Kommt später die API (Tageswerte, direkte Writes), tauscht nur die Datenquelle
> (Tageswerte summiert statt Zeitraumsummen); Engine, Leitplanken und Oberfläche bleiben.

## Ziel

Die Agentur lässt ProfitBash Gebote und Budgets überwachen und Vorschläge machen, ohne die Kontrolle abzugeben:
- **Ziele** je Client (vorgezogen aus Phase 6, F4): Ziel-ACoS bzw. -ROAS, auch je Profil und Produktgruppe, mit Rechner.
- **Optimizer und Regeln** als Pipeline mit harten **Leitplanken** (höchste Änderung je Woche, Gebotsboden, Mindestdaten;
  Defaults je Organisation, je Client überschreibbar, F-S6) und **Schattenmodus** je Client.
- **Budget-Caps** je Profil und Monat mit **Pacing** (Ist, Soll, Prognose) und einem **Enforcer**, der meldet und
  Vorschläge in den Warenkorb legt (F5, F6).
- **Prüfungen „kein Geld verbrennen“** (Ideen-Dokument E), soweit die Bulk-Datei die Daten liefert.
- **Graduation- und Preset-Vorschläge** aus den Kanten des Struktur-Katalogs (Phase 4), nie automatisch.
- **Benachrichtigungen** in der App, live per SSE (F8).

Navigation (`plan.md` §3): „Budgets“ (`/ads/budgets`, Feature `budgets`), „Automationen & Regeln“ (`/ads/automations`,
Feature `automations`), „Ziele“ (`/ads/goals`, Feature `goals`, vorgezogen), „Benachrichtigungen“ (`/notifications`, alle).
Schreiben nur mit Recht `write` (Admin, Editor); Leitplanken-Defaults der Organisation nur Admins (wie Katalog, `phase-4.md` F11).

## Definition of Done

- [ ] Nichts geht automatisch an Amazon: Jede Änderung der Automatik ist ein Vorschlag (Schattenmodus: nur Protokoll;
      freigeschaltet: Warenkorb mit Herkunft `automation` bzw. `budget_cap`), übermittelt wird wie in Phase 3 von Hand.
- [ ] Jeder Lauf der Pipeline läuft über `runJob` und schreibt `job_runs`; je Lauf steht fest, auf welchen Daten (Datei,
      Zeitraum) er gerechnet hat, welche Regel bzw. welcher Optimizer-Schritt je Vorschlag gegriffen hat und welche
      Leitplanke ihn begrenzt hat. Läufe ohne neue Daten tun nichts (idempotent je Datenstand).
- [ ] Optimizer, Regeln, Leitplanken, Pacing, Prüfungen und Graduation-Kriterien liegen in `packages/engine` ohne I/O, mit
      Tests je Leitplanke, je Regelart und je Prüfung; Beträge nur mit `decimal.js`.
- [ ] Ziele, Leitplanken, Regeln, Schwellen der Prüfungen und Caps sind **Daten** der Organisation (mit eigenen
      Startwerten, änderbar), nichts davon ist hart codiert und nichts 1:1 aus Drittprodukten übernommen.
- [ ] Leitplanken halten in jedem Fall: Kein Vorschlag ändert ein Gebot stärker als erlaubt je 7 Tage (gezählt über alle
      Änderungen dieses Targets über ProfitBash in dem Fenster, auch von Hand gelegte), unterschreitet den Boden oder überschreitet die Grenzen
      von Amazon (`limits`, Phase 3); zu wenig Daten heißt kein Vorschlag.
- [ ] Pacing kennzeichnet geschätzte Werte (Zeitraumsummen anteilig, „≈“), exakte nur aus Tageswerten.
- [ ] Benachrichtigungen erreichen alle berechtigten Mitglieder live (SSE) und nach einem Neuladen; ein fehlender
      SSE-Kanal legt keine Seite lahm.
- [ ] Beträge bleiben Decimal-Strings mit Währung; Amazon-IDs Strings.
- [ ] Alle Zugriffe über den Access-Layer (ADR 002); Test je Endpunkt (fremde Organisation, ausgeblendetes Profil, Recht `write`).
- [ ] Jede schreibende Aktion erzeugt ein `audit_event` (Einstellungen, Regeln, Ziele, Caps, Freischalten, Annehmen und
      Verwerfen von Vorschlägen).
- [ ] Tests gegen den Mock-Anbieter bzw. synthetische Bulk-Dateien, keiner gegen echte Amazon-Endpunkte.
- [ ] Browser-Pane geprüft wie in Phase 2–4 (1440 px, Tablet, Handy, Hell/Dunkel, Konsole).
- [ ] `pnpm test`, `typecheck`, `lint`, `build`, beide Smoke-Tests und CI grün.

## Fragen an Dominik

Gestellt zu Beginn der Planung (2026-10-10), jede mit Empfehlung.

- **F1 – Woher kommen die Kennzahlen?** Empfehlung: aus der Bulk-Datei, die Dominik ohnehin lädt (Summen über den Zeitraum
  der Datei je Kampagne, Ad Group, Target, Product Ad). Alternativen: zusätzlich Tagesberichte (1.11e wieder aufnehmen) oder
  Phase 5 nur gegen Demo-Daten.
  **Entschieden (Dominik, 2026-10-10): aus der Bulk-Datei, wie empfohlen.**
- **F2 – Zeitraum des wöchentlichen Downloads.** Empfehlung: letzte 30 Tage (genug Daten für den Optimizer; die
  Monatsausgaben fürs Pacing werden anteilig geschätzt und mit „≈“ gekennzeichnet). Alternativen: Monatsanfang bis gestern
  (exakt, aber am Monatsanfang wenig Daten) oder beide Dateien.
  **Entschieden (Dominik, 2026-10-10): letzte 30 Tage, wie empfohlen.** ProfitBash nimmt trotzdem jeden Zeitraum an
  (die vorhandenen Dateien haben 9 bis 60 Tage) und rechnet mit dem, was die neueste Datei abdeckt.
- **F3 – Wie weit darf der Optimizer gehen?** Empfehlung: neue Clients starten im Schattenmodus (rechnet und protokolliert);
  je Client auf „Vorschläge in den Warenkorb“ umschaltbar, übermittelt wird von Hand. Ob mit der API automatisch übermittelt
  wird, entscheiden wir, wenn die API da ist.
  **Entschieden (Dominik, 2026-10-10): Schatten, dann Warenkorb, wie empfohlen.**
- **F4 – Ziel für den Optimizer.** Empfehlung: einfache Einstellung Ziel-ACoS je Client unter „Automationen“, Seite „Ziele“
  bleibt in Phase 6.
  **Entschieden (Dominik, 2026-10-10): die Seite „Ziele“ aus Phase 6 vorziehen** (abweichend von der Empfehlung). Umfang
  in 5.3: Ziel-ACoS bzw. -ROAS je Client, Profil und Produktgruppe mit Rechner; TACoS nur als Hinweis „braucht
  Umsatzdaten (Phase 7)“. `plan.md` ist angepasst.
- **F5 – Wofür gilt ein Budget-Cap?** Empfehlung: je Profil und Monat in der Währung des Profils, für das ganze Profil oder
  eine Auswahl (Portfolio, Tag).
  **Entschieden (Dominik, 2026-10-10): je Profil und Monat, wie empfohlen.**
- **F6 – Was tut der Enforcer?** Empfehlung: Benachrichtigung und Vorschläge im Warenkorb (Tagesbudgets senken, bei
  erreichtem Cap pausieren); Dominik übermittelt. Alternative: zusätzlich das Monatslimit als Portfolio-Budget bei Amazon.
  **Entschieden (Dominik, 2026-10-10): melden und Vorschlag, wie empfohlen.**
- **F7 – Dayparting.** Ohne stündliche Daten weiß ProfitBash nicht, welche Stunden gut laufen. Amazon bietet
  Budgetregeln nach Tageszeit (Budget zu bestimmten Stunden **erhöhen**); die echte Bulk-Datei vom 2026-10-07 hat dafür ein
  Blatt „Budget Rules“ (Wochentage, `Intraday Schedule Start Time`/`End Time`, `Budget Rule Increase By …`), laut Amazons
  Ankündigung vom 30.11.2023 aber nur in USA, Kanada, UK, Indien und Japan. Empfehlung: verschieben.
  **Entschieden (Dominik, 2026-10-10): verschieben, bis API und stündliche Daten da sind.** `plan.md` ist angepasst.
- **F8 – Kanal für Benachrichtigungen.** Empfehlung: nur in der App (Glocke, Liste, live per SSE), kein externer Dienst.
  **Entschieden (Dominik, 2026-10-10): nur in der App, wie empfohlen.**

## Aufgaben (nach F1–F8, 2026-10-10; nach dem Review des Plans überarbeitet)

**Begriffe:** Ein **Lauf** ist eine Ausführung der Pipeline für ein Profil. Ein **Vorschlag** ist eine gewünschte
Änderung (Gebot, Budget, Zustand) mit Begründung; im **Schattenmodus** bleibt er im Protokoll, im Modus **Warenkorb**
wird er eine ausstehende Änderung (`ad_changes`) mit Herkunft `automation` bzw. `budget_cap`. Eine **Leitplanke** begrenzt
jeden Vorschlag, egal woher er kommt. Der **Datenstand** einer Entity ist die zuletzt hochgeladene Datei, die Kennzahlen
für sie enthält (Teil-Exporte und Dateien ohne Leistungsdaten lassen den Stand der übrigen Entities stehen); der Lauf
eines Profils startet, wenn eine Datei mit Kennzahlen dazukommt.

**Festlegungen aus dem Review des Plans (Claude, 2026-10-10; Dominik kann widersprechen):**
- **Wem gehören Vorschläge im Warenkorb?** Der Warenkorb gehört heute je einem Nutzer (`ad_changes.created_by`,
  `submitAdChanges` übermittelt nur die eigenen Zeilen). Im Modus `cart` landen Vorschläge deshalb im Warenkorb eines
  **zuständigen Nutzers je Client** (Einstellung in 5.4; vorbelegt mit dem, der den Modus einschaltet). Die Automatik
  ersetzt nur ihre eigenen offenen Zeilen (Herkunft `automation`/`budget_cap`), nie von Hand gelegte; liegt für ein
  Target schon eine händische Änderung im Warenkorb, gibt es keinen Vorschlag. Aus der Vorschlagsliste kann jeder mit
  `write` einzelne Vorschläge in den eigenen Warenkorb übernehmen.
- **Profile ohne Client** (`client_id` leer): Defaults der Organisation, Modus `shadow`, Ziel nur über Profil oder
  Produktgruppe.
- **Mehrere Ziele für ein Target** (ASIN in mehreren Produktgruppen, Anzeige mit mehreren ASINs): Es gilt das strengste
  Ziel (niedrigster ACoS); SB und SD ohne eindeutige ASIN nehmen das Ziel des Profils bzw. Clients.
- **Basis für Leitplanken:** Ausgangsgebot ist der neueste Wert aus offenen, übermittelten und angewendeten Änderungen,
  sonst der Wert der Entity. Die Grenze „je 7 Tage“ zählt Änderungen **über ProfitBash**; Änderungen in der Konsole
  sieht ProfitBash erst als neuen Stand beim nächsten Import (ohne Datum).

### 5.1 Kennzahlen aus der Bulk-Datei (`packages/db`, `apps/worker`)
- [x] Tabelle für Zeitraumsummen je Ebene (Kampagne, Ad Group, Target, Product Ad, **Platzierung**): Profil, Ad-Typ,
      Ebene, Kampagne, Amazon-ID (bei Platzierungen die Platzierung), Zeitraum, Kennzahlen (Impressions, Klicks, Ausgaben,
      Umsatz, Bestellungen, Einheiten; SD zusätzlich sichtbare Impressions und „Views & Clicks“ getrennt), Datei-Import.
      Ersetzt wird **je Profil, Ad-Typ und Zeitraum** wie bei den Suchbegriffen (`replaceSearchTermPeriodMetrics`): ganze
      Datei → der Zeitraum, Teil-Export → nur die Kampagnen der Datei; andere Zeiträume bleiben stehen.
- [x] Importer: Kennzahlen-Spalten der Blätter SP, SB (beide) und SD lesen, Deutsch und Englisch; abgeleitete Spalten (CTR,
      ACoS, CPC, ROAS) nicht übernehmen. Datei ohne Zeitraum (umbenannt, keiner angegeben) → keine Kennzahlen, Zähler wie
      `searchTermsWithoutPeriod`; Datei ohne Leistungsdaten schreibt nichts. Kommentar zu `COLUMN_ALIASES` anpassen.
- [x] Lesefunktionen: Datenstand je Entity (neueste Datei mit dieser Entity) und je Profil (zuletzt hochgeladene Datei mit
      Kennzahlen, Auslöser des Laufs); Rückgabe mit Zeitraum und Herkunft (`file`, später `daily`).
- **Befund (2026-10-10, echte Datei, nur Struktur gezählt):** Alle Zeilen der SP-Blätter tragen Kennzahlen, auch
  „Bidding Adjustment“ (je Platzierung, die Summe ist nicht immer die der Kampagne); Ad Groups und Targets summieren sich
  zur Kampagne. Attribution laut Doku nicht in den Spaltennamen; **Annahme:** Standards der Konsole (SP 7 Tage bei
  Sellern, 14 bei Vendoren; SB und SD 14 Tage), in `plan.md` §5 festhalten.
- [x] Umsetzung (2026-10-10, Stand für 5.2 und später):
  - **Tabelle** `amazon_ads_entity_period_metrics` (Migration `0036_entity_period_metrics`): Ebene `campaign` | `adGroup` |
    `target` | `productAd` | `placement`, Kampagne und Entity als Amazon-ID (Platzierung in API-Schreibweise, z. B.
    `PLACEMENT_TOP`), Zeitraum, Kennzahlen, SD-Spalten mit Views getrennt (`*_views_clicks`, `viewable_impressions`). Keine
    Fremdschlüssel auf die Entities (wie die Suchbegriff-Summen).
  - **`packages/db/src/entity-period-metrics.ts`:** `replaceEntityPeriodMetrics` (wie `replaceSearchTermPeriodMetrics`),
    `listLatestEntityPeriodMetrics` (Datenstand je Entity: je Ad-Typ, Kampagne und Entity die zuletzt hochgeladene Datei,
    die sie enthält), `findProfileMetricsState` (zuletzt hochgeladene Datei mit Kennzahlen, Auslöser des Laufs in 5.7),
    `listEntityPeriodMetrics` (ein Zeitraum). Systemzugriff, an Organisation und Profil gebunden.
  - **Importer** (`apps/worker/src/file-import/bulk-metrics.ts`, eingebunden in `bulk.ts`): Kennzahlen nur, wenn das Blatt alle
    Pflichtspalten hat (Impressions, Klicks, Ausgaben, Verkäufe, Bestellungen, Einheiten); Zeilen mit leeren Kennzahlen
    schreiben nichts, Nullen schon (sonst gälte für die Entity der Stand einer älteren Datei). Negatives haben keine Ebene.
    Die SD-Spalten „(Views & Clicks)“ werden am Zusatz erkannt, weil `normalizeHeader` Klammerzusätze abschneidet. SB/SD-Zeilen
    ohne Kampagnen-ID bekommen die Kampagne über Target bzw. Anzeige der Datei. Eine ungültige Kennzahl verwirft nur die
    Kennzahlen der Zeile (`invalidEntityMetricRows`). Zähler `entityMetrics`, `entityMetricsWithoutPeriod` (im Verlauf der
    Uploads angezeigt).
  - **Nicht gebaut:** die Oberfläche für „Daten bis“ bzw. veraltete Daten (kommt mit 5.2a, Quelle `file_imports`).
  - **Nach dem Review (2026-10-10):** Eine Kopfzeile mit nur einem Teil der Kennzahlen-Spalten wird geloggt
    (`bulk_import.metric_sheet_incomplete` mit den fehlenden Spalten), statt still wie „Leistungsdaten abgewählt“ zu
    wirken; Kennzahlen einer fremd wirkenden Datei werden geloggt verworfen (`entity_metrics_skipped_unmatched`), Zeilen
    ohne auflösbare Kampagne gezählt (`entity_metrics_unresolved`), ungültige Kennzahlen-Zeilen mit eigenem Log-Budget und
    Summe. Index `…_latest_idx` für den Datenstand je Entity.
  - **Offen für 5.4 ff.:**
    - Der Datenstand folgt dem Upload (`imported_at`), nicht dem jüngsten Zeitraum: Wird nachträglich eine ältere Datei
      hochgeladen, rechnet die Automatik darauf. 5.7 warnt, wenn der neue Zeitraum vor dem bisherigen endet.
    - Entities, die in einer neueren vollständigen Datei fehlen (archiviert, herausgefiltert), behalten die Summen der
      älteren Datei als Datenstand. Wer liest, vergleicht `period_end` mit `findProfileMetricsState`.
    - Unbekannte Platzierungstexte landen unverändert als Entity-ID (`SITE_AMAZON_BUSINESS` ist ungeprüft); beim ersten
      echten Upload prüfen.
    - Die Tabelle wächst je Wochendatei; Aufräumen alter Zeiträume (z. B. je Profil nur die neuesten Dateien) mit 5.12.
    - Deutsche Zusätze der SD-Spalten („(Aufrufe und Klicks)“, „Sichtbare Impressions“) und die Kennzahlen-Spalten der
      SB-Blätter sind ungeprüft; fehlen sie, meldet der Import das (siehe oben).

### 5.2a Benachrichtigungen: Daten, Versand, Quellen (`packages/db`, `apps/api`, `apps/worker`)
- [x] Tabellen: Benachrichtigung (Organisation, optional Profil, Art, Schwere, i18n-Parameter, Link, Erzeugt, Schlüssel
      gegen Dubletten), Lesestatus je Nutzer. Sichtbar nur für Mitglieder, die das Profil sehen (Access-Layer).
- [x] Erzeugen in der Transaktion des Auslösers, dazu Postgres `NOTIFY`; die API hört mit `LISTEN` und schiebt per SSE
      (`/api/notifications/stream`) an verbundene Clients, auch wenn Worker und API getrennt laufen (`WORKER_MODE`);
      Heartbeat, Wiederaufnahme über `Last-Event-ID`. API: Liste, ungelesen zählen, gelesen setzen.
- [x] Quellen: Datei-Import fertig bzw. fehlgeschlagen, Übermittlung abgeschlossen bzw. mit Fehlern, keine Bulk-Datei seit
      8 Tagen (aus `file_imports`, einmal je Profil und Woche), Ablauf der Amazon-Einwilligung (30/14/3 Tage vorher; nur mit
      Mock prüfbar, es gibt keine echten Connections). Aufräumen gelesener Einträge nach 90 Tagen.
- **Empfänger (Dominik, 2026-10-10):** Import und Übermittlung an den Auslöser (Uploader bzw. wer übermittelt hat),
  Fehler zusätzlich an alle Org-Admins; „keine Bulk-Datei“ an alle, die das Profil sehen; Einwilligung nur an Org-Admins.
- [x] Umsetzung (2026-10-10, Stand für 5.2b und später):
  - **Tabellen** `notifications` und `notification_reads` (Migration `0037_notifications`): `seq` (Identity) für
    Reihenfolge, Seiten und `Last-Event-ID`; `audience` `members` | `admins` | `recipient` mit `recipient_user_id`;
    `kind` als Text (`NOTIFICATION_KINDS` in `packages/shared/src/notifications.ts`), `params` als JSON für die i18n-Texte,
    `dedupe_key` eindeutig je Organisation. Profil und Connection mit zusammengesetzten Fremdschlüsseln (`ON DELETE
    CASCADE`).
  - **`packages/db/src/notifications.ts`:** `createNotification` (Insert mit `ON CONFLICT DO NOTHING`, dann
    `pg_notify('profitbash_notifications', {id, organizationId})`, kommt erst nach dem Commit an), Sichtbarkeit:
    Profil über `visibleProfilesScope` (Admins auch ausgeblendete), ohne Profil alle Mitglieder; dazu `audience`.
    `listNotifications` (neueste zuerst, Filter ungelesen/Art/Profil, Seiten über `before`), `countUnreadNotifications`,
    `markNotificationsRead` (IDs oder alle, unsichtbare übergangen, Audit `notification.read` nur bei Änderung),
    `listNotificationsAfter` (Wiederaufnahme), `cleanupNotifications` (gelesene nach 90, alle nach 365 Tagen).
  - **Quellen:** `closeFileImport` (auch beim Aufgeben einer Datei) und `closeAdChangeSubmission` (Übergang auf
    abgeschlossen; „mit Fehlern“, wenn die Übermittlung scheitert oder eine Änderung `failed` ist) erzeugen die Meldung
    in ihrer Transaktion; händisches Abschließen einer Bulk-Übermittlung und ein sofort abgeschlossenes Setup ohne
    anlegbare Kampagnen melden nichts (`notify: false`). `notification-sources.ts`: `notifyStaleBulkFiles` (Datei-Profile
    ohne Connection, nicht entfernt oder ausgeblendet; Stand = Upload der letzten importierten Bulk-Datei, sonst Anlage
    des Profils; Schlüssel je angefangener Woche ab Tag 8) und `notifyExpiringConsents` (Stufe 30/14/3 im Schlüssel,
    3 Tage als Fehler).
  - **Job** `notifications-check` täglich 07:00 Berlin (plattformweit, nicht im Sync-Status): erst aufräumen, dann die
    zeitgesteuerten Quellen.
  - **API** (`routes/notifications.ts`, alle Mitglieder): `GET /notifications`, `GET /notifications/unread-count`,
    `POST /notifications/read`, `GET /notifications/stream` (SSE: Ereignisse `ready` mit `retry`, `notification` mit
    `id` = `seq`, `ping` als Heartbeat alle 25 s, `resync` nach Unterbrechung des LISTEN oder wenn mehr als 100 nachzuholen
    wären). `NotificationHub` (`notification-hub.ts`) hält eine eigene `LISTEN`-Verbindung auf `DATABASE_URL_DIRECT` und
    prüft je Ereignis für jeden Abonnenten der Organisation die Sichtbarkeit; beim Herunterfahren schließt er die
    offenen Kanäle. Ohne Hub antwortet der Kanal mit 503.
  - **Offen für 5.2b:** Der Client erkennt Doppelte an `seq` (erst abonnieren, dann nachholen) und lädt bei `resync`
    Liste und Zähler neu. Eine Nummer, die vor einer kleineren committet, kann bei der Wiederaufnahme fehlen (seltene
    Überholung paralleler Transaktionen); die Liste beim Öffnen der Glocke gleicht das aus.
  - **Offen für später:** SSE hinter dem Proxy von Railway prüfen (siehe unten); Benachrichtigungen neuer Quellen
    (Vorschläge 5.7, Caps 5.9b, Prüfungen 5.10) über `createNotification` mit eigenem `kind`.

### 5.2b Benachrichtigungen: Oberfläche
- [ ] Glocke mit Zähler im Kopf (SSE-Client, ohne SSE Abfrage beim Fokus), Seite `/notifications` (Liste, Filter
      ungelesen/Art/Profil, alle gelesen), Loading, Empty, Error.

### 5.3 Ziele (`/ads/goals`, vorgezogen aus Phase 6, F4)
- [ ] Tabelle Ziele: Organisation, Client, optional Profil oder Produktgruppe; Kennzahl `acos` oder `roas` (eins aus dem
      anderen gerechnet), Wert als Decimal-String. Vorrang: Produktgruppe vor Profil vor Client; Gleichstand siehe oben.
- [ ] Engine: wirksames Ziel je Target bzw. Kampagne; Rechner Break-even-ACoS aus Preis, Kosten je Einheit und Gebühren
      (von Hand, nur das übernommene Ziel wird gespeichert), Ziel-ACoS = Break-even minus gewünschte Marge.
- [ ] API hinter `requireFeature('goals', …)`, Seite mit Liste je Client, Bearbeiten, Rechner im Dialog; TACoS und Wachstum
      als Hinweis „braucht Umsatzdaten (Phase 7)“. Navigation (`phase: 6` → 5) und Platzhaltertext anpassen.

### 5.4 Leitplanken und Automations-Einstellungen (`packages/shared`, `packages/db`, `apps/api`, `apps/web`)
- [ ] Einstellungen je Organisation mit eigenen Startwerten, je Client überschreibbar (F-S6): höchste Gebotsänderung je
      7 Tage (%), Gebotsboden (% des CPC und absolut), höchstes Gebot, Mindestdaten für einen Vorschlag (Klicks,
      Ausgaben), höchste Budgetsenkung je Lauf (%), Modus je Client `off` | `shadow` | `cart` (Start `shadow`, F3),
      zuständiger Nutzer für `cart`.
- [ ] zod-Schemas in `packages/shared`, Speicherung mit Audit; Defaults der Organisation nur Admins, Werte je Client
      Admins und Editoren.
- [ ] Engine: Leitplanken als reine Funktionen für Gebote und Budgets (Basis siehe oben) → begrenzter Wert und Grund;
      Tests je Leitplanke, auch zusammen mit den Grenzen von Amazon (`limitFor`).
- [ ] Seitengerüst `/ads/automations` mit dem Tab „Einstellungen“ (weitere Tabs folgen in 5.6b, 5.8, 5.10).

### 5.5 Optimizer (`packages/engine`, ohne I/O)
- [ ] Gebotsvorschlag je Target (SP zuerst, SB und SD danach, vCPM-Gebote ausgenommen, `plan.md` §5) aus Zeitraumsummen
      und wirksamem Ziel: Wert je Klick, bei wenigen Klicks geglättet gegen die Ebene darüber (Ad Group, dann Kampagne);
      Zielgebot = Wert je Klick × Ziel-ACoS; dann Leitplanken. Eigene Formel und Startwerte, in der Umsetzungsnotiz.
- [ ] Targets ohne eigenes Gebot und Auto-Targets: Vorschlag als eigenes Gebot am Target.
- [ ] Ausnahmen: geschützte Begriffe (Phase 2b) nicht unter den Boden senken, archivierte und pausierte Entities nie.
- [ ] Tests mit synthetischen Summen: zu wenig Daten, über/unter Ziel, keine Bestellung, Boden, Obergrenze, Währung.

### 5.6a Regeln: Modell, Engine, API
- [ ] Regel = Name, Ebene (Target; Kampagne für Budgets), Bedingungen (Kennzahl im Zeitraum, Vergleich, Wert, auch
      relativ zum Ziel), Aktion (Gebot bzw. Budget ± % oder absolut, setzen, pausieren), Gültigkeit je Client oder für
      alle, abschaltbar. Je Client: **erste passende Regel gewinnt**, sonst der Optimizer (Ideen-Dokument F).
- [ ] Startregeln als Daten (eigene Werte), API mit Audit, Vorschau „würde heute für N Entities greifen“.

### 5.6b Regeln: Editor
- [ ] Tab „Regeln“ auf `/ads/automations`: Liste mit Reihenfolge, Bearbeiten, Vorschau.

### 5.7 Pipeline (`apps/worker`, `packages/db`)
- [ ] Job `automation-run` je Profil über `runJob`: nach jedem Import mit Kennzahlen und täglich per Cron; ohne neue
      Kennzahlen und ohne geänderte Regeln, Ziele oder Einstellungen tut er nichts.
- [ ] Ablauf: Datenstand → Regeln → Optimizer → Leitplanken → Lauf und Vorschläge speichern (Regel bzw. Optimizer-Schritt,
      vorher/nachher, Begründung, begrenzt durch). Modus `cart`: Warenkorb des zuständigen Nutzers (siehe oben),
      `ad_changes.origin` und `AD_CHANGE_ORIGINS` um `automation` und `budget_cap` erweitern, eigener Schutz gegen doppelte
      offene Automatik-Zeilen. Benachrichtigung „N neue Vorschläge“.
- [ ] ADR 006: Automatik ohne API (Zeitraumsummen, Datenstand als Takt, Vorschläge statt Writes, Warenkorb-Zuordnung,
      Weg zur API).

### 5.8 Automationen: Läufe und Vorschläge
- [ ] Tabs **Läufe** (je Profil, Datenstand, Anzahl Vorschläge, Status) und **Vorschläge** (Grid: Entity, vorher, nachher,
      Regel/Optimizer, Leitplanke, Kennzahlen; „in meinen Warenkorb“ einzeln oder markiert, verwerfen).

### 5.9a Budgets: Caps und Pacing (`/ads/budgets`)
- [ ] Tabelle Caps: Profil, Monat (einmalig oder jeden Monat), Betrag in der Währung des Profils, Umfang (ganzes Profil,
      Portfolios oder Tags), Warnschwellen.
- [ ] Engine Pacing: Ist im Monat (Tageswerte exakt; Zeitraumsummen anteilig, „≈“, mit unterer und oberer Schätzung), Soll
      linear, Prognose zum Monatsende; Tests für Monatswechsel, Datei über zwei Monate, Zeitzone des Profils.
- [ ] Seite: Caps je Profil, Balken Ist/Soll/Prognose, Datenstand, Kampagnen im Umfang.

### 5.9b Budgets: Enforcer (nach 5.7)
- [ ] Im Lauf: Prognose über Cap → Benachrichtigung und Vorschlag „Tagesbudgets anteilig senken“ (Herkunft `budget_cap`,
      Budget-Leitplanke, Grenzen von Amazon); „pausieren“ nur, wenn schon die untere Schätzung über dem Cap liegt, mit
      Hinweis auf den Datenstand. Modus wie F3.

### 5.10 Prüfungen „kein Geld verbrennen“ (Ideen-Dokument E)
- [ ] Prüfungen als Daten mit Schwellen je Organisation, Ergebnis je Lauf: aktive vCPM-Kampagnen (nur SD; SB-Blätter haben
      keine Kostenart), Platzierungs-Anpassung über Schwelle bei Platzierungs- bzw. Kampagnen-ACoS über Ziel (Kennzahlen je
      Platzierung aus 5.1), Targets mit Ausgaben über Schwelle ohne Bestellung, Kampagnen ohne Ziel bzw. ohne Cap.
      Off-Amazon: Spalte nur in US-Dateien; einlesen und prüfen, wo vorhanden.
- [ ] Hinweis-Checkliste je Kampagne für Dinge ohne Daten (Sponsored Prompts, SB-vCPM, Off-Amazon außerhalb der USA).
- [ ] Tab „Prüfungen“, Benachrichtigung nur bei neuen Befunden, Befund quittierbar.

### 5.11a Katalog: Kriterien und Zuordnung (Vorarbeit für 5.11b)
- [ ] Graduation-Kanten und Presets im Struktur-Katalog um Kriterien erweitern (Schwellen auf einen Datei-Zeitraum, z. B.
      Bestellungen und ACoS gegen Ziel; Preset-Wechsel nach Kennzahlen der Produktgruppe), mit Migration der gespeicherten
      Kataloge.
- [ ] Zuordnung Kampagne → Baustein speichern: beim Übermitteln eines Setups (Phase 4), für Bestand über das Namensschema
      vorgeschlagen und von Hand bestätigt.

### 5.11b Graduation- und Preset-Vorschläge
- [ ] Graduation: Suchbegriffe (Zeitraumsummen, Phase 2b) in Kampagnen eines Bausteins mit ausgehender Kante, die die
      Kriterien erfüllen, als Vorschlag; Annehmen legt sie wie in 4.6 auf die Merkliste (das Preset der Produktgruppe
      verteilt im Setup), Negativ in der Quelle wie dort.
- [ ] Preset-Wechsel: Kriterien auf die Kennzahlen der Produktgruppe; Annehmen ändert das Preset (Audit), nie automatisch.
- [ ] Abschnitt „Vorschläge“, Benachrichtigung bei neuen Vorschlägen.

### 5.12 Schatten-Auswertung (frühestens nach einigen Wochen mit Daten)
- [ ] Je Client: Vorschläge neben dem, was tatsächlich übermittelt wurde, und Kennzahlen nur aus nicht überlappenden
      Zeiträumen; ausdrücklich als Orientierung ohne Wirkungsnachweis gekennzeichnet. Schalter „Vorschläge in den
      Warenkorb“ an derselben Stelle.

### 5.13 Abschluss
- [ ] Definition of Done prüfen, Browser-Pane, offene Punkte festhalten.

## Offen vor dem Bau (nicht von Dominik zu entscheiden)

- Attribution der Bulk-Kennzahlen gegen eine Datei mit bekannten Konsolen-Werten prüfen, sobald ProfitBash live ist (5.1).
- SSE hinter dem Proxy von Railway (Puffern, Timeouts) beim ersten Deploy prüfen (5.2a).

## Bewusst nicht in Phase 5

- **Dayparting** (F7): erst mit API und stündlichen Daten; Budgetregeln nach Tageszeit über das Blatt „Budget Rules“ nur
  dann, wenn Amazon sie in den Märkten von Muuv anbietet.
- Automatisch übermitteln ohne Rückfrage (F3: Entscheidung mit der API).
- **Zeitraumsummen in Explorer und Dashboard:** Beide lesen weiter Tageswerte; Datei-Profile sehen die Summen nur auf den
  Seiten der Automatik (Vorschläge, Pacing, Prüfungen). Wieder aufnehmen auf Dominiks Wunsch.
- Gebotsänderungen in der Konsole mit Datum erkennen (siehe „Basis für Leitplanken“).
- Organic-Benachrichtigungen und Branded-CPC-Prüfung (brauchen SQP, offen), Preset-Wechsel nach SQP-Band.
- B2B-Prüfung (braucht Business-Report, Phase 7), Reserved Share of Voice (nicht in der Bulk-Datei).
- E-Mail, Slack oder andere Kanäle (F8).
- TACoS-Ziele und Wachstumsziele mit Umsatzdaten (Phase 7); Kundenzugang, Audit-Log-UI (Phase 6).
- Wettbewerber-Liste je Client (F-S9, später).

## Reihenfolge für Claude Code

5.1 → 5.2a → 5.2b → 5.3 → 5.4 → 5.5 → 5.6a → 5.6b → 5.7 → 5.8 → 5.9a → 5.9b → 5.10 → 5.11a → 5.11b → 5.12 → 5.13.
5.2a/b und 5.3 hängen nicht an 5.1 und können vorgezogen werden; 5.5–5.12 brauchen 5.1, 5.9b braucht 5.7. Bis zu drei
Aufgaben je Session (`CLAUDE.md`), nach jedem Schritt Tests grün, Commit, Häkchen und „Umsetzung“-Notiz.
