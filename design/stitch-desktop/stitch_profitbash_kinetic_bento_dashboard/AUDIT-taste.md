# Taste-Audit — ProfitBash Stitch-Export

**Modus:** Redesign / Preserve (bestehendes „Kinetic Bento"-System, in Stitch visuell abgenommen).
**Scope:** `design-taste-frontend` schließt reine Dashboards laut eigener Regel (§13) aus → hier nur
Redesign-Audit + Anti-Slop-Bereinigung angewandt. Der eigentliche UI-Feinschliff der Dashboard-Screens
gehört zu `impeccable` (Runde 2) bzw. Claude Design.

## ✅ Bereits gefixt (sicher, in diesem Durchgang)
- **Font-Konsistenz:** Login lief auf *Plus Jakarta Sans*, die anderen 13 auf *Space Grotesk*.
  → Alle 14 Screens jetzt einheitlich **Space Grotesk** (+ JetBrains Mono für Zahlen).
- **Em-dash entfernt:** `<title>ProfitBash — Anmelden</title>` → Bindestrich (Anti-Slop-Regel).

## 🟡 Bewusst NICHT angefasst (Preserve / Risiko)
- **Primary-Violett `#4227b1`:** einheitlich über alle Screens, minimal dunkler als der DESIGN.md-Wert
  `#5A44C9`. Da in Stitch abgenommen → nicht still geändert. In Claude Design ggf. angleichen und dann
  DESIGN.md an die Realität anpassen (nicht umgekehrt).
- **MD3-Token im Tailwind-Config** (`on-primary-container` 55×, `on-secondary-fixed` 10×,
  `tertiary-container` 3×): sehen nach Ballast aus, sind aber **in Klassen tatsächlich benutzt** →
  Bulk-Löschen würde Styling zerschießen. Nur mit Einzelprüfung entfernen.
- **`★`-Glyphen** (Risk-Matrix „Stars", Peak-Marker): semantisch, kein Deko-Emoji → belassen.

## 🔧 Empfehlungen für Claude Design (Feinschliff-Runde)
1. **Ein Token-Set statt 14 Inline-Configs:** Jede HTML hat eine eigene `tailwind.config`. Für die
   spätere Codebasis in *ein* geteiltes Theme (CSS-Variablen) ziehen → Single Source of Truth.
2. **Shared App-Shell:** Nav-Rail + Topbar als *eine* Komponente, nicht pro Screen dupliziert
   (aktuell 14× kopiert → Drift-Risiko bei jeder Änderung).
3. **MD3-Tokens semantisch umbenennen:** `on-primary-container` etc. → sprechende Kinetic-Bento-Namen
   (`violet-wash`, `ink-secondary` …), sobald in echten Code überführt.
4. **Fonts self-hosten:** aktuell Google-Fonts via `<link>` + Tailwind-CDN (ok für Prototyp/Stitch).
   Für Produktion: `@font-face`/`next/font`, kein CDN.
5. **Interaktive States** (loading = Skeletons, empty, error) sind in statischen Stitch-Screens nicht
   angelegt → in der echten Implementierung ergänzen.

## Zahlen-Check (Ist-Zustand)
- 14 Screens, alle `lang="de"`, `darkMode: "class"` konsistent.
- Stack: Tailwind (CDN) + Space Grotesk + JetBrains Mono + Material Symbols. Plain HTML → läuft nativ
  auf Cloudflare Pages.
