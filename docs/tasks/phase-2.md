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
      läuft über `runJob` und erscheint im Sync-Status (Healthchecks optional, siehe 2.2).
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
  **Entschieden (Dominik, 2026-09-28): wie empfohlen.** Dazu (2026-09-28): Die Auswahl der Filterleiste ist **zwischen Dashboard
  und Explorer geteilt** (eine zuletzt benutzte Auswahl je Nutzer).
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
  **Entschieden (Dominik, 2026-09-28): wie empfohlen, persönlich und im Team teilbar.** Dazu (2026-09-29): Sortierung
  mitspeichern; beim Entfernen eines Mitglieds bleiben seine freigegebenen Ansichten, die persönlichen werden gelöscht (2.9).
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
- [x] Eigenes Paket für die externe Quelle (Leitplanke 3), z. B. `packages/ecb`: Referenzkurse der EZB (EUR-Basis) laden und mit zod
      prüfen; Kurse als Decimal-String (nie `number`). Quelle, Format und Veröffentlichungszeit beim Umsetzen gegen die EZB-Doku prüfen.
- [x] Tabelle `fx_rates` (`date`, `base` = `EUR`, `quote`, `rate` `numeric`; unique (`date`, `quote`)). **Ohne `organization_id`:**
      öffentliche Referenzdaten für alle Organisationen; in ADR 002 unter „Geltungsbereich“ ergänzen.
- [x] Job `fx-rates-sync` über `runJob`, plattformweit: täglich nach Veröffentlichung der EZB; beim ersten Lauf Historie ab einem
      festen Startdatum (Konstante, z. B. 01.01.2026; liest nicht über Organisationen hinweg, welche Tage gebraucht werden).
- [x] **Überwachung:** Plattformweite Läufe (`job_runs.organization_id` leer) erscheinen nicht im Sync-Status der Organisation.
      Deshalb Healthcheck **Pflicht** (`HEALTHCHECKS_FX_RATES_SYNC_URL`) und „Kurse bis“ im Datenstand des Dashboards (F11), damit ein
      hängender Kursabruf auffällt, bevor Summen nur noch mit Hinweis erscheinen.
      **Geändert (Dominik, 2026-09-28): ohne externes Konto.** Der Kursabruf erscheint im Sync-Status jeder Organisation; das
      Dashboard warnt, wenn die Kurse älter als 4 Tage sind (2.7); einen Absturz der App meldet Railway. `HEALTHCHECKS_FX_RATES_SYNC_URL`
      bleibt optional wie die anderen Ping-URLs (leer = kein Ping). E-Mail-Warnungen kommen mit Phase 5.
- [x] Alle von der EZB veröffentlichten Währungen speichern (die Anzeigewährung ist wählbar, F3; USD gehört immer zur Auswahl).
- [x] Kurs für Tag *d* = letzter veröffentlichter Kurs an oder vor *d*. Fehlt er (neue Währung, von der EZB nicht veröffentlicht),
      bleibt der Betrag unumgerechnet und die Summe zeigt einen Hinweis statt einer falschen Zahl. Umrechnung zwischen zwei
      Nicht-EUR-Währungen über EUR mit den Kursen desselben Tages (F3).
- [x] Tests mit msw (kein Aufruf der echten EZB), inkl. Wochenende, Feiertag, fehlender Währung, Wiederholung ohne Duplikate.
- [x] Umsetzung (Stand für 2.4 und später):
  - **Quelle** (geprüft am 2026-09-28 gegen die EZB-Seite „Euro foreign exchange reference rates“ und echte Antworten): SDMX Data API
    `https://data-api.ecb.europa.eu/service/data/EXR/D..EUR.SP00.A?startPeriod=…&format=csvdata&detail=dataonly`. Ein Abruf liefert
    alle Währungen für einen beliebigen Zeitraum (die XML-Dateien `eurofxref-*` können nur „heute“, 90 Tage oder alles seit 1999).
    Veröffentlichung an TARGET-Arbeitstagen gegen 16:00 MEZ (Konzertation 14:10); keine Werte an Wochenenden und TARGET-Feiertagen
    (Neujahr, Karfreitag, Ostermontag, 1. Mai, 25./26.12.). Antwort: CSV mit CRLF, Werte ohne Tausendertrennzeichen, Nullen am Ende
    gekürzt (`178.5`); leerer Zeitraum = HTTP 200 mit leerem Body. Stand 2026-09-28: 29 Währungen (u. a. USD, GBP, SEK, PLN, TRY;
    BGN fehlt seit dem Euro-Beitritt 2026, RUB seit 03/2022).
  - **Paket `@profitbash/ecb`** (`rates.ts`): `fetchEcbRates({ startDate, endDate? })` → `{ date, currency, rate }[]`, Kurs als
    Decimal-String wie geliefert. Spalten über den Kopf gefunden; Zeile mit anderer Spaltenzahl, Kurs ≤ 0, Exponent, Basis ≠ EUR
    oder doppelter Tag je Währung → `EcbError` (ohne Rohdaten); Beobachtungen ohne Wert (leer/`NaN`) fehlen. 404 = keine Kurse,
    5xx/Netzwerk 3 Versuche mit Backoff, 4xx sofort Fehler.
  - **Tabelle `fx_rates`** (Migration `0015_fx_rates`): Primärschlüssel (`quote`, `date`) statt nur unique, damit „letzter Kurs an
    oder vor *d*“ je Währung ein Index-Zugriff ist; Checks: `base = 'EUR'`, `quote` drei Großbuchstaben und nicht EUR, `rate > 0`.
    `packages/db/src/fx-rates.ts`: `upsertFxRates` (Upsert, zählt `inserted`/`updated`/`unchanged`; gleicher Wert in anderer
    Schreibweise ist unverändert), `latestFxRateDate`, `fxRatesOnOrBefore(db, date, currencies)` (Map; EUR immer `1`; Währung ohne
    Kurs bis *d* fehlt).
  - **Umrechnung** (`packages/engine/src/fx.ts`): `convertAmount(amount, from, to, rates)` = Betrag ÷ Kurs(from) × Kurs(to) mit `Dec`,
    `null`, wenn ein Kurs fehlt. **Für 2.4:** dieselbe Regel in SQL je Tag (lateral bzw. `distinct on` über `fx_rates` mit
    `date <= Tag`), Ergebnis gegen `convertAmount` testen; fehlt ein Kurs, den Betrag nicht in die umgerechnete Summe zählen und
    melden (wie `coverage` in `sumWithGaps`).
  - **Job `fx-rates-sync`** (`apps/worker/src/jobs/fx-rates-sync.ts`): plattformweit über `runJob` (`organization_id` und `scope`
    leer), täglich **06:00 Europe/Berlin** (Dominik, 2026-09-28: holt die Kurse des Vortags zusammen mit dem Amazon-Sync). Lädt ab
    dem letzten gespeicherten Tag minus 7 Tage (Korrekturen der EZB; nie vor `FX_RATES_START_DATE` = 2026-01-01), beim ersten Lauf
    ab dem Startdatum, und schreibt in einer Transaktion. Zähler `fetched`, `inserted`, `updated`, `unchanged`, `currencies`. Eine
    leere Antwort ist ein Fehlschlag (der Zeitraum enthält immer einen EZB-Arbeitstag; leer heißt: Endpunkt oder Format geändert).
    Nach einem Fehlschlag plant der Worker einen neuen Versuch nach 1 Std. ein, höchstens 3 (Daten `{ retry }`). Ist
    `fx_rates` beim Start des Workers leer, plant er sofort einen Lauf ein (sonst gäbe es bis zum nächsten Morgen keine Kurse).
    Tests ersetzen den Abruf über `startWorker({ fetchFxRates })`.
  - **Sync-Status:** `SHARED_PLATFORM_JOB_NAMES` (`fx-rates-sync`) in `@profitbash/shared`; `GET /api/job-runs` zeigt deren
    plattformweite Läufe in jeder Organisation, andere plattformweite (Auslöser, Cleanup) weiter nicht. Filter „Job“ enthält
    „Wechselkurse (EZB)“, die Spalte „Amazon-Konto“ zeigt „EZB, für alle Organisationen“.
  - Review (unabhängig): keine kritischen Befunde. Übernommen: unbenutzter Import (Lint), leere Antwort als Fehlschlag statt
    „Erfolgreich · 0 Kurse“, Wiederholung nach 1 Std., Abbruch beim Lesen des Bodys wie ein Netzwerkfehler, Prüfung über
    `SHARED_PLATFORM_JOB_NAMES` im Web. Bewusst nicht: Test „Start mit vorhandenen Kursen plant nichts ein“ (bräuchte einen zweiten
    Worker auf derselben Test-DB; die Bedingung ist eine Zeile in `worker.ts`), 404 bleibt „keine Kurse“ (SDMX-Standard; der Job
    meldet die leere Antwort ohnehin als Fehler).
  - **Für 2.5/2.7:** „Kurse bis“ = `latestFxRateDate`. Vorsicht bei der vereinbarten Warnung „älter als 4 Tage“: Am Dienstag nach
    Ostern um 06:00 ist der letzte Kurs vom Gründonnerstag (5 Kalendertage), ohne dass etwas hängt. Die Grenze deshalb in
    TARGET-Arbeitstagen zählen oder großzügiger wählen (z. B. mehr als 5 Kalendertage) und mit Ostern und Weihnachten testen.
    **Entschieden (Dominik, 2026-09-28): Warnung, wenn der letzte Kurs mehr als 5 Kalendertage alt ist** (einfacher als
    EZB-Arbeitstage; Ostern: Dienstag nach Ostern 5 Tage, also keine Warnung). Mit Ostern und Weihnachten testen.
  - **Offen für 0.9 (Deploy):** Ohne Healthchecks.io fehlt auch die externe Überwachung des Backups (`HEALTHCHECKS_DB_BACKUP_URL`,
    `docs/deploy.md`); vor dem Deploy mit Dominik klären, ob das Backup anders überwacht wird.
    **Entschieden (Dominik, 2026-09-29): in der App.** Das Backup schreibt seine Läufe in die eigene Datenbank (Sync-Status),
    das Dashboard warnt Admins, wenn das letzte gelungene Backup älter als 26 Std. ist; umgesetzt mit 0.9 (`phase-0.md`).

### 2.3 Demo-Daten mit Volumen (F12)
- [x] Generator im Mock-Anbieter nach F12, deterministisch (fester Seed), nur erfundene Namen; Seed-Schritt für Clients und
      Zuordnung. Standard bleibt der kleine Mock (Tests laufen schnell).
