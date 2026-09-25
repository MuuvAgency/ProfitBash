# PROFITBASH-claude-design.html — Übergabe für Claude Design

**Eine** self-contained HTML mit allen 14 Screens, Variante B (responsive):
- **< 1024px** → Mobile-Layout (`lg:hidden`), **≥ 1024px** → Desktop-Layout (`hidden lg:block`).
- **Ein** geteiltes Token-Set (Kinetic Bento, skalierte Typo-Skala) im `<head>` — keine 28 Einzel-Configs.
- Screen-Wechsel: Dropdown unten rechts ODER die In-Screen-Navigation (JS-Router).

## Enthaltene Fixes (Desktop + Mobile, beide Audit-Runden)
- Fonts vereinheitlicht (Space Grotesk), Em-dashes entfernt.
- A11y: alle Formularfelder mit `aria-label`; Amazon-Ads `<h1>`; `prefers-reduced-motion`.
- Token-Konsistenz + geschärfte KPI-Hierarchie (data-hero 42px, headline-sm 18px …).

## Öffnen (Pfad enthält Doppelpunkte → am einfachsten via lokalem Server)
```bash
cd "/Users/dominik/Profit Dash Amazon : Otto : etc" && python3 -m http.server 8765
# dann http://127.0.0.1:8765/PROFITBASH-claude-design.html
```

## Quellen (unverändert erhalten)
- Desktop-Screens: `design/stitch-desktop/…/<screen>/code.html`
- Mobile-Screens:  `design/stitch-mobile/…/<screen>_mobile/code.html`
- Kanonische Tokens: `design/stitch-desktop/…/theme.js`
