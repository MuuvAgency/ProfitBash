import { describe, expect, it } from 'vitest';
import { compareDecimal, compareDecimalNullsLast, decimalSign } from './decimal-compare';

const sign = (n: number) => Math.sign(n);

describe('compareDecimal', () => {
  it('vergleicht Decimal-Strings wie Zahlen', () => {
    expect(sign(compareDecimal('2', '10'))).toBe(-1);
    expect(sign(compareDecimal('10', '2'))).toBe(1);
    expect(compareDecimal('1.5', '1.50')).toBe(0);
    expect(sign(compareDecimal('0.09', '0.1'))).toBe(-1);
    expect(sign(compareDecimal('12.345', '12.34'))).toBe(1);
  });

  it('behandelt negative Werte und -0', () => {
    expect(sign(compareDecimal('-2', '-10'))).toBe(1);
    expect(sign(compareDecimal('-0.5', '0'))).toBe(-1);
    expect(compareDecimal('-0', '0')).toBe(0);
    expect(compareDecimal('-0.00', '0')).toBe(0);
    expect(sign(compareDecimal('-1', '0.001'))).toBe(-1);
  });

  it('ignoriert führende Nullen', () => {
    expect(compareDecimal('007.10', '7.1')).toBe(0);
  });

  it('verliert keine Stellen jenseits von Number.MAX_SAFE_INTEGER', () => {
    expect(sign(compareDecimal('9007199254740993', '9007199254740992'))).toBe(1);
    expect(sign(compareDecimal('0.10000000000000000001', '0.1'))).toBe(1);
  });

  it('wirft bei Werten, die kein Decimal-String sind', () => {
    expect(() => compareDecimal('1e3', '1')).toThrow(TypeError);
    expect(() => compareDecimal('abc', '1')).toThrow(TypeError);
  });
});

describe('compareDecimalNullsLast', () => {
  it('sortiert fehlende Werte in beide Richtungen ans Ende', () => {
    const values = ['3', null, '-1', '10', null];
    const ascending = [...values].sort((a, b) =>
      compareDecimalNullsLast(a, b, undefined, undefined, false),
    );
    const descending = [...values].sort((a, b) =>
      compareDecimalNullsLast(a, b, undefined, undefined, true),
    );
    expect(ascending).toEqual(['-1', '3', '10', null, null]);
    // AG Grid kehrt das Ergebnis bei absteigender Sortierung um: dort muss null „kleiner“ sein.
    expect(descending.reverse()).toEqual(['10', '3', '-1', null, null]);
  });
});

describe('decimalSign', () => {
  it('liefert das Vorzeichen ohne Umweg über number', () => {
    expect(decimalSign('0.0000001')).toBe(1);
    expect(decimalSign('-3.2')).toBe(-1);
    expect(decimalSign('0.000')).toBe(0);
    expect(decimalSign('-0')).toBe(0);
    expect(decimalSign(null)).toBeNull();
  });
});
