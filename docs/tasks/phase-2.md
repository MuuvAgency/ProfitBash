# Phase 2 – Sehen

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5 inkl. „Kennzahlen je Ad-Typ“),
> `docs/tasks/phase-1.md` (Umsetzungsnotizen 1.5–1.9, F8, F12), `docs/decisions/` (001 Stack, 002 Mandanten-Modell,
> 003 Decimal-Library, 004 Amazon-API), `design/DESIGN.md` und die Referenzen `dashboard_home`, `werbekosten_ppc`.
>
> **Status: Entwurf (2026-09-28), zur Abstimmung.** Fragen stehen als **F1–F14** unter „Fragen an Dominik“, jeweils mit
> Empfehlung (die Nummern gelten nur in dieser Datei; `phase-1.md` hat eigene F1–F14). Umgesetzt wird erst, wenn die Fragen
> entschieden sind. Aufgaben, die von einer Frage abhängen, verweisen darauf.
>
> **Ausgangslage:** Es gibt vorerst keinen Ads-API-Zugang (`phase-1.md` F12). Entschieden (Dominik, 2026-09-28): Phase 2 wird
> jetzt gegen den Mock-Anbieter gebaut, 1.10 wartet. Phase 2 liest nur aus den Tabellen von Phase 1; von außen kommen nur die
> EZB-Kurse (2.2).

## Ziel

Die Agentur sieht ihre Amazon-Werbung, ohne die Konsole zu öffnen:
- **Dashboard** mit den Ads-Kennzahlen über alle oder ausgewählte Clients und Profile, mit Zeitraum und Vergleich.
- **Explorer** (nur lesen): Portfolios, Kampagnen, Ad Groups, Targets, Product Ads, Suchbegriffe und Negatives mit Kennzahlen,
  Drill-Down von oben nach unten, Chart über dem Grid, Filter, gespeicherte Ansichten.
- **Mitglieder** verwalten (anlegen, Rolle ändern, entfernen).
- **ASIN-Quick-Tool:** Wo wird eine ASIN beworben, und was bringt sie?
- Summen über Währungen hinweg in EUR (EZB-Tageskurse, `phase-1.md` F8).

## Definition of Done

- [ ] Dashboard und Explorer zeigen mit den Mock-Daten (SP, SB, SD; EUR, GBP, SEK) dieselben Summen wie eine unabhängige
      SQL-Prüfung (Test), in Originalwährung bei einer Währung, sonst in EUR mit „≈“.
- [ ] Kennzahlen je Ad-Typ werden richtig gelesen und gekennzeichnet (`plan.md` §5, Tabelle unter F4): Attributionsfenster, Klick-
      und View-Anteil bei SB/SD, SD-Same-SKU nur nach Klick, vCPM-Kampagnen, SB-Preview-Lücke, Spalten, die Amazon für einen Ad-Typ
      oder eine Ebene nicht liefert („–“, nie 0). Ein Test deckt jede dieser Regeln ab.
- [ ] Alle Datenabfragen laufen über den Access-Layer (ADR 002); ausgeblendete und fremde Profile erscheinen nie (Test je Endpunkt,
      auch für gespeicherte Ansichten und die Client-Auswahl). Die Endpunkte prüfen Feature-Recht und Entitlement serverseitig.
- [ ] Beträge bleiben bis zur Anzeige Decimal-Strings (kein `number` in API und Rechenkern), Kennzahlen mit Division durch 0 sind
      „–“ statt 0 oder `Infinity`.
- [ ] Jede Datenansicht hat Loading- (Skeleton), Empty- und Error-Zustand; ein fehlerhaftes Widget legt die Seite nicht lahm.
      Alle Texte über i18n-Keys, Zahlen in JetBrains Mono über die Helper aus `packages/shared`.
- [ ] Dashboard und Explorer im Browser-Pane geprüft: 1440 px (Sidebar ein- und ausgeklappt), Tablet, Handy (F13), Hell/Dunkel,
      Konsole ohne Fehler und ohne Warnungen zu nicht registrierten AG-Grid-Modulen.
- [ ] Jede schreibende Aktion (Mitglieder, gespeicherte Ansichten) erzeugt ein `audit_event` mit handelndem Nutzer; der neue Job (2.2)
      läuft über `runJob` und pingt Healthchecks.
