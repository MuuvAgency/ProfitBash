# Phase 4 – Tools

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5), `docs/tasks/phase-3.md` (Definition of Done,
> 3.2b, 3.4, 3.8, 3.9 und alle „Offen“-Notizen zur Bulk-Datei), `docs/decisions/` (001–005),
> `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` (Abschnitte C, D, E; entschieden: F-S7, F-S8, F-S9),
> `design/DESIGN.md`.
>
> **Status: in Arbeit (2026-10-09).** Die Fragen F1–F12 sind entschieden (2026-10-09, die Nummern gelten nur in dieser
> Datei). Fertig: 4.1. Nächster Schritt: 4.2.
>
> **Ausgangslage:** Es gibt weiterhin keinen Ads-API-Zugang. Alles, was Phase 4 bei Amazon anlegt, geht deshalb wie in
> Phase 3 als **Bulk-Datei** raus (Upload in der Werbekonsole von Hand) und wird über den API-Weg nur gegen den Mock gebaut.
> Ein echter Upload der SP-Bulk-Datei aus Phase 3 ging am 2026-10-09 ohne Fehler durch (`phase-3.md` 3.2b). Für Anlagen ist
> das nur ein schwacher Beleg: `Create` hat mehr Pflichtfelder als Änderungen, und SB- und SD-Blätter (3.9) sind ungeprüft.

## Ziel

Die Agentur baut neue Werbestrukturen aus ProfitBash heraus, einheitlich und nachvollziehbar:
- **Produktgruppen:** die ASINs und SKUs eines Clients zu beworbenen Einheiten bündeln (Hero und Kinder).
- **Kampagnen-Setup:** aus einer Produktgruppe, einem **Preset** des eigenen Struktur-Katalogs und einer Liste von Keywords
  bzw. Targets entsteht ein Vorschlag für Kampagnen, Ad Groups, Anzeigen und Targets, mit Namen nach dem eigenen
  Namensschema. Die **Harvest-Merkliste** aus Phase 3 (`search_term_harvest_marks`) ist ein Eingang dafür.
- **Bulk-Datei-Export:** der Vorschlag geht als Übermittlung raus (Bulk-Datei jetzt, API später).
- **Gebots-Stack-Simulator:** zeigt, welches Gebot aus Basisgebot, Strategie und Anpassungen höchstens entsteht.
- **Portfolio anlegen** und Kampagnen beim Setup zuordnen.

Navigation (`plan.md` §3): „Tools (Produktgruppen · Kampagnen-Setup · Portfolio)“ unter `/ads/tools/*`, Feature `tools`.
Schreiben nur mit Recht `write` (Admin, Editor).

## Definition of Done (Entwurf)

- [ ] Jede Anlage läuft über einen Entwurf und eine Übermittlung (`runJob`, `job_runs` bzw. Bulk-Datei), nie direkt aus der
      Oberfläche an Amazon; je Übermittlung steht fest, wer was angelegt hat (`audit_event`).
- [ ] Struktur-Katalog, Presets und Namensschema sind **Daten** der Organisation (änderbar, mit Startwerten), nichts davon
      ist hart codiert; Bezeichnungen und Werte sind eigene (Eigenständigkeit, `CLAUDE.md`).
- [ ] Der Plan aus Preset, Produktgruppe und Eingaben entsteht in `packages/engine` ohne I/O (Tests je Baustein und Preset).
- [ ] Leitplanken aus dem Ideen-Dokument E: vCPM und Off-Amazon sind gesperrt und nur je Kampagne bewusst freischaltbar
      (F-S7); Gebote und Budgets werden gegen die Grenzen von Amazon geprüft (wie Phase 3).
- [ ] Doppelte Anlagen werden vor dem Übermitteln erkannt (gleicher Kampagnenname im Profil, Keyword schon exakt gebucht).
- [ ] Die Bulk-Datei für Anlagen ist per Rundlauf mit dem Import-Leser getestet; nach dem nächsten Bulk-Import sind die
      angelegten Entities ihrem Entwurf zugeordnet (über den Namen).
- [ ] Beträge bleiben Decimal-Strings mit Währung; Amazon-IDs Strings.
- [ ] Alle Zugriffe über den Access-Layer (ADR 002); Test je Endpunkt (fremde Organisation, ausgeblendetes Profil, Recht `write`).
- [ ] Tests gegen den Mock-Anbieter (msw bzw. `mock.ts`), keiner gegen echte Amazon-Endpunkte.
- [ ] Browser-Pane geprüft wie in Phase 2 und 3 (1440 px, Tablet, Handy, Hell/Dunkel, Konsole).
- [ ] `pnpm test`, `typecheck`, `lint`, `build`, beide Smoke-Tests und CI grün.

