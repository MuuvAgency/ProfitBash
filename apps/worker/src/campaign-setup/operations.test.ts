import type { CampaignSetupItemRow } from '@profitbash/db';
import { describe, expect, it } from 'vitest';
import { buildSetupOperations } from './operations';

/** Anlagen einer Setup-Übermittlung → Aufträge für `applyCreates` (`phase-4.md` 4.4, API-Weg). */

const NAME = 'SP | EXACT | Flaschen';
let counter = 0;
const item = (
  payload: CampaignSetupItemRow['payload'],
  overrides: Partial<CampaignSetupItemRow> = {},
): CampaignSetupItemRow => ({
  id: `i${counter++}`,
  submissionId: 'sub',
  position: counter,
  entityType: payload.entity,
  campaignRef: NAME,
  adGroupRef: payload.entity === 'campaign' || payload.entity === 'placement' ? null : NAME,
  payload,
  status: 'submitted',
  amazonEntityId: null,
  errorCode: null,
  errorMessage: null,
  ...overrides,
});

const campaignPayload = {
  entity: 'campaign',
  adProduct: 'SP',
  name: NAME,
  targetingType: 'manual',
  state: 'PAUSED',
  dailyBudget: '25.00',
  currencyCode: 'EUR',
  biddingStrategy: 'SALES_UP_AND_DOWN',
  offAmazon: false,
} as const;
const context = { accountType: 'seller', countryCode: 'DE', startDate: '2026-10-09' };