- [x] Hinweis in `docs/` (Entwicklung), wie man die lokale DB mit den großen Daten neu füllt.
- [x] Umsetzung (Stand für 2.4 und später):
  - **Entschieden (Dominik, 2026-09-28): ein Befehl** (`pnpm demo:load`) statt Verbinden und Synchronisieren über die Oberfläche.
  - **Generator** (`packages/amazon-ads/src/mock-large.ts`): `LARGE_MOCK_PROFILES` (6 EU-Profile: DE, FR, IT in EUR, UK in GBP als
    Vendor, SE in SEK als Agency, PL in PLN; IDs `71000000000000xx`, Namen „Demo …“), `largeMockAccount(profile)` mit Mulberry32
    je Profil (fester Seed aus der Profil-ID). Ergebnis: 300 Kampagnen (210 SP, 42 SB, 48 SD), 669 Ad Groups, 12 187 Targets,
    942 Negatives, 1 441 Product Ads, 16 146 Suchbegriffe je Tag (vor Tagen ohne Aktivität). Ein Test prüft je Report-Typ und
    Profil die Zeilen gegen die Schemas des Clients und auf doppelte Schlüssel (die lehnt der Import ab). Sortiment je Profil aus erfundenen
    Produktwörtern (Marken „Waldkauz“, „Lumen“, „Kranich“), daraus Kampagnen-, Ad-Group-, Keyword- und Portfolio-Namen.
    Sonderfälle: rund ein Viertel der SB-Kampagnen mit `withoutReports` (v3-Preview-Lücke: Export ja, Report-Zeilen nein), SP-Negatives
    auch auf Kampagnenebene (SB/SD nur auf Ad-Group-Ebene: deren Export trägt keine `campaignId`, eine Kampagnen-Negative ließe sich
    nicht zuordnen), SB-Kollektionen und SD-Bild-Ads mit mehreren ASINs, SD-vCPM-Kampagnen, Vendor ohne SKU, pausierte und
    archivierte Entities. SB-Targets ohne Ad Group erzeugt der Generator nicht (gleicher Grund wie bei den Negatives; der Fall steht
    in den Tests von 2.4).
  - **Mock** (`mock.ts`): Option `scale: 'default' | 'large'`; `large` ersetzt die Test-Profile aller Regionen durch die 6
    Demo-Profile (NA und FE leer). `mock-data.ts`: `MockCampaign.withoutReports`, `MockTarget.searchTerms` (sonst die zwei festen
    Mock-Begriffe), `MockAd.sku` (sonst aus der ASIN). Kennzahlen weiter über `metricsFor` für jeden angefragten Zeitraum.
  - **Schalter** `AMAZON_ADS_MOCK_SCALE` (`amazonAdsEnvSchema`, `default`/`large`, leer = `default`); `large` nur mit
    `AMAZON_ADS_USE_MOCK=true` und nicht bei `NODE_ENV=production` (`refineAmazonAdsCredentials`). Durchgereicht über
    `createAmazonAdsClientFromConfig({ config: { mockScale } })` in API und Worker, damit der tägliche Sync von `pnpm dev` die
    Demo-Profile nicht als entfernt markiert.
  - **`pnpm demo:load`** (`apps/worker/src/demo.ts`, `demo-cli.ts`): legt die Mock-Connection in der Organisation `muuv` an (Upsert
    über den natürlichen Schlüssel wie der OAuth-Callback, Audit `connection.create` ohne Handelnden), ruft dann die Jobfunktionen
    direkt auf (`syncConnectionProfiles`, `syncConnectionEntities`, `syncConnectionReports`, `pollAmazonRequests` bis nichts mehr
    offen ist; Fortsetzungen nach dem Zeitbudget führt es selbst aus) und wiederholt `reports-sync`, bis er nichts mehr anfordert
    (siehe unten). Danach Clients per (Organisation, Slug) und die
    Zuordnung der Profile (`LARGE_MOCK_CLIENTS`: Waldkauz DE+FR, Lumen UK+SE, Kranich PL, IT ohne Client) über
    `assignProfilesToClient` (`system-access.ts`), Audit `client.create` und `profile.update` (mit `before`/`after`). Jeder Lauf
    geht über `runJob` (`job_runs` wie im Betrieb, Basis für `failedSinceLastRun`); ein gescheiterter Lauf bricht mit seiner
    Meldung ab. `reports-sync` läuft, bis keine Historie der Connection mehr offen ist (`countOpenBackfills`, normal 2 Runden:
    anfordern, dann Merker setzen; höchstens 4). Ohne pg-boss und Lease: `pnpm dev` muss dabei aus sein
    (`docs/development.md`). Der CLI verlangt `AMAZON_ADS_USE_MOCK=true` und lehnt `NODE_ENV=production` ab.
    Der Mock läuft mit `processingMs: 0`, die Wartezeiten sind die echten Poll-Abstände (mindestens 1 Min.; Exports warten auf
    freie Plätze, 5 je Typ).
  - **Gemessen** (lokal, 2026-09-28, frische DB): `pnpm demo:load` 13 Min., 2 Report-Runden, 0 gescheiterte Aufträge, keine offene
    Historie. Kennzahl-Zeilen: Kampagnen 23 699, Ad Groups 48 747, Targets 937 494, Product Ads 110 261, Suchbegriffe 862 653
    (zusammen rund 2 Mio.), SP-Historie 93 Tage; DB 1 GB.
  - **Doku:** `docs/development.md` (lokale DB, Mock-Anbieter, Demo-Daten neu laden), Verweis im README.
  - Review (unabhängig): Übernommen: doppelte Suchbegriffe bei Auto-Targets (jeder große `spSearchTerm`-Report wäre abgelehnt
    worden, `demo:load` brach ab; neuer Test über alle Report-Typen), Ende der Report-Runden über offene Merker statt über
    `requested` (war immer > 0), Läufe über `runJob`, Profil-Zuordnung als Systemzugriff in `packages/db`, Audit bei erneutem
    Laden (`connection.reconnect`) und mit `before`, SKU nur bei SD-Product-Ads, Schutz im CLI (Mock verlangt), Doku.

### 2.4 Abfrage-Schicht (`packages/db`)
- [x] Neues Modul (z. B. `ads-analytics.ts`) für Lesezugriffe von Nutzern: **nur** über `visibleProfilesScope()` (ADR 002), Filter
      nach Clients, Profilen, Ad-Typen, Zeitraum; Summen in SQL (`sum()` auf `numeric`/`bigint`, als String zurück).
- [x] Clients für die Filterleiste (F2) aus den sichtbaren Profilen abgeleitet (Helfer im Access-Layer, vgl. „Offen für Phase 6“ in
      ADR 002), nutzbar für alle Rollen.
- [x] Umrechnung in die Anzeigewährung (F3: automatisch, EUR, USD oder eine Profilwährung) je Tag über `fx_rates` in derselben
      Abfrage, Originalwährung bleibt daneben erhalten. Wählbare Währungen aus den sichtbaren Profilen (Access-Layer) plus EUR, USD.
- [x] Abfragen: Summen je Zeile einer Ebene (F6) für Zeitraum und Vergleichszeitraum, Summenzeile über alle Zeilen, Tagesreihe für
      eine Auswahl, Summen je Client/Profil/Ad-Typ fürs Dashboard, Product-Ad-Suche nach ASIN inkl. `extra.asins` (F10). Obergrenze
      der Zeilen nach F7.
- [x] Indizes prüfen (`EXPLAIN ANALYZE` mit den Demo-Daten aus 2.3), bei Bedarf ergänzen; Ergebnis hier notieren.
- [x] Tests: fremde Organisation, ausgeblendetes Profil, gemischte Währungen, Tage ohne Kurs, Platzhalter-Entities (Name leer),
      entfernte Entities (`removed_at`), SB-Kampagnen ohne Kennzahlen (Preview-Lücke), SB-Targets ohne Ad Group, Kürzen bei der
      Obergrenze (Summenzeile bleibt vollständig).
