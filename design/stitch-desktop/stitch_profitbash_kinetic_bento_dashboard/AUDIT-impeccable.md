# Impeccable Audit — ProfitBash (Stitch-Export, 14 Screens)

**Mode:** Operate (Dashboard/Product-UI) · Redesign/Preserve · Web · static HTML + Tailwind-CDN.
**Method:** mechanical detector (`impeccable detect`, 68 findings) + verified 5-dimension code audit.
Audit dokumentiert — fixt nicht. Umsetzung folgt in Claude Design / gezielten Commands.

## Implementation-Integrity-Verdikt
**PASS (mit Auflagen).** Die Screens drücken ein kohärentes, produktspezifisches System aus
(Kinetic Bento, echte Marktplatz-Daten, konsistente Nav/Topbar, JetBrains Mono für Zahlen). Kein
generisches Template. Drift ist moderat und beruht v. a. auf dem Maschinen-Export: 14 separate
Inline-Configs, MD3-Token-Reste, hartkodierte Hex-Werte.

## Audit Health Score

| # | Dimension | Score | Kernbefund |
|---|-----------|-------|-----------|
| 1 | Accessibility | 2/4 | Icon-Buttons ohne Namen; Labels nicht mit Inputs verknüpft |
| 2 | Performance | 3/4 | Tailwind-CDN (Runtime-Compile) statt Build-Step |
| 3 | Responsive | 3/4 | Breakpoints überall da; 29 feste px-Breiten im Browser prüfen |
| 4 | Theming | 2/4 | 118 rohe Hex im Markup + 14 Configs + MD3/Kinetic gemischt |
| 5 | Implementation Integrity | 3/4 | Kohärent; flache Typo-Hierarchie, dekorative Puls-Dots |
| **Total** | | **13/20** | **Acceptable — solide Basis, gezielte Arbeit nötig** |

*(13/20 ist ein guter Wert für einen rohen Stitch-Export. Der Weg zu 17+ ist mechanisch.)*

## Detector-Zusammenfassung (68 Befunde, 2 error / 66 warning)
| Antipattern | Anzahl | Bewertung |
|---|---|---|
| pulsing-dot (`animate-pulse`/`ping`) | 28 | P2 — dekorative Liveness; nur für echt live Daten behalten (MCP-Sync-Dot ok) |
| nested-cards | 27 | P3 — im Bento oft *gewollt* (Tile mit Sub-Tiles); im Browser einzeln prüfen |
| flat-type-hierarchy | 12 | **Messartefakt** (CDN) — aber realer Kern: KPI-Werte zu schwach abgesetzt |
| overused-font (Space Grotesk) | 1 | P3 — bewusst vereinheitlicht; distinktere Face ist Claude-Design-Entscheid |

## Befunde nach Severity

### P1 — vor Release fixen
- **[A11y] Icon-only-Buttons ohne accessible name** (~15, v. a. verkaufsanalyse). Material-Symbols-
  Buttons ohne `aria-label`. Screenreader liest nichts. WCAG 4.1.2. → `aria-label` je Button.
  Command: `/impeccable clarify` bzw. `/impeccable harden`.
- **[A11y] Formular-Labels nicht verknüpft.** 50 `<input>`, aber nur 7 `label[for=]` / 4 `input[id=]`.
  Labels sind visuell da, aber nicht programmatisch zugeordnet. WCAG 1.3.1 / 3.3.2. → `for`/`id`-Paare
  oder Input in `<label>` wrappen. Betrifft COGS, Versandprofile, Gebühren, OPEX, PPC, Setup, Login.
  Command: `/impeccable harden`.

### P2 — nächste Runde
- **[Theming] 118 hartkodierte Hex** (`bg-[#..]`/`text-[#..]`) im Markup umgehen die Tokens →
  Farbänderung muss an 100+ Stellen erfolgen. + 14 getrennte Inline-Configs. Command: `/impeccable extract` (ein Token-Set).
- **[Integrity] Flache Typo-Hierarchie.** Fast alles 18/20px; größte Zahl projektweit = 1× 42px.
  KPI-Hero-Werte sollten deutlich dominieren (~40-56px). Command: `/impeccable typeset`.
- **[A11y] `amazon_ads` ohne `<h1>`** — Heading-Struktur unvollständig auf dem wichtigsten neuen Screen.
- **[A11y] Kein `prefers-reduced-motion`** bei vorhandenen `animate-pulse/ping`. Command: `/impeccable animate`.
- **[A11y] Kontrast prüfen:** Lime `#B4DE2C` als *Text* auf Hell fällt unter 4.5:1 — nur für Flächen/
  große Werte nutzen, Text in `lime-deep #7E9E12`. Amber-Status ebenfalls prüfen.

### P3 — Politur
- **[Perf] Tailwind-CDN** kompiliert im Browser → für Produktion Build-Step/Tailwind-CLI (Cloudflare Pages).
- **[Perf] Google-Fonts via `<link>`** → self-host für Produktion.
- **[Integrity] Puls-Dots** auf statische Status reduzieren (nur MCP-Sync/„live" behalten).
- **[Integrity] Verschachtelte Cards** visuell prüfen — im Bento meist ok, sonst via Surface-Tier/Spacing flachziehen.

## Systemische Muster
1. **Kopierte statt geteilter Bausteine:** Nav-Rail, Topbar, Configs, Status-Dots 14× dupliziert →
   jede Änderung driftet. Kernursache hinter Theming- und Konsistenz-Findings.
2. **Maschinelle Größen statt Skala:** arbiträre `text-[Npx]` statt semantischer Stufen → flache Hierarchie.

## Positiv (bewahren)
- Durchgängig `lang="de"`, Viewport-Meta, `md:`/`lg:`-Breakpoints auf **allen 14** Screens.
- JetBrains Mono konsequent für Zahlen — korrekt für Finanzdaten.
- Praktisch keine `<img>`-alt-Probleme (icon-/CSS-basiert).
- Kohärente Kinetic-Bento-Sprache, realistische Daten, keine Platzhalter-Slop.

## Empfohlene Reihenfolge (falls in Code statt Claude Design umgesetzt)
1. **[P1] `/impeccable harden`** — Formular-Labels verknüpfen + Icon-Button-Namen (A11y-Blocker).
2. **[P2] `/impeccable extract`** — ein geteiltes Token-Set statt 14 Configs + 118 Hex.
3. **[P2] `/impeccable typeset`** — KPI-Hierarchie schärfen (Hero-Werte skalieren).
4. **[P2] `/impeccable animate`** — reduced-motion + Puls-Dots kuratieren.
5. **[P3] `/impeccable polish`** — Abschlusspass (CDN→Build, Fonts self-host, Rest).
