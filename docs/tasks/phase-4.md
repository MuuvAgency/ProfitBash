# Phase 4 – Tools

> Vor Beginn lesen: `CLAUDE.md`, `docs/plan.md` (§2 Roadmap, §3 Navigation, §5), `docs/tasks/phase-3.md` (Definition of Done,
> 3.2b, 3.4, 3.8, 3.9 und alle „Offen“-Notizen zur Bulk-Datei), `docs/decisions/` (001–005),
> `docs/ideas/2026-10-erweiterungen-sqp-kampagnen-tools.md` (Abschnitte C, D, E; entschieden: F-S7, F-S8, F-S9),
> `design/DESIGN.md`.
>
> **Status: in Arbeit (2026-10-09).** Die Fragen F1–F12 sind entschieden (2026-10-09, die Nummern gelten nur in dieser
> Datei). Fertig: 4.1–4.10. Nächster Schritt: 4.11.
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
  **Startschema (Dominik, 2026-10-09): eigene englische Kürzel** statt der Kürzel des Sheets-Tools, Muster
  `{adType} | {block} | {group} | {target}`, z. B. `SP | EXACT1 | Flaschen | trinkflasche 1l` (Kürzel: AUTO, BROAD,
  PHRASE, EXACT, EXACT1, BRAND, CAT, PAT, PAT-EXP, PAT1, PAT-COMP, PAT-DEF, HEADER, VIDEO, RT-VIEW, RT-BUY).
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

- **F13 – Fragen zu Beginn von 4.4 (Dominik, 2026-10-09):**
  - **Startwerte im Katalog:** noch nicht angesehen; es gelten die Startwerte. Dominik fragt, ob Gebote und Budgets
    **aus vorhandenen Kampagnen des Profils** kommen können, wenn es sie schon gibt. Wird in 4.5 umgesetzt (Vorschlag
    in 4.5 unten), sonst wie empfohlen der Katalog.
  - **Freischalten von vCPM und Off-Amazon** gilt je Baustein des Entwurfs, nicht je Kampagne (wie empfohlen).
  - **Entwürfe gehören dem Team:** Alle mit Schreibrecht sehen und ändern die Entwürfe eines Profils; der Ersteller
    steht dabei.
  - **Ein Entwurf = eine Übermittlung = eine Bulk-Datei** (kein Bündeln mehrerer Entwürfe).

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
    Produkt schon enthalten). Bei Seller-Profilen nur Anzeigen mit SKU: SB- und SD-Zeilen aus Reports tragen nur die
    ASIN und wären nach der SKU-Regel nicht speicherbar (Review-Befund); dieselbe ASIN erscheint über ihre SP-Anzeige mit
    SKU. Die Suche im Dialog filtert nur die geladenen Produkte; bei mehr als 5000 verweist der Hinweis auf die Handeingabe. Audit `product_group.create|update|delete` (Update mit vorher/nachher, ohne Änderung kein
    Event).
  - **Seite:** `/ads/tools` leitet auf `/ads/tools/product-groups` um (weitere Unterseiten kommen mit 4.2, 4.5, 4.7). Filter
    nach Profil, Dialog mit Profil (nur beim Anlegen), Name, gewählten Produkten mit Hero-Auswahl, Liste der beworbenen
    Produkte (Suche, Hinweis „auch in“ anderen Gruppen) und Handeingabe; der Hero ist optional („Kein Hero“). Geprüft im Browser-Pane (Anlegen mit
    Demo-Daten, Handy, Tablet, Hell-Modus, Konsole); Testgruppe danach gelöscht.

### 4.2 Struktur-Katalog, Presets und Namensschema (`packages/shared`, `packages/db`, `packages/engine`)
- [x] Bausteine, Graduation-Kanten und Presets als Daten je Organisation mit eigenen Startwerten (Seed), sechs Presets
      (F-S8); Phrase optional, Standard Breit-Cluster; `BRAND-DEF` ohne ausgehende Kante.
- [x] Zuordnung Preset → Client und Produktgruppe.
- [x] Namensschema als Muster mit Platzhaltern; Engine-Funktion Name aus Baustein, Produktgruppe und Eingaben, mit Prüfung
      der Grenzen von Amazon (Länge, Zeichen) und auf Eindeutigkeit im Profil.
- [x] Verwaltung für Admins (Katalog, Presets, Namensschema) unter `/ads/tools/catalog` (F11).
- [x] Umsetzung (Stand für 4.3 und später):
  - **Ein Dokument je Organisation** (`structure_catalogs`: `catalog` jsonb, `version`, Migration
    `0030_structure_catalog`), geprüft mit `structureCatalogSchema` (`packages/shared/src/structure-catalog.ts`, auch als
    Einstieg `@profitbash/shared/structure-catalog`). Ohne Zeile gelten die Startwerte `DEFAULT_STRUCTURE_CATALOG`
    (Version 0, kein Seed in der Datenbank: neue Organisationen bekommen sie ohne Migration). Ein gespeichertes Dokument,
    das nicht mehr zum Schema passt, fällt mit seiner Version auf die Startwerte zurück. Speichern als Ganzes mit
    Version (409 bei gleichzeitiger Änderung), Audit `structure_catalog.update` mit vorher/nachher.
  - **Prüfung im Schema:** eindeutige Schlüssel, Kanten nur zwischen bekannten Bausteinen, ohne Schleife und nie aus einem
    Baustein mit `source: 'brand'`, Presets nur aus bekannten Bausteinen, genau ein Standard-Preset, Felder passend zum
    Anzeigentyp (Strategie und Platzierungen nur SP, Optimierung nur SD und dort nur `clicks`/`conversions`, also nur
    CPC), nur bekannte Platzhalter. vCPM und Off-Amazon kennt der Katalog nicht (F-S7: Freischalten je Kampagne im Setup).
  - **Beträge in EUR** (Decimal-Strings): Der Katalog gilt für alle Marktplätze; die Plan-Engine (4.3) rechnet Gebote und
    Budgets mit dem Tageskurs in die Währung des Profils um und prüft dann die Grenzen von Amazon.
  - **Bausteine** (19, Schlüssel wie im Ideen-Dokument mit Präfix `SP-`/`SB-`/`SD-`): Werte änderbar (Bezeichnung,
    Kürzel, Gebot, Budget, Strategie, Platzierungen, Optimierung, Rückblick), Art und Targeting fest. Neue Arten von
    Bausteinen kommen mit dem Setup, das sie anlegen kann (4.4, 4.9, 4.10). Phrase gibt es als Baustein, kein
    Start-Preset nutzt sie. Startwerte von Gebot und Budget sind eigene Schätzungen (F4), Dominik korrigiert sie.
  - **Presets:** sechs (Muuv-Standard als Standard, Kontrolle, Funnel-Hub, Launch, Profit und Verteidigung,
    Verbrauchsgut), je Baustein optional abweichendes Gebot, Budget, Platzierung oben und Rückblick. Wirksames Preset:
    Produktgruppe vor Client vor Standard (`effectivePreset`); ein gelöschtes Preset fällt still zurück.
  - **Zuordnung:** `client_presets` (Client → Preset) und `product_groups.preset_key`; setzen dürfen Admins und Editoren
    (`write`), Katalog ändern nur Org-Admins (F11, 403 `STRUCTURE_CATALOG_FORBIDDEN`). Ein Namensschema je Client gibt
    es nicht (F3 nannte es als Empfehlung, entschieden war nur das Startschema); bei Bedarf als Platzhalter `{client}`.
  - **Namen** (`packages/engine/src/naming.ts`, Einstieg `@profitbash/engine/naming`): `renderCampaignName` (leerer
    Platzhalter fällt samt Trenner davor weg), `campaignNameIssues` (leer, länger als 128 Zeichen, Steuerzeichen),
    `uniqueCampaignName` (ohne Groß/Klein, hängt ` 2`, ` 3` an und kürzt dafür das Ende). **Annahme:** 128 Zeichen für SP, SB und
    SD, noch gegen die Limits-Seite von Amazon zu prüfen (siehe „Offen vor dem Bau“).
  - **API** (Feature `tools`): `GET/PUT /api/ads/tools/catalog`, `PUT /api/ads/tools/client-presets/{clientId}`,
    `presetKey` an `POST/PATCH /api/ads/tools/product-groups` (400 `PRODUCT_GROUP_UNKNOWN_PRESET`).
  - **Seite** `/ads/tools/catalog` mit Reitern Presets, Bausteine, Graduation, Namensschema (Vorschau an drei Beispielen)
    und Zuordnung; Entwurf mit Prüfung vor dem Speichern, „Verwerfen“, „Startwerte laden“ (nur in den Entwurf),
    klebende Aktionsleiste. Nicht-Admins sehen alles lesend und setzen nur Presets je Client. Die Tools haben Reiter
    (Produktgruppen · Struktur-Katalog); der Produktgruppen-Dialog wählt das Preset der Gruppe. Das Web nutzt dafür
    `@profitbash/engine` (Workspace-Paket, keine neue externe Abhängigkeit). Geprüft im Browser-Pane (Speichern,
    Handy, Tablet, Hell-Modus); der Testkatalog ist aus der Dev-DB gelöscht.
  - **Review-Befunde (eingearbeitet):** Gespeichert wird mit der Version, auf der der Entwurf beruht (sonst hätte ein
    Neuladen im Hintergrund fremde Änderungen still überschrieben); die Seite meldet eine neuere Fassung. Beim Speichern
    werden Zuordnungen zu gelöschten Presets gelöst (`client_presets`, `product_groups.preset_key`, Zahl im Audit unter
    `clearedAssignments`), neue Presets bekommen zufällige Schlüssel, und das Löschen warnt mit der Zahl der Clients und
    Produktgruppen. Graduation-Kanten dürfen keinen Kreis bilden. Kürzel sind je Anzeigentyp eindeutig. Abweichungen im
    Preset passen zum Baustein (oben nur mit Platzierungen, Rückblick nur bei Zielgruppen; Rückblick nur und immer bei
    Zielgruppen). Befunde der Prüfung sind Codes mit Parametern (`params.issue`), die Seite übersetzt sie und nennt
    Baustein bzw. Preset und Feld. Im Namensschema sind nur Leerraum und `| - _ / · : , ;` Trenner; Klammern bleiben
    stehen. Gleichzeitiges erstes Speichern endet mit 409 statt 500.
  - **Bewusst offen:** Die API lässt Admins Schlüssel, Art und Targeting eines Bausteins ändern (die Oberfläche nicht);
    die Plan-Engine (4.3) liest nur bekannte Schlüssel. Ein Namensschema ohne `{block}`/`{target}` ist erlaubt (Namen
    unterscheiden sich dann nur über ` 2`, ` 3`); keine Warnung beim Wechsel der Seite innerhalb der App (nur beim
    Schließen oder Neuladen des Tabs).

