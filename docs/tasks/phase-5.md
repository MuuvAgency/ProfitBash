# Phase 5 – Automatisieren

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5 inkl. „Kennzahlen je Ad-Typ“),
> `docs/tasks/phase-4.md` (Definition of Done, 4.11 „Offen nach Phase 4“), `docs/tasks/phase-3.md` (3.1, 3.3, 3.4: Warenkorb,
> Übermittlung, Grenzen und Warnungen), `docs/tasks/phase-1.md` (1.11c/d: Datei-Import, 1.11e: entfallen),
> `docs/decisions/` (001–005), `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` (Abschnitte E und F, F-S6),
> `design/DESIGN.md`.
>
> **Status: verfeinert (2026-10-10), Fragen F1–F8 entschieden (die Nummern gelten nur in dieser Datei), Plan nach einem
> unabhängigen Review überarbeitet (Festlegungen unter „Aufgaben“). Fertig: 5.1, 5.2a, 5.2b, 5.3, 5.4, 5.5, 5.6a, 5.6b, 5.7, 5.8, 5.9a, 5.9b, 5.10, 5.11a, 5.11b. Als Nächstes: 5.12 (frühestens nach einigen Wochen mit Daten), dann 5.13.**
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
  - **Nach dem Review (2026-10-10):** Der SSE-Callback räumt in `finally` auf (Abonnent, Heartbeat), auch wenn das
    Nachholen scheitert (Hono ruft `onAbort` nach einem Fehler nicht mehr); Warten über ein Promise statt einer Schleife;
    `subscriberCount()` am Hub; der Fehlertext in den Parametern ist auf 300 Zeichen gekürzt.
  - **Vertrag für 5.2b (Client):** Doppelte an `seq` erkennen (erst abonnieren, dann nachholen) und nach `seq` sortieren
    (die Zustellung läuft je Ereignis parallel); bei `resync` Liste und Zähler neu laden. Der Kanal gilt für die
    Organisation beim Verbinden: nach Wechsel der Organisation und beim Abmelden die `EventSource` schließen bzw. neu
    öffnen. Eine Nummer, die vor einer kleineren committet, kann bei der Wiederaufnahme fehlen (seltene Überholung
    paralleler Transaktionen); Zähler per REST und die Liste beim Öffnen der Glocke gleichen das aus.
  - **Offen (Review, bewusst nicht gebaut):** Ein offener Kanal prüft die Session nicht erneut (nach Abmelden in einem
    anderen Tab liefert er weiter, Sichtbarkeit wird aber je Ereignis geprüft); kein Test für `resync` nach einer
    Unterbrechung des LISTEN und für den Fehlerpfad beim Nachholen (bräuchte eine fehlschlagende Datenbank).
  - **Offen für später:** SSE hinter dem Proxy von Railway prüfen (siehe unten); Benachrichtigungen neuer Quellen
    (Vorschläge 5.7, Caps 5.9b, Prüfungen 5.10) über `createNotification` mit eigenem `kind`.

### 5.2b Benachrichtigungen: Oberfläche
- [x] Glocke mit Zähler im Kopf (SSE-Client, ohne SSE Abfrage beim Fokus), Seite `/notifications` (Liste, Filter
      ungelesen/Art/Profil, alle gelesen), Loading, Empty, Error.
- [x] Umsetzung (2026-10-10):
  - **Live-Kanal** `apps/web/src/notifications/live.ts`: eine `EventSource` je aktiver Organisation (neu bei Wechsel,
    zu beim Abmelden), gestartet in der App-Shell (`useNotificationStream`). Jede neue Nummer, `resync` und eine
    Wiederverbindung laden alles unter dem Query-Schlüssel `notifications` neu (Doppelte aus Live und Nachholen zählen
    einmal; die Reihenfolge kommt aus der neu geladenen Liste). Ohne `EventSource` nur Abfrage beim Fokus: Der Zähler
    lädt bei jedem Fokus des Fensters neu (`refetchOnWindowFocus: 'always'`).
  - **Glocke** (`NotificationBell.vue`) oben in der Sidebar (neben Ein-/Ausklappen) und in der mobilen Kopfzeile: Zahl
    der ungelesenen (ab 100 „99+“, Zahl im `aria-label`), Popover mit den fünf neuesten, „Alle gelesen“, „Alle anzeigen“.
  - **Seite** `/notifications` (`NotificationsPage.vue`): neueste zuerst, „Ältere laden“ (Seiten über `before`), Filter
    Alle/Ungelesen, Art, Profil (die Profile der geladenen Benachrichtigungen; kein eigener Endpunkt), „Alle gelesen“,
    je Eintrag gelesen setzen und „Öffnen“ (setzt gelesen und folgt dem Link). Skeleton, leerer Zustand (eigene Texte für
    Filter), Fehler mit erneutem Versuch. Texte je Art über `notifications.kind.<kind>` (`labels.ts`).
  - **Browser-Pane (2026-10-10):** Live-Zustellung gegen die Dev-DB (Einträge per SQL mit `pg_notify`), Glocke, Popover,
    gelesen setzen, „Öffnen“, 1440 px, Tablet dunkel, Handy hell; Konsole ohne Fehler nach der Anmeldung. Testdaten
    wieder gelöscht.
  - **Nach dem Review (2026-10-10):** Der Kanal öffnet sich nach einem endgültigen Abbruch (Antwort ohne 200, z. B.
    beim Deploy) selbst neu (5 s, verdoppelt bis 60 s), jede (Wieder-)Verbindung lädt Zähler und Liste neu; Filter und
    gemerkte Profile werden beim Wechsel der Organisation zurückgesetzt; in der mobilen Schublade keine zweite Glocke;
    Fehler beim Markieren werden angezeigt; „Alle als gelesen markieren“ bleibt bedienbar, wenn der Zähler fehlt;
    ohne aktive Organisation kein endloses Skeleton; Überschriften h2 (Seite) bzw. h3 (Popover).
  - **Offen:** Kein Test, dass Art- und Profilfilter in der Anfrage landen (Select im Test ohne Styles schwer
    bedienbar), und keiner für die Verdrahtung der `EventSource` in der Shell (jsdom hat keine). Der Profilfilter kennt nur Profile aus schon geladenen Seiten; bei sehr vielen Benachrichtigungen
    ggf. die sichtbaren Profile über einen eigenen Endpunkt laden.

### 5.3 Ziele (`/ads/goals`, vorgezogen aus Phase 6, F4)
- [x] Tabelle Ziele: Organisation, Client, optional Profil oder Produktgruppe; Kennzahl `acos` oder `roas` (eins aus dem
      anderen gerechnet), Wert als Decimal-String. Vorrang: Produktgruppe vor Profil vor Client; Gleichstand siehe oben.
- [x] Engine: wirksames Ziel je Target bzw. Kampagne; Rechner Break-even-ACoS aus Preis, Kosten je Einheit und Gebühren
      (von Hand, nur das übernommene Ziel wird gespeichert), Ziel-ACoS = Break-even minus gewünschte Marge.
- [x] API hinter `requireFeature('goals', …)`, Seite mit Liste je Client, Bearbeiten, Rechner im Dialog; TACoS und Wachstum
      als Hinweis „braucht Umsatzdaten (Phase 7)“. Navigation (`phase: 6` → 5) und Platzhaltertext anpassen.


- [x] Umsetzung (2026-10-10, Stand für 5.4 und später):
  - **Engine** `packages/engine/src/goals.ts`: `goalValues` (ACoS in Prozent ↔ ROAS = 100 / ACoS, gesetzter Wert
    exakt, der andere auf zwei Stellen), `effectiveGoal` (Produktgruppe vor Profil vor Client, bei mehreren Gruppen
    das strengste Ziel), `calculateTargetAcos` (Break-even = (Preis − Kosten − Gebühren) / Preis, Ziel = Break-even −
    Marge, `null`, wenn nichts bleibt). **Shared** `packages/shared/src/goals.ts`: `GOAL_METRICS`, `GOAL_SCOPES`,
    Grenzen (ACoS über 0 bis 100 %, ROAS 1 bis 100, höchstens zwei Nachkommastellen, Komma erlaubt), Schemas.
  - **Tabelle `goals`** (Migration `0038_goals`): genau eins von `client_id` | `profile_id` | `product_group_id`
    (Check `num_nonnulls = 1`), `metric`, `value numeric(5,2)`, `created_by`/`updated_by`; je Objekt höchstens ein Ziel
    (drei Unique-Indizes, NULL zählt nicht, zugleich Ziel des Upserts); zusammengesetzte Fremdschlüssel mit
    `ON DELETE CASCADE`, dafür `product_groups_id_org_uq` ergänzt.
  - **Zugriffe** `packages/db/src/goals.ts`: `getGoalsOverview`, `setGoal` (Upsert, Audit `goal.set` mit
    vorher/nachher), `deleteGoal` (Audit `goal.delete`). Sichtbar heißt: Profil sichtbar, Produktgruppe an einem
    sichtbaren Profil, Client mit mindestens einem sichtbaren Profil; sonst `GoalError` `NOT_FOUND`. Für 5.5/5.7 fehlt
    noch eine Lesefunktion „Ziele eines Profils als `GoalSetting[]`“ für `effectiveGoal` (erst dort bauen).
  - **API** `routes/goals.ts` hinter `requireFeature('goals', …)`: `GET /ads/goals` (`view`), `PUT /ads/goals`
    (`write`), `DELETE /ads/goals/{id}` (`write`), `POST /ads/goals/calculate` (`view`, speichert nichts; auf dem
    Server, weil das Web kein `decimal.js` hat, ADR 003). Fehler `GOAL_NOT_FOUND` (404).
  - **Seite** `GoalsPage.vue`: je Client eine Kachel (Client, Profile, Produktgruppen), „Ohne Client“ getrennt, eigenes
    oder geerbtes Ziel („gilt vom Client/Profil“), Dialog mit Kennzahl, Wert, Vorschau des anderen Werts (nur Anzeige),
    Rechner („Als Ziel übernehmen“), „Ziel entfernen“ ohne Rückfrage (ein Ziel ist sofort wieder gesetzt); Hinweis
    TACoS/Wachstum. Navigation `goals` in Phase 5.
  - **OpenAPI:** `goalSchema.nullable()` machte die Komponente `Goal` selbst nullable; deshalb
    `z.union([goalSchema, z.null()])`.
  - Browser-Pane geprüft (1440 px und Handy, Rechner, Übernehmen, Speichern, Vererbung), Testdaten entfernt.
  - **Review (zwei Reviewer auf demselben Diff):** Enter im Rechner speicherte das Ziel (jetzt: rechnet), abgeleitete
    Werte kaufmännisch gerundet wie die Vorschau (100 / 32 = 3,13), `targetRoas` entfernt (ungenutzt), Rechner je
    Dialog leer, `deleteGoal` ohne Schein-Objekt. Zurückgewiesen: Typen der Engine aus shared importieren (die Engine
    hat kein DOM/Node im tsconfig, die Wurzel von shared braucht beides); eigener Test für das Skeleton.
  - **Entschieden (Dominik, 2026-10-10):** Wer nur eines von mehreren Profilen eines Clients sieht, darf das Ziel des
    Clients setzen; es gilt dann auch für Profile, die er nicht sieht. Verliert ein Client sein letztes sichtbares
    Profil, bleibt sein Ziel gespeichert, ist aber nicht mehr erreichbar.

