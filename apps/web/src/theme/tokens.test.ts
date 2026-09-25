import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { Theme } from '@primeuix/themes';
import { describe, expect, it } from 'vitest';
import { preset } from './preset';
import { designColors, designFontSizes, designSpacing } from './tokens';

// @vitest-environment node

interface DesignConfig {
  theme: {
    extend: {
      colors: Record<string, string>;
      fontSize: Record<string, unknown>;
      spacing: Record<string, string>;
    };
  };
}

/** design/theme.js ist ein Browser-Skript (`tailwind.config = …`), kein Modul. */
function loadDesignConfig(): DesignConfig['theme']['extend'] {
  const source = readFileSync(new URL('../../../../design/theme.js', import.meta.url), 'utf8');
  const context: { tailwind: { config?: DesignConfig } } = { tailwind: {} };
  runInNewContext(source, context);
  if (!context.tailwind.config) throw new Error('design/theme.js setzt tailwind.config nicht');
  return context.tailwind.config.theme.extend;
}

describe('Design-Tokens', () => {
  const design = loadDesignConfig();

  it('übernehmen die Farben aus design/theme.js', () => {
    for (const [name, value] of Object.entries(designColors)) {
      expect(design.colors[name]?.toLowerCase(), name).toBe(value.toLowerCase());
    }
  });

  it('übernehmen die Typo-Skala aus design/theme.js', () => {
    for (const [name, [size, rest]] of Object.entries(designFontSizes)) {
      expect(design.fontSize[name], name).toEqual([size, rest]);
    }
  });

  it('übernehmen die Abstände aus design/theme.js', () => {
    for (const [name, value] of Object.entries(designSpacing)) {
      expect(design.spacing[name], name).toBe(value);
    }
  });
});

describe('PrimeVue-Preset', () => {
  Theme.setTheme({ preset, options: { darkModeSelector: '.dark' } });
  const common = Theme.getCommon('tokens-test', undefined) as Record<string, { css?: string }>;
  const emitted = new Set(
    Object.values(common).flatMap((part) => part.css?.match(/--p-pb-[\w-]+(?=:)/g) ?? []),
  );

  it('gibt Farben mit Light-Wert an :root und Dark-Wert unter .dark aus', () => {
    const css = common.global?.css ?? '';
    expect(css).toMatch(/:root,:host\{[^}]*--p-pb-color-canvas:#EEEDF3/);
    expect(css).toMatch(/\.dark\{[^}]*--p-pb-color-canvas:#121019/);
  });

  it('liefert jede Variable, die main.css für Tailwind verwendet', () => {
    const css = readFileSync(new URL('../styles/main.css', import.meta.url), 'utf8');
    const used = [...new Set(css.match(/--p-pb-[\w-]+/g) ?? [])];
    expect(used.length).toBeGreaterThan(20);
    expect(used.filter((name) => !emitted.has(name))).toEqual([]);
  });
});