- [x] Umsetzung (Stand für 2.5 und später):
  - **`@profitbash/shared/analytics`** (eigener Einstiegspunkt ohne Node-/DOM-Typen, auch fürs Web): `AD_PRODUCTS`,
    `adProductSchema`, `ATTRIBUTION_SETTINGS` (`console` | `clicks14d`), `attributionSettingSchema`,
    `DEFAULT_ATTRIBUTION_SETTING`. Die Engine übernimmt `AdProduct`/`AttributionSetting` von dort (Abhängigkeit
    `@profitbash/shared`); `packages/db` hängt jetzt von `@profitbash/engine` ab.
  - **Access-Layer:** `listVisibleClientsAndProfiles(db, { userId, orgId })` → sichtbare Profile (ID, Amazon-ID, Name, Land,
    Währung, Zeitzone, Kontotyp, `clientId`) und nur die Clients mit mindestens einem sichtbaren Profil; Nicht-Mitglied: leer.
  - **`packages/db/src/ads-analytics.ts`** (aus `index.ts` exportiert). Gemeinsame Eingabe `AnalyticsQuery`: `userId`, `orgId`,
    `clientIds?` (+ `withoutClient` für „Ohne Client“), `profileIds?`, `adProducts?` (alles UND), `period`, `comparison?`,
    `currency` (`auto` oder Code), `attribution`. Die Auswahl beginnt immer mit `visibleProfilesScope()`; ausgeblendete und fremde
    Profile fallen auch bei ausdrücklicher Nennung heraus.
    - `queryExplorerRows({ …, level, filter?, limit? })`, Ebenen `portfolio`, `campaign`, `adGroup`, `target`, `productAd`,
      `searchTerm`; Negatives ohne Kennzahlen über `queryNegatives` (gleiche Auswahl und Filter). `filter`: `portfolioIds`,
      `campaignIds`, `adGroupIds` (Drill-Down), `includeRemoved` (Standard nein), `productSearch` (ASIN/SKU, auch
      `extra.asins`, Groß-/Kleinschreibung egal). Ergebnis: `currency`, `converted`, `rows` (Beträge in der **Originalwährung** der
      Zeile, `attributes` je Ebene, `placeholder`, `removed`, `hasMetrics`, `attribution` = `summarizeAttribution`), `totalRows`,
      `truncated`, `totals` (Anzeigewährung, `attribution`, `comparisonAttribution`, `missingFxCurrencies`). Entities ohne
      Kennzahlen: Impressionen, Klicks, Kosten 0; Umsatz usw. 0, wenn Amazon den Wert für Ad-Typ und Ebene liefert, sonst `null`.
      Suchbegriffe nur mit Kennzahlen, ID `targetId:searchTerm`. Sortiert nach umgerechnetem Spend (dann Name, ID), gekürzt auf
      `MAX_ANALYTICS_ROWS` (10 000); die Summenzeile gilt für alle Zeilen der Auswahl. Der Ad-Typ-Filter gilt für Zeilen und
      Kennzahlen (Portfolios: nur Kennzahlen). `includeRemoved` wirkt auf Zeilen **und** Summenzeile.
    - `queryTimeSeries({ …, level, filter?, entityIds? })`: Summen je Tag in der Anzeigewährung (`days`, `comparisonDays`),
      nur Tage mit Kennzahlen (Lücken füllt die Anzeige, F5).
    - `queryDashboard(query)`: Summen gesamt und je Client (`null` = ohne Client), Profil (mit Land, Währung) und Ad-Typ aus den
      Kampagnen-Kennzahlen, eine Abfrage mit `grouping sets`. Zählt **alle** Kampagnen (auch entfernte: ihr Spend war echt); der
      Kampagnen-Reiter des Explorers blendet entfernte standardmäßig aus, seine Summe kann dann kleiner sein.
    - `listSelectableCurrencies`: EUR, USD und die Währungen sichtbarer Profile, die in `fx_rates` vorkommen.
    - `queryDataStatus(selection, REPORT_AD_PRODUCT_SELECTION)`: `dataThrough` (Minimum über die Profile **mit** Datenstand, per
      `metricsImportedThroughSql`), `provisionalFrom` = `dataThrough` − 13 Tage (`PROVISIONAL_DAYS` 14), `earliestDate` (erster
      Tag mit Kampagnen-Kennzahlen), `profilesWithoutData`.
  - **Umrechnung in SQL:** CTE `fx` = Tag × Währung → Faktor = Kurs(Ziel) ÷ Kurs(Quelle) mit dem letzten Kurs an oder vor dem Tag
    (`numeric(48,30)`, 30 Nachkommastellen; EUR = 1, gleiche Währung = 1, fehlender Kurs = `null`), dazu `fxa` als Matrix
    (Tage × Währungen): Jede Kennzahl-Zeile liest ihren Faktor per Index statt über einen Join. Umgerechnete Summen werden in TS
    auf 12 Nachkommastellen gerundet (`HALF_EVEN`), nicht umgerechnete bleiben exakt (z. B. `3.40`). Der Test vergleicht die
    Summen mit `convertAmount` je Zeile (9 Nachkommastellen) für EUR, USD (zwei Nicht-EUR-Währungen) und einen Zeitraum ohne
    SEK-Kurs (Betrag nicht gezählt, `missingFxCurrencies: ['SEK']`).
  - **Attribution in SQL:** je Feld ein `CASE` über den Index der Kombination aus Ad-Typ und Kontotyp (`COMBOS`, nur Vendor
    weicht ab), gleiche Spalten zusammengefasst; welche Kombinationen vorkommen, melden Merker (`bool_or`) statt
    `array_agg(distinct …)` (das erzwang eine Sortierung).
  - **Aufbau der Abfrage:** abgeleitete Tabelle `x` mit `offset 0` (Attribution, Faktor und Zeitraum-Merker je Zeile einmal),
    Profil-IDs als Liste (`m.profile_id = any(…)`, aus der Auswahl über den Access-Layer), eine umschließende Tagesspanne vor dem
    exakten Filter (Index `(profile_id, date)` liest einen Bereich), Drill-Down und Suche schon beim Lesen der Kennzahlen
    (Join auf die Entity mit Profil: Schlüssel-Index `(profile_id, <entity>_id, date)`), Ergebnis als ein JSON (Beträge als Text,
    nie als JSON-Zahl), `set local work_mem = '64MB'` für die großen Lesezugriffe.
  - **EXPLAIN ANALYZE / Messung** (lokal, Demo-Daten aus 2.3, rund 2 Mio. Kennzahl-Zeilen, 6 Profile in 4 Währungen, Anzeige EUR,
    zweiter Lauf; `shared_buffers` 128 MB): Portfolios 40 ms, Kampagnen 50 ms, Ad Groups 105 ms, Product Ads 220 ms, Dashboard
    60 ms, Tagesreihe Kampagnen 60 ms (jeweils alle Profile, 30 Tage + Vergleich). Targets: alle Profile 30 Tage ohne Vergleich
    740–820 ms, mit Vergleich 1,6–1,8 s, ein Client (2 Profile) mit Vergleich 560–650 ms, 7 Tage mit Vergleich 620–650 ms,
    Drill-Down auf eine Kampagne 9 ms. Suchbegriffe: 1,0 s / 2,5–2,9 s / 770–880 ms / 770–810 ms / 12 ms (Streuung zwischen
    Messläufen). Engpass laut Plan: das Lesen der Kennzahl-Zeilen
    (rund 620 000 Target-Zeilen à 330 Byte für 60 Tage, etwa 0,7 s) und die Aggregation, nicht Indizes (alle Zugriffe über
    `…_profile_date_idx` bzw. den Schlüssel-Index; kein neuer Index nötig). Fester Anteil bei 10 000 Zeilen rund 300 ms (JSON mit
    10 MB bauen, übertragen, parsen); die API komprimiert (2.5).
  - **Fehlende Kurse:** In umgerechneten Summen (Summenzeile, Tagesreihe, Dashboard) zählen Kennzahl-Zeilen ohne Kurs gar nicht,
    auch nicht mit Klicks und Impressionen, damit CPC, CPM und ACoS aus denselben Zeilen stammen; die Währung steht in
    `missingFxCurrencies`. Zeilen des Explorers (Originalwährung) sind vollständig. Eine Zeile, deren Währung an allen Tagen keinen
    Kurs hat, sortiert ans Ende (umgerechneter Spend `null`; nur bei Währungen ohne EZB-Kurs denkbar).
  - **Vertrag für 2.5–2.8:** Die API prüft Eingaben mit zod (Ebene, Tage, `limit`, Währung nur aus `listSelectableCurrencies`,
    Suchbegriffe nicht leer). Die Hero-Kachel des Dashboards ruft `queryTimeSeries` mit `includeRemoved: true` (wie
    `queryDashboard`), sonst passt ihr Verlauf nach entfernten Kampagnen nicht zur Summe. Vergleichswerte einer Zeile ohne Daten im
    Vergleichszeitraum sind 0; ob der Vergleich vor dem ersten Datentag beginnt, zeigt `earliestDate` (F5). Der Portfolio-Reiter
    summiert nur Kampagnen mit Portfolio (Kampagnen ohne Portfolio fehlen dort, F6).
  - **Offen für Phase 6:** `listVisibleClientsAndProfiles` liest Clients zusätzlich nur aus der Organisation (`clients` gehört
    der Eigentümer-Org). Für Kunden-Orgs reicht dann die Einschränkung auf die Clients sichtbarer Profile.
  - Review (unabhängig): keine kritischen Befunde; Mandantentrennung, `sql.raw` nur mit Konstanten, Beträge nie über `number`,
    Umrechnung wie `convertAmount` bestätigt. Übernommen: Attribution je Zeile aus Ad-Typ und Kontotyp der Zeile (vorher
    fälschlich „vollständig“ außer bei Portfolios), Zeilen ohne Kurs ganz aus umgerechneten Summen, Tests für fremde und
    ausgeblendete IDs im Drill-Down, `withoutClient`. Nur festgehalten: Sortierung bei komplett fehlendem Kurs, Hero-Kachel,
    Nullen im Vergleich, Eingabeprüfung in der API, Phase 6 (siehe oben). Bewusst nicht jetzt: Aufteilen des Moduls in mehrere
    Dateien (nach dem Merge möglich, keine Verhaltensänderung).
  - **Offen (für Dominik, vor 2.8):** Targets und Suchbegriffe über **alle** Profile mit 30 Tagen **und** Vergleich liegen über der
    1-s-Grenze der DoD (1,6–1,8 s bzw. 2,5–2,9 s mit ~12 000 Targets). Vorschläge: (a) der Explorer lädt den Vergleich erst auf Wunsch
    oder nach den Zeilen, (b) Voraggregation (z. B. je Entity und Woche) für lange Zeiträume, (c) Infinite Row Model mit
    Sortierung auf dem Server (F7). Kampagnen, Dashboard, Drill-Down und ein Client bleiben unter 1 s.
    **Entschieden (Dominik, 2026-09-28): (a) Vergleich nachladen.** Der Explorer lädt die Zeilen ohne Vergleich (unter 1 s) und
    den Vergleich danach; die Spalten „Veränderung“ füllen sich, sobald er da ist (2.8).
    **Entschieden (Dominik, 2026-09-29), Rest:** Die DoD „unter 1 s“ gilt für die Datenbank-Abfragen, die die Seite wartend
    braucht (Zeilen ohne Vergleich, Dashboard, Tagesreihen); die größte Auswahl (Targets, alle 6 Profile, 30 Tage) braucht im
    Browser 1,5 s bis zu den Zeilen, 3,1 s mit Vergleich, und bleibt als bekannte Grenze festgehalten. Voraggregation bzw.
    serverseitiges Row Model (b, c) erst als eigene Aufgabe, wenn echte Konten es verlangen.

### 2.5 API (`apps/api`)
- [x] Middleware `requireFeature(key, 'view')`: prüft Entitlement und Rolle serverseitig (`resolveFeatureAccess`), `403` mit
      Fehlerformat `{ error: { code, message } }`.
- [x] Endpunkte (POST, IDs im Body): Explorer-Zeilen je Ebene, Tagesreihe, Dashboard-Summen, ASIN-Suche, Clients und wählbare
      Währungen für die Filterleiste; Anzeigewährung als Parameter (F3). zod an der Grenze, OpenAPI und `schema.gen.ts` neu erzeugt.
      Beträge als Decimal-Strings, Kennzahlen aus 2.1.
- [x] Antwort nennt die Währung und ob umgerechnet wurde, Attribution je Summe (gemischt ja/nein, fehlende Werte), „Daten bis“,
      den Beginn der vorläufigen Tage und ob die Zeilen gekürzt sind.