describe('buildSetupOperations', () => {
  it('bildet jede offene Anlage ab, Platzierungen gehen mit der Kampagne', () => {
    const campaign = item(campaignPayload);
    const placement = item({ entity: 'placement', placement: 'PLACEMENT_TOP', percentage: 20 });
    const adGroup = item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' });
    const ad = item({ entity: 'product_ad', asin: 'B0TEST0001', sku: 'SKU-1' });
    const keyword = item({ entity: 'keyword', text: 'flasche', matchType: 'exact', bid: '0.90' });
    const similar = item({
      entity: 'product_target',
      expression: { type: 'asinExpanded', value: 'B0FREMD001' },
      bid: '0.50',
    });
    const category = item({
      entity: 'product_target',
      expression: { type: 'category', value: '123' },
      bid: '0.40',
    });
    const negative = item({ entity: 'negative_keyword', text: 'glas', matchType: 'negativeExact' });
    const negativeAsin = item({ entity: 'negative_product_target', asin: 'B0FREMD002' });

    const result = buildSetupOperations(
      [campaign, placement, adGroup, ad, keyword, similar, category, negative, negativeAsin],
      context,
    );
    expect(result.rejected).toEqual([]);
    expect(result.created).toEqual(new Map());
    expect(result.followers).toEqual(new Map([[campaign.id, [placement.id]]]));
    const parents = { campaignRef: campaign.id, adGroupRef: adGroup.id };
    expect(result.operations).toEqual([
      {
        ref: campaign.id,
        entity: 'campaign',
        name: NAME,
        targetingType: 'MANUAL',
        state: 'PAUSED',
        dailyBudget: '25.00',
        startDate: '2026-10-09',
        biddingStrategy: 'SALES_UP_AND_DOWN',
        placements: [{ placement: 'PLACEMENT_TOP', percentage: '20' }],
        amazonPortfolioId: null,
        offAmazon: null,
      },
      {
        ref: adGroup.id,
        entity: 'adGroup',
        campaignRef: campaign.id,
        name: NAME,
        defaultBid: '0.85',
        state: 'ENABLED',
      },
      { ref: ad.id, entity: 'productAd', ...parents, sku: 'SKU-1', asin: null, state: 'ENABLED' },
      {
        ref: keyword.id,
        entity: 'keyword',
        ...parents,
        keywordText: 'flasche',
        matchType: 'EXACT',
        bid: '0.90',
        state: 'ENABLED',
      },
      {
        ref: similar.id,
        entity: 'target',
        ...parents,
        expression: { type: 'ASIN_EXPANDED_FROM', value: 'B0FREMD001' },
        bid: '0.50',
        state: 'ENABLED',
      },
      {
        ref: category.id,
        entity: 'target',
        ...parents,
        expression: { type: 'ASIN_CATEGORY_SAME_AS', value: '123' },
        bid: '0.40',
        state: 'ENABLED',
      },
      {
        ref: negative.id,
        entity: 'negativeKeyword',
        ...parents,
        keywordText: 'glas',
        matchType: 'NEGATIVE_EXACT',
      },
      { ref: negativeAsin.id, entity: 'negativeTarget', ...parents, asin: 'B0FREMD002' },
    ]);
  });

  it('bewirbt bei Vendoren die ASIN und sperrt Off-Amazon in den USA (F-S7)', () => {
    const campaign = item(campaignPayload);
    const adGroup = item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' });
    const ad = item({ entity: 'product_ad', asin: 'B0TEST0001', sku: null });
    const { operations } = buildSetupOperations([campaign, adGroup, ad], {
      ...context,
      accountType: 'vendor',
      countryCode: 'US',
    });
    expect(operations[0]).toMatchObject({ offAmazon: 'limitSpend' });
    expect(operations[2]).toMatchObject({ sku: null, asin: 'B0TEST0001' });
  });

  it('setzt fort: angelegte Eltern stehen in created, ihre Zeilen werden nicht erneut gesendet', () => {
    const campaign = item(campaignPayload, { status: 'applied', amazonEntityId: '4401' });
    const placement = item(
      { entity: 'placement', placement: 'PLACEMENT_TOP', percentage: 20 },
      { status: 'applied' },
    );
    const adGroup = item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' });
    const result = buildSetupOperations([campaign, placement, adGroup], context);
    expect(result.created).toEqual(new Map([[campaign.id, '4401']]));
    expect(result.operations.map((op) => op.ref)).toEqual([adGroup.id]);
    expect(result.followers).toEqual(new Map());
  });

  it('lässt Kinder scheitern, deren Kampagne bzw. Ad Group nicht angelegt wird', () => {
    const campaign = item(campaignPayload, { status: 'failed' });
    const adGroup = item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' });
    const other = item({ ...campaignPayload, name: 'Zweite' }, { campaignRef: 'Zweite' });
    const lostGroup = item(
      { entity: 'ad_group', name: 'Zweite', defaultBid: '0.85' },
      { campaignRef: 'Zweite', adGroupRef: 'Zweite', status: 'dismissed' },
    );
    const keyword = item(
      { entity: 'keyword', text: 'flasche', matchType: 'broad', bid: '0.90' },
      { campaignRef: 'Zweite', adGroupRef: 'Zweite' },
    );
    const result = buildSetupOperations([campaign, adGroup, other, lostGroup, keyword], context);
    expect(result.operations.map((op) => op.ref)).toEqual([other.id]);
    expect(result.rejected.map(({ itemId, code }) => [itemId, code])).toEqual([
      [adGroup.id, 'PARENT_NOT_CREATED'],
      [keyword.id, 'PARENT_NOT_CREATED'],
    ]);
  });

  it('negiert in der Quelle unter den echten IDs der bestehenden Kampagne (4.6)', () => {
    const source = item(
      {
        entity: 'source_negative',
        amazonCampaignId: '111',
        amazonAdGroupId: '222',
        negative: { type: 'keyword', text: 'trinkflasche 1l', matchType: 'negativeExact' },
        harvestMarkId: '00000000-0000-4000-8000-000000000001',
      },
      { campaignRef: 'SP | AUTO | Flaschen', adGroupRef: 'Auto' },
    );
    const target = item(
      { entity: 'keyword', text: 'trinkflasche 1l', matchType: 'exact', bid: '0.9' },
      { status: 'applied', amazonEntityId: '903' },
    );
    const result = buildSetupOperations([target, source], context);
    expect(result.rejected).toEqual([]);
    expect(result.operations).toEqual([
      {
        ref: source.id,
        entity: 'negativeKeyword',
        campaignRef: 'amazon-campaign:111',
        adGroupRef: 'amazon-ad-group:222',
        keywordText: 'trinkflasche 1l',
        matchType: 'NEGATIVE_EXACT',
      },
    ]);
    expect(result.created.get('amazon-campaign:111')).toBe('111');
    expect(result.created.get('amazon-ad-group:222')).toBe('222');
  });

  describe('Negatives in der Quelle warten auf das neue Ziel des Begriffs', () => {
    const source = (text: string) =>
      item(
        {
          entity: 'source_negative',
          amazonCampaignId: '111',
          amazonAdGroupId: '222',
          negative: { type: 'keyword', text, matchType: 'negativeExact' },
          harvestMarkId: '00000000-0000-4000-8000-000000000001',
        },
        { campaignRef: 'SP | AUTO | Flaschen', adGroupRef: 'Auto' },
      );
    const parents = (status: string) => [
      item(campaignPayload, { status, amazonEntityId: status === 'applied' ? '901' : null }),
      item(
        { entity: 'ad_group', name: NAME, defaultBid: '0.85' },
        { status, amazonEntityId: status === 'applied' ? '902' : null },
      ),
    ];

    it('stellt sie zurück, solange das Keyword noch offen ist', () => {
      const negative = source('Trinkflasche  Glas');
      const result = buildSetupOperations(
        [
          ...parents('submitted'),
          item({ entity: 'keyword', text: 'trinkflasche glas', matchType: 'exact', bid: '0.9' }),
          negative,
        ],
        context,
      );
      expect(result.operations.map((op) => op.ref)).not.toContain(negative.id);
      expect(result.deferred).toEqual([negative.id]);
      expect(result.rejected).toEqual([]);
    });

    it('sendet sie, wenn das Keyword angelegt ist', () => {
      const negative = source('trinkflasche glas');
      const result = buildSetupOperations(
        [
          ...parents('applied'),
          item(
            { entity: 'keyword', text: 'trinkflasche glas', matchType: 'exact', bid: '0.9' },
            { status: 'applied', amazonEntityId: '903' },
          ),
          negative,
        ],
        context,
      );
      expect(result.operations.map((op) => op.ref)).toContain(negative.id);
      expect(result.deferred).toEqual([]);
    });

    it('lässt sie scheitern, wenn kein Ziel des Begriffs angelegt wird', () => {
      const negative = source('trinkflasche glas');
      const result = buildSetupOperations(
        [
          ...parents('applied'),
          item(
            { entity: 'keyword', text: 'trinkflasche glas', matchType: 'exact', bid: '0.9' },
            { status: 'failed' },
          ),
          negative,
        ],
        context,
      );
      expect(result.rejected).toEqual([
        expect.objectContaining({ itemId: negative.id, code: 'HARVEST_TARGET_NOT_CREATED' }),
      ]);
    });
  });

  it('legt neue Kampagnen im Portfolio des Entwurfs an (4.7)', () => {
    const result = buildSetupOperations(
      [item({ ...campaignPayload, amazonPortfolioId: '7001' })],
      context,
    );
    expect(result.operations[0]).toMatchObject({ entity: 'campaign', amazonPortfolioId: '7001' });
  });

  it('bildet Sponsored Display auf die SD-Anlagen ab (4.9)', () => {
    const SD = 'SD | RT-VIEW | Flaschen';
    const sd = { campaignRef: SD, adGroupRef: SD };
    const campaign = item(
      {
        ...campaignPayload,
        adProduct: 'SD',
        name: SD,
        biddingStrategy: null,
        amazonPortfolioId: '7001',
        sdTactic: 'audience',
        costType: 'cpc',
      },
      { campaignRef: SD, adGroupRef: null },
    );
    const adGroup = item(
      { entity: 'ad_group', name: SD, defaultBid: '0.55', bidOptimization: 'conversions' },
      sd,
    );
    const result = buildSetupOperations(
      [
        campaign,
        adGroup,
        item({ entity: 'product_ad', asin: 'B0TEST0001', sku: 'SKU-1' }, sd),
        item({ entity: 'audience_target', audience: 'views', lookbackDays: 30, bid: '0.60' }, sd),
        item(
          { entity: 'product_target', expression: { type: 'asin', value: 'B0FREMD001' }, bid: '0.50' },
          sd,
        ),
        item(
          { entity: 'product_target', expression: { type: 'category', value: '12345' }, bid: '0.40' },
          sd,
        ),
        item({ entity: 'negative_product_target', asin: 'B0FREMD002' }, sd),
      ],
      { ...context, countryCode: 'US' },
    );
    expect(result.rejected).toEqual([]);
    const parents = { campaignRef: campaign.id, adGroupRef: adGroup.id };
    expect(result.operations.map(({ ref: _ref, ...op }) => op)).toEqual([
      {
        entity: 'sdCampaign',
        name: SD,
        state: 'PAUSED',
        dailyBudget: '25.00',
        startDate: '2026-10-09',
        tactic: 'T00030',
        costType: 'cpc',
        amazonPortfolioId: '7001',
      },
      {
        entity: 'sdAdGroup',
        campaignRef: campaign.id,
        name: SD,
        defaultBid: '0.55',
        bidOptimization: 'conversions',
        state: 'ENABLED',
      },
      { entity: 'sdProductAd', ...parents, sku: 'SKU-1', asin: null, state: 'ENABLED' },
      {
        entity: 'sdTarget',
        ...parents,
        expression: { type: 'views', lookbackDays: 30 },
        bid: '0.60',
        state: 'ENABLED',
      },
      {
        entity: 'sdTarget',
        ...parents,
        expression: { type: 'asinSameAs', value: 'B0FREMD001' },
        bid: '0.50',
        state: 'ENABLED',
      },
      {
        entity: 'sdTarget',
        ...parents,
        expression: { type: 'asinCategorySameAs', value: '12345' },
        bid: '0.40',
        state: 'ENABLED',
      },
      { entity: 'sdNegativeTarget', ...parents, asin: 'B0FREMD002' },
    ]);
  });

  it('lehnt bei Display ab, was die API nicht kennt („ähnlich wie“, Keywords)', () => {
    const SD = 'SD | PAT | Flaschen';
    const sd = { campaignRef: SD, adGroupRef: SD };
    const expanded = item(
      { entity: 'product_target', expression: { type: 'asinExpanded', value: 'B0FREMD001' }, bid: '0.50' },
      sd,
    );
    const keyword = item({ entity: 'keyword', text: 'flasche', matchType: 'exact', bid: '0.50' }, sd);
    const result = buildSetupOperations(
      [
        item(
          { ...campaignPayload, adProduct: 'SD', name: SD, biddingStrategy: null, sdTactic: 'contextual', costType: 'cpc' },
          { campaignRef: SD, adGroupRef: null },
        ),
        item({ entity: 'ad_group', name: SD, defaultBid: '0.50', bidOptimization: 'clicks' }, sd),
        expanded,
        keyword,
      ],
      context,
    );
    expect(result.rejected).toEqual([
      expect.objectContaining({ itemId: expanded.id, code: 'SD_NOT_SUPPORTED' }),
      expect.objectContaining({ itemId: keyword.id, code: 'SD_NOT_SUPPORTED' }),
    ]);
  });

  it('lässt eine Zielgruppe unter einer SP-Kampagne scheitern statt sie liegen zu lassen', () => {
    const audience = item({ entity: 'audience_target', audience: 'views', lookbackDays: 30, bid: '0.60' });
    const result = buildSetupOperations(
      [
        item(campaignPayload),
        item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' }),
        audience,
      ],
      context,
    );
    expect(result.rejected).toEqual([
      expect.objectContaining({ itemId: audience.id, code: 'SD_NOT_SUPPORTED' }),
    ]);
  });
});
