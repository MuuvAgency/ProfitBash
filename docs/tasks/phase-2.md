# Phase 2 – Sehen

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5 inkl. „Kennzahlen je Ad-Typ“),
> `docs/tasks/phase-1.md` (Umsetzungsnotizen 1.5–1.9, F8, F12), `docs/decisions/` (001 Stack, 002 Mandanten-Modell,
> 003 Decimal-Library, 004 Amazon-API), `design/DESIGN.md` und die Referenzen `dashboard_home`, `werbekosten_ppc`.
>
> **Status: abgestimmt (2026-09-28).** Alle Fragen **F1–F14** unter „Fragen an Dominik“ sind entschieden (die Nummern gelten nur
> in dieser Datei; `phase-1.md` hat eigene F1–F14). Aufgaben, die von einer Frage abhängen, verweisen darauf.
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
- Summen über Währungen hinweg in einer wählbaren Anzeigewährung, Standard EUR (EZB-Tageskurse, `phase-1.md` F8, F3).

## Definition of Done

- [ ] Dashboard und Explorer zeigen mit den Mock-Daten (SP, SB, SD; EUR, GBP, SEK) dieselben Summen wie eine unabhängige
      SQL-Prüfung (Test), in Originalwährung bei einer Währung, sonst in der Anzeigewährung (Standard EUR) mit „≈“ (F3).
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
  **Entschieden (Dominik, 2026-09-28): ein Explorer für alle Ad-Typen, nach Ad-Typ filterbar.**
- **F2 – Auswahl von Clients und Profilen.** Wie wählt man aus, was Dashboard und Explorer zeigen? Empfehlung: eine
  **Filterleiste oben** (gleich in Dashboard und Explorer): Clients (mehrfach), darin Profile (mehrfach), Standard „alle
  sichtbaren“. Profile ohne Client erscheinen unter „Ohne Client“.
  - Die Auswahl zeigt nur Clients mit sichtbaren Profilen, auch für Editoren und Viewer (heute sieht nur der Admin die Clients).
    Die Liste entsteht über den Access-Layer, nicht über eine neue Abfrage nach Organisation (ADR 002).
  - Die URL enthält nur Kurzes (Zeitraum, Ebene, Drill-Down, Client-IDs oder die ID einer gespeicherten Ansicht), damit man Links
    teilen und mit der Zurück-Taste arbeiten kann. Eine lange Liste einzelner Profile kommt nicht in die URL (Regel in `CLAUDE.md`),
    sondern in die zuletzt benutzte Auswahl je Nutzer (`ui_state`) bzw. in eine gespeicherte Ansicht (F8).
  **Entschieden (Dominik, 2026-09-28): wie empfohlen.**
- **F3 – Währung.** Empfehlung: Stammen alle ausgewählten Profile aus einer Währung, zeigt die App diese Währung. Sonst rechnet sie
  **in EUR um, je Tag mit dem EZB-Kurs dieses Tages** (für Wochenenden und Feiertage gilt der letzte Kurs davor), und kennzeichnet
  Summen mit „≈“ (`plan.md` §5). Keine wählbare Anzeigewährung (später nachrüstbar). Der Explorer zeigt je Zeile die
  Originalwährung, Summenzeilen folgen derselben Regel.
  **Entschieden (Dominik, 2026-09-28): Anzeigewährung wählbar.** In der Filterleiste (F2) eine Auswahl „Währung“, Standard
  **automatisch**: eine Währung in der Auswahl → diese, sonst EUR. Wählbar sind EUR, USD und die Währungen der sichtbaren Profile
  (Liste über den Access-Layer), soweit die EZB sie veröffentlicht. Umgerechnet wird je Tag über EUR mit den EZB-Kursen dieses Tages
  (Betrag ÷ Kurs der Quellwährung × Kurs der Zielwährung; Wochenenden und Feiertage wie oben), Summen mit „≈“, sobald etwas
  umgerechnet wurde. Der Explorer zeigt je Zeile weiter die Originalwährung, Summenzeilen und Dashboard die Anzeigewährung. Die
  Auswahl wird mit der Filterleiste gespeichert (`ui_state`, gespeicherte Ansichten).
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
  **Entschieden (Dominik, 2026-09-28): wie empfohlen** (Standard „wie Konsole“, Umschalter „14 Tage, nur Klicks“).