- [x] Komprimierung der Antworten (F7).
- [x] Umsetzung (Stand für 2.6 und später):
  - **`requireFeature(deps, key | keys, 'view' | 'write')`** (`middleware.ts`, nach `requireSession`): Entitlements der aktiven
    Organisation (`listEnabledFeatures`) und Rolle über `resolveFeatureAccess`; mehrere Keys = eines genügt. Fehler `403`
    `FEATURE_FORBIDDEN` bzw. `NO_ACTIVE_ORGANIZATION`.
  - **Endpunkte** (`routes/analytics.ts`, Tag „Auswertungen“, alle POST unter `/api/ads/*`, gzip über `hono/compress`, wenn der
    Browser es anbietet):
    - `filter-options` (Feature `dashboard` **oder** `sp-explorer`): sichtbare Clients und Profile
      (`listVisibleClientsAndProfiles`), wählbare Währungen, `fxRatesThrough` (= `latestFxRateDate`), `fxRatesStale`.
    - `explorer/rows` (`sp-explorer`): `level` inkl. `negative` (dann `current`/`total` `null`), `filter` (Drill-Down,
      `includeRemoved`); Antwort `meta`, `rows`, `totalRows`, `truncated`, `maxRows` (10 000), `total`.
    - `timeseries` (`dashboard` oder `sp-explorer`): `level` (Standard `campaign`), `filter`, `entityIds` (höchstens 200; unabhängig
      davon gilt die Body-Grenze von 64 KB, größere Anfragen scheitern mit `413`); `days`, `comparisonDays`, `attribution`,
      `comparisonAttribution`. Die Hero-Kachel des Dashboards (2.7) schickt `filter.includeRemoved: true`,
      damit der Verlauf zur Dashboard-Summe passt.
    - `dashboard` (`dashboard`): `total`, `byClient`, `byProfile`, `byAdProduct` (jede Gruppe mit eigener Attribution des
      Vergleichszeitraums), `fxRatesThrough`, `fxRatesStale`.
    - `asin-search` (`sp-explorer`): `terms` (1–100 ASINs oder SKUs), sonst wie `explorer/rows` auf Ebene `productAd`.
  - **Schemas** in `@profitbash/shared` (`analytics-api.ts`): Anfrage `analyticsQuerySchema` (Auswahl wie 2.4, `period`,
    `comparison` (weglassen oder `null`), `currency` (optional, Standard `auto`), `attribution` (optional, Standard `console`;
    optional statt zod-`default`, damit der generierte Client die Felder weglassen darf), Zeitraum höchstens 400 Tage
    (`from` ≤ `to`). Nullbare Verwendungen benannter Komponenten über `orNull` (`z.union([…, z.null()])`): `.nullable()` machte die
    Komponente selbst nullbar (`PeriodMetrics` usw. im Client `| null`); `openapi.test.ts` prüft das. Eine andere
    Anzeigewährung als `auto` muss in `listSelectableCurrencies` stehen, sonst `400 CURRENCY_NOT_SELECTABLE`.
    Antwort: `meta` (`currency`, `converted`, `missingFxCurrencies`, `dataThrough`, `provisionalFrom`, `earliestDate`,
    `profilesWithoutData`), Summen als `{ sums, derived }` (`deriveMetrics`; Umsatz und Käufe gehen nur bei vollständiger
    Abdeckung in ACoS, ROAS und CVR ein), `change` je Kennzahl (`absolute`, `relative`) für Summen und Dashboard-Gruppen, je
    Explorer-Zeile nur `relative` (Nutzlast), `attribution` (`summarizeAttribution`).
  - **„Kurse veraltet“:** `isFxRateStale(latest, now)` (`@profitbash/shared/analytics`): mehr als 5 Kalendertage (Entscheidung
    siehe 2.2); ein neuer Tag zählt erst ab 08:00 Berlin (Abruf 06:00 plus Wiederholung nach 1 Std.), sonst gäbe es am
    Mittwoch nach Ostern früh einen Fehlalarm. Getestet mit Ostern 2027 (auch 07:30) und Weihnachten 2025/2026.
  - **Negatives:** `meta.currency` wie bei den anderen Endpunkten (`resolveDisplayCurrency`), keine Beträge.
  - **Nutzlast:** 10 000 Target-Zeilen mit Vergleich rund 14 MB JSON aus der DB-Schicht, gzip 1,5 MB (die API ergänzt abgeleitete
    Kennzahlen und Veränderungen, entsprechend mehr).
  - Review (unabhängig): keine kritischen Befunde; Rechte, Mandantentrennung, Währungsprüfung, Komprimierung und
    `isFxRateStale` bestätigt. Übernommen: nullbare OpenAPI-Komponenten (generierte Typen waren falsch), Antworten in den Tests
    gegen die Antwort-Schemas geprüft, Attribution des Vergleichszeitraums für Dashboard-Gruppen und Tagesreihe, Schonfrist bis
    08:00, Obergrenze `entityIds` und Hinweis auf `413`, Währung bei Negatives, optionale Standardfelder, Tests für „eines der
    Features genügt“, `comparison: null`, `auto` mit einer Währung. Nur in 2.4 getestet (dort vollständig): fremde und
    ausgeblendete IDs in Auswahl und Drill-Down.

### 2.6 Web-Grundlagen
- [x] **AG Charts Community** einführen (ADR 001; Version exakt pinnen, Lizenz und Mindestalter prüfen), Theme aus den Tokens
      (Hell/Dunkel), Achsen und Tooltips in Mono über die Formatierungs-Helper. Prüfen, wie sich vorläufige Tage markieren lassen
      (F5; z. B. Bereich über `crossLines`).
- [x] AG Grid: deutsche `localeText` mit `LocaleModule` (offen seit Phase 0), benötigte Module registrieren (Sortierung, Filter, CSV
      nach F6). Nur registrierte Module nutzen, Konsole prüfen. Vergleich für Decimal-Strings (F7) in `packages/shared`.
- [x] Filterleiste (F2, F3, F4, F5) als eigene Komponente (Clients/Profile, Anzeigewährung, Attribution, Zeitraum, Vergleich), kurzer
      Zustand in der URL, letzte Auswahl in `ui_state`.
- [x] Bausteine: KPI-Kachel mit Veränderung, Hinweise „≈“, „gemischte Attribution“ und „Wert fehlt“, Kennzeichnung vorläufiger Tage.
      **Entschieden (Dominik, 2026-09-28): Farbe der Veränderung nach Bedeutung:** Umsatz, ROAS, Käufe, Klicks, Impressionen, CTR,
      CVR: mehr = gut (Lime); ACoS, CPC, CPM: mehr = schlecht (rot); Spend neutral (nur Pfeil).
- [x] Umsetzung (Stand für 2.7 und später):
  - **AG Charts Community 14.2.0** (`ag-charts-community`, `ag-charts-vue3`, `ag-charts-locale`, exakt gepinnt; MIT, veröffentlicht
    2026-09-16, passt zu AG Grid 36.2.0). Nur registrierte Module (`src/charts/modules.ts`: Balken, Linie, Zahlen- und Zeitachse,
    `CrossLinesModule`, Legende, Locale), deutsches Chart-Locale (`AG_CHARTS_LOCALE_DE_DE`). Theme `chartTheme(scheme)` aus
    `tokens.ts` (Canvas kennt keine CSS-Variablen; Hell/Dunkel über `useColorScheme`), Achsen in Mono, Beschriftung über
    `formatNumber`/`formatDay`. `buildTimeSeriesOptions` (`src/charts/time-series.ts`): bis zu zwei Reihen (Balken/Linie, Achse
    links/rechts); Werte gehen **nur für die Position** als `Number()` an den Chart, der Tooltip formatiert den Decimal-String.
    Vorläufige Tage = `crossLines` vom Typ `range` von `provisionalFrom` bis zum letzten Tag, beschriftet „Vorläufig“.
    `fillDays` füllt fehlende Tage: zwischen `earliestDate` und `dataThrough` 0 (keine Aktivität), davor/danach Lücke (F5).
    `TimeSeriesChart.vue` (Canvas mit `role="img"` und `aria-label`). Tests prüfen die Optionen (happy-dom hat kein Canvas;
    `ag-charts-vue3` ist dort gemockt).
  - **AG Grid:** `LocaleModule` mit `AG_GRID_LOCALE_DE` aus `@ag-grid-community/locale` 36.2.0 (`gridLocaleText`, auch in
    Sync-Status und Profiltabelle). Neu registriert: `TextFilterModule`, `CustomFilterModule` (Filter für Beträge ohne `number` in
    2.8), `PinnedRowModule` (Summenzeile), `CsvExportModule`; Sortieren gehört zum Kern. Weiter nicht registriert: `TooltipModule`,
    `RenderApiModule`. Ein Test nutzt Sortierung, Textfilter, Summenzeile und CSV und prüft, dass AG Grid nichts meldet.
  - **Decimal-Vergleich** (`@profitbash/shared`, `decimal-compare.ts`): `compareDecimal` (ziffernweise, auch jenseits von
    `Number.MAX_SAFE_INTEGER`, `-0` = 0, wirft bei Nicht-Decimal-Strings), `compareDecimalNullsLast(a, b, nodeA, nodeB, isDescending)`
    direkt als AG-Grid-`comparator` (fehlende Werte in beide Richtungen am Ende; getestet in einer echten Grid-Spalte),
    `decimalSign`.
  - **Filterleiste** (`src/analytics/`): `periods.ts` (Voreinstellungen F5; „Letzte N Tage“ enden gestern, „Diese Woche/Dieser
    Monat/Dieses Jahr bis jetzt“ enden heute, Wochen ab Montag, „Letzte 12 Monate“ = 12 volle Monate vor dem laufenden; Vergleich
    Vorperiode gleicher Länge bzw. Vorjahr mit 29.02. → 28.02.; „heute“ in der Zeitzone des Browsers). `filters.ts`: URL-Parameter
    `clients`, `nc` (Ohne Client), `pf=1` (Profilauswahl aktiv; die IDs stehen nur in `ui_state`), `period`, `from`/`to`, `cmp`,
    `cur`, `attr`; Standardwerte fehlen in der URL. Ohne Filter-Parameter gilt die letzte Auswahl (`ui_state` `analytics/filters`,
    **geteilt** zwischen Dashboard und Explorer) und wird per `replace` in die URL übernommen; Änderungen per `push`
    (Zurück-Taste). Jeder Verlaufseintrag trägt den ganzen Zustand in `history.state` (`analyticsFilters`), damit Zurück/Vor
    auch die Profilauswahl und den Ausgangszustand wiederherstellt (Vorrang: Verlaufseintrag, dann URL-Parameter, dann letzte
    Auswahl). Ein Link ohne `pf=1` zeigt die Clients ganz; ein geteilter Link mit `pf=1` nimmt beim Empfänger dessen eigene
    letzte Profilauswahl innerhalb der verlinkten Clients (bekannte Grenze: die Profile des Absenders stehen nicht im Link).
    Eine eigene Änderung gilt vor einer gespeicherten Auswahl, die erst danach ankommt; gespeichert wird nacheinander, immer
    der neueste Stand (Fehler still, URL und Verlauf bleiben). Mehr als 1000 Profile (API-Grenze) bzw. rund 400 (16 KB
    `ui_state`) kosten nur die gespeicherte Profilauswahl. „Heute“ wird beim Fokus des Tabs neu bestimmt. `sanitizeFilterState` entfernt Unsichtbares (Clients, Profile,
    Profile außerhalb der Clients, nicht wählbare Währung → automatisch). Auswahl als Baum (PrimeVue `TreeSelect`, Checkboxen):
    Clients › Profile, „Ohne Client“; alles oder nichts gewählt = keine Einschränkung, Teilauswahl = `clientIds` plus
    `profileIds` (Server verknüpft mit UND). `useAnalyticsFilters()` liefert `state`, `options` (`/filter-options`), `ready`
    (erst dann laden Widgets), `update`, `query` (Body für `/api/ads/*`). `FilterBar.vue`: fünf Felder mit sichtbaren Labels,
    „Frei wählen“ mit Datumsbereich (übernimmt erst beide Enden; über 400 Tage
    Fehlermeldung statt stillem Standard), Anzeige der Tage von Zeitraum und Vergleich in Mono, „Vorjahr“
    gesperrt, solange `earliestDate` nach dessen Beginn liegt (Prop der Seite aus `meta.earliestDate`).
  - **Bausteine:** `metrics.ts` (`formatMetricValue` je Art, `formatChange` mit Vorzeichen, `changeTone` nach Bedeutung),
    `hints.ts` (`metricHints`: „≈“ nur an Beträgen, „Ohne Kurs nicht gezählt“ an allen Summen, gemischte Attribution bzw. „Wert
    fehlt“/„unvollständig“ an Umsatz, Käufen, Einheiten, ACoS, ROAS, CVR nach `coverage`), `HintBadge.vue` (Schalter mit Popover,
    lesbar auch auf Touch), `KpiTile.vue` (Überzeile, Wert in Mono mit „≈“, Veränderung als Pille mit Pfeil und Text für
    Screenreader, Vergleichswert, Skeleton). Die API-Funktionen stehen unter `api.analytics.*` (`filterOptions`, `dashboard`,
    `timeSeries`, `explorerRows`).
    Veränderungen, die als „0,0 %“ erscheinen (Betrag unter 0,05 %), sind neutral, ohne Vorzeichen und Pfeil.
  - Review (unabhängig): keine kritischen Befunde. Übernommen: Signatur des Grid-Vergleichs, Zurück-Taste nach der ersten
    Änderung und für die Profilauswahl (`history.state`), Zeitraum über 400 Tage, Wettlauf mit der gespeicherten Auswahl,
    Speichern nacheinander, gerundete 0 neutral, zu lange Profilliste kostet nur die Profile, „Ohne Client“ ohne solche
    Profile entfällt, Bereich „Vorläufig“ je einen halben Tag breiter (Randbalken ganz im Bereich), „Heute“ beim Fokus,
    Sortiertest prüft die Reihenfolge, `title` an der Währung und `aria-controls` des Popovers entfernt. Offen für 2.7: Chart
    einmal im Browser prüfen (Balken auf der Zeitachse; ggf. `unit-time`).


### 2.7 Dashboard (`/dashboard`)
- [x] Inhalt nach F11 im Kinetic-Bento-Look (Referenzen als Stil, nicht als Inhalt), Zustände je Widget.
- [x] SB-Preview-Lücke erklären, sobald SB in der Auswahl ist (`plan.md` §5).
- [x] Umsetzung (Stand für 2.8 und später):
  - **Seite** `pages/DashboardPage.vue` (Route `dashboard`), Widgets in `src/dashboard/`: Filterleiste (2.6), **Hero-Kachel**
    (`DashboardHero.vue`, dunkel: Spend und Umsatz mit Veränderung, Vergleichswert und Hinweisen, darunter der Tagesverlauf
    Spend als Balken, Umsatz als Linie auf eigener Achse, vorläufige Tage markiert), **KPI-Kacheln** ACoS, ROAS, Käufe, Klicks
    mit CPC, **Anteil je Ad-Typ** (`AdProductShareTile.vue`: Spend mit ACoS, Balken für den Anteil an Spend und Umsatz),
    **Datenstand** (`DataStatusTile.vue`), **Tabelle je Client bzw. Profil** (`BreakdownTable.vue`, Umschalter, sortierbar über
    die Spaltenköpfe mit `compareDecimalNullsLast`, Name als Link in den Explorer). Raster: 12 Spalten ab `lg` (Hero 8, KPIs 4
    als 2 × 2, Anteil 7, Datenstand 5, Tabelle 12), darunter eine bzw. zwei Spalten (F13).
  - **Abfragen** (`dashboard/queries.ts`): `/dashboard` und `/timeseries` getrennt (ein Fehler trifft nur sein Widget), erst wenn
    `useAnalyticsFilters().ready` und sichtbare Profile da sind; beim Filterwechsel bleiben die alten Werte stehen
    (`keepPreviousData`, blass und `aria-busy`, bis die neuen da sind). Die Hero-Kachel schickt `level: 'campaign'`, `filter.includeRemoved: true` (passt zur Summe).
  - **Zustände:** je Widget Skeleton, Fehler mit „Erneut versuchen“ (nur solange keine Daten da sind), leer („Keine Kennzahlen
    im gewählten Zeitraum“). Ohne sichtbare Profile ersetzt ein Hinweis die Widgets (Admin: Link „Clients & Connections“); dann
    fragt die Seite keine Kennzahlen an. Scheitern die Filteroptionen, steht der Fehler nur in der Filterleiste (keine
    endlosen Skeletons).
  - **API (Erweiterung von 2.5):** `DashboardResponse.status` aus `queryDashboardStatus` (`packages/db`, eigene Testdatei
    `ads-analytics-status.test.ts`): `lastSyncAt` = letzter erfolgreicher `reports-sync` der Connections der Auswahl (`job_runs`
    der Organisation, `scope` = Connection-ID aus den sichtbaren Profilen), `adProducts` = „Daten bis“ je genutztem Ad-Typ wie
    der Sync (SP immer, SB/SD mit Kampagnen; `null`, solange einem Profil der Stand fehlt), `sbCampaignsWithoutMetrics` =
    nicht entfernte SB-Kampagnen ohne jede Kennzahl-Zeile. Je Ad-Typ `share` (`cost`, `sales`) = Anteil an der Gesamtsumme
    über `share()` aus `@profitbash/engine` (Decimal; die Balkenbreite im Web ist nur CSS).
  - **Datenstand:** Daten bis, vorläufig ab, letzter Sync, Kurse bis, Daten ab; Warnungen bei veralteten Kursen
    (`fxRatesStale`), Profilen ohne Datenstand, einem Ad-Typ hinter den anderen (`profilesBehind`) oder ohne Stand, und wenn der Zeitraum vor dem
    ersten Datentag beginnt (F5). **SB-Preview-Lücke:** Hinweis mit Anzahl, sobald SB in der Auswahl vorkommt.
  - **Links in den Explorer:** `useAnalyticsFilters().linkTo(path, patch)` (kurzer Zustand in der URL, der ganze im
    Verlaufseintrag): Client → `clients=…`, „Ohne Client“ → `nc=1`, Profil → Client plus `pf=1`, die Profil-ID nur in
    `history.state`.
  - **Chart:** Tagesachse `unit-time` (`UnitTimeAxisModule` statt `TimeAxisModule`; ein Band je Tag, Balken füllen den Tag,
    kein Polster an den Rändern); auf der Hero-Kachel immer das dunkle Chart-Theme (`scheme="dark"`).
  - **Demo-Daten:** Der Mock setzte am ersten Tag jedes angefragten Report-Zeitraums feste Prüfwerte (1 234 567,89 Umsatz);
    durch den täglichen Import über ein rollierendes Fenster stand das an fast jedem Tag. `largeMockAccount` schaltet das ab
    (`exactValueProbe: false`); der kleine Mock behält es. Lokale DB danach neu geladen (`docs/development.md`).
  - Review (unabhängig): keine kritischen Befunde. Übernommen: hängender Ad-Typ je Profil statt über die Minima verschiedener
    Profilmengen, „Letzter Sync“ = ältester Erfolg, doppelter API-Test entfernt und Anteile genau geprüft, CPC mit
    Veränderung und „≈“, Umsatz je Ad-Typ als Betrag, weitere Hinweise am Spend je Ad-Typ, Zustand beim Nachladen, keine
    Skeletons ohne Filteroptionen, CPC-Spalte über i18n, vorsichtigerer Text zur SB-Lücke, keine doppelte Warnung „ohne
    Datenstand“. Bewusst so: Ein Profil-Link in einem neuen Tab (nur `href`) nimmt die eigene letzte Profilauswahl (bekannte
    Grenze aus 2.6).

### 2.8 Explorer (`/ads/explorer/*`)
- [x] Reiter, Drill-Down, Brotkrumen, Chart und Grid nach F6/F7; Spaltenauswahl, Sortierung, Filter; Zustand in der URL.
- [x] CSV-Export der geladenen Zeilen in aktueller Filterung und Sortierung (F6); Beträge als Decimal-Strings mit Währungsspalte,
      Hinweis im Export, wenn die Zeilen gekürzt sind (F7).
- [x] Spalten je Ad-Typ lesbar: Attribution (F4), Klick-/View-Anteil bei SB/SD, sichtbare Impressionen und vCPM bei SD, Kostenart
      (`extra.costType`; Gebote bei vCPM als „je 1000 sichtbare Impressionen“ beschriftet), Platzhalter („unbekannt“) und entfernte
      Entities (Filter, Standard ausgeblendet; `phase-1.md` F10).
- [x] Negatives ohne Kennzahlen; Product Ads mit ASIN/SKU, bei mehreren ASINs (`extra.asins`) als Liste in einem Popover der Zelle
      (Master/Detail ist AG Grid Enterprise).
- [x] Umsetzung (Stand für 2.9 und später):
  - **Seite** `pages/ExplorerPage.vue`, Bausteine in `src/explorer/`. **URL** (`state.ts`): Ebene als Pfad
    (`/ads/explorer/portfolios|campaigns|ad-groups|targets|product-ads|search-terms|negatives`; `/ads/explorer` leitet im Router
    auf Kampagnen um), Drill-Down als je eine ID (`portfolio`, `campaign`, `adGroup`), `removed=1`, `adp` (Ad-Typen, F1),
    `m1`/`m2` (Chart); dazu die Filterleiste (geteilt mit dem Dashboard). Spaltenauswahl je Ebene in `ui_state`
    (`explorer/columns.<ebene>`).
  - **Drill-Down** (F6): Klick auf den Namen öffnet die nächste Ebene (Portfolio → Kampagnen → Ad Groups → Targets), obere
    Filter bleiben; die Reiter behalten den Drill-Down (SB-Targets ohne Ad Group erscheinen so beim Reiter Targets einer
    Kampagne). **Brotkrumen:** Auswahl der Filterleiste › Portfolio › Kampagne › Ad Group; Namen aus dem Verlaufseintrag
    (`history.state.explorerCrumbs`, beim Klick gesetzt), sonst aus den Zeilen (`campaignName` …), sonst allgemein
    („Kampagne“).
  - **Vergleich nachladen** (Entscheidung zu 2.4 „Offen“): `useExplorerRows` fragt erst ohne Vergleich, danach dieselbe
    Anfrage mit Vergleich; bis dahin zeigen die Spalten „Δ“ „–“ und ein Hinweis „Vergleich wird geladen …“ (eigener Fehler mit
    „Erneut versuchen“). Negatives ohne Vergleich. Gemessen im Browser (Demo-Daten, alle Profile, Targets, 30 Tage, `pnpm dev`):
    Zeilen nach 1,5 s (2,3 MB), mit Vergleich nach 3,1 s (5,6 MB); Kampagnen deutlich darunter. Die reine DB-Abfrage liegt bei
    0,74–0,82 s (2.4); der Rest ist JSON, Übertragung und Grid. Weiter unter 1 s ginge nur mit Voraggregation oder
    serverseitigem Row Model (2.4 „Offen“, Vorschläge b und c).
  - **Spalten** (`columns.ts`): Name (links fest, Link, „(unbekannt)“ bei Platzhaltern, „(entfernt)“), Status, Ad-Typ, Profil,
    Währung (immer im CSV, sichtbar nach Wahl), je Ebene Portfolio, Kampagne, Ad Group, Target, Match-Typ, Ebene (Negatives),
    ASIN, SKU, Targeting, Budget, Gebotsstrategie, Kostenart (CPC/vCPM), Standardgebot/Gebot (bei vCPM „je 1000 sichtbare
    Impr.“), Attribution je Zeile nach F4 („7 Tage, Klick“, „14 Tage, Klick + View“; Vendor 14 Tage), Kennzahlen (Impressionen,
    Klicks, CTR, Spend, CPC, Umsatz, ACoS, ROAS, Käufe, Einheiten, CVR, sichtbare Impressionen, vCPM) und Veränderungen (Δ Spend,
    Δ Umsatz, Δ ACoS, Farbe nach Bedeutung). Beträge je Zeile in der Originalwährung, die **Summenzeile** (unten angeheftet) in
    der Anzeigewährung mit „≈“; fehlende Werte „–“. Den Klick-Anteil von SB/SD zeigt die Einstellung „14 Tage, nur Klicks“ der
    Filterleiste (die Zeilen der API tragen nur die gewählte Attribution; eine eigene Spalte bräuchte die API).
  - **Sortieren und Filtern** im Browser: Beträge und Zähler mit `compareDecimalNullsLast` und dem eigenen `DecimalFilter`
    („mindestens“/„höchstens“, Komma oder Punkt, `compareDecimal`, nie `number`), Texte mit dem Textfilter. **Kürzung:**
    Hinweis „Es werden die 10.000 Zeilen mit dem höchsten Spend gezeigt (von …)“; die Summenzeile gilt für alle.
  - **Chart** (`ExplorerChart.vue`) über dem Grid, zwei wählbare Kennzahlen (Balken links, Linie rechts), Tagesreihe der Ebene
    mit Drill-Down; markierte Zeilen (Checkboxen, `RowSelectionModule`) schränken ihn ein (bis 200, sonst ganze Auswahl mit
    Hinweis). Bei Negatives kein Chart.
  - **CSV** (`ExplorerGrid.csv`): geladene Zeilen in aktueller Filterung und Sortierung, sichtbare Spalten plus Währung,
    Beträge als Decimal-String (`useValueFormatterForExport: false`), ohne Summenzeile, bei Kürzung ein Hinweis als erste Zeile;
    Datei `profitbash-<ebene>-<von>_<bis>.csv`.
  - **Product Ads:** ASIN und SKU; bei mehreren ASINs (`extra.asins`) „teilt sich n ASINs“ mit Liste im Popover der Zelle.
    Zeilen ohne Kennzahlen (z. B. SB-Preview-Lücke) tragen ein Kennzeichen.
  - **Grid:** feste Höhe mit Virtualisierung, bis 15 Zeilen wächst es mit; auf dem Handy scrollt es waagerecht in seiner
    Kachel (erste Spalte fest, F13).
  - Browser-Pane geprüft: 1440 px, Handy, Hell/Dunkel, Drill-Down mit Brotkrumen, Targets mit Kürzung, ASIN-Popover, Konsole
    ohne Fehler und ohne AG-Warnungen.
  - Review (unabhängig): keine kritischen Befunde. Übernommen: Budget und Gebote als Beträge (roher Decimal-String, Sortierung,
    `DecimalFilter`, CSV roh; „je 1000 sichtbare Impr.“ nur in der Anzeige), sichtbare Impressionen formatiert, Anteile im
    Filter in Prozent (`filterParams.scale`, Verschiebung als String), Text „CPM“, Markierungen bei jeder Änderung der Anfrage
    zurückgesetzt, Drill-Down verwirft tiefere IDs, CSV mit BOM (Excel), Formeln in Texten entschärft (`csvSafe`), fehlende
    Werte leer, Ad-Typen in fester Reihenfolge in der URL, Brotkrumen speichern nur echte Namen, Zeilenzahl formatiert,
    Chart-Anfrage ohne Vergleich im Schlüssel, `aria-expanded` am ASIN-Knopf, konstante Grid-Optionen, Download robuster.
  - **Offen (klein, später)** (Dominik, 2026-09-29: jetzt als 2.13; erledigt in 2.13 außer den Brotkrumen-Namen): Amazon-Enums unübersetzt (Match-Typ, Targeting, Gebotsstrategie) und Ausdrücke von Targets als
    JSON; nach einer Änderung in der Filterleiste gelten Brotkrumen-Namen aus den Zeilen statt aus dem Verlauf;
    `suppressCellFocus` (Tastatur-Navigation im Grid aus, Links per Tab erreichbar); Zeilen der Abfrage als `shallow`
    (weniger Proxys bei 10 000 Zeilen); weitere Tests (CSV nach Sortierung, Spaltenauswahl speichern, Vergleichsfehler).


### 2.9 Gespeicherte Ansichten (F8)
- [x] Tabelle, Access-Funktionen (Profile und Clients beim Laden über den Access-Layer gefiltert), API, Audit-Events; ADR 002
      ergänzen. Menü „Ansichten“ in Dashboard und Explorer (speichern, laden, umbenennen, löschen, freigeben).
- [x] Umsetzung (Stand für 2.10 und später):
  - **Entschieden (Dominik, 2026-09-29):** Die Sortierung der Explorer-Tabelle wird mitgespeichert (dazu kurz in der URL,
    `sort=<spalte>.<asc|desc>`). Wird ein Mitglied entfernt (2.10), werden seine **persönlichen** Ansichten gelöscht, die
    freigegebenen bleiben (Admins können sie umbenennen, überschreiben oder löschen).
  - **Schema** (`@profitbash/shared`, `saved-views.ts`): `SAVED_VIEW_AREAS` (`dashboard`, `explorer`), `savedViewStateSchema`
    = `filters` (Filterleiste wie `FilterState`: Clients, „Ohne Client“, Profile, Zeitraum, Vergleich, Währung, Attribution) und
    nur im Explorer `explorer` (Ebene, Drill-Down je eine ID, entfernte, Ad-Typen, zwei Chart-Kennzahlen als Array der Länge 2
    (OpenAPI kennt keine Tupel), Spalten oder `null` = Standard, Sortierung oder `null`). Name getrimmt, 1–80 Zeichen, eindeutig
    je Besitzer und Bereich (ohne Groß-/Kleinschreibung), höchstens 200 eigene je Bereich. `PERIOD_PRESETS` und
    `COMPARISON_MODES` liegen jetzt in `@profitbash/shared` (das Web übernimmt sie von dort).
  - **Tabelle** `saved_views` (Migration `0016_saved_views`): Organisation, Besitzer (`owner_user_id`, Kaskade beim Löschen des
    Nutzers), Name, Bereich (Check), `shared`, `state` jsonb. **Zugriffe** nur über `packages/db/src/saved-views.ts`:
    persönliche sieht nur der Besitzer, freigegebene alle Mitglieder; ändern und löschen Besitzer und Org-Admins (auch
    fremde freigegebene; fremde persönliche bleiben auch für Admins unsichtbar, `404`); freigeben nur mit `canShare` (Recht
    `write` im Feature des Bereichs, prüft die API), zurücknehmen darf der Besitzer immer (auch nach Herabstufung zum
    Viewer; Umbenennen und Überschreiben eigener freigegebener Ansichten bleiben ihm ebenfalls). Audit
    `saved_view.create|update|delete` in derselben Transaktion (Update mit `before`/`after` für Name und Freigabe,
    `stateChanged`; der Zustand selbst steht nicht im Audit).
  - **Access-Layer** (ADR 002, Geltungsbereich ergänzt): `loadSavedViewVisibility` lädt sichtbare Clients und Profile
    (`listVisibleClientsAndProfiles`) und die sichtbaren Drill-Down-IDs aller Zustände einer Anfrage (eine Abfrage je
    Entity-Tabelle über `visibleProfilesScope`), `applySavedViewVisibility` filtert. Beim Speichern **und** beim Laden:
    `hiddenItems` zählt Entferntes, `selectionHidden` meldet, dass von einer eingeschränkten Auswahl nichts sichtbar bleibt
    (sonst hieße der Zustand „alle Profile“; das Web lädt die Ansicht dann nicht und sagt es). Clients ohne sichtbares Profil
    fallen wie in der Filterleiste weg. Ein Zustand, den das Schema nicht mehr kennt, erscheint mit `outdated` und dem
    Standard des Bereichs (überschreiben oder löschen möglich, laden nicht).
  - **API** (`routes/saved-views.ts`, Tag „Gespeicherte Ansichten“): `GET /api/saved-views?area=`, `GET|PATCH|DELETE
    /api/saved-views/{id}`, `POST /api/saved-views`. Recht `view` im Feature des Bereichs (`dashboard` bzw. `sp-explorer`,
    sonst `403 FEATURE_FORBIDDEN`), bei ID-Zugriffen im Bereich der Ansicht. Fehler `SAVED_VIEW_NOT_FOUND` (404),
    `SAVED_VIEW_FORBIDDEN`, `SAVED_VIEW_SHARE_FORBIDDEN` (403), `SAVED_VIEW_NAME_TAKEN`, `SAVED_VIEW_LIMIT_REACHED` (409),
    Zustand im falschen Bereich `400`. Antwort mit `own`, `canEdit`, `canShare`, `hiddenItems`, `selectionHidden`, `outdated`.
    Nimmt ein Admin die Freigabe einer fremden Ansicht zurück, bekommt er das Ergebnis (danach sieht nur der Besitzer sie).
  - **Web:** `SavedViewsMenu.vue` (Knopf „Ansichten“ im Seitenkopf, zeigt den Namen der Ansicht, die genau dem aktuellen
    Zustand entspricht; Popover mit „Meine Ansichten“ und „Für das Team“ mit Besitzer; je Ansicht Link kopieren, bei
    `canEdit` überschreiben (mit Rückfrage, bei Team-Ansichten mit Hinweis), freigeben/zurücknehmen, umbenennen, löschen (mit
    Rückfrage); „Aktuelle Ansicht speichern“ mit Name und, nur mit Schreibrecht, „Für das Team freigeben“). Laden wirkt wie
    selbst eingestellt: `useAnalyticsFilters().update(patch, { path, query, state, replace })` setzt Filterleiste, URL, Verlauf
    und `ui_state`; im Explorer ersetzen Ebene, Drill-Down, Ad-Typen, entfernte, Chart und Sortierung der Ansicht die
    aktuellen Parameter, die Spalten werden als eigene Auswahl der Ebene gespeichert (`ui_state` `explorer/columns.<ebene>`;
    „Standard“ = `null` in der Ansicht). Link `?view=<id>` (Link kopieren) lädt die Ansicht, sobald die Seite bereit ist,
    per `replace` (Zurück führt nicht erneut auf den Link); Ansicht des anderen Bereichs, nicht sichtbar oder ohne sichtbare
    Auswahl: Hinweis, Parameter entfernt. Hinweis bei `hiddenItems`. Vergleich „aktive Ansicht“ über JSON mit sortierten
    Schlüsseln und Listen (`view-state.ts`, `jsonb` ordnet Schlüssel um).
  - **Sortierung im Explorer:** `ExplorerState.sort` aus `sort=<spalte>.<richtung>`; `buildColumnDefs({ sort })` setzt die
    Richtung an der Spalte und `null` an allen anderen, das Grid meldet nur Klicks (`source === 'uiColumnSorted'`), eine Spalte
    (`suppressMultiSort`); die Seite schreibt sie per `replace` in die URL (kein Verlaufseintrag je Klick).
  - Browser-Pane geprüft (Demo-Daten): speichern (mit Freigabe), laden aus einem anderen Reiter mit Sortierung, umbenennen,
    löschen, Sortierung aus der URL (`aria-sort`), Handy und Hell, Konsole ohne Fehler.
  - Review (unabhängig): keine kritischen Befunde; Mandanten- und Besitzertrennung bestätigt. Übernommen: `404` nach
    Rücknahme der Freigabe durch einen Admin, `selectionHidden` statt still „alle“, Sichtbarkeit einmal je Anfrage (vorher
    mehrere Abfragen je Ansicht), veraltete Zustände sichtbar und löschbar, `replace` beim Laden über den Link, Link auf den
    anderen Bereich, Rückfrage beim Überschreiben, Text bei vergebenem Namen, Tests (Admin nimmt Freigabe zurück, fremde
    Organisation bei PATCH/DELETE, Zustand im falschen Bereich). Bewusst so: Laden überschreibt die eigene Spaltenauswahl
    der Ebene (wie selbst eingestellt), Grenze von 200 Ansichten ohne Sperre gegen gleichzeitiges Anlegen (höchstens knapp
    darüber, unkritisch), herabgestufte Besitzer ändern ihre freigegebenen Ansichten weiter (nur neu freigeben nicht).

### 2.10 Mitglieder (`/admin/members`, F9)
- [x] Liste mit Name, E-Mail, Rolle, Status (Link offen/aktiv); anlegen, Rolle ändern, entfernen, Link neu erzeugen; Schutz des
      letzten Admins. Entfernen löscht die persönlichen gespeicherten Ansichten des Mitglieds, freigegebene bleiben (2.9).
      **Entschieden (Dominik, 2026-09-29):** Nach dem Setzen des Passworts geht es zur Anmeldung (Hinweis „Passwort gesetzt“),
      keine automatische Anmeldung. Eigene Endpunkte hinter `orgAdminOnly` nach den Sicherheitsregeln in F9; Audit mit handelndem Admin.
- [x] Seite zum Setzen des Passworts über den Link (öffentlich, ohne Session, Token im Fragment), Link nur einmal nutzbar.
- [x] Tests: fremde Organisation, abgelaufener, benutzter und neu erzeugter Link, Entfernen beendet Sessions, letzter Admin,
      Token taucht nicht im Log auf.
- [x] Umsetzung (Stand für 2.11 und später):
  - **Tabelle** `member_password_links` (Migration `0017_member_password_links`): Organisation, Nutzer, `token_hash`
    (Hex-SHA-256, eindeutig), `created_by`, `expires_at` (7 Tage, `PASSWORD_LINK_VALID_DAYS`), `used_at`, `revoked_at`. Das
    Token (32 Zufallsbytes, base64url, 43 Zeichen) steht nur in der Antwort beim Anlegen bzw. Neu-Erzeugen und im Fragment
    des Links (`<APP_URL>/set-password#<token>`), nie in DB, Audit oder Log (Test: `ctx.logs`, Audit, Zeile).
  - **Zugriffe** (`packages/db/src/members.ts`, Verwaltung der Eigentümer-Org nach ADR 002): `listMembers` (Status
    `pending` = gültiger offener Link, `active` = Passwort gesetzt, `expired`), `findUserByEmail`, `addMember` (nur für
    Nutzer **ohne** Mitgliedschaft: neu angelegt oder früher entfernt; sonst `EMAIL_TAKEN`), `updateMemberRole`,
    `removeMember`, `regeneratePasswordLink`, `inspectPasswordLink`, `redeemPasswordLink`. Letzter Admin: Admins der
    Organisation werden nach ID geordnet gesperrt (`FOR UPDATE`), dann das Ziel; weder herabstufen noch entfernen
    (`LAST_ADMIN`). Eigenes Konto nicht entfernen (`SELF`). **Superadmins** (Plattform-Rolle) ändern, entfernen, wieder
    aufnehmen oder mit einem Link versehen nur Superadmins (`PROTECTED`), sonst übernähme ein Org-Admin über „Neuer Link“ das
    Superadmin-Konto (Review). Kein Link für Nutzer, die auch in einer anderen Organisation Mitglied sind
    (`OTHER_ORGANIZATION`, Phase 6). Entfernen: Mitgliedschaft löschen, offene Links sperren, **alle** Sessions des Nutzers
    löschen, persönliche Ansichten der Organisation löschen (freigegebene bleiben, 2.9); der Nutzer selbst bleibt
    (Audit-Verweise, Wiederaufnahme). Einlösen: ein atomares `UPDATE` (nicht benutzt, nicht gesperrt, nicht abgelaufen,
    Mitgliedschaft besteht), dann Passwort der Anmeldung per E-Mail setzen oder anlegen (wie better-auth: `credential`,
    `accountId` = Nutzer-ID, Hash von `ctx.password.hash`), alle Sessions beenden. Audit: `member.create`,
    `member.role_update`, `member.remove`, `member.link_create` (handelnder Admin), `member.password_set` (das Mitglied).
  - **API** (`routes/members.ts`, Tag „Mitglieder“): `GET|POST /api/members`, `PATCH|DELETE /api/members/{id}`,
    `POST /api/members/{id}/password-link` hinter `orgAdminOnly`; neue Nutzer über `auth.api.createUser` ohne Session und ohne
    Passwort (Plattform-Rolle `user`; gleichzeitiges Anlegen derselben E-Mail → `409`). Öffentlich:
    `POST /api/password-links/inspect` und `/redeem` (Token im Body; unbekannt, benutzt, gesperrt und abgelaufen gleich:
    `410 PASSWORD_LINK_INVALID`; erst prüfen, dann hashen). Fehler `MEMBER_EMAIL_TAKEN`, `MEMBER_LAST_ADMIN`, `MEMBER_SELF`,
    `MEMBER_OTHER_ORGANIZATION` (409), `MEMBER_PROTECTED` (403), `MEMBER_NOT_FOUND` (404, auch fremde Organisation).
  - **better-auth-Allowlist** (`app.ts`): Von den Organisations-Endpunkten ist per HTTP nur noch `organization/set-active`
    offen; entfernen, Rolle ändern, einladen, verlassen, umbenennen und löschen laufen nicht mehr an Schutz des letzten Admins
    und Sessions vorbei (Review). `auth-audit.test.ts` ruft sie direkt über `auth.handler` auf (die Audit-Hooks bleiben).
  - **Web:** `pages/MembersPage.vue` (Liste ohne waagerechtes Scrollen, auf dem Handy gestapelt; Rolle je Zeile,
    Status mit Punkt, „Neuer Link“ (Rückfrage bei aktivem Konto), Entfernen mit Rückfrage, eigene Admin-Rolle abgeben mit
    Rückfrage; Anlegen mit E-Mail, Name, Rolle; Link-Dialog „nur jetzt sichtbar“ mit Kopieren). `pages/SetPasswordPage.vue`
    (Route `/set-password`, öffentlich): Token aus dem Fragment, sofort aus der Adresszeile entfernt, nicht im Query-Schlüssel;
    zeigt Name und E-Mail, Passwort zweimal (mindestens 12 Zeichen, `MIN_PASSWORD_LENGTH`), danach `/login?reason=passwordSet`
    mit Hinweis; ist im Browser jemand angemeldet, bleibt der Hinweis auf der Seite (sonst leitete `/login` weiter).
  - Browser-Pane geprüft: anlegen, Link öffnen (Fragment verschwindet), Passwort setzen, Zweitnutzung `410`, Log nur mit
    Pfaden, Status „Aktiv“, entfernen; Handy und Dunkel.
  - Review (unabhängig): **kritisch** Übernahme des Superadmin-Kontos über „Neuer Link“ bzw. Wiederaufnahme (behoben mit
    `PROTECTED` und Tests). Übernommen: better-auth-Mitgliederpfade gesperrt, erst prüfen dann hashen, Sperrreihenfolge gegen
    Deadlocks, `409` bei gleichzeitigem Anlegen, Rückfragen (aktives Konto, eigene Rolle), Hinweis bei angemeldetem Browser,
    Token nicht im Query-Schlüssel, Test für gleichzeitiges Einlösen. Bewusst so: Entfernen beendet alle Sessions des Nutzers
    (weitere Mitgliedschaften gibt es erst mit Phase 6), Org-Admins können Passwörter anderer Org-Admins derselben
    Organisation per Link zurücksetzen (sie verwalten die Organisation ohnehin; im Audit sichtbar), kein Rate-Limit auf den
    öffentlichen Endpunkten (Token mit 256 Bit, Hash erst nach gültigem Link).

### 2.11 ASIN-Quick-Tool (F10)
- [x] Popover in den Quick-Tools nach F10 (Feature `sp-explorer`, Recht `view`), Zeitraum aus der Filterleiste bzw. Standard,
      Sprung in den Explorer.
      **Entschieden (Dominik, 2026-09-29):** Der Reiter Product Ads bekommt ein Suchfeld „ASIN/SKU“; das Tool öffnet ihn mit den
      gesuchten Werten, ein Klick auf eine Zeile öffnet zusätzlich deren Ad Group.
- [x] Umsetzung (Stand für 2.12 und später):
  - **API:** `filter.productSearch` (1–100 ASINs/SKUs, je bis 60 Zeichen, dasselbe Schema wie `terms` der ASIN-Suche) für
    `explorer/rows` und `timeseries`, nur auf Ebene `productAd` (sonst `400 VALIDATION_ERROR`); die DB-Schicht sucht wie
    `asin-search` in ASIN, SKU und `extra.asins`, ohne Groß-/Kleinschreibung.
  - **Explorer:** Suchfeld „ASIN/SKU“ im Reiter Product Ads (Enter oder Knopf, Aufheben), URL-Parameter `q` (Begriffe mit
    Komma), `parseProductTerms` (Leerzeichen, Komma, Semikolon, Zeilenumbruch; doppelte ohne Groß-/Kleinschreibung und zu
    lange Begriffe fallen weg, höchstens 100). Andere Reiter nehmen `q` nicht mit; leeres Ergebnis mit eigenem Text.
    Gespeicherte Ansichten tragen die Suche als optionales `explorer.productSearch`, nur im Reiter Product Ads.
  - **ASIN-Tool** (`src/asin/AsinTool.vue` im Popover `QuickTools.vue`, nur mit `sp-explorer`/`view`, sonst der
    Platzhalter): Eingabe mehrerer ASINs/SKUs, Suche über `/api/ads/asin-search` mit der **zuletzt benutzten** Auswahl der
    Filterleiste (`ui_state`, bereinigt mit `sanitizeFilterState`, z. B. nicht wählbare Währung → automatisch), ohne
    Vergleich und ohne die URL der aktuellen Seite zu ändern; Zeitraum sichtbar („zuletzt in der Filterleiste gewählt“,
    eigener Zeitraum mit Daten). Treffer (höchstens 30 gezeigt, „und n weitere“ aus `totalRows`) mit ASIN/SKU, Ad-Typ,
    Status, „teilt sich n ASINs“, Profil › Kampagne › Ad Group, Spend, Umsatz, ACoS in der Originalwährung; Klick öffnet
    Product Ads der Ad Group mit der Suche, „Alle im Explorer öffnen“ nur mit der Suche. Eingabe bleibt beim Schließen des
    Popovers erhalten (`src/asin/state.ts`); eine Live-Region für Anzahl, leeres Ergebnis und Fehler; Fehler (auch
    Filteroptionen) mit „Erneut versuchen“.
  - Browser-Pane geprüft (Demo-Daten): Suche nach ASIN und SKU (auch SD nur mit SKU, SB-Kollektion mit „teilt sich
    3 ASINs“), Sprung in den Explorer mit Ad Group und Suche, Konsole ohne Fehler.
  - Review (unabhängig): keine kritischen Befunde. Übernommen: Fehlerzustand bei fehlenden Filteroptionen, Text zum
    Zeitraum (die Filterleiste einer Seite mit geteiltem Link kann von der zuletzt gespeicherten Auswahl abweichen), Daten
    bei eigenem Zeitraum, „weitere“ aus `totalRows`, `q` nicht in andere Reiter und Ansichten, Eingabe bleibt, Live-Region,
    Tests (Fehler, eigener Zeitraum, andere Ebenen). Bewusst so: `q` darf bis 100 Begriffe tragen (100 ASINs rund 1,1 KB;
    lange SKU-Listen länger, aber weit unter URL-Grenzen), die Entscheidung für ein Suchfeld mit URL-Parameter steht oben.

### 2.12 Alte Tabellen ohne waagerechtes Scrollen (F14)
- [x] Sync-Status (`/ops/sync`) und Profiltabelle (`/admin/connections`) passen bei 1440 px (Sidebar ein- und ausgeklappt) auch mit
      klassischer Scrollbar ohne waagerechtes Scrollen; gekürzte Texte auch auf Touch lesbar (nicht nur per Tooltip).
- [x] Im Browser-Pane mit klassischer Scrollbar prüfen (Scrollbar-Breite per CSS nachgestellt, da das Pane Overlay-Scrollbars hat).
- [x] Umsetzung (Stand für 2.13 und später):
  - **Gemessen vorher** (Browser-Pane, 1440 px, Scrollbar per `::-webkit-scrollbar { width: 15px }` und `html { overflow-y:
    scroll }` nachgestellt): Inhalt 1113 px bei ausgeklappter, 1289 px bei eingeklappter Sidebar. Sync-Status brauchte
    1122 px, die Profiltabelle 1120 px, beide scrollten also ausgeklappt waagerecht.
  - **Umbrechen statt kürzen:** Amazon-Konto und Zähler im Sync-Status (`WrappedCell`, vorher `TruncatedCell` mit `title`),
    Land, Kontoname und Zeitzone in der Profiltabelle brechen um; die Zeile wächst mit (`autoHeight`, Zelle ohne Flex wie
    „Ergebnis“, `whitespace-normal` gegen das `nowrap` von AG Grid). `WrapText` (`components/common`) setzt bevorzugte
    Umbruchstellen nach „@“ und „/“ (`amazon-ads-mock@` / `profitbash.test`, `Europe/` / `Stockholm`), notfalls bricht
    `wrap-anywhere` im Wort. Nur die erste Zeile eines Fehlers bleibt gekürzt; der ganze Text steht per Klick darunter.
  - **„Entfernt“** an einem Profil ist ein Knopf mit Popover (`aria-haspopup`, `aria-expanded`) statt eines Tooltips.
  - **Mindestbreiten:** Sync-Status Ergebnis 280 → 220 px (Amazon-Konto bleibt 180, damit die E-Mail auf zwei Zeilen passt);
    Profiltabelle Land 235 → 170 px. Obergrenze `FIT_WIDTH_AT_1440` = 1080 px (`grid/min-width.ts`; 1113 minus Reserve,
    Windows-Scrollbars 17 px), Reserve für die an den Inhalt angepassten Spalten des Sync-Status `SYNC_AUTO_SIZED_WIDTH` =
    670 px (`sync/layout.ts`, gemessen). Tests prüfen beide Grenzen (happy-dom misst keine Texte; die angepassten Spalten
    nur im Browser).
  - **Gemessen nachher:** beide Tabellen 1113 von 1113 px (ausgeklappt) bzw. 1289 von 1289 px (eingeklappt), Seite ohne
    waagerechtes Scrollen, auch auf dem Handy (375 px; die Tabelle scrollt dort in ihrer Kachel, F13). Hell und Dunkel,
    Konsole ohne Fehler und ohne AG-Warnungen.
  - Nicht geändert: Die Client-Auswahl der Profiltabelle kürzt den gewählten Namen im Feld („Waldkauz (D…“); geöffnet steht
    er ganz da, auch auf Touch.
  - Review (unabhängig): keine kritischen Befunde. Übernommen: umbrechende Zellen vertikal mittig, auch wenn eine andere
    Spalte die Zeile höher macht (`AUTO_HEIGHT_CELL` in `grid/grid.ts`: Flex an der Zelle, der Wrapper von AG Grid darf
    schrumpfen; ersetzt den Umweg „kein Flex an der Zelle“), Zeilen ohne Umbruch wieder 52 px (Renderer `min-h-[50px]`
    wegen 1 px Rand oben und unten), exakte Mindestbreite der Profiltabelle im Test (1055 px), Hover am Knopf „Entfernt“
    über die Fläche. Bewusst so: Die Standard-E-Mail steht im Sync-Status bei ausgeklappter Sidebar auf zwei Zeilen (neben
    den Zählern ist nicht Platz für beide in einer Zeile; 1 : 1 ließe die Zähler öfter umbrechen). `SYNC_AUTO_SIZED_WIDTH`
    ist gemessen: bei neuen oder längeren Job-Namen neu messen.

### 2.13 Kleine offene Punkte des Explorers (aus 2.8)
**Entschieden (Dominik, 2026-09-29): jetzt, vor dem Abschluss von Phase 2.**
- [x] Amazon-Werte übersetzt (Match-Typ, Targeting, Gebotsstrategie), unbekannte wie geliefert.
- [x] Ausdrücke von Targets ohne Keyword lesbar statt als JSON (Name, Spalte „Target“, CSV).
- [x] Tastatur-Navigation im Grid (ohne `suppressCellFocus`), Enter löst den Link bzw. Knopf der Zelle aus.
- [x] Zeilen der Abfrage als `shallow` (keine tiefen Proxys bei 10 000 Zeilen).
- [x] Tests: CSV in der Sortierung des Grids, Spaltenauswahl speichern, Fehler beim Nachladen des Vergleichs.
- [x] Umsetzung (Stand für Phase 3):
  - **`explorer/amazon-labels.ts`:** `amazonLabel(kind, value)` über i18n-Keys `explorer.amazon.<kind>.<WERT>`; bekannt
    sind die Werte aus dem Mock (Match-Typen EXACT/PHRASE/BROAD, Auto-Targeting `SEARCH_CLOSE_MATCH` usw., `PRODUCT_EXACT`,
    SB-Themen, Targeting AUTO/MANUAL und SD-Taktiken T00020/T00030, Gebotsstrategie `SALES_DOWN_ONLY` u. a.). Welche Werte
    Amazon wirklich liefert, zeigt 1.10; unbekannte erscheinen unverändert. `targetLabel(attributes)` baut den Text aus
    `keywordText`/`matchType`/`expression` (Keyword · Match-Typ, „ASIN …“, „Kategorie: …“, „Zielgruppe: Aufrufe, 30 Tage“,
    „Automatisch: Eng verwandt“, „Thema: Keywords zur Marke“, sonst „Schlüssel: Wert“-Liste). Die Art ergibt sich aus den
    Feldern des Ausdrucks, weil Negatives und Suchbegriffe keinen `targetType` tragen. Keine API-Änderung.
  - **Name** von Targets und Negatives ohne Keyword: die DB liefert `coalesce(keyword_text, expression::text)`; die Spalte
    „Name“ zeigt `targetLabel`, sobald es einen Ausdruck gibt (Filter, Sortierung und CSV nutzen denselben Text).
  - **Tastatur** (`ExplorerGrid.vue`): Zellen fokussierbar (Pfeiltasten, Leertaste markiert die Zeile), `onCellKeyDown`
    klickt bei Enter auf einer fokussierten Zelle deren ersten Link oder Knopf (Drill-Down, „teilt sich n ASINs“).
    Sync-Status und Profiltabelle behalten `suppressCellFocus` (dort sind Auswahl und Schalter per Tab erreichbar).
  - **`shallow: true`** für beide Zeilen-Abfragen (`useExplorerRows`); die Zeilen werden nie verändert, nur ersetzt.
  - Browser-Pane geprüft (Demo-Daten, 1440 px): Targets ohne JSON (SP, SB-Themen, SD-Zielgruppen und Kategorien),
    Match-Typen übersetzt, Klick auf „Status“, Pfeil links, Enter öffnet die Ad Groups der Kampagne; Konsole ohne Fehler
    und ohne AG-Warnungen.
  - Nicht in 2.13: Brotkrumen-Namen nach einer Änderung der Filterleiste (aus den Zeilen statt aus dem Verlauf) bleiben
    als bekannte Grenze aus 2.8.
  - Review (unabhängig): keine kritischen Befunde; `shallow`, Tastatur ohne Doppelklick und Schutz lesbarer Namen bestätigt.
    Übernommen: Verfeinerungen einer Kategorie im Text („Kategorie: Leuchten (brand: Lumen)“), Zielgruppe ohne Zeitraum
    ohne „– Tage“, kein Klick bei gehaltenem Enter oder mit Modifikatoren, Tests mit realistischen Keyword-Zeilen (mit
    Ausdruck), Negatives und fokussiertem Link. Bewusst so: Match-Typen heißen wie im deutschen Marktumfeld üblich
    („Genau“, „Wortgruppe“, „Weitgehend“), damit Nutzer sie wiedererkennen (einzelne Fachbegriffe, keine übernommenen
    Texte); die übrigen Texte sind eigene Formulierungen.

## `.env.example`

Neu in Phase 2: `HEALTHCHECKS_FX_RATES_SYNC_URL` (2.2, optional), optional `AMAZON_ADS_MOCK_SCALE` (2.3, nur Entwicklung).

## Bewusst nicht in Phase 2

- Keine Änderungen an Amazon (Gebote, Budgets, Status): Phase 3
- Keine Tags, keine Produktgruppen: Phase 3/4
- Kein TACoS, kein Profit, keine Shop-Bestellungen: Phase 7 (SP-API)
- Keine Placement-Reports (`phase-1.md` F6), keine stündlichen Daten
- Keine Benachrichtigungen und kein E-Mail-Versand: Phase 5 (siehe F9)
- Keine Profil-Freigaben je Mitglied, keine Kundenzugänge: Phase 6
- Kein Datei-Import (`phase-1.md` 1.11, Auslöser erst nach Phase 2)

## Reihenfolge für Claude Code

2.1 → 2.2 → 2.3 → 2.4 → 2.5 → 2.6 → 2.7 → 2.8 → 2.9 → 2.10 → 2.11 → 2.12 → 2.13.

Eine frische Session je Aufgabe (2.4 und 2.8 ggf. geteilt). Nach jedem Schritt: Tests grün, kleiner Commit, Häkchen in dieser
Datei, Umsetzungsnotizen unter der Aufgabe („Umsetzung (Stand für …)“ wie in Phase 1).
