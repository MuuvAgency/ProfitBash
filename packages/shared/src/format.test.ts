import { describe, expect, it } from 'vitest';
import { formatCurrency, formatNumber, formatPercent, MISSING_VALUE } from './format';

// Intl trennt Zahl und Einheit mit einem geschützten Leerzeichen (U+00A0).
const nbsp = ' ';

describe('formatNumber', () => {
  it('formatiert Decimal-Strings je Locale', () => {
    expect(formatNumber('1234567.5', 'de-DE')).toBe('1.234.567,5');
    expect(formatNumber('1234567.5', 'en-US')).toBe('1,234,567.5');
    expect(formatNumber('1234567.5', 'en-GB')).toBe('1,234,567.5');
  });

  it('verliert keine Stellen bei Werten jenseits von Number.MAX_SAFE_INTEGER', () => {
    expect(formatNumber('9007199254740993', 'de-DE')).toBe('9.007.199.254.740.993');
  });

  it('rundet auf höchstens zwei Nachkommastellen, sofern nicht anders angegeben', () => {
    expect(formatNumber('0.125', 'de-DE')).toBe('0,13');
    expect(formatNumber('2', 'de-DE', { minimumFractionDigits: 2 })).toBe('2,00');
  });

  it('akzeptiert Zahlen und negative Werte', () => {
    expect(formatNumber(42, 'de-DE')).toBe('42');
    expect(formatNumber('-3.5', 'de-DE')).toBe('-3,5');
  });

  it('zeigt fehlende oder ungültige Werte als Platzhalter statt „NaN“', () => {
    expect(formatNumber(null, 'de-DE')).toBe(MISSING_VALUE);
    expect(formatNumber(undefined, 'de-DE')).toBe(MISSING_VALUE);
    expect(formatNumber('', 'de-DE')).toBe(MISSING_VALUE);
    expect(formatNumber('12abc', 'de-DE')).toBe(MISSING_VALUE);
    expect(formatNumber(Number.NaN, 'de-DE')).toBe(MISSING_VALUE);
  });
});

describe('formatCurrency', () => {
  it('formatiert Beträge in der Originalwährung', () => {
    expect(formatCurrency('1234.5', 'EUR', 'de-DE')).toBe(`1.234,50${nbsp}€`);
    expect(formatCurrency('1234.5', 'GBP', 'en-GB')).toBe('£1,234.50');
    expect(formatCurrency('1234.5', 'SEK', 'de-DE')).toBe(`1.234,50${nbsp}SEK`);
  });

  it('rundet exakt auf die Stellen der Währung', () => {
    expect(formatCurrency('0.005', 'EUR', 'de-DE')).toBe(`0,01${nbsp}€`);
  });

  it('zeigt fehlende Werte als Platzhalter', () => {
    expect(formatCurrency(null, 'EUR', 'de-DE')).toBe(MISSING_VALUE);
  });
});

describe('formatPercent', () => {
  it('formatiert Anteile (0.1234 = 12,3 %) mit einer Nachkommastelle', () => {
    expect(formatPercent('0.1234', 'de-DE')).toBe(`12,3${nbsp}%`);
    expect(formatPercent('0.1234', 'en-US')).toBe('12.3%');
    expect(formatPercent('1', 'de-DE')).toBe(`100,0${nbsp}%`);
  });

  it('erlaubt andere Nachkommastellen', () => {
    expect(formatPercent('0.1234', 'de-DE', { fractionDigits: 2 })).toBe(`12,34${nbsp}%`);
  });

  it('zeigt fehlende Werte als Platzhalter', () => {
    expect(formatPercent(undefined, 'de-DE')).toBe(MISSING_VALUE);
  });
});

describe('Randfälle', () => {
  it('zeigt auf null gerundete negative Werte ohne Minuszeichen', () => {
    expect(formatNumber('-0.001', 'de-DE')).toBe('0');
    expect(formatCurrency('-0.001', 'EUR', 'de-DE')).toBe(`0,00${nbsp}€`);
    expect(formatPercent('-0.00001', 'de-DE')).toBe(`0,0${nbsp}%`);
    expect(formatNumber('-1.5', 'de-DE')).toBe('-1,5');
  });

  it('zeigt bei ungültigem Währungscode den Platzhalter statt einen Fehler zu werfen', () => {
    expect(formatCurrency('1', 'EURO', 'de-DE')).toBe(MISSING_VALUE);
  });
});