- [ ] Abfragen bleiben bei den Demo-Daten mit Volumen (2.3) unter 1 s (Messung im Test oder per `EXPLAIN ANALYZE` festgehalten).
- [ ] `pnpm test`, `typecheck`, `lint`, `build` und beide Smoke-Tests grün, CI grün.

## Voraussetzungen

- Keine Konten oder Freigaben nötig. Die EZB-Kurse sind öffentlich und ohne Schlüssel abrufbar.
- Die Mock-Daten aus Phase 1 reichen für die Logik; für Layout und Tempo kommen Demo-Daten mit Volumen dazu (2.3, F12).

## Fragen an Dominik

Jede Frage mit Empfehlung. Antworten werden hier mit Datum eingetragen („Entschieden (Dominik, …)“).

- **F1 – Ad-Typen im Explorer.** Ein Explorer für SP, SB und SD mit Filter „Ad-Typ“, oder je Ad-Typ ein eigener Bereich?
  Empfehlung: **ein Explorer für alle drei**, Filter und Spalte „Ad-Typ“. Der Feature-Key `sp-explorer` bleibt (gemeint:
  Sponsored Ads, im Gegensatz zu `dsp-explorer`); `plan.md` §3 bekommt dazu eine Anmerkung. Umbenennen bräuchte eine
  Datenmigration der Entitlements und bringt nichts. Das ASIN-Quick-Tool (F10) hängt am selben Key.
- **F2 – Auswahl von Clients und Profilen.** Wie wählt man aus, was Dashboard und Explorer zeigen? Empfehlung: eine
  **Filterleiste oben** (gleich in Dashboard und Explorer): Clients (mehrfach), darin Profile (mehrfach), Standard „alle
  sichtbaren“. Profile ohne Client erscheinen unter „Ohne Client“.
  - Die Auswahl zeigt nur Clients mit sichtbaren Profilen, auch für Editoren und Viewer (heute sieht nur der Admin die Clients).
    Die Liste entsteht über den Access-Layer, nicht über eine neue Abfrage nach Organisation (ADR 002).
  - Die URL enthält nur Kurzes (Zeitraum, Ebene, Drill-Down, Client-IDs oder die ID einer gespeicherten Ansicht), damit man Links
    teilen und mit der Zurück-Taste arbeiten kann. Eine lange Liste einzelner Profile kommt nicht in die URL (Regel in `CLAUDE.md`),
    sondern in die zuletzt benutzte Auswahl je Nutzer (`ui_state`) bzw. in eine gespeicherte Ansicht (F8).
- **F3 – Währung.** Empfehlung: Stammen alle ausgewählten Profile aus einer Währung, zeigt die App diese Währung. Sonst rechnet sie
  **in EUR um, je Tag mit dem EZB-Kurs dieses Tages** (für Wochenenden und Feiertage gilt der letzte Kurs davor), und kennzeichnet
  Summen mit „≈“ (`plan.md` §5). Keine wählbare Anzeigewährung (später nachrüstbar). Der Explorer zeigt je Zeile die
  Originalwährung, Summenzeilen folgen derselben Regel.
- **F4 – Attributionsfenster.** SP liefert 7 und 14 Tage nur nach Klick, SB/SD nur 14 Tage nach Klick **oder** View.
  Empfehlung: Umschalter mit zwei Einstellungen, Standard **„wie Konsole“**: SP 7 Tage bei Seller- und Agency-Profilen, 14 Tage bei
  Vendoren (`amazon_ads_profiles.account_type`; Agency = 7 Tage ist eine Annahme, 1.10 prüft sie), SB/SD 14 Tage inkl. Views.
  Zweite Einstellung **„14 Tage, nur Klicks“**: SP `*_14d`, SB/SD `*_clicks_14d`, damit über alle Ad-Typen vergleichbar. Summen über
  Ad-Typen mit gemischter Attribution bekommen einen Hinweis. Die Einstellung gehört zur Filterleiste (F2) und wird mitgespeichert.
  Was Amazon je Ad-Typ liefert (fehlende Werte zeigt die App als „–“ mit Hinweis, nie als 0, und zählt sie nicht still in Summen):

  | Wert | SP | SB | SD |
  |---|---|---|---|
  | Umsatz, Käufe, Einheiten, 7 Tage | Klick | – | – |
  | dasselbe, 14 Tage | Klick | Klick + View | Klick + View |
  | dasselbe, 14 Tage nur Klick | = 14 Tage | ja; Einheiten fehlen bei Targets und Suchbegriffen | ja |
  | Same-SKU Umsatz und Käufe | 7 und 14 Tage, Klick | 14 Tage wie Umsatz, ohne Nur-Klick-Variante; fehlt bei Suchbegriffen | 14 Tage, nur Klick |
  | Same-SKU Einheiten | ja | – | – |
  | Sichtbare Impressionen (Basis für vCPM) | – | – | ja |

  Folge für „14 Tage, nur Klicks“: SB-Same-SKU ist dort „–“. Welche Einheiten „wie Konsole“ bei SB-Targets zählen, zeigt 1.10.
