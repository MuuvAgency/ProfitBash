import { definePreset } from '@primeuix/themes';
import Aura from '@primeuix/themes/aura';
import {
  colorRoles,
  designFontSizes,
  designSpacing,
  fonts,
  neutralScale,
  radii,
  shadows,
  violetScale,
} from './tokens';

type Scheme = 'light' | 'dark';

const mapValues = <T, R>(record: Record<string, T>, fn: (value: T) => R): Record<string, R> =>
  Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fn(value)]));

const schemeTokens = (scheme: Scheme) => ({
  pb: {
    color: mapValues(colorRoles, (role) => role[scheme]),
    shadow: mapValues(shadows, (shadow) => shadow[scheme]),
  },
});

const role = (name: keyof typeof colorRoles, scheme: Scheme) => colorRoles[name][scheme];

/** Semantische PrimeVue-Tokens je Farbschema, abgeleitet aus denselben Farbrollen wie Tailwind. */
const semanticScheme = (scheme: Scheme) => ({
  surface: neutralScale,
  primary: {
    color: role('violet', scheme),
    contrastColor: role('on-violet', scheme),
    hoverColor: role('violet-press', scheme),
    activeColor: role('violet-press', scheme),
  },
  highlight: {
    background: role('violet-wash', scheme),
    focusBackground: role('violet-wash', scheme),
    color: role('ink', scheme),
    focusColor: role('ink', scheme),
  },
  text: {
    color: role('ink', scheme),
    hoverColor: role('ink', scheme),
    mutedColor: role('ink-secondary', scheme),
    hoverMutedColor: role('ink', scheme),
  },
  content: {
    background: role('tile-peak', scheme),
    hoverBackground: role('well', scheme),
    borderColor: role('line', scheme),
    color: role('ink', scheme),
    hoverColor: role('ink', scheme),
  },
  formField: {
    background: role('tile-peak', scheme),
    borderColor: role('outline', scheme),
    hoverBorderColor: role('ink-tertiary', scheme),
    focusBorderColor: role('violet', scheme),
    invalidBorderColor: role('loss', scheme),
    color: role('ink', scheme),
    placeholderColor: role('ink-tertiary', scheme),
  },
});

/**
 * PrimeVue-Preset „Kinetic Bento“ auf Basis von Aura.
 * `extend.pb` sind eigene Tokens für Tailwind: PrimeVue gibt sie als CSS-Variablen `--p-pb-*` aus
 * (Light an `:root`, Dark unter `.dark`), `styles/main.css` bildet sie auf Tailwind-Klassen ab.
 * So sind alle Werte nur in `tokens.ts` definiert.
 */
export const preset = definePreset(Aura, {
  extend: {
    pb: {
      font: fonts,
      spacing: designSpacing,
      radius: radii,
      text: mapValues(designFontSizes, ([size, { lineHeight, letterSpacing, fontWeight }]) => ({
        size,
        lineHeight,
        letterSpacing,
        fontWeight,
      })),
    },
    colorScheme: { light: schemeTokens('light'), dark: schemeTokens('dark') },
  },
  semantic: {
    primary: violetScale,
    focusRing: { width: '2px', style: 'solid', color: '{primary.color}', offset: '2px' },
    formField: {
      paddingX: '0.875rem',
      paddingY: '0.625rem',
      borderRadius: radii.control,
    },
    colorScheme: { light: semanticScheme('light'), dark: semanticScheme('dark') },
  },
  components: {
    button: { root: { borderRadius: radii.control } },
  },
});