- **F5 – Zeitraum und Vergleich.** Empfehlung: Voreinstellungen Gestern, Letzte 7 / 14 / 30 Tage, Dieser Monat, Letzter Monat,
  frei wählbar; Standard **Letzte 30 Tage**.
  - Vergleich: **Vorperiode gleicher Länge** (Standard; bei „Dieser Monat“ am 10. also die 10 Tage davor, nicht der ganze
    Vormonat), Vorjahr, aus. Vorjahr ist erst wählbar, wenn die DB Daten dafür hat, also frühestens ein Jahr nach dem ersten echten
    Sync (Amazon liefert höchstens 95 Tage rückwirkend).
  - Tage sind Kalendertage in der Zeitzone des jeweiligen Profils (so liegen sie schon in der DB), „Gestern“ bezieht sich auf die
    Zeitzone des Browsers.
  - Die letzten 14 Tage vor „Daten bis“ sind **vorläufig** (Amazon korrigiert noch) und im Chart als Bereich markiert.
  **Entschieden (Dominik, 2026-09-28), Voreinstellungen:** Letzte 30 Tage (Standard), Letzte 14 Tage, Diese Woche, Letzte Woche,
  Letzter Monat, Vorletzter Monat, Vor-vorletzter Monat, Letzte 12 Monate, Dieses Jahr bis jetzt, Letztes Jahr, dazu frei wählbar.
  Wochen beginnen am Montag. Reichen die Daten nicht so weit zurück (Historie ab dem ersten Sync, höchstens 95 Tage davor),
  zeigt die App ab wann Daten vorliegen, statt Lücken als 0 zu zeigen.
  **Entschieden (Dominik, 2026-09-28), Rest:** „Gestern“, „Letzte 7 Tage“ und „Dieser Monat“ kommen dazu. Vergleich wie empfohlen:
  Vorperiode gleicher Länge (Standard), Vorjahr, aus.
  Damit die Voreinstellungen: Gestern, Letzte 7 Tage, Letzte 14 Tage, Letzte 30 Tage (Standard), Diese Woche, Letzte Woche, Dieser
  Monat, Letzter Monat, Vorletzter Monat, Vor-vorletzter Monat, Letzte 12 Monate, Dieses Jahr bis jetzt, Letztes Jahr, frei wählbar.
- **F6 – Explorer-Ebenen und Drill-Down.** Empfehlung: Reiter **Portfolios · Kampagnen · Ad Groups · Targets · Product Ads ·
  Suchbegriffe · Negatives**. Ein Klick auf eine Zeile filtert die nächste Ebene darauf (Brotkrumen oben: Client › Profil ›
  Kampagne › Ad Group), die Reiter bleiben erreichbar. SB-Targets ohne Ad Group (Kampagnenebene) erscheinen beim Drill-Down von der
  Kampagne direkt unter Targets. Portfolio-Kennzahlen = Summe seiner Kampagnen. Negatives ohne Kennzahlen.
  Ein **Chart** über dem Grid zeigt den Tagesverlauf von bis zu zwei Kennzahlen für die aktuelle Auswahl (oder die markierten
  Zeilen). Dazu **CSV-Export** der geladenen Zeilen (Community-Modul von AG Grid, wenig Aufwand). Frage: CSV-Export jetzt
  oder später?
  **Stand (2026-09-28):** Dominik hat nachgefragt; einfach erklärt: Reiter je Ebene, Klick auf eine Kampagne zeigt nur noch deren
  Ad Groups usw., Pfad oben zum Zurückspringen, Chart über der Tabelle.
  **Entschieden (Dominik, 2026-09-28): Aufbau wie beschrieben, CSV-Export jetzt** (die geladenen Zeilen in der aktuellen
  Filterung und Sortierung).
- **F7 – Datenmenge im Grid.** Empfehlung: Der Server rechnet Summen je Zeile, das Grid bekommt alle Zeilen der Auswahl
  (Sortieren und Filtern im Browser, schnell und einfach) bis zu einer Obergrenze von **10 000 Zeilen**.
  - Bei mehr Zeilen lädt es die 10 000 mit dem höchsten Spend und sagt das deutlich: Filter und Sortierung wirken dann nur auf diese
    10 000, die Summenzeile kommt trotzdem vom Server und gilt für alles.
  - Sortieren und Filtern von Beträgen ohne Umweg über `number`: ein Vergleich für Decimal-Strings in `packages/shared` (das Web
    bekommt kein `decimal.js`, ADR 003).
  - Die Antwort wird komprimiert (10 000 Zeilen mit Vergleichszeitraum sind sonst mehrere MB).
  - Wird das bei echten Konten zu eng, kommt das Infinite Row Model (Community) mit Sortierung und Filter auf dem Server als eigene
    Aufgabe.
  **Entschieden (Dominik, 2026-09-28): wie empfohlen, Obergrenze 10 000 Zeilen.**