### 5.4 Leitplanken und Automations-Einstellungen (`packages/shared`, `packages/db`, `apps/api`, `apps/web`)
- [x] Einstellungen je Organisation mit eigenen Startwerten, je Client überschreibbar (F-S6): höchste Gebotsänderung je
      7 Tage (%), Gebotsboden (% des CPC und absolut), höchstes Gebot, Mindestdaten für einen Vorschlag (Klicks,
      Ausgaben), höchste Budgetsenkung je Lauf (%), Modus je Client `off` | `shadow` | `cart` (Start `shadow`, F3),
      zuständiger Nutzer für `cart`.
- [x] zod-Schemas in `packages/shared`, Speicherung mit Audit; Defaults der Organisation nur Admins, Werte je Client
      Admins und Editoren.
- [x] Engine: Leitplanken als reine Funktionen für Gebote und Budgets (Basis siehe oben) → begrenzter Wert und Grund;
      Tests je Leitplanke, auch zusammen mit den Grenzen von Amazon (`limitFor`).
- [x] Seitengerüst `/ads/automations` mit dem Tab „Einstellungen“ (weitere Tabs folgen in 5.6b, 5.8, 5.10).

- [x] Umsetzung (2026-10-10, Stand für 5.5 und später):
  - **Engine** `packages/engine/src/guardrails.ts`: `applyBidGuardrails` (Vorschlag, Ausgangsgebot `base`, Gebot zu
    Beginn der 7 Tage `windowStart`, CPC, Leitplanken, Amazons Grenze → `{ value, limitedBy[] }`), Reihenfolge:
    Wochenrahmen (± % von `windowStart`), dann bei Senkungen der Boden (der höhere aus CPC-Anteil und absolutem Wert),
    bei Erhöhungen das Höchstgebot, runden auf zwei Stellen zur Basis hin, zuletzt Amazons Grenzen. **Eine Leitplanke
    hält einen Vorschlag auf, dreht aber nie einen bestehenden Wert zurück** (liegt die Basis schon außerhalb, ist das
    Ergebnis die Basis, also kein Vorschlag); nur Amazons Grenzen gelten auch gegen die Basis. `applyBudgetGuardrail`
    (Senkung je Lauf höchstens x % der Basis, Erhöhungen begrenzt nur Amazon). `hasMinimumData`: genug Klicks **oder**
    genug Ausgaben; eine Schwelle von 0 schaltet ihr Kriterium ab, beide 0 heißt kein Minimum. Beträge in der Währung
    des Profils: **5.7 rechnet die EUR-Werte vorher um** (`convertAmount`) und liefert `windowStart` aus `ad_changes`.
  - **Shared** `packages/shared/src/automation.ts`: `guardrailsSchema` (Prozente und Klicks als ganze Zahlen, Beträge
    als Decimal-Strings in EUR, Boden und Höchstgebot `null` = keiner), `DEFAULT_GUARDRAILS`, `AUTOMATION_MODES`,
    `guardrailOverridesSchema` (fehlender Schlüssel = erbt), Schemas der API.
  - **Tabellen** (Migration `0039_automation_settings`): `automation_defaults` (ein Dokument je Organisation, ohne
    Zeile die Startwerte) und `client_automation_settings` (Modus, `responsible_user_id`, `overrides`; ohne Zeile
    `shadow`, nichts überschrieben).
  - **Zugriffe** `packages/db/src/automation.ts`: `getAutomationSettings` (Startwerte, sichtbare Clients, Mitglieder
    mit Schreibrecht), `saveGuardrailDefaults` (nur Org-Admins, Audit `automation_defaults.update`),
    `setClientAutomation` (Client mit mindestens einem sichtbaren Profil; im Modus `cart` ohne Angabe ist zuständig,
    wer speichert; zuständig nur Admins und Editoren der Organisation; Audit `client_automation.update`); ohne
    Änderung wird nichts geschrieben. `loadGuardrailDefaults` ohne Rechteprüfung für den Lauf.
  - **API** `routes/automations.ts` hinter `requireFeature('automations', …)`: `GET /ads/automations/settings`
    (`view`), `PUT …/settings/defaults` (`write`, dazu Admin: sonst 403 `AUTOMATION_DEFAULTS_FORBIDDEN`),
    `PUT …/settings/clients/{clientId}` (`write`; 404 `CLIENT_NOT_FOUND`, 400 `AUTOMATION_INVALID_RESPONSIBLE`). Jede
    Änderung antwortet mit dem neuen Stand.
  - **Seite** `AutomationsPage.vue` mit Tab-Gerüst (ein Tab „Einstellungen“): Formular der Organisation (für
    Nicht-Admins gesperrt), Liste der Clients mit Modus, Zuständigem und Zahl der überschriebenen Werte, Dialog je
    Client (leere Felder erben, der Wert der Organisation steht als Platzhalter). `automations/GuardrailFields.vue`
    und `guardrail-form.ts` (Feldtexte ↔ Werte, geprüft mit den Schemas aus shared).
  - Browser-Pane geprüft (1440 px dunkel, Handy hell, Dialog, Speichern beider Formulare, Konsole), Testdaten entfernt.
  - **Review (ponytail-review):** Schwelle 0 bei den Mindestdaten hob das Minimum ganz auf (jetzt: Kriterium aus),
    Speichern ohne Änderung schrieb Audit-Events, Budgets wurden nicht gerundet, „Gespeichert.“ blieb nach neuen
    Eingaben stehen.
  - **Offen für 5.5/5.7:**
    - Wirksame Leitplanken eines Profils (`{ ...Organisation, ...Client }`, Profil ohne Client: nur Organisation,
      Modus `shadow`) und die Umrechnung EUR → Profilwährung baut der Lauf.
    - Der zuständige Nutzer kann sein Schreibrecht verlieren (Rolle geändert, Mitgliedschaft entfernt; gelöschte
      Nutzer leeren die Spalte): Der Lauf prüft das und fällt auf `shadow` zurück, mit Benachrichtigung.
    - Ein Client kann einen Wert der Organisation nicht auf „keiner“ setzen (Boden, Höchstgebot): leer heißt erben.
      Das Schema erlaubt `null`, die Oberfläche bietet es noch nicht an.
    - Gebote und Budgets werden auf zwei Stellen gerundet (`shortcut:` in `guardrails.ts`; JPY bräuchte null).
    - Kein Schutz gegen gleichzeitiges Speichern der Startwerte (letzter gewinnt, `shortcut:` in `automation.ts`).
- **Entschieden (Dominik, 2026-10-10, zu Beginn von 5.4):**
  - **Startwerte „Mittel“:** Gebot höchstens ±25 % je 7 Tage, Boden 50 % des CPC, Höchstgebot 3,00 €, Vorschlag ab
    15 Klicks oder 10 € Ausgaben, Budget höchstens −20 % je Lauf; kein absoluter Boden (es gilt Amazons Mindestgebot).
  - **Absolute Werte in EUR** (absoluter Boden, Höchstgebot, Mindest-Ausgaben); der Lauf (5.7) rechnet mit dem
    EZB-Tageskurs in die Währung des Profils um.
  - **Werte eines Clients** (Leitplanken, Modus; ebenso das Ziel aus 5.3) ändert, wer `write` hat und mindestens ein
    Profil des Clients sieht. Der offene Punkt aus 5.3 ist damit erledigt.
  - **Review:** nur noch `ponytail:ponytail-review` (`CLAUDE.md` angepasst).

### 5.5 Optimizer (`packages/engine`, ohne I/O)
- [x] Gebotsvorschlag je Target (SP zuerst, SB und SD danach, vCPM-Gebote ausgenommen, `plan.md` §5) aus Zeitraumsummen
      und wirksamem Ziel: Wert je Klick, bei wenigen Klicks geglättet gegen die Ebene darüber (Ad Group, dann Kampagne);
      Zielgebot = Wert je Klick × Ziel-ACoS; dann Leitplanken. Eigene Formel und Startwerte, in der Umsetzungsnotiz.
