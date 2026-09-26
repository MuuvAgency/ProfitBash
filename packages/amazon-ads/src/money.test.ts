import { describe, expect, it } from 'vitest';
import { parseJsonLossless } from './json';
import { amazonDecimalSchema, currencyCodeSchema, isKnownCurrencyCode } from './money';

describe('amazonDecimalSchema', () => {
  it.each([
    ['0.1', '0.1'],
    ['1234567.89', '1234567.89'],
    ['0.005', '0.005'],
    ['1e-7', '0.0000001'],
    ['-2.5E+3', '-2500'],
    ['-0.00', '0'],
    ['1.50', '1.5'],
    ['00.10', '0.1'],
    ['42', '42'],
    ['0.123456789012345678901234567890123', '0.123456789012345678901234567890123'],
    ['123456789012345678901234567890.1', '123456789012345678901234567890.1'],
  ])('normalisiert den String %s zu %s', (input, expected) => {
    expect(amazonDecimalSchema.parse(input)).toBe(expected);
  });

  it.each([
    [42, '42'],
    [0, '0'],
    [-0, '0'],
    [-7, '-7'],
    [Number.MAX_SAFE_INTEGER, '9007199254740991'],
  ])('übernimmt die sichere Ganzzahl %s als %s', (input, expected) => {
    expect(amazonDecimalSchema.parse(input)).toBe(expected);
  });

  it.each([0.1, 1234567.89, 1e-7, Number('0.12345678901234567')])(
    'lehnt die Zahl %s mit Nachkommastellen ab (Parser-Option vergessen, sonst still gerundet)',
    (input) => {
      expect(amazonDecimalSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each(['', ' 1', '1 ', '1.', '.5', '+1', '1,5', 'abc', 'NaN', 'Infinity', '0x10', '1e'])(
    'lehnt den String %j ab',
    (input) => {
      expect(amazonDecimalSchema.safeParse(input).success).toBe(false);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53, -(2 ** 53), 1e21])(
    'lehnt die unsichere Zahl %s ab',
    (input) => {
      expect(amazonDecimalSchema.safeParse(input).success).toBe(false);
    },
  );

  it('nimmt Werte bis zur Zehnerpotenz ±40 an', () => {
    expect(amazonDecimalSchema.parse('1e40')).toBe(`1${'0'.repeat(40)}`);
    expect(amazonDecimalSchema.parse('1e-40')).toBe(`0.${'0'.repeat(39)}1`);
    expect(amazonDecimalSchema.parse('0e999')).toBe('0');
  });

  it.each([
    '1e41',
    '1e-41',
    '1e-1000000',
    '1e1000000',
    // jenseits der Grenzen von decimal.js: würde zu `Infinity` bzw. still zu `0`
    '1e9000000000000001',
    '1e-9000000000000001',
    `1e${'9'.repeat(30)}`,
    `1e-${'9'.repeat(30)}`,
  ])('lehnt %s ab, statt einen riesigen String, Infinity oder still 0 zu liefern', (input) => {
    expect(amazonDecimalSchema.safeParse(input).success).toBe(false);
  });

  it('lehnt andere Typen ab', () => {
    for (const input of [null, undefined, true, {}, [], 1n]) {
      expect(amazonDecimalSchema.safeParse(input).success).toBe(false);
    }
  });

  it('bringt Beträge aus parseJsonLossless ohne Umweg über number exakt an', () => {
    const row = parseJsonLossless('{"cost": 0.1, "sales": 1234567.89, "cpc": 0.005, "bid": 1e-7}', {
      decimals: 'string',
    }) as Record<string, unknown>;
    expect(Object.values(row).map((value) => amazonDecimalSchema.parse(value))).toEqual([
      '0.1',
      '1234567.89',
      '0.005',
      '0.0000001',
    ]);
  });
});

describe('currencyCodeSchema', () => {
  it.each(['EUR', 'GBP', 'SEK', 'PLN', 'TRY', 'XYZ'])('akzeptiert %s', (code) => {
    expect(currencyCodeSchema.parse(code)).toBe(code);
  });

  it.each(['eur', 'EU', 'EURO', 'E1R', '', ' EUR', 1])('lehnt %j ab', (input) => {
    expect(currencyCodeSchema.safeParse(input).success).toBe(false);
  });
});

describe('isKnownCurrencyCode', () => {
  it('kennt die Währungen des EU-Kontos', () => {
    for (const code of ['EUR', 'GBP', 'SEK', 'PLN', 'TRY']) {
      expect(isKnownCurrencyCode(code)).toBe(true);
    }
  });

  it('meldet formal gültige, aber unbekannte Codes', () => {
    expect(isKnownCurrencyCode('XYZ')).toBe(false);
  });
});
