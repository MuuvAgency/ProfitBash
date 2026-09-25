# ProfitBash — Stitch Screen Prompts

Ready-to-paste prompts for Google Stitch. Instructions are in English (Stitch reads
English best); **UI copy stays in German** because the product is German.

**How to use:** In Stitch, first paste `DESIGN.md` as the design system, then paste the
**Shared Preamble** below once, then one **Screen Prompt** per generation. Generate each
screen twice: once "Desktop web," once "Mobile (390px)."

---

## Shared Preamble (paste before every screen prompt)

> Apply the ProfitBash "Kinetic Bento" design system exactly. Surface-layered bento
> tiles (rounded 1.5–2rem, separated by surface tiers + soft violet-tinted shadow, NO
> hard divider lines, NO borders between zones). Violet `#5A44C9` is the only brand/action
> color; lime `#B4DE2C` is the only accent, used only for profit/positive/success in small
> areas (values, dots, thin bars) — never large fills, never glow. Ink `#1B1826` (never
> pure black). Typography: Satoshi for text, JetBrains Mono with tabular figures for ALL
> numbers. Canvas `#EEEDF3`, tiles `#FAFAFC`/`#FFFFFF`, wells `#E6E4EC`, inverted panels
> `#1B1826`. Asymmetric weighted grid — no 3-equal-card rows. No emojis, no serifs, no
> Inter, no gradients on text, no neon, no spinners (skeletons only). Left nav rail on an
> inverted `#1B1826` panel with items: Dashboard, Verkaufsanalyse, Profitabilität, Marken
> & Produkte, Retouren, Bestellungen, Amazon Ads, Einstellungen. On mobile the rail
> becomes a bottom tab bar (Analyse · Bestellungen · Ads · Setup) and tiles stack to a
> single, dense column. Use realistic German marketplace figures, never fake round numbers.

---

## 1. Dashboard (Home)

> Generate the **Dashboard** for ProfitBash. Asymmetric bento layout.
> - **Hero tile (spans 2 cols, inverted `#1B1826` panel):** "Netto-Profit" this month,
>   large mono value `€ 48.213,60`, lime delta pill `+12,4 % vs. Vormonat`, and a slim
>   count-up feel. Below it a thin line spark of daily net profit.
> - **Satellite KPI tiles (1 col each):** "Umsatz" `€ 214.980`, "Bestellungen" `3.842`,
>   "Ø Warenkorb" `€ 55,96`, each with a small sparkline and delta pill (lime up / red down).
> - **"Tägliche Performance" tile:** a 30-day bar/line combo (revenue bars in violet,
>   net-profit line in lime) sitting on a sunken well `#E6E4EC`, mono axis labels.
> - **"Market Velocity" tile:** a trend gauge/area chart with a slow perpetual breathing
>   pulse, label "Marktdynamik", value like `+8,7 %`.
> - **"Marktplätze" mini-tile:** status dots per channel (Amazon = grün, Otto = grün,
>   eBay = amber "Sync ausstehend").
> Top bar: greeting "Guten Morgen, Dominik", date range picker "Sept 2026", export button.

---

## 2. Verkaufsanalyse (Sales Analysis)

> Generate **Verkaufsanalyse**.
> - **Header KPIs:** "Umsatz" `€ 214.980`, "Einheiten verkauft" `4.117`, "Peak-Tag"
>   `Donnerstag`, "Peak-Zeit" `18–20 Uhr`.
> - **Main tile "Umsatztrend":** large multi-week line chart (violet), with a range
>   toggle (7T / 30T / 90T) as ghost pills.
> - **"Wochentags-Analyse" tile:** horizontal bar chart Mon–Son, the strongest day's bar
>   tipped in lime; mono values on the right.
> - **"Tageszeit-Heatmap" tile:** 7×24 grid heatmap of order volume, violet-tinted scale
>   (light Violet Wash → Violet Core), peak cells labeled. No rainbow colors.
> - **"Top-Kategorien" tile:** ranked list with share bars.
> Mobile: charts full width, heatmap scrolls horizontally inside its own tile only.

---

## 3. Profitabilität (P&L)