- [x] Targets ohne eigenes Gebot und Auto-Targets: Vorschlag als eigenes Gebot am Target.
- [x] Ausnahmen: geschützte Begriffe (Phase 2b) nicht unter den Boden senken, archivierte und pausierte Entities nie.
- [x] Tests mit synthetischen Summen: zu wenig Daten, über/unter Ziel, keine Bestellung, Boden, Obergrenze, Währung.
- [x] Umsetzung (2026-10-10, Stand für 5.6a und 5.7):
  - **`packages/engine/src/optimizer.ts`, `suggestBid`:** je Target ein Vorschlag (`kind: 'suggestion'` mit `bid`,
    `base`, `hasOwnBid`, `valuePerClick`, `targetBid`, `limitedBy`) oder `kind: 'none'` mit Grund (`inactive`, `vcpm`,
    `noGoal`, `noBase`, `insufficientData`, `unchanged`).
  - **Eigene Formel:** Wert je Klick = (Umsatz + k × Wert je Klick der Ebene darüber) / (Klicks + k); die Ad Group
    wird ebenso gegen die Kampagne geglättet, die Kampagne zählt roh. Zielgebot = Wert je Klick × Ziel-ACoS, danach
    `applyBidGuardrails` (CPC = Ausgaben / Klicks des Targets). **Startwert k = 12 Klicks**
    (`OPTIMIZER_PRIOR_CLICKS`, je Aufruf überschreibbar; noch keine Einstellung in der Oberfläche). Ohne Bestellung
    sinkt der Wert je Klick mit jedem Klick, statt auf null zu fallen; Wochenrahmen und Boden bremsen.
  - **Ohne eigenes Gebot** (auch Auto-Targets): Ausgangsgebot ist das Standardgebot der Ad Group, der Vorschlag setzt
    ein eigenes Gebot am Target (`hasOwnBid: false`). Ohne beides kein Vorschlag (`noBase`).
  - **Ausnahmen:** Target, Ad Group und Kampagne müssen `ENABLED` sein; Kampagnen mit `costType` vCPM bleiben außen vor.
    **Geschützte Begriffe:** Der Boden gilt für jedes Target, der Optimizer senkt also keinen Begriff darunter; eine
    eigene Behandlung geschützter Begriffe gibt es nicht. Regeln mit „pausieren“ oder „setzen“ (5.6a) müssen
    geschützte Begriffe selbst ausnehmen. **Frage an Dominik (kein Blocker):** Sollen geschützte Begriffe strenger
    behandelt werden (z. B. nie senken)?
  - **Für 5.7 (Aufrufer):** `base` und `windowStart` aus `ad_changes`, Leitplanken in die Währung des Profils
    umrechnen, `limit` über `amazonAdsValueLimit`, Ziel über `effectiveGoal` (Lesefunktion „Ziele eines Profils als
    `GoalSetting[]`“ fehlt weiter). Bei SD den Umsatz aus Klicks nehmen, nicht „Views & Clicks“. Reihenfolge SP, dann
    SB und SD ist Sache des Laufs; die Funktion ist für alle gleich. Bei `unchanged` geht verloren, welche Leitplanke
    festgehalten hat; braucht 5.8 das, `limitedBy` dort mitgeben.

### 5.6a Regeln: Modell, Engine, API
- [x] Regel = Name, Ebene (Target; Kampagne für Budgets), Bedingungen (Kennzahl im Zeitraum, Vergleich, Wert, auch
      relativ zum Ziel), Aktion (Gebot bzw. Budget ± % oder absolut, setzen, pausieren), Gültigkeit je Client oder für
      alle, abschaltbar. Je Client: **erste passende Regel gewinnt**, sonst der Optimizer (Ideen-Dokument F).
- [x] Startregeln als Daten (eigene Werte), API mit Audit, Vorschau „würde heute für N Entities greifen“.
- [x] Umsetzung (2026-10-10, Stand für 5.6b und 5.7):
  - **Shared** `packages/shared/src/automation-rules.ts` (auch als Einstiegspunkt `@profitbash/shared/automation-rules`
    für die Engine): Regel = `id`, `name`, `level` (`target` → Gebot, `campaign` → Budget), 1–5 `conditions` (alle
    müssen zutreffen: Kennzahl `impressions` | `clicks` | `spend` | `sales` | `orders` | `acos` | `cpc`, Vergleich
    `gt` | `gte` | `lt` | `lte`, Wert; beim ACoS wahlweise `relativeToGoal` = Prozent des wirksamen Ziels), `action`
    (`changePercent` −100 bis +500, `changeAbsolute`, `set`, `pause`), `clientId` (`null` = alle) und `enabled`.
    Beträge in EUR wie die Leitplanken. Höchstens 50 Regeln. **Startregeln (eigene Werte):** „Viele Klicks ohne
    Bestellung“ (ab 30 Klicks, 0 Bestellungen → Gebot −20 %), „ACoS weit über dem Ziel“ (ab 20 Klicks, ACoS ≥ 150 %
    des Ziels → Gebot −15 %), „Kampagne weit über dem Ziel“ (ab 50 € Ausgaben, ACoS ≥ 200 % des Ziels → Budget −10 %,
    abgeschaltet).
  - **Engine** `packages/engine/src/rules.ts`: `firstMatchingRule(rules, subject)` (Reihenfolge der Liste;
    abgeschaltete, andere Ebenen und Regeln anderer Clients übersprungen; Regeln eines Clients gelten nicht für
    Profile ohne Client) und `ruleProposal(action, current, eurRate)` → gewünschter Wert oder `{ pause: true }`.
    ACoS ohne Umsatz, aber mit Ausgaben liegt über jeder Schwelle; ohne Ausgaben bzw. Klicks gibt es keinen ACoS
    bzw. CPC und die Bedingung passt nicht; ohne Ziel passt „relativ zum Ziel“ nicht. `eurRate` = ein Euro in der
    Währung des Profils.
  - **Tabelle** `automation_rules` (Migration `0040_automation_rules`): eine Liste je Organisation als Dokument mit
    `version`, ohne Zeile die Startregeln (wie der Struktur-Katalog). **Zugriffe**
    `packages/db/src/automation-rules.ts`: `loadAutomationRules` (für den Lauf), `getAutomationRules`,
    `saveAutomationRules` (ganze Liste, `VERSION_CONFLICT`, `UNKNOWN_CLIENT`, Audit `automation_rules.update` mit
    vorher/nachher), `previewAutomationRules`.
  - **API** (Feature `automations`): `GET /ads/automations/rules` (`view`), `PUT /ads/automations/rules` (`write`;
    409 `AUTOMATION_RULES_VERSION_CONFLICT`, 400 `AUTOMATION_RULES_UNKNOWN_CLIENT`), `POST
    /ads/automations/rules/preview` (`view`, speichert nichts; auch für ungespeicherte Listen).
  - **Vorschau:** je Regel die Entities, für die sie als erste greift, über aktive Targets (Target, Ad Group und
    Kampagne `ENABLED`, keine vCPM-Kampagne) und aktive Kampagnen der sichtbaren Profile, mit dem Datenstand je
    Entity; dazu die Zahl der geprüften Targets und Kampagnen. **Vereinfacht (`shortcut:` im Code):** Ziel nur von
    Profil bzw. Client (ohne Produktgruppen), ohne Leitplanken, ohne geschützte Begriffe; Profile ohne EZB-Kurs
    ihrer Währung zählen nicht. Die Vorschau lädt alle Targets der sichtbaren Profile: im Editor (5.6b) nur auf
    Knopfdruck auslösen.
  - **Für 5.7:** Reihenfolge je Entity: Regel (erste passende) → sonst Optimizer → Leitplanken. `pause` und `set`
    bei geschützten Begriffen auslassen; Gebotsregeln nicht auf vCPM; Datenstand älter als die neueste Datei des
    Profils (`findProfileMetricsState`) ausfiltern; `eurRate` und Ziel je Target wie beim Optimizer. Regeln eines
    gelöschten Clients bleiben in der Liste und greifen nie (der Editor sollte sie kennzeichnen).
  - **Nicht nach TDD:** Der API-Test für `GET`/`PUT /rules` entstand zusammen mit der Route (kein Fehlschlag
    vorher gesehen); alle übrigen Tests liefen zuerst rot.

### 5.6b Regeln: Editor
- [x] Tab „Regeln“ auf `/ads/automations`: Liste mit Reihenfolge, Bearbeiten, Vorschau.
- [x] Umsetzung (2026-10-10):
  - **`AutomationsPage.vue`:** zweiter Tab, Pfeiltasten wie im Katalog (`moveTab`); der Tab „Regeln“ liegt in
    `KeepAlive`, damit der ungespeicherte Entwurf den Wechsel des Tabs übersteht.
  - **`automations/RulesTab.vue`:** nummerierte Liste (Name, Bedingungen → Aktion, Ebene, Client), je Regel Schalter
    „Aktiv“, nach oben/unten, bearbeiten, entfernen; Entwurf wie im Katalog (Speichern der ganzen Liste mit der
    gelesenen `version`, 409 → Hinweis und Neuladen, „Verwerfen“ lädt den Stand des Servers, Hinweis bei neuerem
    Stand, Warnung vor dem Schließen des Fensters). Viewer lesen nur. Höchstens 50 Regeln.
  - **`automations/RuleDialog.vue`:** Name, Ebene (Targets → Gebot, Kampagnen → Budget), Client oder alle, 1–5
    Bedingungen (beim ACoS wahlweise in % des Ziels), Aktion mit Wert; Texte mit Komma, geprüft mit
    `automationRuleSchema`; „Übernehmen“ ändert nur den Entwurf.
  - **Vorschau** nur auf Knopfdruck, auch für den ungespeicherten Entwurf und für Viewer; Zähler je Regel und die
    Zahl der geprüften Targets und Kampagnen, mit dem Hinweis auf die Vereinfachungen aus 5.6a. Jede Änderung der
    Liste verwirft das Ergebnis.
  - **Gelöschter Client:** Die Seite kennt nur Clients mit sichtbarem Profil (aus den Einstellungen); Regeln mit
    einem anderen Client heißen „Client gelöscht oder nicht sichtbar“. Der Server lehnt Listen mit einem gelöschten
    Client ab (`AUTOMATION_RULES_UNKNOWN_CLIENT`), der Hinweis sagt: entfernen oder neu zuordnen.
  - **Review (ponytail-review):** Der Entwurf blieb beim Wechsel der Organisation stehen und wäre in der anderen
    gespeichert worden (behoben, Test); `aria-label` an der Platznummer entfernt (die Liste ist ein `ol`). Der
    Struktur-Katalog hat vermutlich denselben Fehler (eigene Aufgabe vorgeschlagen).
  - Browser-Pane geprüft (Desktop dunkel, Handy hell, Dialog, Speichern, Neuladen, Vorschau, Konsole).
  - **Nicht gebaut:** Ziehen mit der Maus (Pfeile reichen), „Startregeln wiederherstellen“, Rückfrage beim
    Entfernen (erst „Regeln speichern“ schreibt), Warnung beim Verlassen der Seite innerhalb der App (wie im Katalog
    nur beim Schließen des Fensters).
  - **Nicht nach TDD im strengen Sinn:** Die Tests standen vor dem Code, liefen aber erst danach zum ersten Mal
    (zwei schlugen an geschützten Leerzeichen fehl); nur der Test zum Wechsel der Organisation lief vorher rot.