- **F5 – Zeitraum und Vergleich.** Empfehlung: Voreinstellungen Gestern, Letzte 7 / 14 / 30 Tage, Dieser Monat, Letzter Monat,
  frei wählbar; Standard **Letzte 30 Tage**.
  - Vergleich: **Vorperiode gleicher Länge** (Standard; bei „Dieser Monat“ am 10. also die 10 Tage davor, nicht der ganze
    Vormonat), Vorjahr, aus. Vorjahr ist erst wählbar, wenn die DB Daten dafür hat, also frühestens ein Jahr nach dem ersten echten
    Sync (Amazon liefert höchstens 95 Tage rückwirkend).
  - Tage sind Kalendertage in der Zeitzone des jeweiligen Profils (so liegen sie schon in der DB), „Gestern“ bezieht sich auf die
    Zeitzone des Browsers.
  - Die letzten 14 Tage vor „Daten bis“ sind **vorläufig** (Amazon korrigiert noch) und im Chart als Bereich markiert.
- **F6 – Explorer-Ebenen und Drill-Down.** Empfehlung: Reiter **Portfolios · Kampagnen · Ad Groups · Targets · Product Ads ·
  Suchbegriffe · Negatives**. Ein Klick auf eine Zeile filtert die nächste Ebene darauf (Brotkrumen oben: Client › Profil ›
  Kampagne › Ad Group), die Reiter bleiben erreichbar. SB-Targets ohne Ad Group (Kampagnenebene) erscheinen beim Drill-Down von der
  Kampagne direkt unter Targets. Portfolio-Kennzahlen = Summe seiner Kampagnen. Negatives ohne Kennzahlen.
  Ein **Chart** über dem Grid zeigt den Tagesverlauf von bis zu zwei Kennzahlen für die aktuelle Auswahl (oder die markierten
  Zeilen). Dazu **CSV-Export** der geladenen Zeilen (Community-Modul von AG Grid, wenig Aufwand). Frage: CSV-Export jetzt
  oder später?
- **F7 – Datenmenge im Grid.** Empfehlung: Der Server rechnet Summen je Zeile, das Grid bekommt alle Zeilen der Auswahl
  (Sortieren und Filtern im Browser, schnell und einfach) bis zu einer Obergrenze von **10 000 Zeilen**.
  - Bei mehr Zeilen lädt es die 10 000 mit dem höchsten Spend und sagt das deutlich: Filter und Sortierung wirken dann nur auf diese
    10 000, die Summenzeile kommt trotzdem vom Server und gilt für alles.
  - Sortieren und Filtern von Beträgen ohne Umweg über `number`: ein Vergleich für Decimal-Strings in `packages/shared` (das Web
    bekommt kein `decimal.js`, ADR 003).
  - Die Antwort wird komprimiert (10 000 Zeilen mit Vergleichszeitraum sind sonst mehrere MB).
  - Wird das bei echten Konten zu eng, kommt das Infinite Row Model (Community) mit Sortierung und Filter auf dem Server als eigene
    Aufgabe.
- **F8 – Gespeicherte Filter.** Empfehlung: **gespeicherte Ansichten** (Filterleiste, Reiter, Spalten, Sortierung, Chart-Kennzahlen)
  in einer eigenen Tabelle `saved_views` (Organisation, Besitzer, Name, Bereich `dashboard`/`explorer`, Zustand als jsonb,
  `shared`).
  - Persönliche Ansichten darf jede Rolle anlegen, auch Viewer (sie ändern keine Daten). Freigeben für die Organisation: Editoren und
    Admins. Ändern und löschen: Besitzer und Org-Admins.
  - Beim Laden einer Ansicht filtert der Access-Layer die darin genannten Profile und Clients (wichtig ab Phase 6, wenn nicht jeder
    alles sieht). `saved_views` kommt in ADR 002 unter „Geltungsbereich“.
  - Alternative: nur persönlich in `ui_state` (weniger Aufwand, aber ohne Teilen im Team).
