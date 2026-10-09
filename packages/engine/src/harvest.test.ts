import type { PlannedCampaign } from '@profitbash/shared/campaign-setup';
import { describe, expect, it } from 'vitest';
import { harvestInputs, planSourceNegatives, type HarvestMarkSource } from './harvest';

/** Harvest von der Merkliste (`phase-4.md` 4.6, F7, F8): Eingaben des Setups und Negativ in der Quelle. */

const mark = (overrides: Partial<HarvestMarkSource> = {}): HarvestMarkSource => ({
  id: '00000000-0000-4000-8000-000000000001',
  searchTerm: 'trinkflasche 1l',
  adProduct: 'SPONSORED_PRODUCTS',
  amazonCampaignId: '111',
  amazonAdGroupId: '222',
  campaignName: 'SP | AUTO | Flaschen',
  adGroupName: 'SP | AUTO | Flaschen',
  sourceKeyword: null,
  clicks: 8,
  cost: '6.20',
  currencyCode: 'EUR',
  alreadyNegative: false,
  ...overrides,
});
const asinMark = mark({
  id: '00000000-0000-4000-8000-000000000002',
  searchTerm: 'b0fremd001',
});

const campaign = (targets: PlannedCampaign['targets']): PlannedCampaign => ({
  block: 'SP-KW-EXACT',
  adProduct: 'SP',
  targeting: 'keyword',
  name: 'SP | EXACT | Flaschen',
  state: 'ENABLED',
  currencyCode: 'EUR',
  dailyBudget: '25.00',
  biddingStrategy: 'SALES_DOWN_ONLY',
  sdOptimization: null,
  costType: 'cpc',
  offAmazon: false,
  placements: null,
  adGroup: { name: 'SP | EXACT | Flaschen', defaultBid: '0.85' },
  ads: [{ asin: 'B0FLASCHE1', sku: 'FL-750' }],
  targets,
  negatives: [],
});
const planned = [
  campaign([
    { type: 'keyword', text: 'trinkflasche 1l', matchType: 'exact', bid: '0.78' },
    { type: 'product', asin: 'B0FREMD001', match: 'exact', bid: '0.78' },
  ]),
];

describe('harvestInputs', () => {
  it('macht aus Begriffen Keywords und aus ASINs Produkt-Ziele, mit dem CPC als Gebot (F8)', () => {
    const result = harvestInputs({
      marks: [mark(), asinMark],
      selections: [{ markId: mark().id }, { markId: asinMark.id, single: true }],
      currencyCode: 'EUR',
    });
    expect(result.keywords).toEqual([{ text: 'trinkflasche 1l', bid: '0.78' }]);
    expect(result.productTargets).toEqual([{ asin: 'B0FREMD001', bid: '0.78', single: true }]);
    expect(result.hints).toEqual([]);
  });

  it('nimmt ein eingegebenes Gebot vor dem CPC und ohne Klicks bzw. Kosten keines', () => {
    const result = harvestInputs({
      marks: [
        mark(),
        mark({
          id: '00000000-0000-4000-8000-000000000003',
          searchTerm: 'flasche',
          clicks: 0,
          cost: '0.00',
        }),
      ],
      selections: [
        { markId: mark().id, bid: '1.10', single: true },
        { markId: '00000000-0000-4000-8000-000000000003' },
      ],
      currencyCode: 'EUR',
    });
    expect(result.keywords).toEqual([
      { text: 'trinkflasche 1l', bid: '1.10', single: true },
      { text: 'flasche' },
    ]);
  });

  it('rundet den CPC half-even und ignoriert ihn in fremder Währung', () => {
    const result = harvestInputs({
      marks: [
        mark({ clicks: 8, cost: '1.00' }),
        mark({
          id: '00000000-0000-4000-8000-000000000004',
          searchTerm: 'becher',
          currencyCode: 'USD',
        }),
      ],
      selections: [{ markId: mark().id }, { markId: '00000000-0000-4000-8000-000000000004' }],
      currencyCode: 'EUR',
    });
    // 1.00 / 8 = 0.125 → 0.12 (half-even)
    expect(result.keywords).toEqual([{ text: 'trinkflasche 1l', bid: '0.12' }, { text: 'becher' }]);
  });

  it('meldet gewählte Einträge, die nicht mehr auf der Merkliste stehen', () => {
    const result = harvestInputs({
      marks: [],
      selections: [{ markId: mark().id }],
      currencyCode: 'EUR',
    });
    expect(result.keywords).toEqual([]);
    expect(result.hints).toEqual([
      { severity: 'warning', code: 'harvestMarkMissing', markId: mark().id },
    ]);
  });
});