- **Entschieden (Dominik, 2026-10-10, zu Beginn der Session; für 5.7 und 5.8):**
  - **Geschützte Begriffe** bleiben wie in 5.5: Der Boden gilt wie für jedes Target, Regeln mit „pausieren“ oder
    „setzen“ lassen sie aus; keine strengere Behandlung.
  - **Benachrichtigung „N neue Vorschläge“** nur im Modus `cart`, an den zuständigen Nutzer; im Schattenmodus keine.
  - **Verworfene Vorschläge** bleiben verworfen, bis eine neue Datei mit Kennzahlen kommt.

### 5.7 Pipeline (`apps/worker`, `packages/db`)
- [x] Job `automation-run` je Profil über `runJob`: nach jedem Import mit Kennzahlen und täglich per Cron; ohne neue
      Kennzahlen und ohne geänderte Regeln, Ziele oder Einstellungen tut er nichts.
- [x] Ablauf: Datenstand → Regeln → Optimizer → Leitplanken → Lauf und Vorschläge speichern (Regel bzw. Optimizer-Schritt,
      vorher/nachher, Begründung, begrenzt durch). Modus `cart`: Warenkorb des zuständigen Nutzers (siehe oben),
      `ad_changes.origin` und `AD_CHANGE_ORIGINS` um `automation` und `budget_cap` erweitern, eigener Schutz gegen doppelte
      offene Automatik-Zeilen. Benachrichtigung „N neue Vorschläge“.
- [x] ADR 006: Automatik ohne API (Zeitraumsummen, Datenstand als Takt, Vorschläge statt Writes, Warenkorb-Zuordnung,
      Weg zur API).
- [x] Umsetzung (2026-10-10, Stand für 5.8 und 5.9b):
  - **Engine** `packages/engine/src/pipeline.ts`: `decideTarget` (erste passende Regel, sonst Optimizer, danach
    Leitplanken; „pausieren“ und „setzen“ nicht für geschützte Begriffe; nichts für inaktive Entities und
    vCPM-Kampagnen) und `decideCampaign` (nur Regeln: Budget mit `applyBudgetGuardrail`, pausieren). Ergebnis: Vorschlag
    (`field` `bid` | `budget` | `state`, vorher/nachher, Herkunft, Regel, `limitedBy`, gewünschter Wert) oder der Grund
    ohne Vorschlag (`inactive`, `vcpm`, `noGoal`, `noBase`, `insufficientData`, `unchanged`, `protectedTerm`, `noRule`).
  - **Tabellen** (Migration `0041_automation_runs`): `automation_runs` (Profil, Modus, Zuständiger, Datenstand,
    `fingerprint`, Zähler, Hinweise) und `automation_proposals` (Entity, Feld, vorher/nachher, Herkunft, Regel mit
    Name zum Zeitpunkt des Laufs, `limited_by`, `detail` mit Kennzahlen und Ziel, Status `open` | `staged` |
    `dismissed` | `superseded`, `ad_change_id`, `resolved_by`/`resolved_at` für 5.8). `ad_changes.origin` und
    `AD_CHANGE_ORIGINS` um `automation` und `budget_cap` erweitert; Index `ad_changes_automation_pending_uq` (je
    Entity und Feld höchstens eine offene Automatik-Zeile).
  - **Zugriffe** `packages/db/src/automation-runs.ts` (Systemzugriff für den Job): `planAutomationRun` (Profil nicht
    entfernt oder ausgeblendet, Modus, Zuständiger mit Schreibrecht, sonst `shadow`; wirksame Leitplanken
    `{...Organisation, ...Client}` in EUR; EZB-Kurs; Regeln; Ziele von Client, Profil und Produktgruppen des Profils
    als `GoalSetting[]`; geschützte Begriffe; Datenstand; `fingerprint`), `loadAutomationRunEntities` (Kampagnen,
    Ad Groups mit Produktgruppen über die ASINs ihrer Anzeigen, Targets mit Kennzahlen des Datenstands;
    händisch gesperrte Entities; Ausgangswert und Wert zu Beginn der 7 Tage aus `ad_changes`), `saveAutomationRun`
    (eine Transaktion: Verworfenes des Datenstands auslassen, eigene offene Warenkorb-Zeilen ersetzen, ältere
    Vorschläge ablösen, Lauf und Vorschläge schreiben, Audit `automation_run.create`, Benachrichtigungen),
    `listAutomationRunProfiles`.
  - **Job** `apps/worker/src/jobs/automation-run.ts`: `runAutomation` (ohne fälligen Lauf `null`, kein `job_runs`),
    `computeAutomationProposals` (rechnet die Leitplanken mit dem Kurs in die Währung des Profils um, Ziel je Target
    über die Produktgruppen der Ad Group, Grenzen über `amazonAdsValueLimit`), `dispatchAutomationRuns`. Queues
    `automation-run` (je Profil, nach jedem Import mit `entityMetrics`) und `automation-run-all` (07:30 Berlin). Der
    Job erscheint im Sync-Status („Automatik-Lauf“).
  - **Benachrichtigungen:** `automation_proposals` (nur Modus `cart`, an den Zuständigen, Link zum Warenkorb) und
    `automation_responsible_missing` (an die Admins, wenn der Zuständige fehlt oder nicht mehr schreiben darf).
  - **Abweichung von „Basis für Leitplanken“ (ADR 006, Punkt 7):** Angewendete Änderungen zählen nur 7 Tage lang als
    Ausgangswert, übermittelte ohne Frist; danach gilt der Wert der Entity (der nächste Import bringt den Stand der
    Konsole). Die Festlegung oben nennt keine Frist; ohne sie überschriebe eine Monate alte Änderung den importierten Stand.
  - **Vereinfacht bzw. nicht gebaut:**
    - Kampagnen nehmen das Ziel von Profil bzw. Client (Produkte mehrerer Gruppen); Targets ohne Ad Group (SB) haben
      keine Produktgruppe und kein Standardgebot.
    - Entities werden über die Amazon-ID den Kennzahlen zugeordnet, ohne Ad-Typ (wie die Vorschau in 5.6a).
    - Eine von Hand gelegte offene Änderung sperrt die ganze Entity, egal welches Feld und in wessen Warenkorb;
      auch im Schattenmodus.
    - Regeln ohne Mindestdaten: Sie tragen ihre Schwellen selbst (`hasMinimumData` gilt nur für den Optimizer).
    - Der Hinweis `olderPeriod` steht am Lauf; eine Benachrichtigung dazu gibt es nicht (Anzeige in 5.8).
    - Die Seite „Änderungen“ zeigt die Herkunft `automation` noch nicht an (5.8).
    - Kein Aufräumen alter Läufe und Vorschläge (mit 5.12).
    - Die Vorschau der Regeln (5.6a) rechnet weiter vereinfacht; sie nutzt den Lauf nicht.
  - **Nicht nach TDD im strengen Sinn:** Engine- und Datenbanktests entstanden direkt nach dem Code (erste Ausführung
    mit je einem Fehlschlag aus falschen Erwartungen); die Tests des Jobs und des Auslösers liefen vorher rot.
  - **Nicht im Browser geprüft:** Der Lauf hat keine eigene Oberfläche (5.8); in der Dev-DB gibt es keine Kennzahlen.
    Die Dev-DB ist auf `0041_automation_runs` zu migrieren (`pnpm db:migrate`).
  - **Für 5.8:** Liste der Läufe aus `automation_runs` (Zähler in `counts`: `targets`, `campaigns`, `proposals`,
    `staged`, `dismissed` und je Grund), Vorschläge aus `automation_proposals`; „in meinen Warenkorb“ legt eine
    `ad_changes`-Zeile mit Herkunft `automation` für den Nutzer an und setzt `staged`; „verwerfen“ setzt `dismissed`
    und löscht eine offene Warenkorb-Zeile. Ein `staged`-Vorschlag ohne `ad_change_id` gilt als verworfen.
  - **Für 5.9b:** Offene Zeilen mit Herkunft `budget_cap` sperren heute die Entity für den Lauf wie händische; der
    Index erlaubt je Kampagne und Feld nur eine Automatik-Zeile. Der Enforcer legt den Vorrang fest.

### 5.8 Automationen: Läufe und Vorschläge
- [x] Tabs **Läufe** (je Profil, Datenstand, Anzahl Vorschläge, Status) und **Vorschläge** (Grid: Entity, vorher, nachher,
      Regel/Optimizer, Leitplanke, Kennzahlen; „in meinen Warenkorb“ einzeln oder markiert, verwerfen).
