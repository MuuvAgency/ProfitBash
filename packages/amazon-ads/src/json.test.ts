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
