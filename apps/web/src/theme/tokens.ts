/**
 * Design-Tokens „Kinetic Bento“. Quelle: design/theme.js (nur Light-Werte).
 * `designColors`, `designFontSizes` und `designSpacing` spiegeln die Quelle 1:1, ein Test prüft das.
 * Die Dark-Werte sind daraus abgeleitet (gleiche violett getönte Neutralfamilie, aufgehellte Akzente
 * für Kontrast auf dunklem Grund) und stehen nur hier.
 */

/** Farben aus design/theme.js, unter ihren dortigen Namen. */
export const designColors = {
  'canvas-mist': '#EEEDF3',
  'tile-raise': '#FAFAFC',
  'tile-peak': '#FFFFFF',
  'well-sunken': '#E6E4EC',
  'ink-panel': '#1B1826',
  'ink-primary': '#1B1826',
  'ink-secondary': '#63607A',
  'ink-tertiary': '#9C99AD',
  'ink-on-dark': '#EDECF3',
  'on-primary': '#ffffff',
  'primary-container': '#5a44c9',
  'violet-press': '#4835A6',
  'violet-wash': '#ECE8FA',
  'primary-fixed': '#e5deff',
  'on-primary-container': '#d6ceff',
  'primary-fixed-dim': '#c8bfff',
  'on-primary-fixed': '#1a0064',
  'secondary-fixed': '#c7f241',
  'secondary-fixed-dim': '#acd522',
  'lime-deep': '#7E9E12',
  'loss-red': '#D6524B',
  'warn-amber': '#E0A233',
  'error-container': '#ffdad6',
  'on-error-container': '#93000a',
  'whisper-line': 'rgba(27,24,38,0.06)',
  'outline-variant': '#c9c4d6',
  outline: '#787585',
  'on-surface-variant': '#484554',
  'inverse-surface': '#312f38',
} as const;

type FontSize = readonly [
  string,
  { lineHeight: string; letterSpacing: string; fontWeight: string },
];

/** Typo-Skala aus design/theme.js. */
export const designFontSizes = {
  display: ['52px', { lineHeight: '52px', letterSpacing: '-0.03em', fontWeight: '700' }],
  'headline-lg': ['30px', { lineHeight: '34px', letterSpacing: '-0.02em', fontWeight: '700' }],
  'headline-md': ['20px', { lineHeight: '26px', letterSpacing: '-0.01em', fontWeight: '600' }],
  'headline-sm': ['18px', { lineHeight: '22px', letterSpacing: '0em', fontWeight: '600' }],
  'body-lg': ['16px', { lineHeight: '24px', letterSpacing: '0em', fontWeight: '400' }],
  'body-md': ['14px', { lineHeight: '21px', letterSpacing: '0em', fontWeight: '400' }],
  'body-sm': ['13px', { lineHeight: '18px', letterSpacing: '0em', fontWeight: '400' }],
  'label-eyebrow': ['11px', { lineHeight: '14px', letterSpacing: '0.06em', fontWeight: '700' }],
  'data-hero': ['42px', { lineHeight: '40px', letterSpacing: '-0.02em', fontWeight: '700' }],
  'data-lg': ['22px', { lineHeight: '26px', letterSpacing: '0em', fontWeight: '600' }],
  'data-md': ['14px', { lineHeight: '20px', letterSpacing: '0em', fontWeight: '500' }],
  'data-sm': ['12px', { lineHeight: '16px', letterSpacing: '0em', fontWeight: '500' }],
} as const satisfies Record<string, FontSize>;

/** Abstände aus design/theme.js. */
export const designSpacing = {
  'space-xs': '0.25rem',
  'space-sm': '0.5rem',
  'space-md': '1rem',
  'space-lg': '1.25rem',
  'space-xl': '1.75rem',
  gutter: '1.25rem',
  'gutter-mobile': '0.75rem',
  margin: '1.5rem',
  'margin-mobile': '1rem',
} as const;

const c = designColors;

