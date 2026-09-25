# Design System: ProfitBash — "Kinetic Bento"

> Single source of truth for generating ProfitBash screens in Google Stitch.
> Feed this document to Stitch as the design contract. Every generated screen —
> desktop and mobile — must obey the rules below. When the user's Kinetic Bento
> vision and a generic default conflict, the vision wins; when "athletic energy"
> tempts a neon or glow treatment, the anti-slop discipline wins.

---

## 1. Visual Theme & Atmosphere

ProfitBash is a **financial-analysis cockpit for marketplace sellers** (Amazon, Otto,
eBay, Shopify) rebuilt from the old "Otto Analytics" enterprise dashboard. The mood is
**editorial-athletic**: confident, dense with signal, but never cluttered — like a
well-lit performance lab rather than a spreadsheet.

- **Density: 6/10 — "Daily App, leaning dense."** High information yield per tile, but
  every tile breathes. Mobile is deliberately *denser* than typical apps: minimal
  whitespace, no empty hero bands, information stacked tight — yet still legible.
- **Variance: 8/10 — "Offset asymmetric."** Modular Kinetic Bento tiles of unequal
  weight. A hero KPI tile spans two columns; secondary metrics sit as smaller satellites.
  No symmetric "3 equal cards" rows, ever.
- **Motion: 6/10 — "Fluid spring physics."** Tiles cascade in, KPI numbers count up,
  the "Market Velocity" trend breathes with a perpetual micro-pulse. Weighty, never busy.

**Signature construct — Surface-Layered Bento:** regions are separated **only by
background surface tiers** (subtle luminance/tint steps), never by hard 1px divider
lines or heavy card outlines. A tile is "a slightly different surface floating in the
canvas," held by a soft violet-tinted shadow. This is the defining visual mechanic —
protect it.

---

## 2. Color Palette & Roles

A **two-color functional system**: **violet** is the brand/primary-action color;
**lime** is the *single* energetic accent, reserved for profit, success KPIs, and
positive status. No third decorative color. Saturation stays controlled — no neon, no
glow, no gradient wash.

### Surface tiers (the Bento layering engine)
- **Canvas Mist** (`#EEEDF3`) — Page ground. The recessed base everything floats on.
- **Tile Raise** (`#FAFAFC`) — Standard bento tile fill.
- **Tile Peak** (`#FFFFFF`) — Highest tiles: primary KPI, active/focused tile, inputs.
- **Well Sunken** (`#E6E4EC`) — Recessed wells: chart backdrops, table zebra, inset areas.
- **Ink Panel** (`#1B1826`) — Inverted tiles (e.g. the Net-Profit hero, nav rail on
  desktop). Violet-black, never pure black.

### Text / ink
- **Ink Primary** (`#1B1826`) — Headlines, primary values. Violet-charcoal, `#000000` is BANNED.
- **Ink Secondary** (`#63607A`) — Labels, descriptions, metadata.
- **Ink Tertiary** (`#9C99AD`) — Timestamps, axis ticks, disabled.
- **Ink On-Dark** (`#EDECF3`) — Text on Ink Panel surfaces.

### Brand — Violet (primary action, brand, focus)
- **Violet Core** (`#5A44C9`) — Primary buttons, active nav, links, focus rings, chart primary series. Saturation held ~65%.
- **Violet Press** (`#4835A6`) — Hover/pressed state.
- **Violet Wash** (`#ECE8FA`) — Subtle fills: selected rows, badges, tag chips, sparkline underfill.

### Accent — Lime (the ONLY decorative accent: profit, success, positive delta)
- **Lime Signal** (`#B4DE2C`) — Positive KPI values, profit bars, success status dots, "up" trend highlights. **Small areas only** — values, dots, thin bars, single sparkline stroke. Never a large fill, never behind text, never a glow.
- **Lime Deep** (`#7E9E12`) — Lime text on light surfaces (contrast-safe) and pressed state.

### Semantic status
- **Loss Red** (`#D6524B`) — Negative profit, cancelled orders, over-budget PPC.
- **Warn Amber** (`#E0A233`) — Low-stock warnings, ACOS threshold breaches, learning-phase.
- **Info Violet** — reuse Violet Core for neutral/informational status.

### Structure
- **Whisper Line** (`rgba(27,24,38,0.06)`) — Rare hairline (table header underline only). Prefer surface tiers over lines.
- **Tile Shadow** — violet-tinted, diffuse: `0 1px 2px rgba(48,38,92,0.05), 0 10px 30px rgba(48,38,92,0.08)`. No colored glow, no neon halo.

**BANNED:** purple/blue neon glows, gradient-filled headline text, oversaturated fills, pure black, warm/cool gray drift (stick to the violet-tinted neutral family throughout).