## Fragen an Dominik

Jede Frage mit Empfehlung. Antworten werden hier mit Datum eingetragen („Entschieden (Dominik, …)“).

- **F1 – Welche Anzeigentypen legt das Setup in Phase 4 an?** Sponsored Products ist einfach (Kampagne, Ad Group, Anzeige,
  Keywords oder Targets). Sponsored Brands braucht Werbemittel (Logo, Überschrift, Bilder oder Video aus der
  Asset-Bibliothek), Sponsored Display Zielgruppen. Empfehlung: Der Katalog kennt alle Bausteine (auch SB und SD), **angelegt
  wird in Phase 4 zuerst nur Sponsored Products**; SD (nur CPC) als zweiter Schritt, SB erst, wenn es gebraucht wird.
  **Entschieden (Dominik, 2026-10-09): alle drei, in der Reihenfolge SP, dann SD (nur CPC), dann SB.** Für SB trägt Dominik
  Überschrift und Asset-IDs von Hand ein; ProfitBash lädt keine Werbemittel hoch. Das Blatt „Brand Assets Data“ der echten
  Datei nennt nur Marke und `Brand Entity ID`, nicht die IDs von Logo, Bildern und Videos: Woher Dominik die bekommt
  (Asset-Bibliothek der Werbekonsole), klärt 4.10.
- **F2 – Woher kommen die Produkte einer Produktgruppe?** Ohne SP-API kennt ProfitBash nur ASINs und SKUs, die schon
  beworben werden (Product Ads aus dem Import). Empfehlung: Produktgruppe = Name, Client, Marktplatz und eine Liste von
  ASIN/SKU, **auswählbar aus den schon beworbenen Produkten, ergänzbar von Hand**; ein Produkt ist als „Hero“ markierbar.
  **Entschieden (Dominik, 2026-10-09): Auswahl aus den beworbenen Produkten plus Handeingabe, wie empfohlen.**
- **F3 – Namensschema.** Empfehlung: ein Muster aus Bausteinen je Organisation (z. B. Anzeigentyp, Funnel-Kürzel,
  Produktgruppe, Match-Typ, laufende Nummer), je Client überschreibbar. **Ich schlage ein Startschema vor, du passt es in der
  Oberfläche an.** Alternative: Du gibst mir das Schema aus dem Sheets-Tool vorab (Kürzel und Reihenfolge).
  **Entschieden (Dominik, 2026-10-09): Claude schlägt ein Startschema vor, Dominik passt es in der Oberfläche an.**
- **F4 – Startwerte der sechs Presets** (Bausteine je Preset, Startgebote, Tagesbudgets, Gebotsstrategie). Entschieden ist,
  dass es alle sechs gibt (F-S8). Empfehlung: **Ich lege eigene Startwerte fest, du korrigierst sie in der Oberfläche**; die
  Presets bleiben Daten und sind jederzeit änderbar.
  **Entschieden (Dominik, 2026-10-09): Claude legt eigene Startwerte fest, Dominik korrigiert sie in der Oberfläche.**
- **F5 – Weg einer Anlage.** Empfehlung: Das Setup erzeugt einen **Entwurf** (eigene Liste, nicht der Warenkorb der
  Feldänderungen), den man prüft und dann übermittelt. Die Übermittlung erscheint auf der Seite „Änderungen“ unter
  „Übermittlungen“ wie alle anderen, mit Bulk-Datei zum Herunterladen. Alternative: alles in den Warenkorb legen.
  **Entschieden (Dominik, 2026-10-09): eigener Entwurf, Übermittlung auf der Seite „Änderungen“, wie empfohlen.**
- **F6 – Neue Kampagnen aktiv oder pausiert anlegen?** Empfehlung: **pausiert** (du schaltest sie nach einem Blick in die
  Werbekonsole frei), als Einstellung je Entwurf umstellbar.
  **Entschieden (Dominik, 2026-10-09): aktiv** (abweichend von der Empfehlung), je Entwurf auf „pausiert“ umstellbar.
- **F7 – Harvest von der Merkliste.** Was passiert mit einem vorgemerkten Suchbegriff? Empfehlung: Das Preset der
  Produktgruppe entscheidet, wohin er kommt (eigene Exakt-Kampagne je Begriff oder als Keyword in die Exakt-Kampagne der
  Gruppe); **dazu schlägt derselbe Entwurf vor, den Begriff in der Quelle zu negieren** (abwählbar, geschützte Begriffe nie).
  Der Eintrag verlässt die Merkliste, sobald die Übermittlung abgeschlossen ist.
  **Entschieden (Dominik, 2026-10-09): wie empfohlen** (das Preset entscheidet, Negativ in der Quelle als abwählbarer Vorschlag).