/** Farbrollen der UI mit Light- und Dark-Wert. Tailwind-Klassen heißen wie die Rolle (`bg-canvas`). */
export const colorRoles = {
  /** Seitengrund */
  canvas: { light: c['canvas-mist'], dark: '#121019' },
  /** Standard-Kachel */
  tile: { light: c['tile-raise'], dark: '#1B1826' },
  /** Hervorgehobene Kachel, Eingabefelder */
  'tile-peak': { light: c['tile-peak'], dark: '#242033' },
  /** Vertiefte Flächen (Chart-Hintergrund, Zebra) */
  well: { light: c['well-sunken'], dark: '#0D0B12' },
  /** Invertierte Fläche (Sidebar, Login-Markenfläche) */
  panel: { light: c['ink-panel'], dark: '#0D0B12' },
  'on-panel': { light: c['ink-on-dark'], dark: c['ink-on-dark'] },
  'on-panel-muted': { light: c['ink-tertiary'], dark: c['ink-tertiary'] },
  ink: { light: c['ink-primary'], dark: c['ink-on-dark'] },
  'ink-secondary': { light: c['ink-secondary'], dark: '#A9A6BD' },
  'ink-tertiary': { light: c['ink-tertiary'], dark: '#7C798F' },
  violet: { light: c['primary-container'], dark: '#8B78F0' },
  'violet-press': { light: c['violet-press'], dark: '#A294F5' },
  'violet-wash': { light: c['violet-wash'], dark: '#2A2346' },
  'on-violet': { light: c['on-primary'], dark: c['ink-primary'] },
  lime: { light: c['secondary-fixed'], dark: c['secondary-fixed'] },
  'lime-deep': { light: c['lime-deep'], dark: c['secondary-fixed-dim'] },
  loss: { light: c['loss-red'], dark: '#E5736D' },
  'loss-wash': { light: c['error-container'], dark: '#3A1A1D' },
  'on-loss-wash': { light: c['on-error-container'], dark: '#FFB4AB' },
  warn: { light: c['warn-amber'], dark: '#E8B350' },
  line: { light: c['whisper-line'], dark: 'rgba(237,236,243,0.08)' },
  outline: { light: c['outline-variant'], dark: '#3A3649' },
} as const;

/** Violett getönte Schatten (DESIGN.md: „Tile Shadow“), im Dark Mode neutral dunkel. */
export const shadows = {
  tile: {
    light: '0 1px 2px rgba(48,38,92,0.05), 0 10px 30px rgba(48,38,92,0.08)',
    dark: '0 1px 2px rgba(0,0,0,0.3), 0 10px 30px rgba(0,0,0,0.35)',
  },
  raised: {
    light: '0 1px 2px rgba(48,38,92,0.08), 0 14px 36px rgba(48,38,92,0.14)',
    dark: '0 1px 2px rgba(0,0,0,0.35), 0 14px 36px rgba(0,0,0,0.45)',
  },
  /** Aktiver Menüeintrag */
  active: {
    light: '0 4px 12px rgba(90,68,201,0.25)',
    dark: '0 4px 12px rgba(0,0,0,0.4)',
  },
} as const;

/** Radien aus DESIGN.md §4 (Kacheln 1.5rem, Hero-Kacheln 2rem, Buttons und Felder 0.75rem). */
export const radii = {
  control: '0.75rem',
  tile: '1.5rem',
  hero: '2rem',
} as const;

export const fonts = {
  sans: "'Space Grotesk Variable', 'Space Grotesk', ui-sans-serif, system-ui, sans-serif",
  mono: "'JetBrains Mono Variable', 'JetBrains Mono', ui-monospace, monospace",
} as const;

/** Violett-Skala für PrimeVue (`primary`). 400, 700, 800, 950 sind abgeleitet. */
export const violetScale = {
  50: c['violet-wash'],
  100: c['primary-fixed'],
  200: c['on-primary-container'],
  300: c['primary-fixed-dim'],
  400: '#8B78F0',
  500: c['primary-container'],
  600: c['violet-press'],
  700: '#3A2A8A',
  800: '#2B1F6B',
  900: c['on-primary-fixed'],
  950: '#120048',
} as const;

/** Neutrale Skala für PrimeVue (`surface`), violett getönt. 950 ist abgeleitet. */
export const neutralScale = {
  0: c['tile-peak'],
  50: c['tile-raise'],
  100: c['canvas-mist'],
  200: c['well-sunken'],
  300: c['outline-variant'],
  400: c['ink-tertiary'],
  500: c.outline,
  600: c['ink-secondary'],
  700: c['on-surface-variant'],
  800: c['inverse-surface'],
  900: c['ink-primary'],
  950: '#0D0B12',
} as const;