- **F8 – Gespeicherte Filter.** Empfehlung: **gespeicherte Ansichten** (Filterleiste, Reiter, Spalten, Sortierung, Chart-Kennzahlen)
  in einer eigenen Tabelle `saved_views` (Organisation, Besitzer, Name, Bereich `dashboard`/`explorer`, Zustand als jsonb,
  `shared`).
  - Persönliche Ansichten darf jede Rolle anlegen, auch Viewer (sie ändern keine Daten). Freigeben für die Organisation: Editoren und
    Admins. Ändern und löschen: Besitzer und Org-Admins.
  - Beim Laden einer Ansicht filtert der Access-Layer die darin genannten Profile und Clients (wichtig ab Phase 6, wenn nicht jeder
    alles sieht). `saved_views` kommt in ADR 002 unter „Geltungsbereich“.
  - Alternative: nur persönlich in `ui_state` (weniger Aufwand, aber ohne Teilen im Team).
  **Entschieden (Dominik, 2026-09-28): wie empfohlen, persönlich und im Team teilbar.**
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
  **Entschieden (Dominik, 2026-09-28): wie empfohlen, Einmal-Link ohne E-Mail-Versand.**
- **F10 – ASIN-Quick-Tool.** Der Plan nennt nur den Namen. Empfehlung: Popover in den Quick-Tools: eine oder mehrere ASINs eingeben
  (auch aus der Zwischenablage, getrennt durch Leerzeichen, Komma oder Zeilenumbruch) → Liste der Product Ads mit Profil, Kampagne,
  Ad Group, Ad-Typ, Status und Kennzahlen im gewählten Zeitraum; Klick springt in den Explorer (Reiter Product Ads, gefiltert).
  - Gesucht wird in der ASIN des Ads **und** in den ASINs von SB/SD-Ads mit mehreren Produkten (`extra.asins`).
  - Amazon misst Kennzahlen je Ad, nicht je ASIN. Ein Ad mit mehreren ASINs erscheint deshalb einmal, markiert mit „teilt sich
    n ASINs“, und wird nicht auf die einzelnen ASINs aufgeteilt oder doppelt gezählt.
  - Bekannte Lücke: SD-Product-Ads, die nur eine SKU tragen (`phase-1.md` 1.9), findet die Suche nach ASIN nicht; das Popover sagt
    das. Suche nach SKU zusätzlich?
  - Gemeint so, oder etwas anderes (z. B. Keyword-Recherche zu einer ASIN)?
  **Entschieden (Dominik, 2026-09-28): wie empfohlen, zusätzlich Suche nach SKU** (dann findet das Tool auch SD-Ads nur mit SKU;
  Eingaben werden als ASIN oder SKU erkannt bzw. in beiden Feldern gesucht).
- **F11 – Inhalt des Dashboards.** Die Referenzen (`dashboard_home`, `werbekosten_ppc`) zeigen Profit, Shop-Bestellungen und
  Kanäle, die es erst ab Phase 7 bzw. gar nicht gibt. Empfehlung für Phase 2:
  - **KPI-Kacheln** Spend, Umsatz (Ads), ACoS, ROAS, Käufe (Ads, von Amazon der Werbung zugeordnet), Klicks mit CPC, jeweils mit
    Veränderung zum Vergleich. Die große Hero-Kachel (dunkel, wie „Netto-Profit“ in der Referenz) zeigt Spend und Umsatz mit
    Tagesverlauf.
  - **Anteil je Ad-Typ** (Spend, Umsatz, ACoS); **Tabelle je Client bzw. Profil** mit denselben Kennzahlen und Sprung in den
    Explorer; **Datenstand** („Daten bis“, letzter Sync, Hinweis bei hängenden Ad-Typen, Stand der Wechselkurse).
  - Kein TACoS und kein Profit (Phase 7), keine erfundenen Kacheln wie „Market Velocity“.
  **Stand (2026-09-28):** Dominik fragt nach organischen Umsätzen. Die gibt es nicht über die Ads-API, nur über die SP-API (Phase 7;
  laut `plan.md` §2 ginge ein schmaler „Sales-Import“ früher, sobald die SP-API freigegeben ist). Ohne SP-API-Zugang bleibt Phase 2
  bei Ads-Kennzahlen.
  **Entschieden (Dominik, 2026-09-28): Kacheln wie empfohlen, nur Ads-Kennzahlen.** Außerhalb von Phase 2 offen: ob die
  SP-API-Registrierung (`phase-0.md` 0.0e) für ein Einzelunternehmen dieselbe Hürde hat wie das Partner Network (Dominik prüft).
