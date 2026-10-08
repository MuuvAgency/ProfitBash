import { describe, expect, it } from 'vitest';
import {
  amazonAdsValueLimitIssue,
  negativeKeywordLimitIssue,
  SP_BID_LIMITS,
  SP_DAILY_BUDGET_LIMITS,
} from './limits';

const SP = 'SPONSORED_PRODUCTS';

describe('Grenzen von Amazon für Sponsored Products (Doku-Stand 2026-10-08)', () => {
  it('kennt Gebots- und Budgetgrenzen für jeden Marktplatz, den ProfitBash anlegt', () => {
    const countries = [
      'DE',
      'FR',
      'IT',
      'ES',
      'NL',
      'BE',
      'IE',
      'UK',
      'SE',
      'PL',
      'TR',
      'US',
      'CA',
    ];
    expect(Object.keys(SP_BID_LIMITS).sort()).toEqual([...countries].sort());
    expect(Object.keys(SP_DAILY_BUDGET_LIMITS).sort()).toEqual([...countries].sort());
  });

  it.each([
    ['DE', '0.02', '1000'],
    ['UK', '0.02', '1000'],
    ['US', '0.02', '1000'],
    ['SE', '0.18', '9300'],
    ['PL', '0.04', '2000'],
    ['TR', '0.05', '2500'],
  ])('Gebot in %s: %s bis %s', (countryCode, min, max) => {
    const issue = (value: string, field: 'bid' | 'default_bid' = 'bid') =>
      amazonAdsValueLimitIssue({ adProduct: SP, countryCode, field, value });
    expect(issue(min)).toBeNull();
    expect(issue(max)).toBeNull();
    expect(issue(min, 'default_bid')).toBeNull();
    expect(issue('0.01')).toEqual({ code: 'belowMinimum', min, max });
    expect(issue(`${max}.01`)).toEqual({ code: 'aboveMaximum', min, max });
    expect(issue(`${max}.01`, 'default_bid')).toEqual({ code: 'aboveMaximum', min, max });
  });

  it.each([
    ['DE', '1', '1000000'],
    ['CA', '1', '1000000'],
    ['SE', '9', '9300000'],
    ['PL', '2', '2000000'],
    ['TR', '2', '2500000'],
  ])('Tagesbudget in %s: %s bis %s', (countryCode, min, max) => {
    const issue = (value: string) =>
      amazonAdsValueLimitIssue({ adProduct: SP, countryCode, field: 'budget', value });
    expect(issue(min)).toBeNull();
    expect(issue(`${min}.00`)).toBeNull();
    expect(issue(max)).toBeNull();
    expect(issue('0.99')).toEqual({ code: 'belowMinimum', min, max });
    expect(issue(`${max}.01`)).toEqual({ code: 'aboveMaximum', min, max });
  });

  it('begrenzt die Gebotsanpassung je Platzierung auf 0 bis 900 %', () => {
    const issue = (value: string) =>
      amazonAdsValueLimitIssue({ adProduct: SP, countryCode: 'DE', field: 'placement', value });
    expect(issue('0')).toBeNull();
    expect(issue('900')).toBeNull();
    expect(issue('901')).toEqual({ code: 'aboveMaximum', min: '0', max: '900' });
  });

  it('kennt für andere Ad-Typen und unbekannte Marktplätze noch keine Grenzen (Amazon entscheidet)', () => {
    expect(
      amazonAdsValueLimitIssue({
        adProduct: 'SPONSORED_BRANDS',
        countryCode: 'DE',
        field: 'bid',
        value: '0.01',
      }),
    ).toBeNull();
    expect(
      amazonAdsValueLimitIssue({ adProduct: SP, countryCode: 'JP', field: 'bid', value: '0.01' }),
    ).toBeNull();
  });

  it('wirft bei Werten, die keine einfache Dezimalzahl sind', () => {
    for (const value of ['abc', '', ' 1', 'NaN', '0x10', '1e3', '-1']) {
      expect(
        () => amazonAdsValueLimitIssue({ adProduct: SP, countryCode: 'DE', field: 'bid', value }),
        value,
      ).toThrow(/keine einfache Dezimalzahl/);
    }
  });

  it('vergleicht große und lange Beträge exakt', () => {
    expect(
      amazonAdsValueLimitIssue({
        adProduct: SP,
        countryCode: 'DE',
        field: 'bid',
        value: '1000.000000000000000001',
      }),
    ).toMatchObject({ code: 'aboveMaximum' });
  });
});

describe('negativeKeywordLimitIssue', () => {
  it('erlaubt höchstens 80 Zeichen', () => {
    expect(negativeKeywordLimitIssue('x'.repeat(80), 'EXACT')).toBeNull();
    expect(negativeKeywordLimitIssue('x'.repeat(81), 'EXACT')).toEqual({
      code: 'tooLong',
      max: 80,
    });
  });

  it('erlaubt bei Wortgruppen 4 Wörter, bei exakten Negatives 10', () => {
    const words = (count: number) => Array.from({ length: count }, (_, i) => `w${i}`).join(' ');
    expect(negativeKeywordLimitIssue(words(4), 'PHRASE')).toBeNull();
    expect(negativeKeywordLimitIssue(words(5), 'PHRASE')).toEqual({ code: 'tooManyWords', max: 4 });
    expect(negativeKeywordLimitIssue(words(10), 'EXACT')).toBeNull();
    expect(negativeKeywordLimitIssue(words(11), 'EXACT')).toEqual({
      code: 'tooManyWords',
      max: 10,
    });
  });
});
