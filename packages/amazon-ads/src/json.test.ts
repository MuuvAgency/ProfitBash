import { describe, expect, it } from 'vitest';
import { parseJsonLossless } from './json';

describe('parseJsonLossless', () => {
  it('liest Ganzzahlen über Number.MAX_SAFE_INTEGER als unveränderten String', () => {
    const parsed = parseJsonLossless('[{"profileId": 9007199254740993}]') as Array<{
      profileId: unknown;
    }>;
    expect(parsed[0]?.profileId).toBe('9007199254740993');
  });

  it('erhält auch negative und sehr lange Ganzzahlen exakt', () => {
    const parsed = parseJsonLossless(
      '{"a": -9007199254740993, "b": 123456789012345678901234567890}',
    );
    expect(parsed).toEqual({ a: '-9007199254740993', b: '123456789012345678901234567890' });
  });

  it('lässt sichere Ganzzahlen, Dezimalzahlen und andere Werte unverändert', () => {
    const parsed = parseJsonLossless(
      '{"id": 888888888, "max": 9007199254740991, "rate": 1.5, "s": "x", "n": null, "t": true}',
    );
    expect(parsed).toEqual({
      id: 888888888,
      max: 9007199254740991,
      rate: 1.5,
      s: 'x',
      n: null,
      t: true,
    });
  });

  it('wirft bei ungültigem JSON einen SyntaxError', () => {
    expect(() => parseJsonLossless('{"a":')).toThrow(SyntaxError);
  });
});

describe("parseJsonLossless mit { decimals: 'string' }", () => {
  it('liefert Dezimalzahlen als unveränderten Quelltext-String', () => {
    const parsed = parseJsonLossless(
      '{"a": 0.1, "b": 1234567.89, "c": 0.005, "d": -0.00, "e": 1.50, "f": 0.123456789012345678901234567890123}',
      { decimals: 'string' },
    );
    expect(parsed).toEqual({
      a: '0.1',
      b: '1234567.89',
      c: '0.005',
      d: '-0.00',
      e: '1.50',
      f: '0.123456789012345678901234567890123',
    });
  });

  it('liefert Zahlen in Exponentialschreibweise als Quelltext-String, auch ganzzahlige', () => {
    const parsed = parseJsonLossless('[1e-7, -2.5E+3, 1e3]', { decimals: 'string' });
    expect(parsed).toEqual(['1e-7', '-2.5E+3', '1e3']);
  });

  it('lässt sichere Ganzzahlen als Zahl und unsichere als String wie ohne Option', () => {
    const parsed = parseJsonLossless('{"clicks": 42, "zero": 0, "id": 9007199254740993}', {
      decimals: 'string',
    });
    expect(parsed).toEqual({ clicks: 42, zero: 0, id: '9007199254740993' });
  });

  it('lässt -0 als Zahl (der Betrag wird erst im Schema zu 0)', () => {
    expect(Object.is(parseJsonLossless('-0', { decimals: 'string' }), -0)).toBe(true);
  });

  it('wirkt in verschachtelten Objekten und Arrays', () => {
    const parsed = parseJsonLossless('{"rows": [{"cost": 12.34, "sales7d": [0.5]}]}', {
      decimals: 'string',
    });
    expect(parsed).toEqual({ rows: [{ cost: '12.34', sales7d: ['0.5'] }] });
  });

  it('lässt Dezimalzahlen ohne Option weiterhin als Zahl', () => {
    expect(parseJsonLossless('[0.1, 1e-7]')).toEqual([0.1, 1e-7]);
  });
});