- **F12 – Demo-Daten mit Volumen.** Die Mock-Daten haben 16 Kampagnen und 26 Targets; Grid-Layout, Filter und Abfragetempo lassen
  sich daran nicht prüfen. Empfehlung: ein **Generator im Mock-Anbieter** (deterministisch, eigener Schalter, z. B.
  `AMAZON_ADS_MOCK_SCALE=large`): 6 Profile in EUR/GBP/SEK/PLN (neue Mock-Profile), ~300 Kampagnen, **~12 000 Targets** (über der
  Grenze aus F7, damit das Kürzen getestet wird), 95 Tage, alle drei Ad-Typen, nur erfundene Namen. Entities und Kennzahlen kommen
  über denselben Sync wie echte Daten (kein Direkt-Insert); 3 Clients und die Zuordnung der Profile legt ein Seed-Schritt an (Clients
  kommen nicht von Amazon).
  **Entschieden (Dominik, 2026-09-28): wie empfohlen.**
- **F13 – Mobil.** Empfehlung: Dashboard **voll responsive** (eine Spalte unter 768 px, `DESIGN.md` §6). Explorer ab Tablet voll
  nutzbar; auf dem Handy dieselbe Seite, das Grid scrollt waagerecht in seiner Kachel, Chart und Filterleiste stapeln sich. Keine
  eigene Handy-Ansicht des Explorers in Phase 2.
  **Entschieden (Dominik, 2026-09-28): wie empfohlen.**
- **F14 – Tabellen bei klassischer Scrollbar (offen aus Phase 1).** Sync-Status und Profiltabelle passen bei 1440 px nur mit
  Overlay-Scrollbars ohne waagerechtes Scrollen; mit klassischer Scrollbar scrollen sie waagerecht (Amazon-Konto und Ergebnis sind
  schon heute gekürzt, der volle Text steht im Tooltip, der auf Touch fehlt). Empfehlung: **so lassen**. Die Tabellen im Dashboard
  (F11) von vornherein so bauen, dass sie bei 1440 px auch mit klassischer Scrollbar passen. Das Explorer-Grid hat mehr Spalten als
  1440 px fassen und scrollt immer waagerecht (erste Spalte fest).
  **Entschieden (Dominik, 2026-09-28): jetzt anpassen** (eigene Aufgabe 2.12): Sync-Status und Profiltabelle passen bei 1440 px
  auch mit klassischer Scrollbar ohne waagerechtes Scrollen.

## Aufgaben

### 2.1 Kennzahlen-Rechenkern (`packages/engine`)
- [x] `decimal.js` als **eine** konfigurierte Kopie (`Decimal.clone`, ADR 003), nie die globale Konfiguration.
- [x] Summen und abgeleitete Kennzahlen aus Decimal-Strings: CTR, CPC, CVR, ACoS, ROAS, CPM, vCPM (nur SD), Veränderung zum Vergleich
      (absolut und relativ). Division durch 0 → `null`. Ergebnis als Decimal-String mit fester Rechengenauigkeit; gerundet wird erst
      bei der Anzeige.
- [x] Attribution nach F4: Funktion, die je Ad-Typ, Ebene, Kontotyp (Seller/Agency/Vendor) und Einstellung die Spalten für Umsatz,
      Käufe und Einheiten wählt; meldet, ob eine Summe gemischte Attribution enthält und ob Werte fehlen (Tabelle unter F4).
- [x] Tests für jede Zeile der Tabelle unter F4 und die Regeln aus `plan.md` §5: SB/SD `*_14d` inkl. Views; SD-Same-SKU gegen den
      Klick-Anteil; vCPM-Kosten aus `cost` und `viewable_impressions`; SP-Klick-Spalten leer; fehlende Werte nie als 0.