- **F9 – Mitglieder anlegen ohne E-Mail-Versand.** Es gibt noch keinen E-Mail-Dienst, die Registrierung ist aus. Empfehlung: Der
  Admin legt das Mitglied an (E-Mail, Name, Rolle); die App erzeugt einen **einmaligen Link zum Setzen des Passworts** (7 Tage
  gültig), den der Admin selbst weitergibt. Dazu: Rolle ändern, Mitglied entfernen, Link neu erzeugen; der letzte Admin kann weder
  entfernt noch herabgestuft werden. E-Mail-Versand kommt mit einem eigenen Anlass (z. B. Benachrichtigungen, Phase 5).
  Sicherheit (gilt für die Empfehlung):
  - Eigene Endpunkte nur für Org-Admins. Das Anlegen von Nutzern über better-auth ist Superadmins vorbehalten; die Endpunkte rufen es
    deshalb serverseitig auf und schreiben das Audit-Event (`member.create`) selbst, mit dem Admin als Handelndem.
  - Eigene Tabelle für die Links: nur ein Hash des Tokens gespeichert, einmal nutzbar, ungültig bei „Link neu erzeugen“ und beim
    Entfernen. Das Token steht nie im URL-Pfad (der Request-Log schreibt Pfade mit), sondern im Fragment (`#…`).
  - Nicht über „Passwort vergessen“ von better-auth: Das würde einen öffentlichen Endpunkt freischalten und die Gültigkeit für alle
    Links auf 7 Tage setzen.
  - Entfernen eines Mitglieds beendet dessen Sessions.
  Alternative: jetzt einen E-Mail-Dienst anbinden (neues Konto, neue Abhängigkeit, DNS-Einträge für die Domain).
- **F10 – ASIN-Quick-Tool.** Der Plan nennt nur den Namen. Empfehlung: Popover in den Quick-Tools: eine oder mehrere ASINs eingeben
  (auch aus der Zwischenablage, getrennt durch Leerzeichen, Komma oder Zeilenumbruch) → Liste der Product Ads mit Profil, Kampagne,
  Ad Group, Ad-Typ, Status und Kennzahlen im gewählten Zeitraum; Klick springt in den Explorer (Reiter Product Ads, gefiltert).
  - Gesucht wird in der ASIN des Ads **und** in den ASINs von SB/SD-Ads mit mehreren Produkten (`extra.asins`).
  - Amazon misst Kennzahlen je Ad, nicht je ASIN. Ein Ad mit mehreren ASINs erscheint deshalb einmal, markiert mit „teilt sich
    n ASINs“, und wird nicht auf die einzelnen ASINs aufgeteilt oder doppelt gezählt.
  - Bekannte Lücke: SD-Product-Ads, die nur eine SKU tragen (`phase-1.md` 1.9), findet die Suche nach ASIN nicht; das Popover sagt
    das. Suche nach SKU zusätzlich?
  - Gemeint so, oder etwas anderes (z. B. Keyword-Recherche zu einer ASIN)?
- **F11 – Inhalt des Dashboards.** Die Referenzen (`dashboard_home`, `werbekosten_ppc`) zeigen Profit, Shop-Bestellungen und
  Kanäle, die es erst ab Phase 7 bzw. gar nicht gibt. Empfehlung für Phase 2:
  - **KPI-Kacheln** Spend, Umsatz (Ads), ACoS, ROAS, Käufe (Ads, von Amazon der Werbung zugeordnet), Klicks mit CPC, jeweils mit
    Veränderung zum Vergleich. Die große Hero-Kachel (dunkel, wie „Netto-Profit“ in der Referenz) zeigt Spend und Umsatz mit
    Tagesverlauf.
  - **Anteil je Ad-Typ** (Spend, Umsatz, ACoS); **Tabelle je Client bzw. Profil** mit denselben Kennzahlen und Sprung in den
    Explorer; **Datenstand** („Daten bis“, letzter Sync, Hinweis bei hängenden Ad-Typen, Stand der Wechselkurse).
  - Kein TACoS und kein Profit (Phase 7), keine erfundenen Kacheln wie „Market Velocity“.