- **F8 – Startgebot neuer Keywords.** Empfehlung: bei Begriffen von der Merkliste der CPC aus den dort festgehaltenen Kennzahlen als
  Vorschlag,
  sonst der Standardwert des Bausteins; immer vor dem Übermitteln änderbar.
  **Entschieden (Dominik, 2026-10-09): CPC der Merkliste als Vorschlag, sonst Standardwert des Bausteins.**
- **F9 – Portfolio anlegen.** Empfehlung: Name und optional ein Budget (monatlich oder Zeitraum), angelegt über das Blatt
  „Portfolios“ der Bulk-Datei; die Zuordnung der Kampagnen passiert beim Setup. Ohne API erfährt ProfitBash die neue
  Portfolio-ID erst mit dem nächsten Bulk-Import: Kampagnen können deshalb erst **danach** zugeordnet werden (zwei Uploads).
  **Entschieden (Dominik, 2026-10-09): Name und optional Budget über das Blatt „Portfolios“, Zuordnung nach dem nächsten Import.**
- **F10 – Was heißt „Bulk-Datei-Export“ für dich?** (a) Nur der Export dessen, was das Setup anlegt (ist mit F5 erledigt),
  oder (b) zusätzlich ein freier Export markierter Explorer-Zeilen als Bulk-Datei zum Bearbeiten in Excel? Empfehlung: **nur
  (a)** in Phase 4.
  **Entschieden (Dominik, 2026-10-09): nur der Export des Setups.** Kein freier Export aus dem Explorer in Phase 4.
- **F11 – Wer darf was?** Empfehlung: Katalog, Presets und Namensschema ändern nur **Admins**; Produktgruppen pflegen und
  Setups anlegen dürfen Admins und Editoren; Viewer sehen alles nur lesend.
  **Entschieden (Dominik, 2026-10-09): Katalog, Presets und Namensschema nur Admins, sonst wie empfohlen.**
- **F12 – Gebots-Stack-Simulator: wo?** Empfehlung: eigene Seite unter „Tools“ und zusätzlich aus dem Explorer aufrufbar
  („Simulieren“ an einer Kampagne übernimmt deren Strategie und Platzierungen). Alternative: nur als Quick-Tool im Popover.
  **Entschieden (Dominik, 2026-10-09): eigene Seite unter „Tools“ und Aufruf aus dem Explorer.**

## Aufgaben (nach F1–F12, 2026-10-09)

**Begriffe:** Ein **Baustein** beschreibt eine Art von Kampagne (Anzeigentyp, Targeting, Struktur, Gebotsstrategie,
Standardwerte, Namensbaustein). Eine **Graduation-Kante** verbindet zwei Bausteine („Gewinner aus A kommen nach B“). Ein
**Preset** wählt Bausteine und Parameter und wird je Client und je Produktgruppe gesetzt (F-S8). Ein **Entwurf** ist der
geprüfte, noch nicht übermittelte Plan eines Setups.