### 4.3 Plan-Engine (`packages/engine`, ohne I/O)
- [x] Eingabe: Preset, Produktgruppe, Keywords bzw. Targets (von Hand oder von der Merkliste), vorhandene Entities des
      Profils. Ausgabe: Plan mit Kampagnen, Ad Groups, Anzeigen, Targets, Negatives, Platzierungen, Namen, Geboten und
      Budgets, dazu Hinweise (schon vorhanden, Grenze verletzt, gesperrt nach E).
- [x] Leitplanken: vCPM und Off-Amazon gesperrt (F-S7), Conquesting nur aus der von Hand gepflegten Liste (F-S9).
- [x] Umsetzung (Stand für 4.4 und später): `buildCampaignPlan` in `packages/engine/src/plan.ts` (Einstieg
  `@profitbash/engine/plan`), reine Funktion. Die Regeln stehen im Kopf der Datei; das Wichtigste:
  - **Eingabe:** Katalog, wirksames Preset, Produktgruppe (Name, Produkte mit Hero), Profil (Land, Währung, Kontoart,
    Client), `eurRate` (1 EUR in Profilwährung, liefert in 4.5 die Tabelle `fx_rates`), allgemeine Keywords (`single`
    für eine eigene Kampagne, `bid` in Profilwährung, z. B. CPC der Merkliste nach F8), Marken-Begriffe, fremde
    Produkte, Kategorien (ID und Name), Wettbewerber-Liste des Clients, Vorhandenes im Profil (Kampagnennamen, exakte
    Keywords), `limitFor` (dieselbe Grenzen-Abfrage wie Phase 3) und Freischaltungen je Baustein.
  - **Verteilung:** Keywords in Breit und Phrase; exakt gesammelt, markierte einzeln; fehlt einer der beiden
    Exakt-Bausteine, nimmt der andere alle (Preset „Kontrolle“: jedes Keyword einzeln). Produkt-Targets ebenso
    (Sammlung und Einzel-Kampagnen); Wettbewerber nur aus der Liste des Clients; eigene Produkte für „schützen“
    (alle ASINs der Gruppe) und „ähnlich wie eigene“ (Hero, erweitert); SD-Zielgruppen mit Rückblick aus Preset bzw.
    Baustein (Katalog-Feld `audience`: Ansichten oder Käufe, neu in 4.3). Ohne passende Eingaben fällt ein Baustein mit
    Hinweis weg.
  - **Trennung:** Exakt geplante Begriffe sind negativ exakt in Auto, Breit und Phrase, Einzel-Begriffe auch in der
    Exakt-Sammlung; mit Marken-Baustein im Preset sind die Marken-Begriffe negativ Phrase in allen allgemeinen
    Keyword- und Auto-Kampagnen.
  - **Anzeigen:** der Hero (ohne markierten Hero das erste Produkt, Hinweis), bei `1:n:1` und Sponsored Display alle
    Produkte; Vendoren ohne SKU, bei Sellern fehlt keine SKU (sonst Fehler).
  - **Beträge:** Eingabe (Profilwährung) vor Preset vor Baustein; Katalogwerte EUR × `eurRate`, zwei Nachkommastellen
    (half-even, ADR 003). Ad Group mit Standardgebot, Name der Ad Group = Name der Kampagne.
  - **Hinweise** mit Schwere `error` (Grenzen von Amazon für Budget und Gebote, Keyword über 10 Wörter oder 80 Zeichen,
    Name ungültig, fehlende SKU, vCPM bei SP bzw. Off-Amazon außerhalb SP), `warning` (Kampagnenname im Profil schon
    vergeben, der Plan zählt ihn hoch; Keyword schon exakt gebucht; vCPM bzw. Off-Amazon freigeschaltet) und `info`
    (Baustein weggelassen, Werbemittel für SB nötig, kein Hero). Die Oberfläche (4.5) sperrt das Übermitteln bei
    `error`.
  - **Leitplanken:** immer CPC und ohne Off-Amazon; `unlocks` je Baustein (gilt für alle Kampagnen des Bausteins im
    Entwurf) schaltet vCPM (nur SB und SD) bzw. Off-Amazon (nur SP) mit Warnung frei. Neue Kampagnen sind aktiv (F6);
    „pausiert“ setzt der Entwurf (4.5).
  - **Review-Befunde (eingearbeitet):** Mit Marken-Baustein im Preset fallen allgemeine Keywords, die einen
    Marken-Begriff als Wortfolge enthalten, aus den allgemeinen Kampagnen (Hinweis `keywordIsBrand`; sonst wären sie
    dort negativ und liefen nie). Doppelte Eingaben werden zusammengeführt (`single`, wenn einer es ist; erstes Gebot).
    Produkt-Targets sind isoliert: geplante fremde ASINs negativ exakt in Auto und Kategorie, einzelne auch in der
    Sammlung; eigene ASINs unter den fremden fallen mit Warnung weg. Jede Kampagne trägt ihre `targeting`-Art (die
    Bulk-Datei braucht sie, auch wenn sich der Katalog nach dem Entwurf ändert). Negatives gelten für die Ad Group.
    Keine SKU-Pflicht für SB; leere Gruppe ist ein Fehler; Marken-Begriffe gegen die Grenze negativer Phrasen
    (4 Wörter); bei freigeschaltetem vCPM zusätzlich die Warnung „Gebot je 1000 sichtbare Impressionen“.
  - **Offen für 4.4/4.5:** Auto-Kampagnen ohne eigene Gebote je Zielgruppe (es gilt das Standardgebot der Ad Group);
    die Harvest-Merkliste (4.6) liefert Keywords mit CPC als `bid`; Grenzen für Keyword-Länge sind Annahmen wie in
    Phase 3. Startdatum setzt 4.4 (heute in der Zeitzone des Profils). `offAmazon` ist eine Einstellung von SP; SD-
    Zielgruppen laufen ihrer Art nach auch außerhalb von Amazon, und Off-Amazon lässt sich laut Ideen-Dokument E nicht
    per Bulk-Datei setzen (in 4.4 prüfen). Ein vor 4.3 gespeicherter Katalog ohne `audience` an den SD-Zielgruppen
    fällt auf die Startwerte zurück (betrifft nur Entwicklungsdaten; die Dev-DB hat keinen gespeicherten Katalog).
    Freischalten gilt je Baustein, nicht je einzelner Kampagne (mit Dominik in 4.5 klären).

