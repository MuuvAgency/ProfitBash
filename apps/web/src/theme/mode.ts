import { THEMES, type Theme } from '@profitbash/shared';

/** Tatsächlich angezeigte Darstellung. `Theme` ist die Einstellung (inkl. `system`). */
export type ColorScheme = 'light' | 'dark';

const CACHE_KEY = 'profitbash.theme';

export function resolveColorScheme(theme: Theme, systemPrefersDark: boolean): ColorScheme {
  if (theme === 'system') return systemPrefersDark ? 'dark' : 'light';
  return theme;
}

/** Der Umschalter im Account-Menü setzt eine feste Einstellung: das Gegenteil des Sichtbaren. */
export function toggledTheme(current: ColorScheme): Exclude<Theme, 'system'> {
  return current === 'dark' ? 'light' : 'dark';
}

/** PrimeVue (`darkModeSelector: '.dark'`) und Tailwind (`dark:`) lesen dieselbe Klasse. */
export function applyColorScheme(scheme: ColorScheme): void {
  document.documentElement.classList.toggle('dark', scheme === 'dark');
}

/**
 * Letzte Einstellung im Browser, damit schon Login und erster Paint im richtigen Theme erscheinen.
 * Die Quelle bleibt der Server (`preferences.theme`); der Cache ist nur eine Vorschau.
 */
export function readCachedTheme(): Theme {
  try {
    const value = localStorage.getItem(CACHE_KEY);
    return (THEMES as readonly (string | null)[]).includes(value) ? (value as Theme) : 'system';
  } catch {
    return 'system';
  }
}

export function writeCachedTheme(theme: Theme): void {
  try {
    localStorage.setItem(CACHE_KEY, theme);
  } catch {
    // Speicher gesperrt (z. B. privater Modus): Der Cache ist optional.
  }
}
