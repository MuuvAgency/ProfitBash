import { describe, expect, it } from 'vitest';
import { settingsSchema, uiStateParamsSchema, uiStatePutSchema } from './api';

describe('settingsSchema', () => {
  const valid = { theme: 'dark', locale: 'en-US', density: 'compact' };

  it('akzeptiert gültige Einstellungen', () => {
    expect(settingsSchema.parse(valid)).toEqual(valid);
  });

  it.each([
    ['theme', 'pink'],
    ['locale', 'xx-XX'],
    ['density', 'huge'],
  ])('lehnt einen unbekannten Wert für %s ab', (field, value) => {
    expect(settingsSchema.safeParse({ ...valid, [field]: value }).success).toBe(false);
  });

  it('verlangt alle Felder (PUT ersetzt die Einstellungen vollständig)', () => {
    expect(settingsSchema.safeParse({ theme: 'dark' }).success).toBe(false);
  });
});

describe('uiStateParamsSchema', () => {
  it('akzeptiert einfache Bezeichner mit Punkt, Doppelpunkt, Binde- und Unterstrich', () => {
    expect(
      uiStateParamsSchema.safeParse({ scope: 'explorer', key: 'grid.columns:v2' }).success,
    ).toBe(true);
  });

  it.each(['', 'a/b', 'mit leerzeichen', '../etc', 'x'.repeat(65)])(
    'lehnt den Key %j ab',
    (key) => {
      expect(uiStateParamsSchema.safeParse({ scope: 'explorer', key }).success).toBe(false);
    },
  );
});

describe('uiStatePutSchema', () => {
  it('akzeptiert beliebiges JSON als Wert', () => {
    const body = { value: { columns: ['name', 'spend'], widths: { name: 240 } } };
    expect(uiStatePutSchema.parse(body)).toEqual(body);
  });

  it('lehnt einen fehlenden oder null-Wert ab', () => {
    expect(uiStatePutSchema.safeParse({}).success).toBe(false);
    expect(uiStatePutSchema.safeParse({ value: null }).success).toBe(false);
  });

  it('lehnt Werte über 16 KB ab', () => {
    const big = { value: 'x'.repeat(16 * 1024) };
    expect(uiStatePutSchema.safeParse(big).success).toBe(false);
  });
});