### 4.1 Produktgruppen (`packages/db`, `apps/api`, `apps/web`)
- [x] Tabellen für Produktgruppen und ihre Produkte (Client, Profil bzw. Marktplatz, ASIN, SKU, Hero), Access-Layer, Audit.
- [x] API hinter `requireFeature('tools', …)`; Liste der schon beworbenen Produkte eines Profils als Auswahl (F2).
- [x] Seite „Produktgruppen“ unter `/ads/tools/product-groups` (Liste, Anlegen, Ändern, Löschen; Loading, Empty, Error).
- [x] Umsetzung (Stand für 4.2 und später):
  - **Datenmodell:** `product_groups` (Organisation, **Profil**, Name; ein Name je Profil ohne Groß/Klein) und
    `product_group_items` (ASIN, SKU, Hero, Reihenfolge; ein Produkt je ASIN und SKU, höchstens ein Hero je Gruppe,
    Migration `0029_product_groups`). Eine Gruppe gehört zu **genau einem Profil** und wechselt es nicht; der Client kommt
    über das Profil (keine eigene Spalte, nichts läuft auseinander). Gruppen über mehrere Marktplätze gibt es bewusst
    nicht: Kampagnen, SKUs und Gebote sind je Profil. Zugriffe nur über `packages/db/src/product-groups.ts`
    (`visibleProfilesScope()`): Gruppen ausgeblendeter Profile sind unsichtbar und nicht änderbar.
  - **SKU-Regel:** Seller-Profile verlangen je Produkt eine SKU (Product Ads laufen über die SKU), Vendor-Profile erlauben
    keine; andere Kontoarten (`agency`) ohne Regel. Prüfung in der Handeingabe und in der Datenbankschicht
    (`PRODUCT_GROUP_SKU_REQUIRED` bzw. `…_SKU_NOT_ALLOWED`, 400).
  - **Grenzen** (`packages/shared/src/product-groups.ts`): Name 80 Zeichen, 100 Produkte je Gruppe, 2000 Gruppen je
    Organisation, SKU 40 Zeichen; Auswahl höchstens 5000 beworbene Produkte je Profil (`truncated`).
  - **API** (Feature `tools`, Lesen `view`, sonst `write`): `GET/POST /api/ads/tools/product-groups`,
    `PATCH/DELETE …/{id}` (Produkte werden als Ganzes ersetzt), `GET /api/ads/tools/advertised-products?profileId=`
    (Product Ads aller Anzeigentypen je ASIN und SKU ohne entfernte und Platzhalter, mit „aktiv“ und den Gruppen, die das
    Produkt schon enthalten). Audit `product_group.create|update|delete` (Update mit vorher/nachher, ohne Änderung kein
    Event).
  - **Seite:** `/ads/tools` leitet auf `/ads/tools/product-groups` um (weitere Unterseiten kommen mit 4.2, 4.5, 4.7). Filter
    nach Profil, Dialog mit Profil (nur beim Anlegen), Name, gewählten Produkten mit Hero-Auswahl, Liste der beworbenen
    Produkte (Suche, Hinweis „auch in“ anderen Gruppen) und Handeingabe. Geprüft im Browser-Pane (Anlegen mit
    Demo-Daten, Handy, Tablet, Hell-Modus, Konsole); Testgruppe danach gelöscht.

### 4.2 Struktur-Katalog, Presets und Namensschema (`packages/shared`, `packages/db`, `packages/engine`)
- [ ] Bausteine, Graduation-Kanten und Presets als Daten je Organisation mit eigenen Startwerten (Seed), sechs Presets
      (F-S8); Phrase optional, Standard Breit-Cluster; `BRAND-DEF` ohne ausgehende Kante.
- [ ] Zuordnung Preset → Client und Produktgruppe.
- [ ] Namensschema als Muster mit Platzhaltern; Engine-Funktion Name aus Baustein, Produktgruppe und Eingaben, mit Prüfung
      der Grenzen von Amazon (Länge, Zeichen) und auf Eindeutigkeit im Profil.
- [ ] Verwaltung für Admins (Katalog, Presets, Namensschema) unter `/ads/tools/catalog` (F11).

### 4.3 Plan-Engine (`packages/engine`, ohne I/O)
- [ ] Eingabe: Preset, Produktgruppe, Keywords bzw. Targets (von Hand oder von der Merkliste), vorhandene Entities des
      Profils. Ausgabe: Plan mit Kampagnen, Ad Groups, Anzeigen, Targets, Negatives, Platzierungen, Namen, Geboten und
      Budgets, dazu Hinweise (schon vorhanden, Grenze verletzt, gesperrt nach E).
- [ ] Leitplanken: vCPM und Off-Amazon gesperrt (F-S7), Conquesting nur aus der von Hand gepflegten Liste (F-S9).

### 4.4 Schreibschicht für Anlagen (`packages/db`, `packages/amazon-ads`, `apps/worker`)
- [ ] Entwürfe speichern, prüfen, übermitteln (eigene Tabellen; Übermittlungen wie in Phase 3, damit Seite und Verlauf
      dieselben bleiben).
- [ ] Bulk-Datei um Anlagen für **Sponsored Products** erweitern: `Create` für Kampagne, Ad Group, Product Ad, Keyword,
      Produkt-Target, Gebotsanpassung, mit den vorläufigen Text-IDs der Guides für Eltern und Kinder; Rundlauf-Test.
- [ ] Bestätigung durch den nächsten Bulk-Import (Zuordnung über Namen, danach echte IDs).
- [ ] API-Weg gegen den Mock (SP v3 `POST /sp/campaigns` usw.), ADR 005 ergänzen.

### 4.5 Kampagnen-Setup (`apps/api`, `apps/web`)
- [ ] Assistent unter `/ads/tools/setup`: Client und Profil → Produktgruppe → Preset → Keywords und Targets → Vorschau der
      Struktur mit Namen, Geboten, Budgets und Hinweisen → Entwurf speichern → übermitteln.