---

## 3. Typography Rules

Sans + mono pairing only — this is a financial software UI, **serifs are BANNED**.

- **Display / Headlines — `Satoshi`.** Track-tight (`-0.02em`), weight-driven hierarchy (500/700), controlled scale via `clamp()`. Headlines assert through weight and color, not size. Inter is BANNED.
- **Body / UI — `Satoshi`.** Regular 400/Medium 500, relaxed leading (1.5), max 65ch on prose blocks.
- **Numbers / Data — `JetBrains Mono` (MANDATORY for all figures).** Every currency value, percentage, delta, KPI, table cell number, axis tick, timestamp, SKU, and campaign ID renders in mono with tabular figures. This is a financial cockpit — numbers must align in columns and never reflow. Use `font-variant-numeric: tabular-nums`.

**Scale (fluid):** Display `clamp(2rem, 4vw, 3rem)` · H1 `1.75rem` · H2 `1.25rem` · Body `1rem` (never below `0.875rem` for data, `1rem`/16px minimum for prose) · Micro-label `0.75rem` uppercase `+0.04em` for tile eyebrow labels.

**BANNED:** Inter, generic system-font stacks for headings, any serif (Times/Georgia/Garamond and even modern serifs — this is a dashboard), massive screaming display sizes, all-caps body copy.

---

## 4. Component Stylings

- **Bento Tiles (primary container):** Generously rounded (`1.5rem`, hero tiles `2rem`). Fill = Tile Raise/Peak; separated from canvas by tier + Tile Shadow, **not** by a border. Inner padding generous (`1.25–1.75rem`). Unequal weights: hero KPI tile spans 2×, satellites 1×. On hover, tile lifts `-2px` with a slightly deeper shadow (spring). No dividers between stacked metrics inside a tile — use spacing and Ink Tertiary labels.

- **Buttons:** Flat, no outer glow. Primary = Violet Core fill, Ink On-Dark text, `0.75rem` radius; tactile `translateY(1px)` + darken to Violet Press on `:active`. Secondary = ghost (transparent, Violet Core text, Violet Wash hover). Tertiary = plain Ink Secondary text link. Max one primary action per view zone. No custom cursors.

- **KPI / Metric block:** Micro eyebrow label (Ink Tertiary, uppercase) → large mono value → delta pill. Positive delta = Lime Deep text on Lime-tinted pill; negative = Loss Red. Optional inline sparkline (single stroke, Violet Core, Violet Wash underfill; the current point dotted in Lime Signal).

- **Charts (Waterfall P&L, Market Velocity, returns, ad curves):** Sit on Well Sunken. Series in Violet Core; profit/positive segments in Lime Signal; cost/negative in Loss Red; neutral gridlines in Whisper Line. Waterfall connectors are thin Ink Tertiary. Axis labels mono. No 3D, no drop-shadowed bars, no rainbow palettes.

- **Inputs / Forms (COGS, shipping, fees, OPEX, setup):** Label above, helper optional, error below in Loss Red. Fill = Tile Peak on Well Sunken context. Focus = 2px Violet Core ring, no glow. Currency inputs mono with unit affix (EUR/USD/GBP). No floating labels.

- **Tables (Orders, SKU leaderboard, fee matrix):** Zebra via Well Sunken, header row underlined with Whisper Line only. Numeric columns mono, right-aligned, tabular. Status as text + colored dot (Delivered = Lime, In Progress = Amber, Cancelled = Loss Red). Sticky header on scroll.

- **Status / Badges:** Pill, tinted fill + matching text (Lime Wash/Deep, Amber tint, Loss tint, Violet Wash/Core). Small dot + label. No emojis.

- **Loaders:** Skeletal shimmer matching exact tile/table dimensions. No circular spinners anywhere.

- **Empty states:** Composed illustration + one clear primary CTA telling the user how to populate data (e.g. "Connect a marketplace" → Setup Wizard). Never a bare "No data."

- **Error states:** Inline, specific, Loss Red, adjacent to the failing element — never a modal for a field error.

---

## 5. Layout Principles

- **Kinetic Bento grid** via CSS Grid (never flexbox `calc()` percentage hacks). Desktop = 12-col grid, tiles span 3/4/6/8 cols by importance; gap `1.25rem`. Deliberately asymmetric — offset a hero tile against a column of satellites.
- **No overlapping elements.** Every tile, chart, and label owns a clean spatial zone. No absolutely-positioned content stacking over other content.
- **No hard section dividers.** Separate zones with surface tiers and negative space, per the Surface-Layering principle.
- **Containment:** app shell max-width ~`1440px` centered; left nav rail on Ink Panel (desktop), collapsing to a bottom tab bar / sheet on mobile.
- **No generic 3-equal-card feature rows.** Use weighted bento or 2-col zig-zag.
- **Full-height regions** use `min-h-[100dvh]`, never `h-screen`.