- **F12 – Demo-Daten mit Volumen.** Die Mock-Daten haben 16 Kampagnen und 26 Targets; Grid-Layout, Filter und Abfragetempo lassen
  sich daran nicht prüfen. Empfehlung: ein **Generator im Mock-Anbieter** (deterministisch, eigener Schalter, z. B.
  `AMAZON_ADS_MOCK_SCALE=large`): 6 Profile in EUR/GBP/SEK/PLN (neue Mock-Profile), ~300 Kampagnen, **~12 000 Targets** (über der
  Grenze aus F7, damit das Kürzen getestet wird), 95 Tage, alle drei Ad-Typen, nur erfundene Namen. Entities und Kennzahlen kommen
  über denselben Sync wie echte Daten (kein Direkt-Insert); 3 Clients und die Zuordnung der Profile legt ein Seed-Schritt an (Clients
  kommen nicht von Amazon).
- **F13 – Mobil.** Empfehlung: Dashboard **voll responsive** (eine Spalte unter 768 px, `DESIGN.md` §6). Explorer ab Tablet voll
  nutzbar; auf dem Handy dieselbe Seite, das Grid scrollt waagerecht in seiner Kachel, Chart und Filterleiste stapeln sich. Keine
  eigene Handy-Ansicht des Explorers in Phase 2.
- **F14 – Tabellen bei klassischer Scrollbar (offen aus Phase 1).** Sync-Status und Profiltabelle passen bei 1440 px nur mit
  Overlay-Scrollbars ohne waagerechtes Scrollen; mit klassischer Scrollbar scrollen sie waagerecht (Amazon-Konto und Ergebnis sind
  schon heute gekürzt, der volle Text steht im Tooltip, der auf Touch fehlt). Empfehlung: **so lassen**. Die Tabellen im Dashboard
  (F11) von vornherein so bauen, dass sie bei 1440 px auch mit klassischer Scrollbar passen. Das Explorer-Grid hat mehr Spalten als
  1440 px fassen und scrollt immer waagerecht (erste Spalte fest).

## Aufgaben

### 2.1 Kennzahlen-Rechenkern (`packages/engine`)
- [ ] `decimal.js` als **eine** konfigurierte Kopie (`Decimal.clone`, ADR 003), nie die globale Konfiguration.
- [ ] Summen und abgeleitete Kennzahlen aus Decimal-Strings: CTR, CPC, CVR, ACoS, ROAS, CPM, vCPM (nur SD), Veränderung zum Vergleich
      (absolut und relativ). Division durch 0 → `null`. Ergebnis als Decimal-String mit fester Rechengenauigkeit; gerundet wird erst
      bei der Anzeige.
- [ ] Attribution nach F4: Funktion, die je Ad-Typ, Ebene, Kontotyp (Seller/Agency/Vendor) und Einstellung die Spalten für Umsatz,
      Käufe und Einheiten wählt; meldet, ob eine Summe gemischte Attribution enthält und ob Werte fehlen (Tabelle unter F4).
- [ ] Tests für jede Zeile der Tabelle unter F4 und die Regeln aus `plan.md` §5: SB/SD `*_14d` inkl. Views; SD-Same-SKU gegen den
      Klick-Anteil; vCPM-Kosten aus `cost` und `viewable_impressions`; SP-Klick-Spalten leer; fehlende Werte nie als 0.

### 2.2 Wechselkurse (EZB)
- [ ] Eigenes Paket für die externe Quelle (Leitplanke 3), z. B. `packages/ecb`: Referenzkurse der EZB (EUR-Basis) laden und mit zod
      prüfen; Kurse als Decimal-String (nie `number`). Quelle, Format und Veröffentlichungszeit beim Umsetzen gegen die EZB-Doku prüfen.
- [ ] Tabelle `fx_rates` (`date`, `base` = `EUR`, `quote`, `rate` `numeric`; unique (`date`, `quote`)). **Ohne `organization_id`:**
      öffentliche Referenzdaten für alle Organisationen; in ADR 002 unter „Geltungsbereich“ ergänzen.
- [ ] Job `fx-rates-sync` über `runJob`, plattformweit: täglich nach Veröffentlichung der EZB; beim ersten Lauf Historie ab einem
      festen Startdatum (Konstante, z. B. 01.01.2026; liest nicht über Organisationen hinweg, welche Tage gebraucht werden).
