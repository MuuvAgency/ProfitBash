# ProfitBash – Produktplan

> Lebendes Dokument. Quelle der Wahrheit für Roadmap, Navigation und Feature-Keys.
> Details je Phase stehen in `docs/tasks/phase-N.md`, Architekturentscheidungen in `docs/decisions/`.

## 1. Was ist ProfitBash?

Ein Werkzeug der Agentur **Muuv** zur Steuerung von Amazon-Werbung für mehrere Kunden.
Später kommt die Profitabilität je Kunde dazu (Umsatz, Kosten, Netto-Gewinn).
Interner Projektname war `muuv-ppc`, Produkt- und Repo-Name ist **ProfitBash** (`profitbash`).

**Fokus jetzt: Amazon.** Otto, eBay, Shopify und DSP sind pausiert. Die Architektur ist so angelegt,
dass sie später ohne Umbau dazukommen (siehe §5).

## 2. Roadmap

| Phase | Inhalt | Braucht |
|---|---|---|
| **0 – Fundament** | Monorepo, Auth, App-Shell mit kompletter Sidebar, Amazon-Ads-OAuth, Profil-Sync, Jobs, Sync-Status, Settings, Deployment | Ads-API (Mocks bis Freigabe) |
| **1 – Daten** | Entity-Sync (Kampagnen, Ad Groups, Targets, Negatives, Portfolios, Product Ads) und täglicher Report-Import je Ebene in `*_daily_metrics` | Ads-API |
| **2 – Sehen** | Dashboard (Ads-KPIs), Explorer read-only mit Drill-Down, Chart, Grid, Zeitraum/Vergleich, gespeicherte Filter, Mitgliederverwaltung, ASIN-Quick-Tool | – |
| **3 – Ändern** | Pending-Changes-Warenkorb → Submit an Amazon, Submissions, History und Revert, Bulk-Dialoge, Tags | Ads-API (Write) |
| **4 – Tools** | Produktgruppen, Kampagnen-Setup nach **eigenem, konfigurierbarem** Katalog und Namensschema, Portfolio anlegen | – |
| **5 – Automatisieren** | Budget-Caps mit Enforcer und Pacing, Notifications (SSE), Regeln und Bid-Optimizer als tägliche Pipeline, **Dayparting** (Tagesbudget über den Tag verteilen) | – |
| **6 – Steuern** | Ziele (TACoS/ACoS/ROAS/Wachstum) je Client, Kundenzugang (Client-Orgs, Profil-Freigaben), Audit-Log-UI, Plattform-Admin, Impersonation | – |
| **7 – Profit** | Bestellungen, Gebühren, Retouren, Einkaufspreise (COGS), Versand, OPEX, P&L, organische Umsätze → echtes TACoS und Netto-Profit | **Amazon SP-API** |
| später | Otto, eBay, Shopify, DSP, KI-Assistent/MCP-Schnittstelle | jeweilige APIs |

**Hinweis TACoS:** Echtes TACoS braucht organische Umsätze aus der SP-API. Bis Phase 7 zeigt das
Dashboard Ads-Kennzahlen. Die **SP-API-Registrierung sollte parallel jetzt starten**, weil die Freigabe dauert.
Falls sie früh kommt, kann ein schmaler „Sales-Import" vor Phase 7 gezogen werden.

## 3. Navigation (Sidebar) und Feature-Keys

Sichtbar ist ein Eintrag nur mit `view` auf dem Feature-Key (bzw. mit der genannten Rolle).
Einträge späterer Phasen werden schon in Phase 0 angezeigt und öffnen eine Platzhalterseite „Kommt in Phase N".

