import { describe, expect, it } from 'vitest';
import { fractionToPercent, parseDecimalInput, percentToFraction } from './decimal-input';

describe('parseDecimalInput', () => {
  it('liest Komma oder Punkt und entfernt Leerzeichen', () => {
    expect(parseDecimalInput(' 12,50 ')).toBe('12.50');
    expect(parseDecimalInput('0.5')).toBe('0.5');
    expect(parseDecimalInput(',5')).toBe('0.5');
    expect(parseDecimalInput('7')).toBe('7');
  });

  it('lehnt Leeres, Vorzeichen, Exponenten und Text ab', () => {
    for (const text of ['', ' ', '-1', '1e3', 'abc', '1,2,3', '1.000,5']) {
      expect(parseDecimalInput(text), text).toBeNull();
    }
  });
});

describe('Prozent und Bruch', () => {
  it('verschiebt das Komma exakt, ohne Gleitkomma', () => {
    expect(percentToFraction('25')).toBe('0.25');
    expect(percentToFraction('30.5')).toBe('0.305');
    expect(percentToFraction('7')).toBe('0.07');
    expect(percentToFraction('150')).toBe('1.5');
    expect(percentToFraction('0.1')).toBe('0.001');
    expect(percentToFraction('100')).toBe('1');
  });

  it('wandelt zurück und kürzt überflüssige Nullen', () => {
    expect(fractionToPercent('0.25')).toBe('25');
    expect(fractionToPercent('0.305')).toBe('30.5');
    expect(fractionToPercent('1.5')).toBe('150');
    expect(fractionToPercent('0.001')).toBe('0.1');
    expect(fractionToPercent('1')).toBe('100');
    expect(fractionToPercent('0.2500')).toBe('25');
  });
});