- [ ] Entwürfe ansehen, ändern, verwerfen; Verweis auf die Übermittlung. Neue Kampagnen sind im Entwurf **aktiv**
      vorbelegt und je Entwurf auf pausiert umstellbar (F6); die Vorschau sagt das deutlich.

### 4.6 Harvest von der Merkliste
- [ ] Merkliste als Eingang des Setups (Auswahl je Profil), Vorschlag für das Negieren in der Quelle (F7), Einträge nach
      Abschluss von der Merkliste nehmen. Die Merkliste bekommt eine eigene Profil-Auswahl (offener Punkt aus 3.8).

### 4.7 Portfolio anlegen
- [ ] Blatt „Portfolios“ der Bulk-Datei (`Create`), Dialog unter `/ads/tools/portfolios`, Zuordnung beim Setup (F9).

### 4.8 Gebots-Stack-Simulator (`packages/engine`, `apps/web`)
- [ ] **Vorher gegen die aktuelle Amazon-Doku prüfen**, wie Strategie, Platzierung, Zielgruppen- und B2B-Anpassung
      zusammenwirken (Ideen-Dokument D nennt Annahmen aus Folien).
- [ ] Engine-Funktion ohne I/O (Spanne je Platzierung), Seite bzw. Aufruf aus dem Explorer (F12).

### 4.9 Setup für Sponsored Display (F1)
- [ ] Bausteine `SD-CAT`, `SD-PAT`, `SD-RT-VIEWS`, `SD-RT-PURCHASE` anlegen: Kampagne (Taktik, **nur CPC**, vCPM gesperrt nach
      F-S7), Ad Group mit Gebotsoptimierung, Product Ad, kontextbezogene bzw. Zielgruppen-Targets mit Look-Back; Blatt
      „Sponsored Display Campaigns“ mit `Create`, Rundlauf-Test; API-Weg gegen den Mock.

### 4.10 Setup für Sponsored Brands (F1)
- [ ] Bausteine `SB-HEADER-KW`, `SB-VIDEO-KW`, `SB-PAT` im Blatt „SB Multi Ad Group Campaigns“: Kampagne, Ad Group, Anzeige
      je Format, Keywords bzw. Targets. Marke, Überschrift, Landing Page und Asset-IDs (Logo, Bilder, Video) gibt Dominik
      von Hand ein; die Marken (`Brand Entity ID`) liest der Bulk-Import aus dem Blatt „Brand Assets Data“. Offen: woher die
      Asset-IDs kommen (das Blatt nennt sie nicht). Vorher den Guide
      „create SB multi-ad group campaigns“ je Anzeigenformat auswerten (Pflichtfelder je Format).

### 4.11 Abschluss
- [ ] Definition of Done prüfen, Browser-Pane, offene Punkte festhalten.

## Offen vor dem Bau (nicht von Dominik zu entscheiden)

- Der echte Upload der Bulk-Datei aus Phase 3 ging am 2026-10-09 durch (SP, ohne Fehlermeldung); für Anlagen bleibt offen:
  Laut dem „Config“-Blatt der echten Datei braucht `Create` für eine Kampagne ID, Name, Tagesbudget, Targeting-Typ, Zustand,
  Startdatum und Gebotsstrategie, für eine Product Ad Kampagne, Ad Group, SKU und Zustand.
- Welche Stammdaten ein Vendor-Profil statt der SKU braucht.
- Grenzen für Namen und Anzahl (Kampagnen je Konto, Keywords je Ad Group) von der Limits-Seite.

## Bewusst nicht in Phase 4

- Keine automatischen Vorschläge für Graduation oder Preset-Wechsel und kein Optimizer (Phase 5)
- Keine Budget-Caps, kein Dayparting (Phase 5)
- Keine automatischen Conquesting-Kriterien und keine Katalogdaten (Phase 7)
- Kein SQP-gestütztes Setup (Phase 2b wartet auf Dateien)

## Reihenfolge für Claude Code

4.1 → 4.2 → 4.3 → 4.4 → 4.5 → 4.6 → 4.7 → 4.8 → 4.9 → 4.10 → 4.11 (erst Sponsored Products vollständig, dann SD, dann SB;
F1). Der Simulator (4.8) hängt an nichts und kann vorgezogen werden. Bis zu drei Aufgaben je Session (`CLAUDE.md`), nach jedem Schritt Tests grün, Commit, Häkchen und „Umsetzung“-Notiz.
