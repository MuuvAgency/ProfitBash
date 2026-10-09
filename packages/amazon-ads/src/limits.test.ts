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

  it('kennt für unbekannte Ad-Typen und Marktplätze keine Grenzen (Amazon entscheidet)', () => {
    expect(
      amazonAdsValueLimitIssue({
        adProduct: 'SPONSORED_TV',
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

describe('Grenzen für Sponsored Brands und Sponsored Display (3.2c, Doku-Stand 2026-10-09)', () => {
  const SB = 'SPONSORED_BRANDS';
  const SD = 'SPONSORED_DISPLAY';
  const issue = (
    adProduct: string,
    countryCode: string,
    field: 'bid' | 'default_bid' | 'budget' | 'placement',
    value: string,
    costType?: string | null,
  ) => amazonAdsValueLimitIssue({ adProduct, countryCode, field, value, costType })?.code ?? null;

  it('SD: Gebote je Kostenart (CPC ab 0,02, vCPM ab 1 in EUR), auch als Standardgebot', () => {
    expect(issue(SD, 'DE', 'bid', '0.02', 'cpc')).toBeNull();
    expect(issue(SD, 'DE', 'bid', '0.01', 'cpc')).toBe('belowMinimum');
    expect(issue(SD, 'DE', 'default_bid', '0.50', 'VCPM')).toBe('belowMinimum');
    expect(issue(SD, 'DE', 'bid', '1', 'vcpm')).toBeNull();
    expect(issue(SD, 'DE', 'bid', '1000.01', 'vcpm')).toBe('aboveMaximum');
    expect(issue(SD, 'TR', 'bid', '1.80', 'vcpm')).toBe('belowMinimum');
    expect(issue(SD, 'SE', 'bid', '0.17', 'cpc')).toBe('belowMinimum');
  });

  it('SD ohne bekannte Kostenart: nur was für beide Kostenarten ausgeschlossen ist', () => {
    expect(issue(SD, 'DE', 'bid', '0.50', null)).toBeNull();
    expect(issue(SD, 'DE', 'bid', '0.01')).toBe('belowMinimum');
    expect(issue(SD, 'DE', 'bid', '1000.01')).toBe('aboveMaximum');
    // Für Irland nennt Amazon keine SD-Grenzen.
    expect(issue(SD, 'IE', 'bid', '0.01', 'cpc')).toBeNull();
  });

  it('SB: CPC zwischen dem Minimum für Bild-Anzeigen und dem Maximum, vCPM zwischen 1 und 5000', () => {
    expect(issue(SB, 'DE', 'bid', '0.09', 'cpc')).toBe('belowMinimum');
    expect(issue(SB, 'DE', 'bid', '0.10', 'cpc')).toBeNull();
    expect(issue(SB, 'DE', 'bid', '39.01', 'cpc')).toBe('aboveMaximum');
    expect(issue(SB, 'UK', 'bid', '31.01', 'cpc')).toBe('aboveMaximum');
    expect(issue(SB, 'DE', 'bid', '45', 'vcpm')).toBeNull();
    expect(issue(SB, 'DE', 'bid', '5000.01', 'vcpm')).toBe('aboveMaximum');
    // Ohne Kostenart gilt die weiteste Spanne (0,10 bis 5000).
    expect(issue(SB, 'DE', 'bid', '45')).toBeNull();
    expect(issue(SB, 'DE', 'bid', '0.09')).toBe('belowMinimum');
  });

  it('Tagesbudgets je Marktplatz; Platzierungen gibt es nur bei SP', () => {
    expect(issue(SB, 'DE', 'budget', '0.99')).toBe('belowMinimum');
    expect(issue(SB, 'SE', 'budget', '8')).toBe('belowMinimum');
    expect(issue(SD, 'DE', 'budget', '1')).toBeNull();
    expect(issue(SD, 'TR', 'budget', '1.99')).toBe('belowMinimum');
    expect(issue(SD, 'DE', 'budget', '1000001')).toBe('aboveMaximum');
    expect(issue(SB, 'DE', 'placement', '950')).toBeNull();
  });

  it('kennt SB- und SD-Grenzen für die Marktplätze, die ProfitBash anlegt (SD ohne Irland)', () => {
    for (const country of [
      'DE',
      'FR',
      'IT',
      'ES',
      'NL',
      'BE',
      'UK',
      'US',
      'CA',
      'SE',
      'PL',
      'TR',
    ]) {
      expect(issue(SB, country, 'bid', '0.001', 'cpc'), country).toBe('belowMinimum');
      expect(issue(SD, country, 'bid', '0.001', 'cpc'), country).toBe('belowMinimum');
      expect(issue(SB, country, 'budget', '0.5'), country).toBe('belowMinimum');
      expect(issue(SD, country, 'budget', '0.5'), country).toBe('belowMinimum');
    }
    expect(issue(SB, 'IE', 'bid', '0.001', 'cpc')).toBe('belowMinimum');
  });
});