### 4.4 Schreibschicht für Anlagen (`packages/db`, `packages/amazon-ads`, `apps/worker`)
- [x] Entwürfe speichern, prüfen, übermitteln (eigene Tabellen; Übermittlungen wie in Phase 3, damit Seite und Verlauf
      dieselben bleiben).
- [x] Bulk-Datei um Anlagen für **Sponsored Products** erweitern: `Create` für Kampagne, Ad Group, Product Ad, Keyword,
      Produkt-Target, Gebotsanpassung, mit den vorläufigen Text-IDs der Guides für Eltern und Kinder; Rundlauf-Test.
- [x] Bestätigung durch den nächsten Bulk-Import (Zuordnung über Namen, danach echte IDs).
- [x] API-Weg gegen den Mock (SP v3 `POST /sp/campaigns` usw.), ADR 005 ergänzen.
- [x] Umsetzung (Stand für 4.5 und später):
  - **Quellen (2026-10-09):** „Config“-Blatt der echten Bulk-Datei (Pflichtspalten je Entity und Operation, nur
    Kopfzeilen und Werte-Listen gelesen), Guide „How to create Sponsored Products campaigns“, Limits-Seite von Amazon,
    SP-v3-Spec (ADR 005, Abschnitt „Anlagen über die API“). Pflicht bei `Create`: Kampagne ID, Name, Tagesbudget,
    Targeting-Typ, Zustand, Startdatum, Gebotsstrategie; Ad Group Kampagne, ID, Name, Standardgebot, Zustand; Product
    Ad Kampagne, Ad Group, SKU (Seller) bzw. ASIN (Vendor), Zustand; Keyword und Produkt-Target Kampagne, Ad Group,
    Zustand, Text und Match-Typ bzw. Ausdruck (Gebot optional); Gebotsanpassung Kampagne und Platzierung.
  - **Limits-Seite:** Kampagnenname höchstens 128 Zeichen bei Sellern, **116 bei Vendoren**; nur die dort genannten
    Zeichen (Buchstaben, Ziffern, Leerzeichen, `- $ " ' & ( ) * + , . / : ; = ? @ \ [ ] _ ` ~ { } |`, Umlaute und
    weitere Latin-Bereiche; **nicht** `·`, `%`, `!`, `#`, Emoji). `campaignNameIssues(name, maxLength)`,
    `campaignNameMaxLength(accountType)`; die Plan-Engine und die Vorschau des Namensschemas prüfen danach (der
    Trenner `·` im Namensschema ergibt deshalb einen Fehler). Keywords: 80 Zeichen, 10 Wörter, negativ Phrase 4.
  - **Off-Amazon:** per Bulk-Datei setzbar, laut Guide nur in den USA (`Off-Amazon ad serving`: `Increase reach` |
    `Limit off-Amazon spend`), über die API `offAmazonSettings`. Ohne Freischaltung schreibt ProfitBash in den USA
    „Limit off-Amazon spend“ (F-S7), sonst bleibt das Feld leer (Amazons Standard); freigeschaltet außerhalb der USA
    ergibt einen Hinweis `offAmazonOnlyUs`. Das Ideen-Dokument E („kein Bulk“) ist damit überholt.
  - **Datenmodell** (Migration `0031_campaign_setup`): `campaign_setup_drafts` (Profil, Produktgruppe, Preset, Name,
    Status `draft` → `submitted` | `discarded`, Zustand neuer Kampagnen `ENABLED`/`PAUSED`, Eingaben `inputs`, Plan
    `campaigns`, `version`, Übermittlung) und `campaign_setup_items` (je neuer Entity eine Zeile: Art, Kampagne und
    Ad Group als Text-ID = Name, `payload`, Status wie `ad_changes`, `amazon_entity_id`, Fehler).
    `ad_change_submissions.kind` (`changes` | `setup`): Setups erscheinen auf der Seite „Änderungen“, die Zähler
    zählen ihre Zeilen (`loadAdChangeSubmissionSummaries`). Schemas in `@profitbash/shared/campaign-setup`
    (`plannedCampaignSchema`, `setupInputsSchema`, `saveCampaignSetupDraftSchema`); die Engine leitet ihre Typen
    davon ab.
  - **Engine:** `reviewCampaignPlan` prüft einen gespeicherten (vielleicht geänderten) Plan beim Übermitteln: Name im
    Profil bzw. im Plan schon vergeben (`campaignNameTaken`/`…Duplicate`, Fehler), Name ungültig, Grenzen von Budget
    und Geboten, Keyword zu lang, fehlende Anzeige, SKU (Seller) oder Ziele, fremde Währung, vCPM bei SP,
    Off-Amazon außerhalb SP (Fehler); Keyword schon exakt gebucht, Off-Amazon freigeschaltet (Warnung); SB und SD
    erst mit 4.9/4.10 (`adProductLater`). `planSetupItems` macht aus dem Plan die Zeilen (Kampagne, Platzierungen über
    0 %, Ad Group, Anzeigen, Targets, Negatives; SB und SD nur als Kampagne mit `supported: false`).
  - **Datenbank** (`campaign-setup.ts`): `saveCampaignSetupDraft` (anlegen; ändern mit Version, 409-artig
    `VERSION_CONFLICT`; Profil fest, Produktgruppe desselben Profils, Preset aus dem Katalog), `list…`, `get…`,
    `discard…`, `getCampaignSetupContext` (Profil, vorhandene Kampagnennamen auch archivierter Kampagnen und offener
    bzw. angelegter Setups, exakte Keywords), `submitCampaignSetupDraft` (Sperre je Profil, `review` in der
    Transaktion mit dem aktuellen Stand, eine Übermittlung `setup`, Zeilen, Audit `ad_change_submission.create` mit
    `kind`, `draftId`, `items`; Weg `api` nur mit Connection). SB/SD-Kampagnen stehen sofort als `failed`
    `AD_PRODUCT_NOT_SUPPORTED` in der Übermittlung. Audit `campaign_setup_draft.create|update|discard`.
  - **Ablauf** (`campaign-setup-processing.ts`): `recordCampaignSetupResults`, `closeAdChangeSubmission` zählt
    Setup-Zeilen mit (auch `failRemaining`), ein unterbrochener API-Lauf lässt offene Anlagen als `UNKNOWN_OUTCOME`
    scheitern, `closeBulkFileSubmission` schließt Setup-Zeilen als angelegt bzw. verworfen ab.
    **Bestätigung durch den Bulk-Import** (`confirmCampaignSetupItems`, aus `confirmBulkFileAdChanges`): Kampagne über
    den Namen im Profil (ohne Groß/Klein), Ad Group über den Namen in der Kampagne, darunter Anzeige (SKU bzw. ASIN),
    Keyword (Text, Match-Typ), Produkt-Target (ASIN, exakt bzw. „ähnlich“), Kategorie und Negatives; Gebotsanpassung,
    wenn die Kampagne den Prozentsatz zeigt. Bestätigte Zeilen tragen die echte Amazon-ID.
  - **Bulk-Datei** (`buildSetupBulkFile` im Worker, Blatt SP): je Zeile `Create`, Text-ID = Name (der Guide macht es
    so; eine Text-ID nur aus Ziffern wird abgelehnt), Startdatum = Tag des Downloads in der Zeitzone des Profils
    (Amazon lehnt vergangene Tage ab, deshalb nicht beim Übermitteln festgelegt), Vendoren mit ASIN. Was nicht in die
    Datei passt, scheitert mit Code, Kinder ohne Eltern mit `PARENT_NOT_CREATED`. Download und Abschluss über die
    vorhandenen Endpunkte `GET /api/ads/changes/submissions/{id}/bulk-file` (Dateiname `profitbash-setup-…`) und
    `POST …/close`; die API nennt `kind` je Übermittlung.
  - **API-Weg** (`applyCreates`, ADR 005): Kampagnen (mit Platzierungen in `dynamicBidding`) → Ad Groups → Anzeigen,
    Keywords, Targets, Negatives; Eltern-IDs aus der Antwort, Kinder gescheiterter Eltern `PARENT_NOT_CREATED`,
    keine Wiederholung bei 5xx. Der Job `ad-changes-submit` erkennt `kind = setup` (`buildSetupOperations`):
    Drosselung lässt Zeilen offen, der nächste Lauf setzt mit den angelegten Eltern fort (`created`); Abbruch wie bei
    Änderungen. Der Mock nimmt Anlagen an und liefert sie im nächsten Export (Ende-zu-Ende in
    `ad-changes-flow.test.ts`).
  - **Review-Befunde (eingearbeitet):** `submitCampaignSetupDraft` prüft selbst mit `reviewCampaignPlan` (Aufrufer
    gibt nur `limitFor`); nur Fehler sperren (`rejected` mit `issues`), Warnungen und Hinweise kommen mit der
    Übermittlung zurück (vorher hätte die Liste `[]` jede Übermittlung gesperrt); Dubletten im Profil und in
    offenen Setups sind getestet. Nach dem Abschließen von Hand trägt der nächste Bulk-Import die echten IDs nach,
    auch in abgeschlossenen Übermittlungen (Index `campaign_setup_items_unresolved_profile_idx`). Ein erneuter
    Download schreibt nur noch offene Zeilen; Kinder angelegter Eltern nennen deren echte ID bzw. warten
    (`waiting`), bis der Import sie zugeordnet hat. Die Spalte „Off-Amazon ad serving“ steht nur in der Datei, wenn
    eine Zeile sie belegt (Dateien aus Phase 3 unverändert). Eine Übermittlung ohne anlegbare Kampagne ist sofort
    abgeschlossen. Die Prüfung meldet Namen nur aus Ziffern (`onlyDigits`, wäre in der Datei eine echte ID),
    Auto-Kampagnen mit Zielen, doppelte Ziele bzw. Negatives einer Ad Group und ungültige Ad-Group-Namen (255
    Zeichen). Exakte Keywords offener Setups zählen als gebucht (Warnung). Ergebnisse je Zeile in einer Transaktion.
  - **Offen bzw. bewusst so:** Startdatum ist der Tag des Downloads: Wer kurz vor Mitternacht (Zeitzone des Profils)
    herunterlädt und erst danach hochlädt, bekommt ein vergangenes Datum (Hinweis in der Oberfläche, 4.5). Erster
    echter Upload einer Anlage-Datei steht aus (Pflichtspalten laut Config sind
    erfüllt; ob `Bidding Adjustment` mit `Create` ohne Strategie und die Spalte „Off-Amazon ad serving“ außerhalb
    der USA leer angenommen werden, zeigt der Upload). Ein Portfolio setzt das Setup noch nicht (4.7). Auto-Kampagnen ohne eigene Gebote je
    Zielgruppe (Amazon legt die vier an). Der Detail-Endpunkt einer Übermittlung liefert für Setups noch keine Zeilen
    (kommt mit 4.5, ebenso die API für Entwürfe). Kampagnennamen im Profil zählen ohne Rücksicht auf den Anzeigentyp.

### 4.5 Kampagnen-Setup (`apps/api`, `apps/web`)
- [x] Assistent unter `/ads/tools/setup`: Client und Profil → Produktgruppe → Preset → Keywords und Targets → Vorschau der
      Struktur mit Namen, Geboten, Budgets und Hinweisen → Entwurf speichern → übermitteln.
- [x] Entwürfe ansehen, ändern, verwerfen; Verweis auf die Übermittlung. Neue Kampagnen sind im Entwurf **aktiv**
      vorbelegt und je Entwurf auf pausiert umstellbar (F6); die Vorschau sagt das deutlich.
- [x] Startwerte aus dem Profil (F13): Hat das Profil Kampagnen mit Kennzahlen, schlägt das Setup Gebote aus den
      eigenen Daten vor (z. B. mittlerer CPC der letzten 60 Tage je Match-Typ bzw. Targeting-Art, gekennzeichnet als
      „aus dem Profil“), sonst gelten Preset und Baustein. Regel und Mindestdaten beim Bau festlegen und hier notieren.
- [x] Umsetzung (Stand für 4.6 und später):
  - **Startwerte aus dem Profil (F13, Regel):** mittlerer CPC (Kosten ÷ Klicks) der Sponsored-Products-Targets in
    den 60 Tagen vor heute (Zeitzone des Profils), getrennt nach Keywords je Match-Typ, Produkt-Targets (exakt und
    „ähnlich“ zusammen) und Kategorien; nur ab **30 Klicks** je Gruppe, zwei Nachkommastellen (half-even)
    (`loadProfileBidSuggestions`). Die Plan-Engine nimmt sie als `profileBids`: für SP-Bausteine vor Preset und
    Baustein, Gebote aus der Eingabe gehen vor; Standardgebot der Ad Group und Gebote der Ziele. Hinweis
    `bidFromProfile` je Baustein, in der Vorschau zu einer Zeile zusammengefasst; abschaltbar im Assistenten. Budgets
    bleiben beim Katalog (die Kennzahlen sagen nichts über ein passendes Budget neuer Kampagnen).
  - **API** (Feature `tools`, `apps/api/src/routes/campaign-setup.ts`): `POST /api/ads/tools/setup/plan` (Lesen;
    plant auf dem Server mit Katalog, Produktgruppe, Kurs des Tages, Grenzen von Amazon, Vorhandenem und Geboten aus
    dem Profil; `409 CAMPAIGN_SETUP_FX_RATE_MISSING` ohne Kurs), `GET/POST …/setup/drafts`, `GET/PUT …/drafts/{id}`,
    `POST …/drafts/{id}/discard`, `POST …/drafts/{id}/submit` (`status: submitted | rejected` mit `issues`; Weg
    `api` plant den Job ein). Fehler `CAMPAIGN_SETUP_<CODE>`. Das Detail einer Übermittlung
    (`GET /api/ads/changes/submissions/{id}`) liefert `setupItems`. Die Wettbewerber-Liste je Client (F-S9) gibt es
    noch nicht: Conquesting fällt mit Hinweis weg.
  - **Seite** `/ads/tools/setup` (Reiter „Kampagnen-Setup“): Entwürfe des Teams (Status, Ersteller, Link auf die
    Übermittlung) und Assistent auf einer Seite: Profil, Produktgruppe, Preset (vorbelegt: Gruppe vor Client vor
    Standard), Eingaben als Textfelder je Zeile (Keywords, Einzel-Keywords, Marke, fremde ASINs einzeln bzw.
    gesammelt, Kategorien `ID;Name`), Freischalten je Baustein (vCPM bei SB/SD, Off-Amazon bei SP), „Planen“.
    Vorschau: Hinweise nach Schwere, Kampagnen mit Art, Budget und Standardgebot (bearbeitbar), Zahl der Anzeigen,
    Ziele und Negatives, Kampagne entfernen; Kurs-Hinweis außerhalb EUR; Schalter „pausiert anlegen“ mit klarem Text
    (F6). Speichern, Übermitteln (Bulk-Datei oder API; ungespeicherte Änderungen werden vorher gesichert; Fehler der
    Prüfung sperren), Verwerfen. Nach dem Übermitteln Verweis auf die Übermittlung. Übermittelte Entwürfe sind nur
    lesbar.
  - **Seite „Änderungen“:** Setup-Übermittlungen tragen „Kampagnen-Setup“, das Detail listet die Anlagen (Art, was,
    Kampagne, Status, Amazon-ID, Fehler) ohne Folgeschritte und mit eigenem Hinweis zum Upload.
  - Geprüft im Browser-Pane (Demo-Daten, 2026-10-09): planen mit Geboten aus dem Profil (8 Kampagnen), pausiert
    speichern, als Bulk-Datei übermitteln (45 Anlagen, eine SD-Kampagne als „noch nicht“), Detail auf der Seite
    „Änderungen“, Download (`profitbash-setup-…xlsx`), Handy und Hell-Modus (die Tabelle lief am Handy über:
    behoben), Konsole ohne Fehler. Testdaten danach gelöscht.
  - **Review-Befunde (eingearbeitet):** Fehlertexte für alle `CAMPAIGN_SETUP_*` (fehlender Kurs, gleichzeitige
    Änderung, keine Verbindung …). Hinweise einer Kampagne fallen weg, wenn der Nutzer sie entfernt bzw. Budget oder
    Standardgebot korrigiert (sonst blieb das Übermitteln gesperrt; der Server prüft beim Übermitteln erneut). Gebote
    aus dem Profil und der Kurs-Hinweis übersetzt und als Betrag bzw. Datum formatiert. Ungespeicherte Änderungen:
    „Schließen“ fragt nach, „Öffnen“ anderer Entwürfe gibt es erst nach dem Schließen, „Verwerfen“ fragt nach.
    „Gebote aus dem Profil“ umschalten verlangt neues Planen; Gruppe und Preset zählen als ungespeicherte
    Änderung. Detail auf der Seite „Änderungen“: Match-Typ, Ausdruck und Platzierung übersetzt, eigene Fehlercodes
    übersetzt. API-Tests je Endpunkt (fremde Organisation, ausgeblendetes Profil, Recht `write`), fehlender Kurs und
    Gebote aus dem Profil über die API.
  - **Offen bzw. bewusst so:** Gebote einzelner Keywords lassen sich in der Vorschau nicht ändern (nur Budget und
    Standardgebot je Kampagne; feiner über „Neu planen“ mit Geboten in der Eingabe später). Ein Ändern der Eingaben
    verlangt „Neu planen“, das manuelle Änderungen der Vorschau überschreibt. Die Kanalwahl „API“ prüft die
    Verbindung erst beim Übermitteln (`409`). Startdatum ist der Tag des Downloads (Hinweis auf der Seite). Ein
    geöffneter, gespeicherter Entwurf zeigt Hinweise erst nach „Neu planen“ bzw. beim Übermitteln.

### 4.6 Harvest von der Merkliste
- [x] Merkliste als Eingang des Setups (Auswahl je Profil), Vorschlag für das Negieren in der Quelle (F7), Einträge nach
      Abschluss von der Merkliste nehmen. Die Merkliste bekommt eine eigene Profil-Auswahl (offener Punkt aus 3.8).
- [x] Umsetzung (Stand für 4.7 und später):
  - **Entschieden (Dominik, 2026-10-09):** Harvest-Begriffe kommen in einen **eigenen Entwurf**; die Produktgruppe
    wählt der Nutzer (kein Übernehmen in offene Entwürfe). Die Wettbewerber-Liste je Client (F-S9) kommt **später**.
  - **Eingang:** Der Assistent zeigt nach der Profil-Wahl die Merkliste dieses Profils („Von der Merkliste“: Begriff,
    Quelle, Klicks, Kosten, CPC; je Begriff Gebot und „eigene Kampagne“). Das ist die eigene Profil-Auswahl der
    Merkliste: Sie hängt hier nicht am Datei-Zeitraum der Suchbegriff-Analyse (offener Punkt aus 3.8 gelöst). Die
    Auswahl steht in `inputs.harvest` (`markId`, `single`, `bid`); der Server liest Begriff, Quelle und CPC selbst
    (`loadHarvestMarkSources`), Einträge anderer Profile fallen mit Warnung `harvestMarkMissing` weg.
  - **Engine** (`packages/engine/src/harvest.ts`, Einstieg `@profitbash/engine/plan`): `harvestInputs` macht aus
    Begriffen Keywords, aus ASIN-Suchbegriffen fremde Produkt-Ziele; das Preset verteilt sie wie alle Eingaben (F7).
    Gebot (F8): Eingabe vor CPC der Merkliste (`harvestCpc`: Kosten ÷ Klicks beim Vormerken, half-even, nur in der
    Währung des Profils), sonst Baustein bzw. Gebote aus dem Profil. `planSourceNegatives` schlägt je Begriff
    **negativ exakt in der Ad Group der Quelle** vor (ASINs als negatives Produkt-Ziel), vorbelegt und abwählbar
    (`deselectedSources` bleibt beim neuen Planen abgewählt). Kein Vorschlag (Hinweis `info`): geschützt
    (`sourceProtected`, nie), Quelle fehlt, kein SP, schon negativ exakt, Quelle bucht den Begriff selbst exakt,
    Plan legt den Begriff nicht an (`sourceNotPlanned`, sonst ginge der Traffic verloren).
  - **Eine Übermittlung:** Gewählte Vorschläge stehen im Entwurf (`campaign_setup_drafts.source_negatives`,
    Migration `0032_harvest_setup`) und werden beim Übermitteln zu Zeilen `source_negative` nach den neuen Kampagnen
    (echte IDs der bestehenden Kampagne und Ad Group im `payload`, Namen in `campaign_ref`/`ad_group_ref`). Damit
    bleibt es bei einem Entwurf = einer Bulk-Datei (F13). Bulk-Datei: `Create` „Negative Keyword“ bzw. „Negative
    Product Targeting“ mit den echten IDs; API-Weg: Eltern als schon angelegt (`created`). Prüfung beim Übermitteln
    (`reviewCampaignPlan`): Ad Group der Quelle muss als SP-Ad-Group im Profil bestehen (`sourceNegativeMissing`),
    geschützte Begriffe des Clients sperren (`sourceNegativeProtected`), Dubletten und Länge wie sonst.
    Bestätigung durch den Import über die Ad Group der Quelle (Amazon-ID) und Text bzw. ASIN.
  - **Merkliste leeren:** Sobald die Übermittlung abgeschlossen ist (`closeAdChangeSubmission` ohne offene Zeilen,
    also nach API-Lauf, Import-Bestätigung oder „hochgeladen“ von Hand), verlassen die Einträge des Entwurfs die
    Merkliste, deren Keyword bzw. Produkt-Ziel angelegt wurde (`releaseHarvestMarks`, Audit
    `search_term_harvest.remove` ohne Nutzer mit `submissionId`). Verworfene oder gescheiterte bleiben vorgemerkt.
  - **API:** `GET /api/ads/tools/setup/harvest?profileId=` (Feature `tools`, `view`; 404 für unsichtbare Profile),
    `inputs.harvest` und `deselectedSources` an `POST …/setup/plan` (Antwort mit `sourceNegatives`),
    `sourceNegatives` an Entwürfen. Die Seite „Änderungen“ zeigt die Zeilen als „Negativ in der Quelle“.
  - **Review-Befunde (eingearbeitet):** Ein Negativ in der Quelle hängt am neuen Ziel seines Begriffs: Als angelegt
    zählen nur Ziele von Sponsored Products (`plannedSpTerms`; SB/SD legt das Setup noch nicht an), die Prüfung beim
    Übermitteln sperrt Negatives ohne geplantes Ziel (`sourceNegativeNotPlanned`). Über die API geht das Negativ erst
    in einem zweiten Aufruf desselben Laufs raus, wenn das Ziel angelegt ist (`deferred`); scheitert das Ziel, scheitert
    das Negativ mit `HARVEST_TARGET_NOT_CREATED`. In der Bulk-Datei steht es nur, wenn das Ziel mit in der Datei steht
    oder schon angelegt ist (Amazon verarbeitet die Datei als Ganzes: lehnt Amazon dort nur das Keyword ab, greift
    das Negativ trotzdem; der Import zeigt das, die Zeile bleibt dann offen). ASIN-Begriffe aus Keyword-Ad-Groups
    bekommen keinen Vorschlag (`sourceKeywordAdGroup`, negative Produkt-Ziele gehen dort nicht). „Schon negiert“
    zählt auch Negatives exakt auf Ebene der Quell-Kampagne. Die Auswahl eines Entwurfs verliert Einträge, die nicht
    mehr auf der Merkliste stehen; ein Profilwechsel leert Auswahl und Vorschläge; ein ungültiges Gebot wird erklärt.
    Audit des Leerens wie `removeHarvestMarks` (`id` = Organisation, `profileIds`). Tests: abgelehntes Keyword behält
    den Begriff auf der Merkliste, zweiter Aufruf im Job, Profilwechsel im Assistenten.
  - Geprüft im Browser-Pane (Demo-Daten, 2026-10-10): Merkliste im Assistenten (Begriff und ASIN aus einer
    Auto-Kampagne), Planen mit beiden, ein Vorschlag abgewählt, als Bulk-Datei übermittelt (25 Anlagen), Detail auf
    der Seite „Änderungen“ mit „Negativ in der Quelle“, Download der Datei, Handy (Tabelle scrollt in sich). Dabei
    gefunden und behoben: Die Prüfung der Quell-IDs verlangte höchstens 20 Ziffern (Demo-IDs haben 22; jetzt String
    bis 64 Zeichen, Bestand prüft das Übermitteln) und schnelle Klicks hintereinander überschrieben die Auswahl (lokale
    Kopie im Auswahlfeld). Testdaten danach gelöscht.
  - **Offen bzw. bewusst so:** Die Suchbegriff-Analyse verlinkt noch nicht ins Setup (Einstieg ist der Assistent).
    Ein Begriff kann in mehreren offenen Entwürfen stehen; die Warnung „schon exakt gebucht“ zählt offene Setups
    mit. Negativ immer exakt in der Ad Group (nicht Kampagnenebene, nicht Wortgruppe). Der CPC einer Merkliste in
    fremder Währung (Profil hat die Währung gewechselt) wird nicht als Gebot genommen; die Spalte zeigt ihn trotzdem.

### 4.7 Portfolio anlegen
- [x] Blatt „Portfolios“ der Bulk-Datei (`Create`), Dialog unter `/ads/tools/portfolios`, Zuordnung beim Setup (F9).
- [x] Umsetzung (Stand für 4.8 und später):
  - **Quelle (2026-10-10):** Guide „Use portfolios with bulksheets“ (`…/bulksheets/bulksheets-portfolios`): Product
    „Portfolios“, Entity „Portfolio“, Operation „Create“ (kein „Archive“), Portfolio ID leer, Name Pflicht. Budget
    optional; dann Betrag, Währung des Marktplatzes, Policy `dateRange` | `monthlyRecurring` (bzw. `noCap`) und
    Startdatum `yyyyMMdd` Pflicht, Ende optional und später nicht mehr änderbar. Kampagnen lassen sich nur
    bestehenden Portfolios zuordnen (ID aus einer später heruntergeladenen Datei). Das „Config“-Blatt der echten Datei
    nennt für Portfolios nichts.
  - **Bulk-Datei:** `buildPortfolioBulkSheet` (`packages/amazon-ads/src/bulk-file.ts`, Blatt „Portfolios“, Spalten
    wie die echte Datei); ungültige Werte, Ende vor Start und doppelte Namen fallen mit Grund weg. Rundlauf mit dem
    Import-Leser (`bulk-export-roundtrip.test.ts`); der Leser kennt jetzt auch die Schreibweise des Guides
    (`monthlyRecurring` …). `buildSetupBulkFile` schreibt Portfolio-Zeilen ins Blatt „Portfolios“ (Datei mit einem
    oder zwei Blättern), Dateiname `profitbash-portfolio-…`.
  - **Datenmodell** (Migration `0033_portfolio_create`): Ein neues Portfolio ist eine eigene Übermittlung der Art
    `portfolio` (nur Bulk-Datei) mit einer Zeile `portfolio` in `campaign_setup_items` (ohne Entwurf; `draft_id` ist
    nur dafür leer). So gelten Seite „Änderungen“, Zähler, Download, „hochgeladen/verworfen“ und die Bestätigung
    wie bei Setups. Der nächste Bulk-Import ordnet die echte ID über den Namen zu (ohne Groß/Klein). Budget in der
    Währung des Profils. Name je Profil eindeutig (bestehende und noch nicht importierte, `PORTFOLIO_NAME_TAKEN`;
    Annahme: höchstens 128 Zeichen, Amazon nennt keine Grenze im Guide).
  - **Zuordnung beim Setup (F9):** Entwurf mit `portfolioId` (ein bestehendes Portfolio des Profils für alle neuen
    Kampagnen, `PORTFOLIO_MISMATCH` sonst). Beim Übermitteln tragen die Kampagnen dessen Amazon-ID (Bulk-Datei
    „Portfolio ID“, API `portfolioId`); fehlt es inzwischen, sperrt `portfolioMissing`. Noch nicht importierte
    Portfolios sind im Assistenten nicht wählbar (Hinweis mit ihren Namen).
  - **API** (Feature `tools`): `GET /api/ads/tools/portfolios?profileId=` (`view`; Portfolios mit Budget und Zahl
    der Kampagnen, dazu `pending`), `POST /api/ads/tools/portfolios` (`write`; 201 mit der Übermittlung).
    Über die API legt ProfitBash keine Portfolios an (F9; Zeilen dort `PORTFOLIO_BULK_FILE_ONLY`).
  - **Seite** `/ads/tools/portfolios` (Reiter „Portfolio“): Profil, Liste (Name, Budget, Kampagnen, Zustand),
    „Angelegt, noch nicht importiert“ mit Verweis auf die Übermittlung, Formular (Name, optional Budget monatlich
    oder im Zeitraum, Start, Ende) nur mit `write`. Seite „Änderungen“: Art „Portfolio“, Zeile mit Name und Budget,
    eigener Hinweis zur Zuordnung nach dem nächsten Import.
  - Geprüft im Browser-Pane (Demo-Daten, 2026-10-10): Liste mit Budgets und Zahl der Kampagnen, Anlage mit Budget im
    Zeitraum, Datei geprüft (Blatt „Portfolios“, Werte wie im Guide), Detail auf der Seite „Änderungen“, Auswahl im
    Assistenten mit Hinweis auf das noch nicht importierte, Handy, Konsole ohne Fehler. Dabei behoben: Zustand
    übersetzt, Dateiname, Zeitraum mit Ende. Testdaten gelöscht.
  - **Review-Befunde (eingearbeitet):** Auf der Seite „Änderungen“ fehlte der Download-Knopf für Übermittlungen ohne
    Änderungen, also für Setups (seit 4.5) und Portfolios: Er zählt jetzt auch offene Anlagen (Test für beide); die
    Auswahl des Wegs für Folgeschritte gibt es nur noch bei Änderungen. Ein Budget darf frühestens heute beginnen
    (Zeitzone des Profils, `PORTFOLIO_START_IN_PAST`; das Formular setzt `min`). Den Namen sperren nur Portfolios,
    deren Datei noch nicht hochgeladen ist (ein „hochgeladen“ ohne Bestätigung durch den Import kann ein gescheiterter
    Upload sein). Namen werden beidseitig in Postgres ohne Groß/Klein verglichen. Unbekannte Budget-Arten (der Sync
    liefert z. B. `noCap`) erscheinen lesbar. Assistent: Fehler der Portfolio-Liste mit „Erneut versuchen“ und Hinweis,
    wenn das Portfolio eines Entwurfs nicht mehr besteht. Eigener Fehlertext, wenn die Profil-Liste nicht lädt.
    **Bewusst nicht:** Payloads der Anlagen im Web als Union typisieren (die API liefert sie offen typisiert, die
    Anzeige prüft je Art); Mindestbudget eines Portfolios (der Guide nennt keines, Amazon lehnt beim Upload ab).
    Nach den Befunden im Browser-Pane erneut geprüft: Download-Knopf und „hochgeladen/verworfen“ bei einer
    Portfolio-Übermittlung, keine Auswahl für Folgeschritte.
  - **Offen bzw. bewusst so:** Portfolios ändern (Budget, Name) und Kampagnen bestehender Setups nachträglich
    zuordnen gibt es nicht (nicht Teil von F9). Ein Portfolio je Entwurf, nicht je Kampagne. Erster echter Upload
    einer Portfolio-Datei steht aus.

### 4.8 Gebots-Stack-Simulator (`packages/engine`, `apps/web`)
- [x] **Vorher gegen die aktuelle Amazon-Doku prüfen**, wie Strategie, Platzierung, Zielgruppen- und B2B-Anpassung
      zusammenwirken (Ideen-Dokument D nennt Annahmen aus Folien).
- [x] Engine-Funktion ohne I/O (Spanne je Platzierung), Seite bzw. Aufruf aus dem Explorer (F12).
- [x] Umsetzung (Stand für 4.9 und später):
  - **Doku-Befund (2026-10-10):** SP-v3-Spec (`SponsoredProductsPlacement`, `shopperCohortBidding`,
    `SponsoredProductsBiddingStrategy`) und Amazon-Guide „Dynamische Gebote“ (`advertising.amazon.com/library/guides/
    dynamic-bidding-sponsored-products`). Platzierungen (oben, Produktseiten, Rest der Suche) und Amazon Business
    (`SITE_AMAZON_BUSINESS`) je 0–900 %, **multiplikativ** (Beispiel der Spec: 1,00 × 1,5 oben × 2 Business = 3,00).
    Zielgruppen (`shopperCohortBidding`, höchstens 10 je Kampagne, je 0–900 %) wirken auf das schon angepasste Gebot
    (Beispiel: 1,00 × 1,5 × 2 = 3,00). „Dynamisch erhöhen und senken“ ändert das Gebot laut aktuellem Guide auf
    **allen** Platzierungen um bis zu ±100 % (1,00 → höchstens 2,00); die Aufteilung „oben +100 %, sonst +50 %“ aus
    dem Ideen-Dokument D stammt aus älteren Seiten und gilt nicht mehr. „Nur senken“ bis −100 %, „fest“ unverändert.
    Dass die Strategie auf das angepasste Gebot wirkt, ist Amazons Rechnung in der Werbekonsole; die Spec beziffert
    es nicht ausdrücklich (Annahme). Regelbasierte Gebote beziffert Amazon nicht (Hinweis). Welche von mehreren
    passenden Zielgruppen gilt, sagt die Doku nicht: Der Simulator rechnet je Zielgruppe eine Zeile.
  - **Engine** (`packages/engine/src/bid-stack.ts`, `simulateBidStack`): Zeilen je Platzierung × Amazon Business
    (falls gesetzt) × Zielgruppe (ohne und je eine) mit Faktor, Mindest- und Höchstgebot (zwei Stellen, half-even)
    und dem höchsten Gebot insgesamt; ungültige Eingaben (`RangeError`): Gebot ≤ 0, Anpassung außerhalb 0–900 oder
    nicht ganzzahlig, mehr als 10 Zielgruppen.
  - **Seite** `/ads/tools/bid-simulator` (Reiter „Gebots-Simulator“, Feature `tools`, `view`): rechnet im Browser,
    lädt keine Daten. Eingaben Basisgebot, Strategie, drei Platzierungen, Amazon Business, Zielgruppen (bis 10);
    Tabelle mit Faktor, mindestens, höchstens; Fehlerhinweis statt Tabelle bei ungültigen Werten.
  - **Aufruf aus dem Explorer (F12):** In der Leiste markierter Zeilen erscheint für genau eine SP-Kampagne „Gebot
    simulieren“ (wie „Strategie und Platzierungen“); der Link trägt Strategie, Platzierungen, Amazon Business,
    Währung und Namen als wenige Query-Werte (`simulatorLink`, keine IDs). Das Basisgebot trägt man ein (es gilt je
    Keyword bzw. Ad Group, nicht je Kampagne).
  - **Review-Befunde (eingearbeitet):** Das Basisgebot nimmt das Dezimalkomma (0,85); Zeilen tragen die Position
    der Zielgruppe (`audienceIndex`), damit gleich benannte Zielgruppen nicht kollidieren; Prozent nur als ganze
    Zahl ohne andere Schreibweisen (1e2), ungültige Felder mit `aria-invalid`, Hinweis per `aria-live`; eine neue
    Query auf derselben Seite wird neu eingelesen; Faktor mit bis zu sechs Nachkommastellen. Geprüft im
    Browser-Pane (Aufruf aus dem Explorer mit Strategie und Platzierung der Kampagne, Handy, Hell-Modus, Konsole).
    **Bewusst so:** „Gebot simulieren“ steht in der Leiste markierter Zeilen und erscheint deshalb nur, wo man Zeilen
    markieren kann (Schreibrecht) und für eine änderbare SP-Kampagne (nicht archiviert); die Seite selbst ist mit
    `view` im Feature `tools` erreichbar. Amazon Business mit 0 % zählt als gesetzt (gleiche Zeilen doppelt).
    Höchstgebote je Marktplatz begrenzt der Simulator nicht.
  - **Offen bzw. bewusst so:** Kein CPC-Bezug aus echten Platzierungsdaten (Ideen-Dokument D) und kein gestapelter
    Balken: Die Platzierungsberichte liegen ProfitBash noch nicht vor. SB und SD rechnet der Simulator nicht (andere
    Regeln, kommt bei Bedarf mit 4.9/4.10). Zielgruppen-Anpassungen bestehender Kampagnen kennt der Import nicht;
    sie werden von Hand eingetragen.

### 4.9 Setup für Sponsored Display (F1)
- [x] Bausteine `SD-CAT`, `SD-PAT`, `SD-RT-VIEWS`, `SD-RT-PURCHASE` anlegen: Kampagne (Taktik, **nur CPC**, vCPM gesperrt nach
      F-S7), Ad Group mit Gebotsoptimierung, Product Ad, kontextbezogene bzw. Zielgruppen-Targets mit Look-Back; Blatt
      „Sponsored Display Campaigns“ mit `Create`, Rundlauf-Test; API-Weg gegen den Mock.
- [x] Umsetzung (Stand für 4.10 und später):
  - **Entschieden (Dominik, 2026-10-10):** Der Rückblick der Zielgruppen kommt aus Baustein bzw. Preset (Katalog), nicht
    je Entwurf. Bisher kein echter Upload einer Setup- oder Portfolio-Datei (ProfitBash ist noch nicht live).
  - **Quellen (2026-10-10):** Guide „How to create Sponsored Display campaigns with bulksheets“
    (`…/bulksheets/sd/sd-examples/create-sd-campaign`), SD-3.0-Spec (`CreateCampaign`, `CreateAdGroup`,
    `CreateTargetingClause`, `TargetingPredicateNested`), Kopfzeile des SD-Blatts der echten Datei. Das „Config“-Blatt
    der echten Datei nennt **nur Sponsored Products** (84 Zeilen, keine SD-Pflichtspalten).
  - **Guide:** Kampagne `Create` mit Text-ID = Name, Start `yyyyMMdd`, `State`, `Tactic` als ID (`T00020` kontextbezogen,
    `T00030` Zielgruppen), `Budget Type` = `daily`, `Budget`, `Cost Type` (`CPC`; `vCPM` gehört zu „Optimize for viewable
    impressions“); Ad Group mit `Ad Group Default Bid` und `Bid Optimization` („Optimize for page visits“ bzw. „…
    conversions“); Product Ad mit SKU (Seller) bzw. ASIN (Vendor); `Contextual Targeting` (`asin="…"`,
    `category="…"`), `Audience Targeting` (`views=(exact-product lookback=30)`, `purchases=(…)`), `Negative Product
    Targeting`. Eine Kampagne hat nur eine Taktik.
  - **Rückblick:** Amazon nimmt laut Spec nur **7, 14, 30, 60, 90, 180, 365** Tage. Der Katalog prüft das
    (`lookbackNotAllowed`, `presetLookbackNotAllowed`), ebenso das Schema geplanter Ziele. „Ähnlich wie“
    (`asin-expanded`) gibt es nur bei SP (`expandedOnlySp` im Katalog, `expandedNotAvailable` beim Übermitteln).
  - **Engine:** `planSetupItems` legt SD wie SP an (keine Platzierungen): Kampagne mit `sdTactic` und `costType`, Ad
    Group mit `bidOptimization` (`reach` bei freigeschaltetem vCPM), Zielgruppen als neue Entity `audience_target`
    (Migration `0034_sd_setup`, nur der Check der Entity). `reviewCampaignPlan`: `adProductLater` nur noch für SB,
    SKU-Pflicht bei Sellern auch für SD.
  - **Bulk-Datei:** `buildBulkSheet('sd', …)` schreibt `Create`-Zeilen (`sdCreateRow`); SD-Kampagnen ohne `sd` bzw.
    mit Gebotsstrategie, Ad Groups ohne Optimierung, „ähnlich wie“ und unbekannte Rückblicke sind `invalidValue`;
    Platzierungen und Keywords `notSupportedInBulkFile`. Die echte Datei eines Sellers hat nur „ASIN (Informational
    only)“: Die Spalte **„ASIN“** erscheint nur, wenn eine Vendor-Anzeige sie belegt (Annahme nach dem Guide).
    `buildSetupBulkFile` legt die Zeilen nach dem Anzeigentyp der Kampagne ins SP- bzw. SD-Blatt (Portfolios, SP, SD).
    Rundlauf mit dem Import-Leser (Taktik, Budget-Typ, Kostenart, Ausdrücke).
  - **Bestätigung:** Zielgruppen über Ereignis und Rückblick (`expression.event`, `expression.lookback`), alles andere
    wie bei SP über Namen, SKU, ASIN und Kategorie.
  - **API-Weg** (ADR 005, „Anlagen für Sponsored Display“): `applyCreates` (umbenannt aus `applySpCreates`) mit den
    Entities `sd…`; `buildSetupOperations` bildet SD-Zeilen darauf ab, was SD nicht kennt, scheitert mit
    `SD_NOT_SUPPORTED`. Der Mock nimmt SD-Anlagen an und liefert sie im nächsten Export (Ende-zu-Ende in
    `ad-changes-flow.test.ts`).
  - **Oberfläche:** Seite „Änderungen“ zeigt Zielgruppen („Ansichten der Produkte, 30 Tage“), Texte für die neuen
    Befunde; der Hinweis „noch nicht“ nennt nur noch Sponsored Brands.
  - Geprüft im Browser-Pane (Demo-Daten, 2026-10-10): Preset Funnel-Hub mit zwei SD-Retargeting-Kampagnen geplant,
    als Bulk-Datei übermittelt (37 Anlagen, nur SB „noch nicht“), Detail auf der Seite „Änderungen“, Datei geladen
    (Blätter SP und SD, Werte wie im Guide), Handy ohne Überlauf, Konsole ohne Fehler der App. Testdaten gelöscht.
  - **Offen bzw. bewusst so:** Erster echter Upload einer SD-Anlage steht aus (ob `Ad Group` mit `Bid Optimization`
    beim Create angenommen wird und `exact-product` für Ansichten so passt; der Guide zeigt als Beispiel
    `similar-product`). Vendor-Anzeigen von SD in der Spalte „ASIN“ sind eine Annahme. Kontextbezogene SD-Ziele ohne
    Verfeinerungen (Preis, Sterne); keine Zielgruppen fremder Produkte (Ideen-Dokument C.2a nennt sie, F-S9 kommt
    später). Kein Off-Amazon für SD (Einstellung von SP).

### 4.10 Setup für Sponsored Brands (F1)
- [x] Bausteine `SB-HEADER-KW`, `SB-VIDEO-KW`, `SB-PAT` im Blatt „SB Multi Ad Group Campaigns“: Kampagne, Ad Group, Anzeige
      je Format, Keywords bzw. Targets. Marke, Überschrift, Landing Page und Asset-IDs (Logo, Bilder, Video) gibt Dominik
      von Hand ein; die Marken (`Brand Entity ID`) liest der Bulk-Import aus dem Blatt „Brand Assets Data“. Offen: woher die
      Asset-IDs kommen (das Blatt nennt sie nicht). Vorher den Guide
      „create SB multi-ad group campaigns“ je Anzeigenformat auswerten (Pflichtfelder je Format).
- **Entschieden (Dominik, 2026-10-10):** `SB-HEADER-KW` legt eine **Manual Collection** an (Amazon hat „Product
  collection“ abgeschafft): 3–10 Produkte der Produktgruppe. Werbemittel (Marke, Logo-ID, Video-ID, Titel) **einmal je
  Entwurf** für alle SB-Kampagnen. Die `Brand Entity ID` liest der **Bulk-Import** aus dem Blatt „Brand Assets Data“,
  der Assistent bietet sie zur Auswahl. Asset-IDs kopiert Dominik aus der Asset-Bibliothek der Werbekonsole. SB geht in
  Phase 4 **nur per Bulk-Datei** raus (wie Portfolios), die API folgt mit dem echten API-Zugang.
- **Guide-Befund (2026-10-10, `…/bulksheets/sb/sb-examples/create-sb-campaign` und `…/sb-examples/examples`):**
  Kampagne Pflicht: ID, Name, Budget-Typ (`Daily`), Budget, Bid Optimization (`true`: Amazon passt an; `false` nur mit
  eigenen Platzierungs-Zeilen), Brand Entity ID bei Sellern (Vendoren leer), Start optional `yyyyMMdd`. Ad Group: ID,
  Name, State. Anzeige je Format: **Manual Collection ad** (Ad Name, Brand Name, 3–10 Creative ASINs, Landing Page
  Type `Product list` oder `Store` mit URL, optional Brand Logo Asset ID, Ad Title bis 32 Zeichen); **Video ad** (Ad
  Name, ein Creative ASIN, Landing Page `Detail Page` mit URL der Produktseite, Video Asset ID; nur US, UK, DE). Keyword
  und Product Targeting wie bei SP (Bid, `category="…"` bzw. `asin="…"`). Grenzen: Kampagnenname 128, Marke 30,
  Überschrift 50 (Japan 35). Das Blatt „Brand Assets Data“ der echten Datei hat nur `Brand Entity ID` und `Brand Name`
  (keine Asset-IDs); das Blatt „SB Multi Ad Group Campaigns“ hat zusätzlich `Ad Title`, `Product Exclusions`, `Sites`.
- [x] Umsetzung (Stand für 4.11 und später):
  - **Katalog:** neues Feld `sbAdFormat` (`collection` | `video`, nur und immer bei SB: `sbNeedsFormat`,
    `formatOnlySb`); Startwerte `SB-HEADER-KW` und `SB-PAT` Kollektion, `SB-VIDEO-KW` Video. Kein Start-Preset nutzt
    `SB-HEADER-KW` (Funnel-Hub hat das Video). Das Format ist wie die Targeting-Art fest (in der Oberfläche nicht
    änderbar).
  - **Werbemittel je Entwurf** (`inputs.creative`, `sbCreativeSchema`): Marke (`brandEntityId` aus dem Import oder
    keine bei Vendoren), Markenname (30 Zeichen), Logo- und Video-Asset-ID (`amzn1.assetlibrary.…`), Titel der
    Kollektion (32 Zeichen). Der Assistent zeigt den Abschnitt nur bei SB-Bausteinen im Preset, die Video-ID nur bei
    einem Video-Baustein; die Marke füllt den Markennamen vor; falsche Werte sind markiert und sperren das Speichern.
  - **Prüfung** (`reviewCampaignPlan` mit `creative`): ohne Werbemittel `sbCreativeMissing`, Seller ohne Marke
    `sbBrandEntityMissing`, Kollektion mit 3–10 Produkten (`sbCollectionAsins`), Video mit Video-ID, genau einem
    Produkt und nur in US/UK/DE (`sbVideoMissing`, `sbVideoOneProduct`, `sbVideoNotAvailable`), vCPM bei SB gesperrt
    (`sbVcpmNotAvailable`: Das Blatt hat keine Spalte „Cost Type“; die Freischaltung wird für SB nicht mehr
    angeboten). `adProductLater` entfällt.
  - **Anlagen** (`planSetupItems`): Kampagne mit `brandEntityId`, Ad Group, **eine** Anzeige `sb_ad` (Format, Name =
    Kampagnenname, Marke, Assets, alle ASINs der Kollektion bzw. das eine des Videos), Keywords, Produkt-Targets,
    Negatives. Migration `0035_sb_setup` (Tabelle `amazon_ads_brands`, Entity `sb_ad`).
  - **Bulk-Datei** (`sbCreateRow`, Blatt „SB Multi Ad Group Campaigns“): Kampagne mit `Budget Type` Daily, `Bid
    Optimization` true (Amazon passt die Platzierungen an; keine eigenen Platzierungs-Zeilen), Brand Entity ID bei
    Sellern; Ad Group ohne Standardgebot; „Manual Collection ad“ mit Landing Page `Product list`, Brand Name,
    optional Logo und Ad Title, Creative ASINs „A, B, C“; „Video ad“ mit Landing Page `Detail Page` auf
    `https://www.<Marktplatz>/dp/<ASIN>` (Domain je Land im Worker), Video Asset IDs. Placement, Product Ad und
    „ähnlich wie“ werden übersprungen bzw. sind ungültig. Die Setup-Datei schreibt die Blätter Portfolios, SP, SB, SD.
  - **API-Weg:** SB-Kampagnen scheitern mit `SB_BULK_FILE_ONLY`, ihre Kinder mit `PARENT_NOT_CREATED` (entschieden).
  - **Bulk-Import:** liest das Blatt „Brand Assets Data“ (`replaceProfileBrands`: neue anlegen, Namen nachziehen,
    fehlende als entfernt) und SB-Anzeigen je Format als Product Ads mit `extra.adType` (`MANUAL_COLLECTION`,
    `VIDEO` …), `extra.name` und `extra.asins` (wie der Export); vorher waren sie übergangen. Die Bestätigung ordnet
    `sb_ad` über den Anzeigennamen in der Ad Group zu. Rundlauf mit dem Import-Leser für SB-Anlagen.
  - **API:** `GET /api/ads/tools/setup/brands?profileId=` (Feature `tools`, `view`; 404 für fremde und
    ausgeblendete Profile). Seite „Änderungen“: Zeile „Marken-Anzeige“ mit Format, Marke und ASINs.
  - Geprüft im Browser-Pane (Demo-Daten mit einer eingefügten Marke, 2026-10-10): Funnel-Hub mit SB-Video, Marke aus
    der Liste (Name vorbelegt), falsche Logo-ID markiert, Video-ID eingetragen, als Bulk-Datei übermittelt (39
    Anlagen), Detail mit „Marken-Anzeige“, Datei geladen (Blätter SP, SB, SD; SB-Zeilen wie im Guide), Handy ohne
    Überlauf. Dabei behoben: „vCPM für Video“ wurde angeboten, obwohl das SB-Blatt keine Kostenart kennt; der Hinweis
    „braucht Werbemittel“ blieb nach dem Eintragen stehen. Testdaten gelöscht.
  - **Offen bzw. bewusst so:** Erster echter Upload einer SB-Anlage steht aus (Schreibweise der Entities „Manual
    Collection ad“/„Video ad“, `Bid Optimization` als `true`, Landing Page des Videos). Deutsche Namen des Blatts
    „Brand Assets Data“ und der SB-Spalten sind ungeprüft. Kein Store Spotlight, keine Auto Collection, keine eigene
    Landing Page (Store) und kein Logo-Zuschnitt. Ein Satz Werbemittel je Entwurf (nicht je Kampagne).

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