- [x] Umsetzung (Stand für 2.2 und später):
  - **Decimal** (`decimal.ts`): `Dec` = `Decimal.clone` mit 34 signifikanten Stellen (wie decimal128), `ROUND_HALF_EVEN`; ein
    Test belegt, dass die globale Konfiguration unverändert bleibt. `parseDecimal` nimmt nur Decimal-Strings ohne Exponent
    (`-?\d+(\.\d+)?`, sonst `TypeError`), `formatDecimal` schreibt ohne Exponent, `-0` als `0`. Alle Werte (auch Zähler) sind
    Decimal-Strings, weil SQL-Summen über `bigint`/`numeric` als String kommen.
  - **Kennzahlen** (`metrics.ts`): `deriveMetrics` liefert Anteile als Bruch (0.25 = 25 %, passend zu `formatPercent`): CTR =
    Klicks/Impressionen, CPC = Kosten/Klicks, CVR = Käufe/Klicks, ACoS = Kosten/Umsatz, ROAS = Umsatz/Kosten, CPM und vCPM je
    1000. vCPM nutzt `viewableCost` (Kosten nur der Zeilen mit sichtbaren Impressionen, in SQL `sum(cost) filter (where
    viewable_impressions is not null)`), sonst wäre vCPM einer Summe mit SP/SB falsch. `sales`/`purchases` müssen aus denselben
    Zeilen stammen wie `cost`; bei teilweiser Abdeckung übergibt der Aufrufer `null`. Negative Korrekturen werden weiter
    gerechnet (z. B. negativer ACoS), die Anzeige entscheidet 2.8. `change` bezieht die relative Veränderung auf |Vergleichswert|.
    `sumWithGaps` zählt fehlende Werte nicht als 0 und meldet `coverage` (`full`/`partial`/`none`).
  - **Attribution** (`attribution.ts`): `selectAttribution({ adProduct, level, accountType, setting })` liefert je Feld (Umsatz,
    Käufe, Einheiten, jeweils auch Same-SKU) den Spaltennamen wie in `DailyMetricValues` (`sales7d`, `salesClicks14d` …) oder
    `null`, dazu `basis`/`sameSkuBasis` (Fenster, Views ja/nein; `null`, wenn kein Wert geliefert wird). Nur `accountType`
    `vendor` hat „wie Konsole“ 14 Tage, alle anderen (auch unbekannte) 7 Tage. SB „wie Konsole“ nutzt bei Targets `units14d`
    (1.10 prüft, was die Konsole zeigt). `METRIC_AVAILABILITY` hält fest, welche Spalten der Report je Ad-Typ und Ebene füllt
    (SD-Suchbegriffe: kein Report); der Abgleich mit `REPORT_DEFINITIONS` und `createReportRowSchema` steht in
    `packages/amazon-ads/src/metric-availability.test.ts` (dort, damit `packages/engine` ohne Node-Typen und ohne Abhängigkeit
    auf `@profitbash/amazon-ads` bleibt; amazon-ads hat dafür `@profitbash/engine` als devDependency).
  - **Für 2.4/2.5:** `summarizeAttribution` bekommt je Kombination aus Ad-Typ und Kontotyp, die in den Zeilen einer Summe
    **vorkommt**, eine Auswahl (höchstens 3 × 3) und meldet `mixed`, `sameSkuMixed` und `coverage` je Feld; SQL-`sum()` überspringt
    `null` still, die Lücke steht nur dort. Die Spaltenwahl je Zeile lässt sich als `CASE` über Ad-Typ und Kontotyp bauen.
    Die Einstellung `'console' | 'clicks14d'` braucht das Web (Filterleiste, `ui_state`, gespeicherte Ansichten) als zod-Enum in
    `@profitbash/shared` (das Web darf `@profitbash/engine` wegen `decimal.js` nicht importieren, ADR 003); dann in der Engine von
    dort übernehmen.
  - Review (unabhängig): keine kritischen Befunde. Übernommen: keine Grundlage, wo Amazon keinen Wert liefert (sonst falscher
    Hinweis „gemischt“ bei SP- und SB-Suchbegriffen), vCPM über `viewableCost`, Test für negative Korrekturen, Doku zu leeren
    Eingaben. Bewusst nicht: Vergleichsspalte für SD-Same-SKU (`sameSkuBasis` sagt „nur Klick“; eine Kennzahl, die Same-SKU mit
    dem Umsatz verrechnet, gibt es in Phase 2 nicht), Groß-/Kleinschreibung von `accountType` (Amazon liefert klein, 1.10 prüft).

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
- [ ] Alle von der EZB veröffentlichten Währungen speichern (die Anzeigewährung ist wählbar, F3; USD gehört immer zur Auswahl).
- [ ] Kurs für Tag *d* = letzter veröffentlichter Kurs an oder vor *d*. Fehlt er (neue Währung, von der EZB nicht veröffentlicht),
      bleibt der Betrag unumgerechnet und die Summe zeigt einen Hinweis statt einer falschen Zahl. Umrechnung zwischen zwei
      Nicht-EUR-Währungen über EUR mit den Kursen desselben Tages (F3).
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
- [ ] Umrechnung in die Anzeigewährung (F3: automatisch, EUR, USD oder eine Profilwährung) je Tag über `fx_rates` in derselben
      Abfrage, Originalwährung bleibt daneben erhalten. Wählbare Währungen aus den sichtbaren Profilen (Access-Layer) plus EUR, USD.
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
- [ ] Endpunkte (POST, IDs im Body): Explorer-Zeilen je Ebene, Tagesreihe, Dashboard-Summen, ASIN-Suche, Clients und wählbare
      Währungen für die Filterleiste; Anzeigewährung als Parameter (F3). zod an der Grenze, OpenAPI und `schema.gen.ts` neu erzeugt.
      Beträge als Decimal-Strings, Kennzahlen aus 2.1.
