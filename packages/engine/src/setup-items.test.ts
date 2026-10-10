import type { PlannedCampaign } from '@profitbash/shared/campaign-setup';
import { describe, expect, it } from 'vitest';
import { planSetupItems } from './setup-items';

/** Aus dem Plan eines Entwurfs werden die einzelnen Anlagen der Übermittlung (`phase-4.md` 4.4). */

const sp: PlannedCampaign = {
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
  placements: { topOfSearch: 20, productPages: 0, restOfSearch: 5 },
  adGroup: { name: 'SP | EXACT | Flaschen', defaultBid: '0.85' },
  ads: [{ asin: 'B0FLASCHE1', sku: 'FL-750' }],
  targets: [
    { type: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '0.90' },
    { type: 'product', asin: 'B0FREMD001', match: 'exact', bid: '0.50' },
    { type: 'product', asin: 'B0FREMD003', match: 'expanded', bid: '0.45' },
    { type: 'category', categoryId: '12345', name: 'Trinkflaschen', bid: '0.40' },
  ],
  negatives: [
    { type: 'keyword', text: 'glas', matchType: 'negativePhrase' },
    { type: 'product', asin: 'B0FREMD002', matchType: 'negativeExact' },
  ],
};

describe('planSetupItems', () => {
  it('legt je Kampagne Eltern vor Kindern an, mit den Namen als Text-IDs', () => {
    const items = planSetupItems([sp], { campaignState: 'PAUSED' });
    const refs = { campaignRef: sp.name, adGroupRef: sp.adGroup.name };

    expect(items).toEqual([
      {
        entityType: 'campaign',
        campaignRef: sp.name,
        adGroupRef: null,
        supported: true,
        payload: {
          entity: 'campaign',
          adProduct: 'SP',
          name: sp.name,
          targetingType: 'manual',
          state: 'PAUSED',
          dailyBudget: '25.00',
          currencyCode: 'EUR',
          biddingStrategy: 'SALES_DOWN_ONLY',
          offAmazon: false,
          amazonPortfolioId: null,
        },
      },
      {
        entityType: 'placement',
        campaignRef: sp.name,
        adGroupRef: null,
        supported: true,
        payload: { entity: 'placement', placement: 'PLACEMENT_TOP', percentage: 20 },
      },
      {
        entityType: 'placement',
        campaignRef: sp.name,
        adGroupRef: null,
        supported: true,
        payload: { entity: 'placement', placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 5 },
      },
      {
        entityType: 'ad_group',
        ...refs,
        supported: true,
        payload: { entity: 'ad_group', name: sp.adGroup.name, defaultBid: '0.85' },
      },
      {
        entityType: 'product_ad',
        ...refs,
        supported: true,
        payload: { entity: 'product_ad', asin: 'B0FLASCHE1', sku: 'FL-750' },
      },
      {
        entityType: 'keyword',
        ...refs,
        supported: true,
        payload: { entity: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '0.90' },
      },
      {
        entityType: 'product_target',
        ...refs,
        supported: true,
        payload: {
          entity: 'product_target',
          expression: { type: 'asin', value: 'B0FREMD001' },
          bid: '0.50',
        },
      },
      {
        entityType: 'product_target',
        ...refs,
        supported: true,
        payload: {
          entity: 'product_target',
          expression: { type: 'asinExpanded', value: 'B0FREMD003' },
          bid: '0.45',
        },
      },
      {
        entityType: 'product_target',
        ...refs,
        supported: true,
        payload: {
          entity: 'product_target',
          expression: { type: 'category', value: '12345' },
          bid: '0.40',
        },
      },
      {
        entityType: 'negative_keyword',
        ...refs,
        supported: true,
        payload: { entity: 'negative_keyword', text: 'glas', matchType: 'negativePhrase' },
      },
      {
        entityType: 'negative_product_target',
        ...refs,
        supported: true,
        payload: { entity: 'negative_product_target', asin: 'B0FREMD002' },
      },
    ]);
  });

  it('setzt Auto-Targeting und Fixgebot und lässt Platzierungen mit 0 % weg', () => {
    const items = planSetupItems(
      [
        {
          ...sp,
          targeting: 'auto',
          biddingStrategy: 'NONE',
          placements: { topOfSearch: 0, productPages: 0, restOfSearch: 0 },
          targets: [],
          negatives: [],
        },
      ],
      { campaignState: 'ENABLED' },
    );
    expect(items.map((item) => item.entityType)).toEqual(['campaign', 'ad_group', 'product_ad']);
    expect(items[0]!.payload).toMatchObject({
      targetingType: 'auto',
      state: 'ENABLED',
      biddingStrategy: 'NONE',
    });
  });

  it('nimmt SB nur als Kampagne auf, die (noch) nicht angelegt wird', () => {
    const items = planSetupItems(
      [
        {
          ...sp,
          adProduct: 'SB',
          name: 'SB | HEADER | Flaschen',
          biddingStrategy: null,
          placements: null,
        },
      ],
      { campaignState: 'ENABLED' },
    );
    expect(items.map((item) => [item.entityType, item.supported])).toEqual([['campaign', false]]);
  });

  const sdAudience: PlannedCampaign = {
    ...sp,
    block: 'SD-RT-VIEWS',
    adProduct: 'SD',
    targeting: 'audience',
    name: 'SD | RT-VIEW | Flaschen',
    biddingStrategy: null,
    placements: null,
    sdOptimization: 'conversions',
    adGroup: { name: 'SD | RT-VIEW | Flaschen', defaultBid: '0.55' },
    targets: [{ type: 'audience', audience: 'views', lookbackDays: 30, bid: '0.60' }],
    negatives: [],
  };

  it('legt Sponsored Display mit Taktik, Kostenart und Gebotsoptimierung an (4.9)', () => {
    const items = planSetupItems([sdAudience], { campaignState: 'ENABLED' });
    const refs = { campaignRef: sdAudience.name, adGroupRef: sdAudience.adGroup.name };
    expect(items).toEqual([
      {
        entityType: 'campaign',
        campaignRef: sdAudience.name,
        adGroupRef: null,
        supported: true,
        payload: {
          entity: 'campaign',
          adProduct: 'SD',
          name: sdAudience.name,
          targetingType: 'manual',
          state: 'ENABLED',
          dailyBudget: '25.00',
          currencyCode: 'EUR',
          biddingStrategy: null,
          offAmazon: false,
          amazonPortfolioId: null,
          sdTactic: 'audience',
          costType: 'cpc',
        },
      },
      {
        entityType: 'ad_group',
        ...refs,
        supported: true,
        payload: {
          entity: 'ad_group',
          name: sdAudience.adGroup.name,
          defaultBid: '0.55',
          bidOptimization: 'conversions',
        },
      },
      {
        entityType: 'product_ad',
        ...refs,
        supported: true,
        payload: { entity: 'product_ad', asin: 'B0FLASCHE1', sku: 'FL-750' },
      },
      {
        entityType: 'audience_target',
        ...refs,
        supported: true,
        payload: { entity: 'audience_target', audience: 'views', lookbackDays: 30, bid: '0.60' },
      },
    ]);
  });

  it('setzt bei Display-Kontext die kontextbezogene Taktik und bei vCPM die Optimierung auf Reichweite', () => {
    const items = planSetupItems(
      [
        {
          ...sdAudience,
          block: 'SD-CAT',
          targeting: 'category',
          name: 'SD | CAT | Flaschen',
          costType: 'vcpm',
          sdOptimization: 'clicks',
          targets: [{ type: 'category', categoryId: '12345', name: 'Flaschen', bid: '0.40' }],
        },
      ],
      { campaignState: 'ENABLED' },
    );
    expect(items[0]!.payload).toMatchObject({ sdTactic: 'contextual', costType: 'vcpm' });
    expect(items[1]!.payload).toMatchObject({ entity: 'ad_group', bidOptimization: 'reach' });
    expect(items[3]!.payload).toEqual({
      entity: 'product_target',
      expression: { type: 'category', value: '12345' },
      bid: '0.40',
    });
  });

  it('hängt gewählte Negatives in der Quelle mit den echten IDs an (4.6, F7)', () => {
    const negative = {
      markId: '00000000-0000-4000-8000-000000000001',
      searchTerm: 'trinkflasche 1l',
      amazonCampaignId: '111',
      amazonAdGroupId: '222',
      campaignName: 'SP | AUTO | Flaschen',
      adGroupName: 'Auto',
      negative: { type: 'keyword', text: 'trinkflasche 1l', matchType: 'negativeExact' },
      selected: true,
    } as const;
    const items = planSetupItems([], {
      campaignState: 'ENABLED',
      sourceNegatives: [
        negative,
        { ...negative, markId: '00000000-0000-4000-8000-000000000002', selected: false },
      ],
    });
    expect(items).toEqual([
      {
        entityType: 'source_negative',
        campaignRef: 'SP | AUTO | Flaschen',
        adGroupRef: 'Auto',
        supported: true,
        payload: {
          entity: 'source_negative',
          amazonCampaignId: '111',
          amazonAdGroupId: '222',
          negative: { type: 'keyword', text: 'trinkflasche 1l', matchType: 'negativeExact' },
          harvestMarkId: '00000000-0000-4000-8000-000000000001',
        },
      },
    ]);
  });

  it('setzt das Portfolio des Entwurfs an jede neue Kampagne (4.7)', () => {
    const items = planSetupItems([sp], { campaignState: 'ENABLED', amazonPortfolioId: '7001' });
    expect(items[0]!.payload).toMatchObject({ entity: 'campaign', amazonPortfolioId: '7001' });
    const without = planSetupItems([sp], { campaignState: 'ENABLED' });
    expect(without[0]!.payload).toMatchObject({ entity: 'campaign', amazonPortfolioId: null });
  });
});
