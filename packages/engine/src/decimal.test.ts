import Decimal from 'decimal.js';
import { describe, expect, it } from 'vitest';
import { Dec, DECIMAL_PRECISION, formatDecimal, parseDecimal } from './decimal';

describe('Dec', () => {
  it('ist eine eigene Kopie mit fester Genauigkeit, die globale Konfiguration bleibt unverändert', () => {
    expect(Dec).not.toBe(Decimal);
    expect(Dec.precision).toBe(DECIMAL_PRECISION);
    expect(Decimal.precision).toBe(20);
  });

  it('rechnet exakt mit Dezimalbrüchen', () => {
    expect(formatDecimal(parseDecimal('0.1').plus(parseDecimal('0.2')))).toBe('0.3');
  });

  it('rundet Divisionen auf die feste Rechengenauigkeit', () => {
    const third = formatDecimal(parseDecimal('1').div(parseDecimal('3')));
    expect(third).toBe(`0.${'3'.repeat(DECIMAL_PRECISION)}`);
  });
});

describe('parseDecimal', () => {
  it.each(['0', '12', '-3.5', '0.000000001', '123456789012345678901234567890.123'])(
    'liest %s exakt',
    (value) => {
      expect(formatDecimal(parseDecimal(value))).toBe(value);
    },
  );

  it.each(['', ' 1', '1.', '.5', '1e5', 'abc', 'NaN', 'Infinity', '+1', '1,5'])(
    'lehnt %j ab',
    (value) => {
      expect(() => parseDecimal(value)).toThrow(TypeError);
    },
  );
});

describe('formatDecimal', () => {
  it('schreibt kleine und große Werte ohne Exponent', () => {
    expect(formatDecimal(parseDecimal('1').div(parseDecimal('10000000000')))).toBe('0.0000000001');
    expect(formatDecimal(parseDecimal('1000000000').times(parseDecimal('1000000000000')))).toBe(
      '1000000000000000000000',
    );
  });

  it('schreibt minus null als 0', () => {
    expect(formatDecimal(parseDecimal('-0'))).toBe('0');
    expect(formatDecimal(parseDecimal('0').times(parseDecimal('-1')))).toBe('0');
  });
});