- [ ] Antwort nennt die Währung und ob umgerechnet wurde, Attribution je Summe (gemischt ja/nein, fehlende Werte), „Daten bis“,
      den Beginn der vorläufigen Tage und ob die Zeilen gekürzt sind.
- [ ] Komprimierung der Antworten (F7).

### 2.6 Web-Grundlagen
- [ ] **AG Charts Community** einführen (ADR 001; Version exakt pinnen, Lizenz und Mindestalter prüfen), Theme aus den Tokens
      (Hell/Dunkel), Achsen und Tooltips in Mono über die Formatierungs-Helper. Prüfen, wie sich vorläufige Tage markieren lassen
      (F5; z. B. Bereich über `crossLines`).
- [ ] AG Grid: deutsche `localeText` mit `LocaleModule` (offen seit Phase 0), benötigte Module registrieren (Sortierung, Filter, CSV
      nach F6). Nur registrierte Module nutzen, Konsole prüfen. Vergleich für Decimal-Strings (F7) in `packages/shared`.
- [ ] Filterleiste (F2, F3, F4, F5) als eigene Komponente (Clients/Profile, Anzeigewährung, Attribution, Zeitraum, Vergleich), kurzer
      Zustand in der URL, letzte Auswahl in `ui_state`.
- [ ] Bausteine: KPI-Kachel mit Veränderung, Hinweise „≈“, „gemischte Attribution“ und „Wert fehlt“, Kennzeichnung vorläufiger Tage.

### 2.7 Dashboard (`/dashboard`)
- [ ] Inhalt nach F11 im Kinetic-Bento-Look (Referenzen als Stil, nicht als Inhalt), Zustände je Widget.
- [ ] SB-Preview-Lücke erklären, sobald SB in der Auswahl ist (`plan.md` §5).

### 2.8 Explorer (`/ads/explorer/*`)
- [ ] Reiter, Drill-Down, Brotkrumen, Chart und Grid nach F6/F7; Spaltenauswahl, Sortierung, Filter; Zustand in der URL.
- [ ] CSV-Export der geladenen Zeilen in aktueller Filterung und Sortierung (F6); Beträge als Decimal-Strings mit Währungsspalte,
      Hinweis im Export, wenn die Zeilen gekürzt sind (F7).
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

### 2.12 Alte Tabellen ohne waagerechtes Scrollen (F14)
- [ ] Sync-Status (`/ops/sync`) und Profiltabelle (`/admin/connections`) passen bei 1440 px (Sidebar ein- und ausgeklappt) auch mit
      klassischer Scrollbar ohne waagerechtes Scrollen; gekürzte Texte auch auf Touch lesbar (nicht nur per Tooltip).
- [ ] Im Browser-Pane mit klassischer Scrollbar prüfen (Scrollbar-Breite per CSS nachgestellt, da das Pane Overlay-Scrollbars hat).

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

2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 → 2.7 → 2.8 → 2.9 → 2.10 → 2.11 → 2.12.

Eine frische Session je Aufgabe (2.4 und 2.8 ggf. geteilt). Nach jedem Schritt: Tests grün, kleiner Commit, Häkchen in dieser
Datei, Umsetzungsnotizen unter der Aufgabe („Umsetzung (Stand für …)“ wie in Phase 1).
