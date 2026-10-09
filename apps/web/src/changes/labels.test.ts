import { describe, expect, it } from 'vitest';
import type { SubmittedAdChangeData } from '../api/client';
import { i18n } from '../i18n';
import { changeSubject, changeValueText } from './labels';

const labels = { t: i18n.global.t as never, te: i18n.global.te as never, locale: 'de-DE' as const };
const plain = (text: string) => text.replace(/\u00a0|\u202f/g, ' ');

const change = (patch: Partial<SubmittedAdChangeData>): SubmittedAdChangeData =>
  ({
    operation: 'update',
    entityType: 'target',
    campaignName: 'SP Nistkasten',
    adGroupName: 'AG Meise',
    field: 'bid',
    before: '0.50',
    after: '0.80',
    currencyCode: 'EUR',
    negative: null,
    entity: {
      targetType: 'keyword',
      keywordText: 'nistkasten meise',
      matchType: 'EXACT',
      expression: null,
      asin: null,
      sku: null,
    },
    ...patch,
  }) as SubmittedAdChangeData;

describe('changeSubject', () => {
  it('nennt je Entity, was geändert wird, und wo es liegt', () => {
    expect(changeSubject(change({}), labels)).toEqual({
      kind: 'Target',
      name: 'nistkasten meise · Genau',
      path: 'SP Nistkasten › AG Meise',
    });
    expect(
      changeSubject(change({ entityType: 'campaign', entity: null, adGroupName: null }), labels),
    ).toEqual({ kind: 'Kampagne', name: 'SP Nistkasten', path: null });
    expect(changeSubject(change({ entityType: 'ad_group', entity: null }), labels)).toEqual({
      kind: 'Ad Group',
      name: 'AG Meise',
      path: 'SP Nistkasten',
    });
    expect(
      changeSubject(
        change({
          entityType: 'product_ad',
          entity: { ...change({}).entity!, keywordText: null, asin: 'B0DEMO0001', sku: 'SKU-1' },
        }),
        labels,
      ),
    ).toMatchObject({ kind: 'Product Ad', name: 'B0DEMO0001 · SKU-1' });
  });

  it('beschreibt ein neues Negative mit Text und Match-Typ bzw. ASIN', () => {
    expect(
      changeSubject(
        change({
          operation: 'create',
          entityType: 'negative_target',
          field: null,
          entity: null,
          adGroupName: null,
          negative: { type: 'keyword', keywordText: 'gratis', matchType: 'PHRASE' },
        }),
        labels,
      ),
    ).toEqual({ kind: 'Neues Negative', name: 'gratis · Wortgruppe', path: 'SP Nistkasten' });
    expect(
      changeSubject(
        change({
          operation: 'create',
          entityType: 'negative_target',
          field: null,
          entity: null,
          negative: { type: 'product', asin: 'B0DEMO0002' },
        }),
        labels,
      ).name,
    ).toBe('ASIN B0DEMO0002');
  });

  it('kommt ohne Namen aus (entfernte Kampagne)', () => {
    expect(
      changeSubject(
        change({ entityType: 'campaign', campaignName: null, entity: null, adGroupName: null }),
        labels,
      ).name,
    ).toBe('(unbekannt)');
  });
});

describe('changeValueText', () => {
  it('zeigt Beträge mit Währung, Platzierungen in Prozent, Zustände und Strategien übersetzt', () => {
    expect(plain(changeValueText('bid', '0.8', 'EUR', labels))).toBe('0,80 €');
    expect(plain(changeValueText('placement_top', '50', null, labels))).toBe('50 %');
    expect(changeValueText('state', 'PAUSED', null, labels)).toBe('Pausiert');
    expect(changeValueText('bidding_strategy', 'NONE', null, labels)).toBe('Feste Gebote');
    expect(changeValueText('state', 'SELTSAM', null, labels)).toBe('SELTSAM');
    expect(changeValueText('bid', null, 'EUR', labels)).toBe('–');
  });
});