- [x] Umsetzung (2026-10-10):
  - **Zugriffe** (`packages/db/src/automation-runs.ts`, über `visibleProfilesScope`): `listAutomationRuns` (die letzten
    100 Läufe der sichtbaren Profile), `listAutomationProposals` (je Status `open` | `staged` | `dismissed`, neueste
    zuerst, höchstens 500, dazu `total`; abgelöste erscheinen nie; ein `staged`-Vorschlag ohne Warenkorb-Zeile zählt
    als verworfen), `stageAutomationProposals` (offene Vorschläge als `ad_changes` mit Herkunft `automation` in den
    Warenkorb des Nutzers; liegt dort schon eine Änderung an der Stelle, bleibt der Vorschlag offen; Audit
    `automation_proposals.stage`), `dismissAutomationProposals` (offene und im Warenkorb liegende, die Zeile wird
    gelöscht, auch im Warenkorb eines anderen Nutzers; Übermitteltes bleibt; Audit `automation_proposals.dismiss`).
  - **API** (Feature `automations`): `GET /ads/automations/runs` und `GET /ads/automations/proposals?status=` (`view`),
    `POST /ads/automations/proposals/stage` und `…/dismiss` (`write`, bis zu 500 IDs im Body, Antwort
    `{ changed, skipped }`). Schemas in `packages/shared/src/automation-runs.ts`.
  - **Seite:** Tabs „Vorschläge“ (`automations/ProposalsTab.vue`: Filter nach Status, je Vorschlag Entity mit Pfad und
    Profil, Kennzahlen und Ziel, vorher → nachher, Regel bzw. Optimizer, begrenzende Leitplanken; einzeln oder
    markiert „In meinen Warenkorb“ und „Verwerfen“; danach laden Liste und Warenkorb neu) und „Läufe“
    (`automations/RunsTab.vue`: Profil, Zeitpunkt, Modus, Datenstand, geprüfte Targets und Kampagnen, Vorschläge, im
    Warenkorb, Hinweise `olderPeriod` und `responsibleMissing`). Viewer lesen nur. Skeleton, leere Zustände, Fehler.
  - **Abweichung:** Liste statt Tabellen-Grid (gestapelte Zeilen, kein waagerechtes Scrollen auf dem Handy); ohne
    Sortierung und ohne Filter nach Profil.
  - **Nicht gebaut:** Vorschläge aus dem Warenkorb des Zuständigen in den eigenen umhängen (im Modus `cart` liegen
    sie schon dort; andere können sie nur verwerfen); Rückfrage vor dem Verwerfen; Seiten über die ersten 500
    hinaus; Kennzeichnung der Herkunft „Automatik“ auf der Seite „Änderungen“; die Gründe ohne Vorschlag je Lauf
    (stehen in `counts`, werden noch nicht angezeigt).
  - **Browser-Pane (2026-10-10):** nur Tabs, Filter und leere Zustände geprüft (Desktop dunkel, Handy; kein
    waagerechtes Scrollen). **Nicht mit echten Vorschlägen geprüft:** Die Dev-DB hat keine Kennzahlen, und das
    Aufräumen von Testdaten per psql war in dieser Session gesperrt. Beim ersten echten Import nachholen.
  - **Offen (Aufräumen von Hand):** In der Dev-DB liegt aus der Prüfung von 5.6b eine Zeile in `automation_rules`
    (Version 1, vier Regeln, darunter „Teure Klicks“) und ein Audit-Event `automation_rules.update`.

- **Entschieden (Dominik, 2026-10-11, zu Beginn der Session; für 5.9a, 5.9b und 5.10):**
  - **Caps:** mehrere je Profil, je Umfang einer (ganzes Profil, Portfolios oder Tags); eine Kampagne kann unter
    mehrere fallen, jeder Cap wird einzeln gerechnet und gemeldet. Ein Cap gilt **jeden Monat**; für einzelne Monate
    kann ein abweichender Betrag gesetzt werden, der dort gewinnt.
  - **Warnschwellen:** Startwerte 80 % und 100 % des Caps, gemessen am geschätzten Ist im Monat, je Cap änderbar;
    je Cap, Monat und Schwelle eine Meldung. „Prognose über Cap“ meldet zusätzlich der Enforcer.
  - **Empfänger der Cap-Meldungen:** alle, die das Profil sehen.
  - **Vorrang (5.9b):** Liegt die Prognose eines Caps über dem Betrag, gilt für dessen Kampagnen der Vorschlag des
    Enforcers (Herkunft `budget_cap`), Budget-Regeln ruhen dort; sonst gilt die Regel wie bisher.
  - **Prüfungen (5.10):** Ein quittierter Befund bleibt quittiert, solange er in jedem Lauf wieder auftritt;
    verschwindet er und kommt zurück, ist er neu und wird wieder gemeldet. Startwerte: Platzierungs-Anpassung ab
    +50 % bei ACoS über Ziel, Target mit Ausgaben ab 20 € ohne Bestellung; „ohne Ziel“ und „ohne Cap“ als Hinweis,
    die übrigen als Warnung.
  - **ADR 006, Punkt 7 bestätigt:** Angewendete Änderungen zählen nur 7 Tage als Ausgangswert der Leitplanken.

### 5.9a Budgets: Caps und Pacing (`/ads/budgets`)
- [x] Tabelle Caps: Profil, Monat (einmalig oder jeden Monat), Betrag in der Währung des Profils, Umfang (ganzes Profil,
      Portfolios oder Tags), Warnschwellen.
- [x] Engine Pacing: Ist im Monat (Tageswerte exakt; Zeitraumsummen anteilig, „≈“, mit unterer und oberer Schätzung), Soll
      linear, Prognose zum Monatsende; Tests für Monatswechsel, Datei über zwei Monate, Zeitzone des Profils.
- [x] Seite: Caps je Profil, Balken Ist/Soll/Prognose, Datenstand, Kampagnen im Umfang.
- [x] Umsetzung (2026-10-11, Stand für 5.9b und 5.10):
  - **Engine** `packages/engine/src/pacing.ts`: `computePacing({ month, cap, warnPercents, campaigns })` rechnet je
    Kampagne aus Ausgaben und Zeitraum ihres Datenstands und summiert: `actual`, `forecast` (je `value`, `low`,
    `high`), `planned` (Cap × Tage bis zum Datenstand / Tage des Monats), `exact`, `dataThrough`, `warnLevel`
    (höchste erreichte Schwelle), `forecastOver`. `monthInTimeZone(now, timeZone)` liefert den laufenden Monat des
    Profils. **Eigene Annahmen:** Ragt der Zeitraum über den Monat hinaus, zählt der Anteil nach Tagen („≈“), die
    Spanne ist ± 50 % des kleineren Teils (im Monat oder außerhalb; `PACING_SPREAD`). Die Prognose rechnet nach dem
    Datenstand je aktiver Kampagne den Tagesschnitt ihres Zeitraums fort, höchstens ihr Tagesbudget; pausierte
    geben nichts mehr aus. Die Spanne der Prognose ist die des Ist.
  - **Shared** `packages/shared/src/budgets.ts`: `budgetCapInputSchema` (Profil, Umfang `profile` | `portfolios` |
    `tags` mit internen IDs, Betrag über 0 mit zwei Stellen, `monthAmounts` `JJJJ-MM` → Betrag, bis zu drei
    Warnschwellen 1–100, Start 80 und 100), Schemas der Übersicht. Höchstens 20 Caps je Profil.
  - **Tabelle** `budget_caps` (Migration `0042_budget_caps`): Profil, `scope_type`, `scope_ids` (jsonb, ohne
    Fremdschlüssel: ein gelöschtes Tag fällt aus dem Umfang), `amount`, `month_amounts`, `warn_percents`.
    **„Einmalig“ ist die Ausnahme eines Monats** am Dauer-Cap (Dominik, 2026-10-11); einen Cap, der nur einen
    Monat lang gilt, gibt es nicht.
  - **Zugriffe** `packages/db/src/budget-caps.ts` (über `visibleProfilesScope`): `getBudgetsOverview` (sichtbare
    Profile mit Caps, Pacing im laufenden Monat, Portfolios und Tags für den Umfang, je Cap die 50 Kampagnen mit
    den höchsten Ausgaben), `saveBudgetCap` (anlegen bzw. ändern; Portfolios müssen zum Profil gehören, Tags zur
    Organisation; Audit `budget_cap.create` / `.update` nur bei einer Änderung), `deleteBudgetCap` (Audit
    `budget_cap.delete`). **Kennzahlen:** Tageswerte des Monats (`amazon_ads_campaign_daily_metrics`, Profile mit
    API-Reports bzw. Demo-Daten) zählen exakt und gehen vor; sonst die Summen des Datenstands je Kampagne
    (`listLatestEntityPeriodMetrics`, auch aus älteren Dateien). Entfernte Kampagnen zählen beim Ist mit.
  - **API** (Feature `budgets`): `GET /ads/budgets` (`view`), `POST /ads/budgets/caps`, `PUT` und `DELETE
    /ads/budgets/caps/{id}` (`write`; 404 `BUDGET_CAP_NOT_FOUND`, 400 `BUDGET_CAP_INVALID_SCOPE`, 409
    `BUDGET_CAP_LIMIT_REACHED`).
  - **Seite** `BudgetsPage.vue`: je Profil Monat und Datenstand, je Cap Umfang, Betrag (mit Hinweis auf den
    abweichenden Monat), Balken (Ist, Prognose hell dahinter, Strich fürs Soll), Ist mit „≈“ und Spanne, Soll bis
    zum Datenstand, Prognose, erreichte Warnschwelle, „Prognose über dem Cap“, aufklappbar die Kampagnen im
    Umfang. Dialog: Umfang, Betrag, abweichende Monate, Warnschwellen; geprüft mit dem Schema aus shared. Viewer
    lesen nur. Skeleton, leerer Zustand, Fehler.
  - **Browser-Pane (2026-10-11):** mit den Tageswerten der Demo-Profile geprüft (Cap anlegen, Anzeige mit
    Warnschwelle und Prognose, Kampagnenliste, Dialog, löschen; Desktop dunkel, Handy hell ohne waagerechtes
    Scrollen, Konsole). Der Test-Cap ist wieder gelöscht; in der Dev-DB bleiben zwei Audit-Events
    (`budget_cap.create`, `budget_cap.delete`). Dev-DB migriert bis `0042_budget_caps`.
  - **Review (ponytail-review):** Zeitraum mit Ende vor Anfang ergab `Infinity` (jetzt übersprungen, Test);
    `shortcut:` für die Abfragen je Profil; Platzhalter `JJJJ-MM` am Monatsfeld. Zurückgewiesen: Speichern ohne
    Änderung setzt `updated_at` neu (kein Audit).
  - **Nicht gebaut:** Meldungen zu den Warnschwellen (brauchen den Lauf, kommen mit 5.9b); Rückfrage vor dem
    Löschen; Pacing vergangener oder künftiger Monate; Verlaufskurve (`plan.md` §7); Caps in einer anderen
    Währung als der des Profils. Die Schätzung mit Zeitraumsummen ist nur im Test und nicht im Browser geprüft
    (keine Datei mit Kennzahlen in der Dev-DB).
  - **Nicht nach TDD im strengen Sinn:** Der Test des Schemas in shared lief erst nach dem Schema (sofort grün);
    Engine, Zugriffe, API und Seite liefen vorher rot.
  - **Für 5.9b:** `withPacing` in `budget-caps.ts` rechnet Caps eines Profils samt Kampagnen im Umfang; für den
    Lauf als Systemzugriff herausführen (ohne Sichtbarkeit). `forecastOver` löst den Enforcer aus, `warnLevel`
    die Meldungen; „pausieren“ bei `actual.low` über dem Cap.