- [ ] **Überwachung:** Plattformweite Läufe (`job_runs.organization_id` leer) erscheinen nicht im Sync-Status der Organisation.
      Deshalb Healthcheck **Pflicht** (`HEALTHCHECKS_FX_RATES_SYNC_URL`) und „Kurse bis“ im Datenstand des Dashboards (F11), damit ein
      hängender Kursabruf auffällt, bevor Summen nur noch mit Hinweis erscheinen.
- [ ] Kurs für Tag *d* = letzter veröffentlichter Kurs an oder vor *d*. Fehlt er (neue Währung, von der EZB nicht veröffentlicht),
      bleibt der Betrag unumgerechnet und die Summe zeigt einen Hinweis statt einer falschen Zahl.
- [ ] Tests mit msw (kein Aufruf der echten EZB), inkl. Wochenende, Feiertag, fehlender Währung, Wiederholung ohne Duplikate.

### 2.3 Demo-Daten mit Volumen (F12)
- [ ] Generator im Mock-Anbieter nach F12, deterministisch (fester Seed), nur erfundene Namen; Seed-Schritt für Clients und
      Zuordnung. Standard bleibt der kleine Mock (Tests laufen schnell).
- [ ] Hinweis in `docs/` (Entwicklung), wie man die lokale DB mit den großen Daten neu füllt.

### 2.4 Abfrage-Schicht (`packages/db`)
- [ ] Neues Modul (z. B. `ads-analytics.ts`) für Lesezugriffe von Nutzern: **nur** über `visibleProfilesScope()` (ADR 002), Filter
      nach Clients, Profilen, Ad-Typen, Zeitraum; Summen in SQL (`sum()` auf `numeric`/`bigint`, als String zurück).
- [ ] Clients für die Filterleiste (F2) aus den sichtbaren Profilen abgeleitet (Helfer im Access-Layer, vgl. „Offen für Phase 6“ in
      ADR 002), nutzbar für alle Rollen.
- [ ] Umrechnung in EUR je Tag über `fx_rates` in derselben Abfrage (F3), Originalwährung bleibt daneben erhalten.
- [ ] Abfragen: Summen je Zeile einer Ebene (F6) für Zeitraum und Vergleichszeitraum, Summenzeile über alle Zeilen, Tagesreihe für
      eine Auswahl, Summen je Client/Profil/Ad-Typ fürs Dashboard, Product-Ad-Suche nach ASIN inkl. `extra.asins` (F10). Obergrenze
      der Zeilen nach F7.
- [ ] Indizes prüfen (`EXPLAIN ANALYZE` mit den Demo-Daten aus 2.3), bei Bedarf ergänzen; Ergebnis hier notieren.
- [ ] Tests: fremde Organisation, ausgeblendetes Profil, gemischte Währungen, Tage ohne Kurs, Platzhalter-Entities (Name leer),
      entfernte Entities (`removed_at`), SB-Kampagnen ohne Kennzahlen (Preview-Lücke), SB-Targets ohne Ad Group, Kürzen bei der
      Obergrenze (Summenzeile bleibt vollständig).

### 2.5 API (`apps/api`)
- [ ] Middleware `requireFeature(key, 'view')`: prüft Entitlement und Rolle serverseitig (`resolveFeatureAccess`), `403` mit
      Fehlerformat `{ error: { code, message } }`.
- [ ] Endpunkte (POST, IDs im Body): Explorer-Zeilen je Ebene, Tagesreihe, Dashboard-Summen, ASIN-Suche, Clients für die
      Filterleiste. zod an der Grenze, OpenAPI und `schema.gen.ts` neu erzeugt. Beträge als Decimal-Strings, Kennzahlen aus 2.1.
- [ ] Antwort nennt Währung bzw. „umgerechnet“, Attribution je Summe (gemischt ja/nein, fehlende Werte), „Daten bis“, den Beginn
      der vorläufigen Tage und ob die Zeilen gekürzt sind.
- [ ] Komprimierung der Antworten (F7).

### 2.6 Web-Grundlagen
- [ ] **AG Charts Community** einführen (ADR 001; Version exakt pinnen, Lizenz und Mindestalter prüfen), Theme aus den Tokens
      (Hell/Dunkel), Achsen und Tooltips in Mono über die Formatierungs-Helper. Prüfen, wie sich vorläufige Tage markieren lassen
      (F5; z. B. Bereich über `crossLines`).