describe('planSourceNegatives', () => {
  const base = { protectedTerms: [] as string[], campaigns: planned };

  it('schlägt negativ exakt in der Ad Group der Quelle vor, ASINs als negatives Produkt-Ziel', () => {
    const result = planSourceNegatives({ ...base, marks: [mark(), asinMark] });
    expect(result.sourceNegatives).toEqual([
      {
        markId: mark().id,
        searchTerm: 'trinkflasche 1l',
        amazonCampaignId: '111',
        amazonAdGroupId: '222',
        campaignName: 'SP | AUTO | Flaschen',
        adGroupName: 'SP | AUTO | Flaschen',
        negative: { type: 'keyword', text: 'trinkflasche 1l', matchType: 'negativeExact' },
        selected: true,
      },
      {
        markId: asinMark.id,
        searchTerm: 'b0fremd001',
        amazonCampaignId: '111',
        amazonAdGroupId: '222',
        campaignName: 'SP | AUTO | Flaschen',
        adGroupName: 'SP | AUTO | Flaschen',
        negative: { type: 'product', asin: 'B0FREMD001', matchType: 'negativeExact' },
        selected: true,
      },
    ]);
    expect(result.hints).toEqual([]);
  });

  it('schlägt geschützte Begriffe nie vor', () => {
    const result = planSourceNegatives({
      ...base,
      protectedTerms: ['Trinkflasche'],
      marks: [mark()],
    });
    expect(result.sourceNegatives).toEqual([]);
    expect(result.hints).toEqual([
      { severity: 'info', code: 'sourceProtected', keyword: 'trinkflasche 1l' },
    ]);
  });

  it('lässt Quellen weg, die fehlen, nicht SP sind, schon negiert sind oder den Begriff exakt buchen', () => {
    const result = planSourceNegatives({
      ...base,
      marks: [
        mark({ campaignName: null }),
        mark({ adProduct: 'SPONSORED_BRANDS' }),
        mark({ alreadyNegative: true }),
        mark({ sourceKeyword: { text: 'Trinkflasche  1L', matchType: 'EXACT' } }),
      ],
    });
    expect(result.sourceNegatives).toEqual([]);
    expect(result.hints.map((hint) => hint.code)).toEqual([
      'sourceMissing',
      'sourceNotSp',
      'sourceAlreadyNegative',
      'sourceIsExact',
    ]);
  });

  it('negiert nur Begriffe, die der Plan auch anlegt', () => {
    const result = planSourceNegatives({
      ...base,
      campaigns: [campaign([{ type: 'keyword', text: 'becher', matchType: 'exact', bid: '0.50' }])],
      marks: [mark(), asinMark],
    });
    expect(result.sourceNegatives).toEqual([]);
    expect(result.hints).toEqual([
      { severity: 'info', code: 'sourceNotPlanned', keyword: 'trinkflasche 1l' },
      { severity: 'info', code: 'sourceNotPlanned', keyword: 'b0fremd001' },
    ]);
  });

  it('übernimmt die Abwahl eines früheren Plans', () => {
    const result = planSourceNegatives({
      ...base,
      marks: [mark()],
      deselected: [mark().id],
    });
    expect(result.sourceNegatives[0]?.selected).toBe(false);
  });
});