> Generate **Profitabilität** centered on a **waterfall chart**.
> - **Waterfall tile (spans full width):** steps left→right: `Umsatz` (violet) →
>   `− COGS` (red) → `− Marktplatzgebühren` (red) → `− Versand` (red) → `− Werbekosten`
>   (red) → `− OPEX` (red) → `Netto-Gewinn` (lime). Thin Ink-Tertiary connector lines,
>   mono value labels on each column, sunken well backdrop.
> - **Margin KPI row:** "Bruttomarge" `41,2 %", "Netto-Marge" `22,4 %`, "Deckungsbeitrag"
>   `€ 88.560`.
> - **"Kostenverteilung" tile:** a compact stacked bar (single horizontal bar) showing
>   cost buckets as violet-tinted segments with a mono legend beneath — not a pie.
> - **Period comparison toggle** (Diesen Monat / Vormonat) as ghost pills.

---

## 4. Marken- & Produktperformance (Brand & Product Performance)

> Generate **Marken & Produkte**.
> - **"Marken-Leaderboard" tile:** ranked table — Marke, Umsatz, Netto-Profit, Marge %,
>   trend spark. Rank 1 row subtly tinted Violet Wash. Mono numeric columns, right-aligned.
> - **"SKU Risk-Matrix" tile:** a 2×2 scatter/quadrant (x = Marge, y = Umsatzvolumen),
>   points sized by units; quadrant labels "Stars / Cash Cows / Fragezeichen / Risiko".
>   Violet points, low-margin points tipped red.
> - **"Bestands-Warnungen" tile:** list of low-stock SKUs with amber warning dots, days-
>   of-cover in mono, "Nachbestellen" ghost button per row.
> - **Product detail drawer** (right slide-over on click): SKU header, unit economics
>   breakdown, 90-day sales spark.

---

## 5. Retouren-Analyse (Returns Analysis)

> Generate **Retouren-Analyse**.
> - **Hero gauge tile:** "Retourenquote" as a radial gauge `9,6 %`, delta pill vs.
>   previous period, threshold ring (amber above target).
> - **"Finanzieller Impact" tile:** line/area chart of return-cost trend over time (red-
>   tinted), mono value "Retouren-Kosten `€ 12.340`".
> - **"Ursachen" tile:** horizontal bar breakdown — Defekt, Passform, Falsch bestellt,
>   Beschädigt (Transport), Sonstiges — mono percentages, worst cause tipped red.
> - **"Top-Retouren-SKUs" tile:** compact ranked list.

---

## 6. Bestellungen (Orders)

> Generate **Bestellübersicht** — dense operational table.
> - **Filter bar:** search, marketplace filter chips (Amazon/Otto/eBay/Shopify), status
>   filter, date range, and a "Export" primary button.
> - **Table:** columns Bestell-Nr (mono), Datum (mono), Marktplatz (with channel dot),
>   Kunde, Betrag (mono, right-aligned), Netto-Profit (mono, lime if positive / red if
>   negative), Status. Status = text + colored dot: `Geliefert` (lime), `In Bearbeitung`
>   (amber), `Storniert` (red). Zebra rows via sunken well, sticky header with a single
>   whisper-line underline.
> - **Row click:** slide-over with order line items and fee/COGS breakdown.
> Mobile: table collapses to stacked order cards (Nr + status dot header, amount + profit
> mono, marketplace tag), dense, ≥44px tap targets.

---

## 7. Amazon Ads Optimization (priority screen)

> Generate **Amazon Ads** — the ads command center. Rich asymmetric bento.
> - **Top KPI row:** "Ad Spend" `€ 9.420`, "ROAS" `4,7×`, "ACOS" `21,3 %`, "Attribuierter
>   Profit" `€ 18.760` — mono values, delta pills.
> - **"Dayparting-Budget" hero tile (spans 2 cols):** an editable 24-hour area/curve chart
>   showing how the daily budget auto-distributes across the day; violet area, peak hours
>   tipped lime; draggable-looking handles; header "Tagesbudget `€ 320` · automatisch
>   verteilt". Small toggle "Dayparting aktiv".
> - **"Automatisierungs-Regeln" tile:** stacked rule cards, each: a plain-language rule
>   "WENN ACOS > 30 % über 3 Tage → Gebot −15 %", a status toggle, and last-triggered
>   time (mono). A "+ Regel erstellen" ghost button opens a rule-builder drawer (IF/THEN
>   condition rows, metric selector, threshold input, action selector).
> - **"Auto-Bidding" tile:** strategy selector (Ziel-ACOS / Umsatzmaximierung / Manuell)
>   as segmented control, plus guardrail inputs "Ziel-ACOS `22 %`" and "Max. Gebot `€ 1,80`".
> - **"Kampagnen-Builder" tile:** a create-flow entry — campaign type cards (Sponsored
>   Products / Sponsored Brands / Sponsored Display), each with an "Anlegen" ghost button;
>   note "Struktur wird automatisch angelegt".
> - **"MCP-Sync" status tile:** data-freshness card — "Zuletzt synchronisiert via Amazon
>   MCP · in DB gespeichert", sync-state dot (grün synchronisiert / amber ausstehend / rot
>   Fehler), last timestamp in mono, "Jetzt synchronisieren" ghost button.
> - **"Kampagnen" table:** Kampagne, Typ, Spend (mono), Umsatz (mono), ACOS (mono, red if
>   over target), Status dot, mini spark.
> Mobile: KPIs 2-up, dayparting chart full width, rule cards stack, table → cards.

---

## 8. Setup-Wizard

> Generate the **Setup-Wizard** — 3-step onboarding, centered card on canvas, calm.
> - **Stepper:** "1 Marktplatz verbinden · 2 Kosten hinterlegen · 3 Fertig" with the
>   active step in violet, completed steps with a lime check dot.
> - **Step 1 content:** marketplace connect cards — Amazon Pro, Otto Business, eBay
>   Business, Shopify — each with a "Verbinden" button; Amazon card shows connected state
>   (lime dot, "Verbunden via MCP").
> - Primary "Weiter" button bottom-right, "Zurück" ghost left. One primary action only.
> Mobile: single column, cards stack, sticky bottom action bar.

---

## 9. Einkaufspreise / COGS

> Generate **Einkaufspreise (COGS)** — a data-entry table screen.
> - **Header:** title + "Import CSV" ghost button + "SKU hinzufügen" primary button.
> - **Table:** SKU, Produkt, Netto-EK (mono currency input with unit affix), Währung
>   selector (EUR/USD/GBP), Wechselkurs (mono), Fracht/Stück (mono input), EK in EUR
>   (computed, mono). Inline-editable cells, focus = violet ring, no glow.
> - **FX rate tile** at top: current rates "USD 0,92 · GBP 1,17" with last-updated mono
>   timestamp.
> Empty state: composed illustration + "Ersten Einkaufspreis anlegen" CTA.

---

## 10. Versandprofile (Shipping Profiles)

> Generate **Versandprofile**.
> - **Carrier tabs/cards:** DHL, FedEx, Hermes — selectable.
> - **Profile editor tile:** "Grundgebühr" (mono currency input) + a **weight-tier table**
>   (Von-Gewicht, Bis-Gewicht, Kosten) with "+ Staffel hinzufügen" ghost button.
> - **Preview tile:** a small step chart showing cost vs. weight for the selected carrier
>   (violet stepped line).
> - Save = primary button.

---

## 11. Marktplatzgebühren (Marketplace Fees)

> Generate **Marktplatzgebühren**.
> - **Marketplace selector** chips (Amazon/Otto/eBay/Shopify).
> - **Category fee table:** Kategorie (Elektronik, Fashion, Haushalt, Beauty, …),
>   Provisionssatz % (mono input), Mindestgebühr (mono). Inline-editable.
> - **Summary tile:** "Ø Provision" `13,8 %`, highest-fee category flagged amber.

---

## 12. Werbekosten / PPC

> Generate **Werbekosten (PPC)** — cross-channel ad overview (distinct from the Amazon Ads
> command center; this is the aggregate view).
> - **KPI row:** "Ad Spend gesamt" `€ 14.870`, "ROI" `3,9×`, "ACOS" `24,1 %`.
> - **"Ad Spend Trend" tile:** line chart over time (violet), profit-overlay line (lime).
> - **"Kanäle" table:** Amazon Ads, Google, Meta — Spend (mono), Umsatz (mono), ROI (mono),
>   ACOS (mono, red if over target), share bar.
> - **"ACOS-Verlauf" tile:** area chart with target threshold line (amber).

---

## 13. Indirekte Ausgaben / OPEX

> Generate **Indirekte Ausgaben (OPEX)**.
> - **Total tile:** "Fixkosten / Monat" `€ 21.400` large mono.
> - **Category list:** Personal, Miete, SaaS-Abos, Versicherung, Sonstiges — each row with
>   monthly amount (mono input), a small share bar, and a category dot. "+ Kostenposition"
>   ghost button.
> - **"Verteilung" tile:** single horizontal stacked bar of OPEX buckets (violet-tinted
>   segments) with mono legend.

---

## 14. Login & Registrierung

> Generate **Login** and **Registrierung** — clean, minimal, split layout.
> - **Left (Ink Panel `#1B1826`):** ProfitBash wordmark, a single confident line "Deine
>   Marktplätze. Ein Gewinn." (no clichés), and a subtle abstract violet/lime data-mark —
>   NOT a stock photo, NOT centered filler.
> - **Right (light):** form card — email + password inputs (label above, violet focus
>   ring), primary "Anmelden" button, social login "Mit Google fortfahren" / "Mit Apple
>   fortfahren" as outline buttons with brand marks (no emoji), and a "Passwort vergessen?"
>   text link. Registrierung variant adds "Name" + "Passwort bestätigen".
> Mobile: single column, Ink-Panel header shrinks to a compact brand band on top, form
> below, ≥44px targets.