- [ ] AG Grid: deutsche `localeText` mit `LocaleModule` (offen seit Phase 0), benötigte Module registrieren (Sortierung, Filter, CSV
      nach F6). Nur registrierte Module nutzen, Konsole prüfen. Vergleich für Decimal-Strings (F7) in `packages/shared`.
- [ ] Filterleiste (F2, F4, F5) als eigene Komponente, kurzer Zustand in der URL, letzte Auswahl in `ui_state`.
- [ ] Bausteine: KPI-Kachel mit Veränderung, Hinweise „≈“, „gemischte Attribution“ und „Wert fehlt“, Kennzeichnung vorläufiger Tage.

### 2.7 Dashboard (`/dashboard`)
- [ ] Inhalt nach F11 im Kinetic-Bento-Look (Referenzen als Stil, nicht als Inhalt), Zustände je Widget.
- [ ] SB-Preview-Lücke erklären, sobald SB in der Auswahl ist (`plan.md` §5).

### 2.8 Explorer (`/ads/explorer/*`)
- [ ] Reiter, Drill-Down, Brotkrumen, Chart und Grid nach F6/F7; Spaltenauswahl, Sortierung, Filter; Zustand in der URL.
- [ ] Spalten je Ad-Typ lesbar: Attribution (F4), Klick-/View-Anteil bei SB/SD, sichtbare Impressionen und vCPM bei SD, Kostenart
      (`extra.costType`; Gebote bei vCPM als „je 1000 sichtbare Impressionen“ beschriftet), Platzhalter („unbekannt“) und entfernte
      Entities (Filter, Standard ausgeblendet; `phase-1.md` F10).
- [ ] Negatives ohne Kennzahlen; Product Ads mit ASIN/SKU, bei mehreren ASINs (`extra.asins`) als Liste in einem Popover der Zelle
      (Master/Detail ist AG Grid Enterprise).

### 2.9 Gespeicherte Ansichten (F8)
- [ ] Tabelle, Access-Funktionen (Profile und Clients beim Laden über den Access-Layer gefiltert), API, Audit-Events; ADR 002
      ergänzen. Menü „Ansichten“ in Dashboard und Explorer (speichern, laden, umbenennen, löschen, freigeben).

### 2.10 Mitglieder (`/admin/members`, F9)
- [ ] Liste mit Name, E-Mail, Rolle, Status (Link offen/aktiv); anlegen, Rolle ändern, entfernen, Link neu erzeugen; Schutz des
      letzten Admins. Eigene Endpunkte hinter `orgAdminOnly` nach den Sicherheitsregeln in F9; Audit mit handelndem Admin.
- [ ] Seite zum Setzen des Passworts über den Link (öffentlich, ohne Session, Token im Fragment), Link nur einmal nutzbar.
- [ ] Tests: fremde Organisation, abgelaufener, benutzter und neu erzeugter Link, Entfernen beendet Sessions, letzter Admin,
      Token taucht nicht im Log auf.

### 2.11 ASIN-Quick-Tool (F10)
- [ ] Popover in den Quick-Tools nach F10 (Feature `sp-explorer`, Recht `view`), Zeitraum aus der Filterleiste bzw. Standard,
      Sprung in den Explorer.

## `.env.example`

Neu in Phase 2 (Vorschlag): `HEALTHCHECKS_FX_RATES_SYNC_URL` (2.2), optional `AMAZON_ADS_MOCK_SCALE` (2.3, nur Entwicklung).

## Bewusst nicht in Phase 2

- Keine Änderungen an Amazon (Gebote, Budgets, Status): Phase 3
- Keine Tags, keine Produktgruppen: Phase 3/4
- Kein TACoS, kein Profit, keine Shop-Bestellungen: Phase 7 (SP-API)
- Keine Placement-Reports (`phase-1.md` F6), keine stündlichen Daten
- Keine Benachrichtigungen und kein E-Mail-Versand: Phase 5 (siehe F9)
- Keine Profil-Freigaben je Mitglied, keine Kundenzugänge: Phase 6
- Kein Datei-Import (`phase-1.md` 1.11, Auslöser erst nach Phase 2)

## Reihenfolge für Claude Code

2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 → 2.7 → 2.8 → 2.9 → 2.10 → 2.11.

Eine frische Session je Aufgabe (2.4 und 2.8 ggf. geteilt). Nach jedem Schritt: Tests grün, kleiner Commit, Häkchen in dieser
Datei, Umsetzungsnotizen unter der Aufgabe („Umsetzung (Stand für …)“ wie in Phase 1).