| Gruppe | Eintrag | Route | Feature-Key / Recht | Phase | Design-Referenz |
|---|---|---|---|---|---|
| Übersicht | Dashboard | `/dashboard` | `dashboard` | 2 | `dashboard_home` |
| Amazon Ads | Explorer | `/ads/explorer/*` | `sp-explorer` | 2 | – |
| | Änderungen (Ausstehend · Übermittlungen) | `/ads/changes` | `changes` | 3 | – |
| | Tags | `/ads/tags/*` | `tags` | 3 | – |
| | Tools (Produktgruppen · Kampagnen-Setup · Portfolio) | `/ads/tools/*` | `tools` | 4 | `amazon_ads` (Builder) |
| | Budgets | `/ads/budgets` | `budgets` | 5 | `werbekosten_ppc` |
| | Automationen & Regeln (inkl. Dayparting) | `/ads/automations` | `automations` | 5 | `amazon_ads` |
| | Ziele | `/ads/goals` | `goals` | 6 | – |
| Profit | Profitabilität (P&L) | `/profit/pnl` | `profit` | 7 | `profitabilit_t_p_l` |
| | Verkaufsanalyse | `/profit/sales` | `profit` | 7 | `verkaufsanalyse` |
| | Produkte & Marken | `/profit/products` | `profit` | 7 | `marken_produkte` |
| | Retouren | `/profit/returns` | `profit` | 7 | `retouren_analyse` |
| | Bestellungen | `/profit/orders` | `profit` | 7 | `bestell_bersicht` |
| | Kosten (Einkaufspreise · Versand · Gebühren · OPEX) | `/profit/costs/*` | `profit` | 7 | `einkaufspreise_cogs`, `versandprofile`, `marktplatzgeb_hren`, `indirekte_ausgaben_opex` |
| Betrieb | Benachrichtigungen | `/notifications` | – (alle) | 5 | – |
| | Sync-Status | `/ops/sync` | Org-Admin | **0** | – |
| Admin | Clients & Connections | `/admin/connections` | Org-Admin | **0** | `setup_wizard` |
| | Mitglieder | `/admin/members` | Org-Admin | 2 | – |
| | Audit-Log | `/admin/audit` | Org-Admin | 6 | – |
| | Plattform (Orgs · Entitlements · Staff) | `/admin/platform/*` | Superadmin | 6 | – |

**Account-Menü (Sidebar-Fuß):** Dark Mode · Einstellungen (`/settings`, Phase 0) · Tastenkürzel · Logout.
**Quick-Tools (Popover):** Phase 0 Platzhalter, ASIN-Tool in Phase 2.
**Login:** Phase 0, Design-Referenz `login_registrierung` (ohne Registrierung, User legt der Admin an).

### Feature-Keys (Entitlements)

`dashboard` · `sp-explorer` · `changes` · `tags` · `tools` · `budgets` · `automations` · `goals` · `profit` · `dsp-explorer` (pausiert)

- `entitled` = die Organisation hat das Feature gebucht (`org_entitlements`).
- `view` / `write` = Rechte des Users, abgeleitet aus seiner Rolle (admin/editor = write, viewer = nur view).
- Neue Features = neuer Key in `packages/shared/src/features.ts`. Keine DB-Enum-Migration nötig (Key als Text).
- `sp-explorer` meint **Sponsored Ads** (SP, SB und SD in einem Explorer, im Gegensatz zu `dsp-explorer`); der Name bleibt, um die
  Entitlements nicht zu migrieren (`phase-2.md` F1). Das ASIN-Quick-Tool hängt am selben Key.

## 4. Rollen

- **Plattform:** `user` | `superadmin` (better-auth Admin-Plugin). Superadmin = Muuv-intern, sieht Plattform-Admin.
- **Organisation:** `admin` | `editor` | `viewer`.
- **Profil-Freigaben (Phase 6):** Mitglieder können auf einzelne Profile eingeschränkt werden.
  Phase 0: Jedes Mitglied sieht alle nicht ausgeblendeten Profile seiner Org. Die Regel steckt bereits im Access-Layer.
- **Kundenzugang (Phase 6):** Die Agentur-Org besitzt alle Daten. Kunden-Orgs bekommen Lesezugriff auf die Profile
  ihres Clients (siehe `docs/decisions/002-tenancy.md`).

## 5. Architektur-Leitplanken für Erweiterbarkeit