### 5.9b Budgets: Enforcer (nach 5.7)
- [x] Im Lauf: Prognose über Cap → Benachrichtigung und Vorschlag „Tagesbudgets anteilig senken“ (Herkunft `budget_cap`,
      Budget-Leitplanke, Grenzen von Amazon); „pausieren“ nur, wenn schon die untere Schätzung über dem Cap liegt, mit
      Hinweis auf den Datenstand. Modus wie F3.
- [x] Umsetzung (2026-10-11, Stand für 5.10):
  - **Engine** `packages/engine/src/cap-enforcer.ts`, `enforceCap({ month, cap, campaigns, maxBudgetDecreasePercent })`:
    Liegt die Prognose über dem Cap, bleibt für die Tage nach dem Datenstand „Cap − Ist“; jede aktive Kampagne mit
    Tagesbudget bekommt denselben Anteil ihres erwarteten Tagesschnitts als neues Budget (eigene Formel), dann
    `applyBudgetGuardrail` (höchste Senkung je Lauf) und Amazons Grenzen. Liegt schon die **untere Schätzung** des
    Ist über dem Cap, schlägt er vor, alle aktiven Kampagnen im Umfang zu pausieren. Kampagnen ohne Ausgaben, ohne
    Tagesbudget oder am Minimum bleiben unberührt. `campaignPacing` (aus `pacing.ts`) liefert Anteil und
    Tagesschnitt je Kampagne.
  - **Plan des Laufs:** `planAutomationRun(db, scope, now)` lädt die Caps des Profils mit Pacing
    (`loadProfileCapPacing` in `budget-caps.ts`, Systemzugriff) nach `plan.caps`. Betrag, Schwellen, Monat und die
    Kampagnen im Umfang stehen im `fingerprint`: Ein geänderter Cap, ein neuer Monat oder ein geänderter Umfang macht
    einen Lauf fällig.
  - **Job** (`computeAutomationProposals`): **Vorrang wie entschieden.** Für Kampagnen unter einem Cap mit Prognose
    über dem Betrag ruhen die Kampagnen-Regeln; es gilt der Vorschlag des Enforcers (bei mehreren Caps der
    strengste: pausieren vor dem niedrigsten Budget), sonst zählt der Lauf `budgetCap`. Ausgangsbudget ist wie bei
    den Regeln der neueste Wert aus übermittelten Änderungen. Eine von Hand gelegte offene Änderung sperrt weiter.
    Die Begründung trägt Cap, Betrag, Währung, Ist, untere Schätzung, Prognose und „Daten bis“.
  - **Speichern:** Vorschläge mit `source = 'budget_cap'` (Migration `0043_proposal_source_budget_cap`) landen im
    Modus `cart` mit Herkunft `budget_cap` im Warenkorb; der Lauf ersetzt seine offenen Zeilen beider Herkünfte, und
    keine davon sperrt die Entity mehr. Auch „In meinen Warenkorb“ behält die Herkunft.
  - **Meldungen** (in der Transaktion des Laufs, an alle, die das Profil sehen, Link `/ads/budgets`):
    `budget_cap_threshold` (je Cap, Monat und Schwelle einmal; ab 100 % als Fehler) und `budget_cap_forecast` (je
    Cap und Monat einmal).
  - **Oberfläche:** Vorschlagsliste mit Herkunft „Budget-Cap“ und der Zeile „Cap · Ist ≈ · Prognose ≈ · Daten bis“;
    Texte der beiden Meldungen; der Warenkorb kennzeichnet Zeilen der Automatik („Vorschlag der Automatik“ bzw.
    „… des Budget-Caps“, offener Punkt aus 5.8).
  - **Review (ponytail-review):** keine Befunde, die eine Änderung brauchten.
  - **Grenzen, bewusst so:**
    - Steht die Automatik eines Clients auf „aus“, läuft nichts, also auch keine Cap-Meldung.
    - Der tägliche Auslöser kennt nur Profile mit Kennzahlen aus einer Datei; Profile, die nur Tageswerte haben
      (heute nur Demo-Daten), bekommen keinen Lauf und damit keine Meldungen.
    - Die Senkung ist je Lauf durch die Leitplanke begrenzt (Start −20 %); reicht das nicht, bleibt die Prognose
      über dem Cap, bis der nächste Lauf fällig ist (neue Datei oder geänderte Einstellungen).
    - Am Monatsanfang ohne Daten im Monat rechnet die Prognose allein mit dem Tagesschnitt der letzten Datei.
  - **Nicht im Browser geprüft:** Für einen Lauf fehlt in der Dev-DB eine Datei mit Kennzahlen (wie 5.8). Die
    Dev-DB ist auf `0043_proposal_source_budget_cap` zu migrieren.
  - **Weiter offen aus 5.8:** Gründe ohne Vorschlag je Lauf anzeigen (stehen in `automation_runs.counts`, jetzt
    auch `budgetCap`).

### 5.10 Prüfungen „kein Geld verbrennen“ (Ideen-Dokument E)
- [x] Prüfungen als Daten mit Schwellen je Organisation, Ergebnis je Lauf: aktive vCPM-Kampagnen (nur SD; SB-Blätter haben
      keine Kostenart), Platzierungs-Anpassung über Schwelle bei Platzierungs- bzw. Kampagnen-ACoS über Ziel (Kennzahlen je
      Platzierung aus 5.1), Targets mit Ausgaben über Schwelle ohne Bestellung, Kampagnen ohne Ziel bzw. ohne Cap.
      Off-Amazon: Spalte nur in US-Dateien; einlesen und prüfen, wo vorhanden.