### Screen inventory (all screens: desktop + mobile)
**Analysis:** Dashboard/Home (Net-Profit hero tile on Ink Panel, daily performance history, Market Velocity trend) · Sales Analysis (revenue trends, weekday analysis, peak-order times) · Profitability/P&L (waterfall: Revenue → COGS → fees → ad spend → Net) · Brand & Product Performance (leaderboards, risk matrix, stock warnings) · Returns Analysis (return-rate gauge, financial-impact trend, cause breakdown).
**Operations:** Orders (compact transaction list, realtime status, quick export).
**Config:** Setup Wizard (3-step marketplace connect) · COGS (net purchase prices, FX EUR/USD/GBP, freight/unit) · Shipping Profiles (base + weight-tiered, DHL/FedEx/Hermes) · Marketplace Fees (category commission rates) · PPC (ad spend, ROI, ACOS) · OPEX (payroll, rent, SaaS).
**Access:** Login & Register (clean, Google/Apple social login).

### Amazon Ads Optimization (new priority screen — build the full shell now)
A dedicated command center; automations are wired later, but every surface must exist:
- **Dayparting Budget tile:** a 24-hour budget-distribution curve (editable area chart, Violet Core line, Lime Signal on peak hours) showing how a daily budget auto-spreads across the day.
- **Campaign Builder:** structured create-flow (auto-generated Sponsored Products / Brands / Display campaign scaffolds).
- **Automation Rules:** rule cards ("IF ACOS > X for 3 days THEN lower bid Y%"), toggleable, with a rule-builder drawer.
- **Auto-Bidding panel:** strategy selector + guardrails (target ACOS, max bid).
- **MCP Sync status:** a data-freshness tile — "Last synced via Amazon MCP · stored to DB," with sync state (synced/pending/error) and last timestamp in mono.
- **Ads KPI row:** Ad Spend · ROAS · ACOS · attributed profit — mono values, delta pills.

---

## 6. Responsive Rules

- **< 768px: single column, no exceptions.** All bento tiles stack; hero KPI stays first and full-width.
- **Denser on mobile** (per the brief): tighter tile padding (`1rem`), no decorative hero bands, KPIs in 2-up mini-grids where they fit, but touch targets stay `≥44px`.
- **No horizontal scroll** anywhere (wide tables scroll inside their own tile with a mono-aligned header; the page body never scrolls sideways).
- **Typography scales via `clamp()`;** data text never below `0.875rem`, prose never below `1rem`.
- **Nav:** desktop Ink-Panel rail → mobile bottom tab bar (Analysis / Orders / Ads / Config) + overflow sheet.
- **Charts** reflow to full width; waterfall becomes vertically scannable on mobile.

---

## 7. Motion & Interaction

- **Spring physics default:** `stiffness: 100, damping: 20`. No linear easing.
- **Staggered bento reveal:** tiles cascade in on mount (~40ms stagger), never all at once.
- **KPI count-up** on load for currency/percent values (mono, tabular so width is stable).
- **Perpetual micro-loops** on active dashboard elements: Market Velocity trend has a slow breathing pulse; live sync dot shimmers; "up" sparkline endpoint gently floats.
- **Tile hover:** `-2px` lift + shadow deepen, spring.
- **Performance:** animate **only `transform` and `opacity`** — never `top/left/width/height`. Any grain/noise on fixed pseudo-elements only. Heavy animated components isolated as client components.

---

## 8. Anti-Patterns (BANNED)

- No emojis anywhere in the UI.
- No `Inter`; no generic system-font headings; no serifs (this is a dashboard).
- No pure black `#000000` — use Ink Primary `#1B1826`.
- No neon or outer-glow shadows; no violet/blue glow (violet is a *flat* brand color here).
- No gradient-filled headline text; no oversaturated fills.
- No warm/cool gray drift — one violet-tinted neutral family only.
- No hard divider lines between bento zones — layer surfaces instead.
- No 3-equal-column card rows; no symmetric filler grids.
- No circular loading spinners — skeletons only.
- No custom mouse cursors.
- No "Scroll to explore," bouncing chevrons, or scroll-arrow filler.
- No generic placeholder names ("John Doe," "Acme," "Nexus"), no fake round numbers (`99.99%`, `50%`) — use plausible marketplace figures.
- No AI copywriting clichés ("Elevate," "Seamless," "Unleash," "Next-Gen").
- No broken Unsplash links — use `picsum.photos` or SVG avatars/illustrations for placeholders.