1. **`clients` ist die zentrale Geschäftseinheit.** Ein Client (z. B. die Marke „Nordwind") bündelt später Amazon-Ads-Profile,
   SP-API-Seller-Konten, Otto-/eBay-/Shopify-Konten, Ziele und Budgets. Deshalb ist er eine eigene Tabelle,
   kein Freitextfeld am Profil.
2. **Connections haben einen `provider`** (`amazon_ads` jetzt, später `amazon_sp`, `otto`, …).
   Provider-spezifische Daten liegen in eigenen Tabellen (`amazon_ads_profiles`, später `otto_accounts` …).
3. **Ein Paket pro externer API:** `packages/amazon-ads` jetzt, später `packages/amazon-sp`, `packages/otto`.
4. **Jobs laufen über einen Job-Wrapper** (`runJob`). Neue Datenquellen = neue Jobs, keine neue Infrastruktur.
5. **Standard-Postgres ohne Anbieter-Spezialitäten.** So bleibt der Wechsel zwischen Railway, Neon und anderen ein `pg_dump`.
6. **Geldbeträge nie als Float.** `numeric` in der DB, Decimal-Strings in der API.
   **Amazon-IDs immer als Text** (verlustfreies JSON-Parsing).
7. **Mandantenfähig ab Tag 1.** Jede Query läuft über Org-Kontext und Access-Layer.
8. **UI-Texte über i18n-Keys** (Default Deutsch), auch wenn vorerst nur Deutsch gepflegt wird.
9. **Mandanten-Modell nach ADR 002:** Daten gehören der Agentur-Org. Abfragen filtern nie direkt nach
   `organization_id`, sondern immer über den Access-Layer.
10. **Eindeutige Begriffe:** `profileId` = interne UUID, `amazonProfileId` = Amazons ID. Dasselbe Muster für
    spätere Entities (`campaignId` intern, `amazonCampaignId` extern).
11. **`@profitbash/shared` hat getrennte Einstiegspunkte:** Die Wurzel ist browserfähig. Server-Code
    (`/env`, `/crypto`) und schwere Abhängigkeiten (`/access-control`) liegen in eigenen Einstiegspunkten.

### Festlegungen für Phase 1 und später

- **Geld und Währungen:** Beträge in Originalwährung plus Währungscode speichern (`numeric`), eine
  Decimal-Library für Berechnungen (Auswahl in Phase 1, z. B. `decimal.js`). Reporting-Währung EUR (Standard; Anzeigewährung
  wählbar, `phase-2.md` F3).
  Tageskurse (z. B. EZB) in einer eigenen Tabelle, umgerechnete Summen in der UI mit „≈" kennzeichnen.
  Im EU-Konto kommen EUR, GBP, SEK, PLN und TRY gemischt vor.
- **Amazon-Kennzahlen sind vorläufig:** Amazon korrigiert jüngere Werte, bis die Attributionsfenster
  abgeschlossen sind. Der tägliche Import lädt deshalb ein rollierendes Fenster (14–30 Tage) neu und schreibt
  per Upsert (Profil, Datum, Entity).
- **Rate-Limits und Nebenläufigkeit:** Jobs je Connection laufen nacheinander (pg-boss `singletonKey` je Queue,
  dazu eine Lease je Connection über alle Amazon-Datenjobs, Phase 1, 1.3), dazu ein Anfrage-Budget je Profil. Asynchrone Amazon-Reports: anfordern, Status mit Backoff abfragen,
  Report-Zustand in der DB festhalten, damit ein Neustart nichts verliert.
- **Schlüsselrotation** für verschlüsselte Tokens ist ab 0.3 vorgesehen (Schlüssel-ID im Ciphertext).
- **Geldbeträge aus Amazon-JSON:** `parseJsonLossless(text, { decimals: 'string' })` liefert Dezimalzahlen als Quelltext-String,
  `amazonDecimalSchema` normalisiert sie mit `decimal.js` (ADR 003, umgesetzt in Phase 1, 1.1).
- **Ablauf der Refresh-Tokens:** Amazon-Refresh-Tokens ab 30.07.2026 laufen 365 Tage nach der Einwilligung ab. Den Zeitpunkt
  der Einwilligung je Connection festhalten und rechtzeitig zum Neu-Verbinden auffordern (spätestens mit den Notifications in Phase 5).
- **Kennzahlen je Ad-Typ (für Phase 2, Details in `phase-1.md` 1.9):** SP-Attribution ist klick-basiert (`*_7d`, `*_14d`). SB (und
  SD) liefern nur 14 Tage, `*_14d` zählt dort Klicks **und** Views (wie die Konsole), der Klick-Anteil steht in `*_clicks_14d`. Summen
  über Ad-Typen müssen das kennzeichnen. SD: Same-SKU (`*_same_sku_14d`) zählt nur Klicks (gegen `*_clicks_14d` lesen),
  `viewable_impressions` (nur SD) ist die Basis für vCPM. Bei SD-Kampagnen mit `costType` VCPM (`extra.costType` der Kampagne)
  gelten Gebote je 1000 sichtbare Impressionen, nicht je Klick; Gebotsregeln müssen das trennen. SB-Reports sind in v3 „Preview“:
  SB-Kampagnen mit `isMultiAdGroupsEnabled=false` haben Entities, aber keine Kennzahlen; die UI erklärt das bei SB-Summen.

## 6. Betriebskosten-Stufen

Siehe `docs/decisions/001-stack.md` §Kosten. Kurzfassung: **Bauen = 0 €**, Pilot mit 1–2 Kunden ≈ 5–10 $/Monat.

## 7. Ideen-Backlog (noch nicht eingeplant)

- Keyword-Übersetzung im Browser (On-Device) für fremdsprachige Märkte
- Budget-Pacing-Chart mit Ist-, Soll- und Prognosekurve
- Freie Tastenkürzel (Grid-Filter, Chart ein/aus, Drill-Down)
- KI-Assistent über MCP (Fragen an die eigenen Daten, Vorschläge für Regeln)