- [x] Hinweis-Checkliste je Kampagne für Dinge ohne Daten (Sponsored Prompts, SB-vCPM, Off-Amazon außerhalb der USA).
- [x] Tab „Prüfungen“, Benachrichtigung nur bei neuen Befunden, Befund quittierbar.
- [x] Umsetzung (2026-10-11, Stand für 5.11a und später):
  - **Shared** `packages/shared/src/automation-checks.ts` (auch als Einstiegspunkt für die Engine): Arten `vcpm`,
    `placement`, `spendNoOrders` (Warnung) und `noGoal`, `noCap` (Hinweis); `checkSettingsSchema` (je Art an/aus,
    Platzierungs-Anpassung ab x %, Ausgaben ohne Bestellung ab x €). **Startwerte (Dominik, 2026-10-11):** alle an,
    +50 %, 20 €.
  - **Engine** `packages/engine/src/checks.ts`, `runChecks`: aktive vCPM-Kampagnen; je Platzierung mit Anpassung ab
    der Schwelle der ACoS der Platzierung (hat sie keine Ausgaben in der Datei, der ACoS der Kampagne) gegen das
    Ziel von Profil bzw. Client, Ausgaben ohne Umsatz liegen über jedem Ziel; aktive Targets in aktiven Kampagnen
    mit Ausgaben ab der Schwelle (EUR, mit dem Kurs umgerechnet) ohne Bestellung; `noGoal` und `noCap` **je Profil
    ein Hinweis** mit der Zahl der aktiven Kampagnen (nicht je Kampagne: ohne Ziel am Profil wären es sonst alle).
  - **Tabellen** (Migration `0044_automation_checks`): `automation_check_settings` (ein Dokument je Organisation,
    ohne Zeile die Startwerte) und `automation_findings` (aktuelle Befunde je Profil; eindeutig je Art, Entity und
    `key`, bei `placement` die Platzierung; erstes und letztes Auftreten, Quittung).
  - **Zugriffe** `packages/db/src/automation-checks.ts`: `loadCheckSettings`, `saveCheckSettings` (nur Admins,
    Audit `automation_checks.update`), `syncAutomationFindings` (bestehende behalten ID, erstes Auftreten und
    Quittung, neue kommen dazu, verschwundene werden gelöscht: **kommt ein Befund zurück, ist er neu**),
    `getAutomationChecks` (sichtbare Profile, offen oder quittiert, Warnungen zuerst, höchstens 500),
    `acknowledgeAutomationFindings` (Audit `automation_findings.acknowledge`).
  - **Lauf:** Die Einstellungen stehen im Plan und im `fingerprint`; `loadAutomationRunEntities` liefert je
    Kampagne die Anpassungen aus `extra.placementBidAdjustments` mit den Summen der Platzierung (Ebene `placement`
    aus 5.1); `computeAutomationFindings` im Job; `saveAutomationRun` gleicht die Befunde in der Transaktion des
    Laufs ab, zählt sie (`counts.findings`) und meldet **nur neue Warnungen** (`automation_findings`, an alle, die
    das Profil sehen, Link `/ads/automations?tab=checks`).
  - **API** (Feature `automations`): `GET /ads/automations/checks?status=open|acknowledged` (`view`), `POST
    /ads/automations/checks/acknowledge` (`write`, bis zu 500 IDs), `PUT /ads/automations/checks/settings` (`write`
    und Admin, sonst 403 `AUTOMATION_DEFAULTS_FORBIDDEN`).
  - **Seite:** Tab „Prüfungen“ (`automations/ChecksTab.vue`): Befunde mit Art, Ort, Zahlen und „seit“, Filter
    offen/quittiert, „Quittieren“ einzeln und für alle gezeigten, Einstellungen (für Nicht-Admins gesperrt) und
    die Liste „Von Hand prüfen“ für Dinge ohne Daten (Sponsored Prompts, SB-vCPM, Off-Amazon). `?tab=` öffnet
    einen Tab der Seite direkt.
  - **Abweichungen vom Aufgabentext:**
    - **Off-Amazon wird nicht eingelesen.** Die Spalte gibt es nur in US-Dateien, und es liegt keine vor, an der
      Name und Werte zu prüfen wären; geraten wird nicht. Sie steht in der Liste „Von Hand prüfen“. Offen, bis
      eine US-Datei da ist.
    - Die Hinweis-Checkliste ist eine Liste je Organisation, nicht je Kampagne abzuhaken.
  - **Grenzen:** Steht die Automatik eines Clients auf „aus“, laufen auch die Prüfungen nicht. Kampagnen ohne
    Kennzahlen im Datenstand werden nicht geprüft. Befunde ändern sich erst mit dem nächsten Lauf (neue Datei oder
    geänderte Einstellungen, Regeln, Ziele, Caps), nicht sofort nach dem Anlegen eines Ziels oder Caps.
  - **Review (ponytail-review):** neue Befunde werden in Blöcken eingefügt (viele Targets ohne Bestellung).
    Zurückgewiesen: bestehende Befunde einzeln aktualisieren (je Befund eine Abfrage; bei den erwarteten Mengen
    unkritisch).
  - **Browser-Pane (2026-10-11):** Tab über `?tab=checks`, leerer Zustand, Einstellungen mit den Startwerten und
    die Liste von Hand geprüft (als Text; Handy ohne waagerechtes Scrollen), nichts gespeichert. **Nicht mit
    Befunden geprüft** (kein Lauf ohne Datei mit Kennzahlen in der Dev-DB) und ohne Bildschirmfoto (die Pane war
    nicht sichtbar). Dev-DB migriert bis `0044_automation_checks`.
  - **Nicht nach TDD im strengen Sinn:** Test und Komponente des Tabs entstanden zusammen (der Test lief erst
    mit der Komponente, zwei Fehlschläge aus Tippfehlern im Code); Engine, Zugriffe, Lauf und API liefen vorher rot.
  - **Weiter offen aus 5.8:** Gründe ohne Vorschlag je Lauf anzeigen (`automation_runs.counts`, jetzt auch
    `budgetCap` und `findings`).

- **Entschieden (Dominik, 2026-10-11, zu Beginn der zweiten Session; für 5.11a, 5.11b und 5.13):**
  - **Kriterien je Graduation-Kante:** Mindest-Bestellungen und höchster ACoS in % des Ziels, je Feld leer = die
    Harvest-Regel der Suchbegriff-Einstufung (2b, je Organisation bzw. Profil); ohne wirksames Ziel gilt deren ACoS.
    Startwerte: Kanten nach Exakt bzw. Produkte leer, Exakt → Exakt einzeln ab 8 Bestellungen und ACoS ≤ 100 % des
    Ziels, Exakt einzeln → SB ab 15 Bestellungen und ACoS ≤ 100 %.
  - **Preset-Wechsel als Kanten** „von Preset → nach Preset“ mit Bedingungen auf die Kennzahlen der Produktgruppe.
    Startwerte: Launch → Muuv-Standard ab 30 Bestellungen; Muuv-Standard → Kontrolle ab 100 Bestellungen und ACoS ≤
    Ziel; Muuv-Standard → Profit und Verteidigung ab 200 € Ausgaben und ACoS ≥ 150 % des Ziels.
  - **Meldung „neue Graduation-/Preset-Vorschläge“ (5.11b):** an alle, die das Profil sehen; je Lauf höchstens eine,
    nur bei neuen Vorschlägen.
  - **Modus „aus“ (für 5.13):** schaltet nur die Vorschläge ab (Gebote, Budgets, Graduation, Presets);
    **Cap-Meldungen und Prüfungen laufen trotzdem.** Heute läuft bei „aus“ nichts; umbauen in 5.13.
  - **Frage von Dominik:** „Gibt es die Automatik, die auf Uploads funktioniert? Ich würde fest vorgeschriebene
    Datensätze hochladen; sie muss flexibel funktionieren, wenn manche fehlen.“ Antwort: Ja, der Lauf startet nach
    jedem Import mit Kennzahlen und überspringt, wofür Daten fehlen (ADR 006). **Offen (Idee, nicht gebaut):** eine
    Übersicht je Profil „diese Datensätze erwartet die Automatik, das liegt vor, das fehlt“ (Bulk-Datei mit
    Kennzahlen, Suchbegriff-Blätter, Zeitraum, Alter). Mit Dominik klären, ob sie in 5.13 oder später kommt.

### 5.11a Katalog: Kriterien und Zuordnung (Vorarbeit für 5.11b)
- [x] Graduation-Kanten und Presets im Struktur-Katalog um Kriterien erweitern (Schwellen auf einen Datei-Zeitraum, z. B.
      Bestellungen und ACoS gegen Ziel; Preset-Wechsel nach Kennzahlen der Produktgruppe), mit Migration der gespeicherten
      Kataloge.
- [x] Zuordnung Kampagne → Baustein speichern: beim Übermitteln eines Setups (Phase 4), für Bestand über das Namensschema
      vorgeschlagen und von Hand bestätigt.
- [x] Umsetzung (2026-10-11, Stand für 5.11b):
  - **Katalog** (`packages/shared/src/structure-catalog.ts`): Kanten tragen `minOrders` und `maxAcosPercentOfGoal`
    (je `null` = Harvest-Regel); neu `presetSwitches` (`from`, `to`, `minOrders`, `minSpend` in EUR, `acos` mit
    `comparison` `lte` | `gte` und `percentOfGoal`; alle gesetzten Bedingungen müssen zutreffen, ohne Ziel passt die
    ACoS-Bedingung nicht). Prüfung: bekannte, verschiedene Presets, keine Dublette, mindestens eine Bedingung
    (`switchUnknownPreset`, `switchSamePreset`, `duplicateSwitch`, `switchNoCondition`); Wechsel im Kreis sind
    erlaubt (hin und zurück ist sinnvoll). Über die Startwerte hinaus hat auch Produkte → Produkt einzeln 8 / 100 %.
  - **Migration der gespeicherten Kataloge:** beim Lesen, ohne SQL-Migration. `upgradeStructureCatalog` (in
    `loadStructureCatalog`) gibt Kanten ohne Kriterien die Startwerte der gleichen Start-Kante und einem Dokument
    ohne `presetSwitches` die Start-Wechsel zwischen Presets, die es noch gibt; Dokumente mit eigenen (auch leeren)
    Angaben bleiben. Das nächste Speichern schreibt die neue Form.
  - **Zuordnung Kampagne → Baustein** (`packages/db/src/campaign-blocks.ts`): Kampagnen aus einem Setup kennen den
    Baustein über ihren Entwurf, sobald die Kampagne ihre Amazon-ID hat (`campaign_setup_items.amazon_entity_id`,
    Plan des Entwurfs über den Namen); **dafür wird beim Übermitteln nichts Zusätzliches gespeichert.** Von Hand
    bestätigte Bausteine stehen in `campaign_blocks` (Migration `0045_campaign_blocks`, je Kampagne eine Zeile,
    fällt mit der Kampagne) und gehen dem Setup vor. `listCampaignBlocks` (sichtbares Profil, nicht archivierte
    Kampagnen, höchstens 5000, mit `suggestedBlockKey`), `setCampaignBlocks` (Baustein muss im Katalog stehen und
    zum Anzeigentyp passen; `null` nimmt die Bestätigung zurück; Audit `campaign_blocks.update` nur bei Änderung),
    **`loadCampaignBlocks(db, orgId, profileId)` für den Lauf in 5.11b** (Amazon-Kampagnen-ID → Baustein, nur
    Bausteine, die es noch gibt).
  - **Vorschlag aus dem Namen** (`suggestBlockFromName` in `packages/engine/src/naming.ts`): das vorderste Kürzel
    eines Bausteins des Anzeigentyps, das als eigenes Wort im Namen steht (ohne Groß/Klein, bei gleicher Stelle das
    längere). `shortcut:` Es sucht im ganzen Namen, nicht an der Stelle von `{block}` im Muster. Namen ohne Kürzel
    (z. B. „… - Manuell - Exakt - …“ der Demo-Profile) bekommen keinen Vorschlag.
  - **API** (Feature `tools`): `GET /ads/tools/campaign-blocks?profileId=` (`view`), `PUT /ads/tools/campaign-blocks`
    (`write`, bis zu 500 Zuordnungen; 404 `PROFILE_NOT_FOUND`, 400 `CAMPAIGN_BLOCK_UNKNOWN_BLOCK` bzw.
    `…_UNKNOWN_CAMPAIGN`).
  - **Seite** `/ads/tools/catalog`: Reiter „Graduation“ mit zwei Feldern je Kante (leer zeigt „Harvest“), neuer
    Reiter „Preset-Wechsel“ (Liste, Bedingungen, hinzufügen, entfernen; ein gelöschtes Preset nimmt seine Wechsel
    mit) und neuer Reiter „Kampagnen“ (Profil wählen, je Kampagne Baustein, Herkunft „aus dem Setup“/„bestätigt“,
    Vorschlag mit „Bestätigen“, „Alle Vorschläge bestätigen“; speichert sofort wie die Presets je Client; Viewer
    lesen nur).
  - **Review (ponytail-review):** Der Plan eines Entwurfs wurde je Kampagnen-Zeile geladen (jetzt einmal je
    Entwurf). Zurückgewiesen: Suchmuster der Kürzel je Aufruf vorbereiten (bei 5000 Kampagnen unkritisch).
  - **Browser-Pane (2026-10-11):** die drei Reiter am Desktop (dunkel) und am Handy (hell, kein waagerechtes
    Scrollen), Konsole ohne Fehler; im Profil „Browser-Prüfung (Datei)“ einen Baustein gesetzt und wieder
    zurückgenommen. In der Dev-DB bleiben davon zwei Audit-Events `campaign_blocks.update`; am Katalog wurde nichts
    gespeichert. Dev-DB migriert bis `0045_campaign_blocks`.
  - **Nicht gebaut:** Filter „nur ohne Baustein“ und Suche im Reiter „Kampagnen“; eine Zuordnung Kampagne →
    Produktgruppe (5.11b rechnet die Gruppe über die ASINs der Anzeigen); „kein Baustein“ für eine Kampagne aus
    dem Setup (nur ein anderer Baustein überschreibt).
  - **Nicht nach TDD im strengen Sinn:** Die Tests des Reiters „Kampagnen“ liefen erst mit der Komponente; alle
    übrigen (Schema, Anheben, Engine, Zugriffe, API, Kanten und Wechsel in der Seite) liefen vorher rot.
  - **Für 5.11b:** Kriterien einer Kante mit `null` über `resolveSearchTermRules` des Profils auflösen
    (`harvestMinPurchases`, `harvestMaxAcos` als Bruch); Kennzahlen der Produktgruppe aus der Ebene `productAd`
    (5.1) über die ASINs der Gruppe; wirksames Preset über `effectivePreset`.

