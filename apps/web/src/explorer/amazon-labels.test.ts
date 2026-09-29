import { describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import { amazonLabel, targetLabel } from './amazon-labels';

const t = i18n.global.t;
const te = (key: string) => i18n.global.te(key);
const labels = { t, te };

describe('amazonLabel', () => {
  it('übersetzt Match-Typen, Targeting und Gebotsstrategie', () => {
    expect(amazonLabel('matchType', 'EXACT', labels)).toBe('Genau');
    expect(amazonLabel('matchType', 'PHRASE', labels)).toBe('Wortgruppe');
    expect(amazonLabel('matchType', 'BROAD', labels)).toBe('Weitgehend');
    expect(amazonLabel('matchType', 'SEARCH_CLOSE_MATCH', labels)).toBe('Eng verwandt');
    expect(amazonLabel('matchType', 'PRODUCT_EXACT', labels)).toBe('Produkt');
    expect(amazonLabel('targetingType', 'AUTO', labels)).toBe('Automatisch');
    expect(amazonLabel('targetingType', 'T00030', labels)).toBe('Zielgruppen');
    expect(amazonLabel('biddingStrategy', 'SALES_DOWN_ONLY', labels)).toBe('Dynamisch, nur senken');
  });

  it('zeigt unbekannte Werte wie geliefert, fehlende als null', () => {
    expect(amazonLabel('matchType', 'NEW_AMAZON_VALUE', labels)).toBe('NEW_AMAZON_VALUE');
    expect(amazonLabel('biddingStrategy', null, labels)).toBeNull();
  });
});

describe('targetLabel', () => {
  it('Keyword mit übersetztem Match-Typ', () => {
    expect(targetLabel({ keywordText: 'nistkasten', matchType: 'PHRASE' }, labels)).toBe(
      'nistkasten · Wortgruppe',
    );
  });

  it('Produkt, Kategorie, Auto-Targeting, Zielgruppe und SB-Thema ohne JSON', () => {
    expect(
      targetLabel(
        {
          expression: { matchType: 'PRODUCT_EXACT', asin: 'B0DEMO0001' },
          matchType: 'PRODUCT_EXACT',
        },
        labels,
      ),
    ).toBe('ASIN B0DEMO0001');
    expect(
      targetLabel(
        {
          expression: { productCategoryId: '12345678901', productCategoryResolved: 'Mock Schuhe' },
        },
        labels,
      ),
    ).toBe('Kategorie: Mock Schuhe');
    expect(targetLabel({ expression: { productCategoryId: '42' } }, labels)).toBe('Kategorie: 42');
    expect(
      targetLabel(
        { expression: { matchType: 'SEARCH_LOOSE_MATCH' }, matchType: 'SEARCH_LOOSE_MATCH' },
        labels,
      ),
    ).toBe('Automatisch: Lose verwandt');
    expect(targetLabel({ expression: { event: 'VIEWS', lookback: 30 } }, labels)).toBe(
      'Zielgruppe: Aufrufe, 30 Tage',
    );
    expect(
      targetLabel({ expression: { matchType: 'KEYWORDS_RELATED_TO_YOUR_BRAND' } }, labels),
    ).toBe('Thema: Keywords zur Marke');
  });

  it('Kategorie mit Verfeinerungen, Zielgruppe ohne Zeitraum', () => {
    expect(
      targetLabel(
        {
          expression: {
            productCategoryId: '42',
            productCategoryResolved: 'Leuchten',
            brand: 'Lumen',
            priceMax: '30',
          },
        },
        labels,
      ),
    ).toBe('Kategorie: Leuchten (brand: Lumen, priceMax: 30)');
    expect(targetLabel({ expression: { event: 'PURCHASES' } }, labels)).toBe('Zielgruppe: Käufe');
  });

  it('Unbekannte Ausdrücke als lesbare Liste, leere als null', () => {
    expect(targetLabel({ expression: { foo: 'bar', size: 3 } }, labels)).toBe('foo: bar, size: 3');
    expect(targetLabel({ expression: {} }, labels)).toBeNull();
    expect(targetLabel({}, labels)).toBeNull();
  });
});