### 5.11b Graduation- und Preset-Vorschläge
- [x] Graduation: Suchbegriffe (Zeitraumsummen, Phase 2b) in Kampagnen eines Bausteins mit ausgehender Kante, die die
      Kriterien erfüllen, als Vorschlag; Annehmen legt sie wie in 4.6 auf die Merkliste (das Preset der Produktgruppe
      verteilt im Setup), Negativ in der Quelle wie dort.
- [x] Preset-Wechsel: Kriterien auf die Kennzahlen der Produktgruppe; Annehmen ändert das Preset (Audit), nie automatisch.
- [x] Abschnitt „Vorschläge“, Benachrichtigung bei neuen Vorschlägen.
- [x] Umsetzung (2026-10-11, Stand für 5.12 und 5.13):
  - **Engine** `packages/engine/src/structure-proposals.ts`: `graduationProposals` summiert die Suchbegriff-Zeilen
    des Datei-Zeitraums je Begriff und Baustein der Kampagne und prüft die ausgehenden Kanten (Bestellungen ab
    `minOrders` bzw. Harvest-Regel; ACoS höchstens `maxAcosPercentOfGoal` des Ziels, ohne Angabe oder ohne Ziel der
    ACoS der Harvest-Regel; ohne Umsatz kein Vorschlag). ASIN-Suchbegriffe gehen nur in Produkt-Bausteine, Begriffe
    nur in Keyword-Bausteine. **Je Begriff ein Vorschlag** (aus dem Baustein mit den meisten Bestellungen) mit allen
    Ziel-Bausteinen, deren Kante passt. Eine Kante zählt nicht, wenn der Begriff im Ziel, in einem Baustein dahinter
    oder in einer Kampagne ohne Baustein schon exakt gebucht ist; Begriffe auf der Merkliste bleiben außen vor.
    `presetSwitchProposals`: je Produktgruppe der erste Wechsel aus ihrem wirksamen Preset, dessen gesetzte
    Bedingungen alle zutreffen (Mindest-Ausgaben in EUR mit dem Kurs umgerechnet; ACoS-Bedingung nur mit Ziel;
    Ausgaben ohne Umsatz liegen über jeder Schwelle).
  - **Tabelle** `automation_structure_proposals` (Migration `0046_structure_proposals`): aktuelle Vorschläge je Profil,
    eindeutig je Art, `subject` (Begriff in Vergleichsform bzw. Produktgruppe) und `key` (Baustein der Quelle bzw.
    Ziel-Preset), mit `detail`, erstem und letztem Auftreten und „verworfen“.
  - **Lauf** (`packages/db/src/structure-proposals.ts`): `planStructure` lädt Katalog, Harvest-Regel des Profils,
    Bausteine der Kampagnen (5.11a) und die wirksamen Presets der Produktgruppen in den Plan; Kanten, Wechsel,
    Harvest-Regel, Zuordnungen und Presets stehen im `fingerprint` (nach dem Deploy gibt es deshalb je Profil einmal
    einen neuen Lauf). `loadStructureProposals` rechnet: Suchbegriffe mit **genau dem Zeitraum des Datenstands**,
    Ziel von Profil bzw. Client; Kennzahlen der Gruppe = Summen der Anzeigen (Ebene `productAd`) ihrer ASINs, Ziel
    der Gruppe über `effectiveGoal`. `syncStructureProposals` gleicht wie bei den Befunden ab (bestehende behalten
    ID und „verworfen“, neue kommen dazu, alles Übrige wird gelöscht), `saveAutomationRun` zählt `counts.structure`
    und meldet **nur neue** (`structure_proposals`, an alle, die das Profil sehen, Link
    `/ads/automations?tab=proposals`). Der Job zählt `structure` in `job_runs`.
  - **Annehmen und Verwerfen** (über `visibleProfilesScope`): `acceptStructureProposals` legt Graduation-Begriffe
    mit `markSearchTermsForHarvest` auf die Merkliste (Kennzahlen des Datei-Zeitraums; das Setup verteilt nach dem
    Preset und schlägt das Negativ in der Quelle vor, 4.6) bzw. setzt das Preset mit `updateProductGroup` (Audit
    `product_group.update`); Angenommenes verlässt die Liste, Audit `automation_structure_proposals.accept`. Was
    sich nicht mehr annehmen lässt (Begriff nicht mehr im Zeitraum, Preset oder Gruppe gelöscht), bleibt stehen und
    zählt als übersprungen. `dismissStructureProposals` (Audit `…dismiss`).
  - **API** (Feature `automations`): `GET /ads/automations/structure-proposals?status=open|dismissed` (`view`),
    `POST …/structure-proposals/accept` und `…/dismiss` (`write`, bis zu 500 IDs, Antwort `{ changed, skipped }`).
  - **Seite:** Abschnitt „Graduation und Presets“ oben im Tab „Vorschläge“ (`automations/StructureProposals.vue`):
    Begriff bzw. Produktgruppe, Art, Profil, Kennzahlen, „Baustein → Bausteine“ bzw. „Preset → Preset“ (Namen aus
    dem Katalog), „Auf die Merkliste“ bzw. „Preset ändern“ und Verwerfen je Zeile; Filter offen/verworfen; Viewer
    lesen nur. Eigener Lade-, Leer- und Fehlerzustand (ein Fehler hier lässt die übrigen Vorschläge stehen).
  - **Festlegungen (Claude, Dominik kann widersprechen):**
    - Verworfen bleibt ein Vorschlag, **solange er in jedem Lauf wieder auftritt** (wie quittierte Befunde, nicht
      wie Gebots-Vorschläge, die mit einer neuen Datei wiederkommen): Ein Begriff, den man nicht graduieren will,
      meldet sich sonst jede Woche neu.
    - Im Modus „Schatten“ und „Warenkorb“ gleich; im Modus „aus“ gibt es keine (der Lauf fällt aus).
    - Annehmen braucht `write` im Feature `automations`; Merkliste und Preset gehören sonst zu `sp-explorer` bzw.
      `tools` (dieselben Rollen, nur das Entitlement der Organisation unterscheidet sich).
  - **Grenzen, bewusst so:**
    - Graduation gibt es nur für Kampagnen mit Baustein (aus dem Setup oder im Struktur-Katalog bestätigt) und nur,
      wenn die Datei die Suchbegriff-Blätter enthält.
    - Die Merkliste merkt sich als Quelle die Zeile mit den höchsten Ausgaben des Begriffs, nicht unbedingt die
      Kampagne des Vorschlags; das Ziel bestimmt weiter das Preset der Produktgruppe im Setup, nicht die Kante.
    - Ein Preset-Wechsel wird beim Annehmen nicht erneut gegen das aktuelle Preset der Gruppe geprüft (wer das
      Preset inzwischen von Hand geändert hat, bekommt den Vorschlag bis zum nächsten Lauf noch angeboten).
    - Annehmen läuft nicht in einer Transaktion mit dem Löschen des Vorschlags (`shortcut:` im Code; der nächste
      Lauf räumt auf).
    - Kein Markieren mehrerer Vorschläge (je Zeile annehmen oder verwerfen).
  - **Review (ponytail-review):** Bausteine „dahinter“ werden je Ziel-Baustein nur einmal bestimmt. Sonst keine
    Befunde, die eine Änderung brauchten.
  - **Browser-Pane (2026-10-11):** Abschnitt mit Filter und leerem Zustand geprüft (Desktop dunkel, kein
    waagerechtes Scrollen). **Nicht mit echten Vorschlägen geprüft:** Die Dev-DB hat keine Datei mit Kennzahlen
    (wie 5.8–5.10). Dev-DB migriert bis `0046_structure_proposals`.
  - **Nach TDD:** Engine, Zugriffe, Job, API und Abschnitt liefen vorher rot.

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
