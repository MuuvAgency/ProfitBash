import { describe, expect, it } from 'vitest';
import { buildBulkSheet, type BulkFileChange, type BulkFileCreate } from './bulk-file';

/**
 * Anlagen für Sponsored Brands (`phase-4.md` 4.10): Zeilen mit `Operation = Create` im Blatt „SB Multi Ad Group
 * Campaigns“ nach dem Guide „How to create Sponsored Brands multi-ad group campaigns with bulksheets“ und seinen
 * Beispielen (Manual Collection ad, Video ad, Keyword, Product targeting).
 */

function build(changes: BulkFileChange[]) {
  const result = buildBulkSheet('sbMultiAdGroup', changes);
  const [header, ...rows] = result.rows;
  return {
    ...result,
    records: rows.map((row) =>
      Object.fromEntries(
        row.flatMap((cell, index) =>
          cell === null ? [] : [[(header as string[])[index]!, cell]],
        ),
      ),
    ),
  };
}

const create = (ref: string, change: BulkFileCreate): BulkFileChange => ({ ref, ...change });
const NAME = 'SB | HEADER | Flaschen';
const parents = { campaignId: NAME, adGroupId: NAME };
const base = { Product: 'Sponsored Brands', Operation: 'Create' };
const ids = { 'Campaign ID': NAME, 'Ad Group ID': NAME };

const campaign: BulkFileCreate = {
  type: 'create',
  entity: 'campaign',
  campaignId: NAME,
  name: NAME,
  targetingType: 'manual',
  state: 'ENABLED',
  dailyBudget: '15.00',
  startDate: '2099-10-10',
  biddingStrategy: null,
  amazonPortfolioId: '7001',
  offAmazon: null,
  sb: { brandEntityId: 'ENTITY1' },
};
const adGroup: BulkFileCreate = {
  type: 'create',
  entity: 'adGroup',
  ...parents,
  name: NAME,
  defaultBid: '0.90',
  state: 'ENABLED',
};
const collection: BulkFileCreate = {
  type: 'create',
  entity: 'sbAd',
  ...parents,
  state: 'ENABLED',
  format: 'collection',
  name: NAME,
  brandName: 'Waldkauz',
  brandEntityId: 'ENTITY1',
  logoAssetId: 'amzn1.assetlibrary.asset1.logo:version_v1',
  videoAssetId: null,
  adTitle: 'Für jeden Tag',
  asins: ['B0FLASCHE1', 'B0FLASCHE2', 'B0FLASCHE3'],
  landingPageUrl: null,
};

describe('buildBulkSheet(sbMultiAdGroup): Anlagen', () => {
  it('legt Kampagne, Ad Group, Kollektion, Keyword, Produkt-Target und Negatives an', () => {
    const { records, skipped } = build([
      create('c', campaign),
      create('g', adGroup),
      create('a', collection),
      create('k', {
        type: 'create',
        entity: 'keyword',
        ...parents,
        keywordText: 'trinkflasche',
        matchType: 'exact',
        bid: '0.90',
        state: 'ENABLED',
      }),
      create('t', {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: { type: 'category', value: '12345' },
        bid: null,
        state: 'ENABLED',
      }),
      create('n', {
        type: 'create',
        entity: 'negativeKeyword',
        ...parents,
        keywordText: 'glas',
        matchType: 'negativePhrase',
      }),
      create('na', { type: 'create', entity: 'negativeProductTarget', ...parents, asin: 'B0FREMD002' }),
    ]);
    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        ...base,
        Entity: 'Campaign',
        'Campaign ID': NAME,
        'Portfolio ID': '7001',
        'Campaign Name': NAME,
        'Start Date': '20991010',
        State: 'enabled',
        'Brand Entity ID': 'ENTITY1',
        'Budget Type': 'Daily',
        Budget: { number: '15.00' },
        // Amazon passt die Gebote je Platzierung an (ohne eigene Platzierungs-Zeilen).
        'Bid Optimization': 'true',
      },
      { ...base, Entity: 'Ad Group', ...ids, 'Ad Group Name': NAME, State: 'enabled' },
      {
        ...base,
        Entity: 'Manual Collection ad',
        ...ids,
        'Ad Name': NAME,
        State: 'enabled',
        'Brand Entity ID': 'ENTITY1',
        'Landing Page Type': 'Product list',
        'Brand Name': 'Waldkauz',
        'Brand Logo Asset ID': 'amzn1.assetlibrary.asset1.logo:version_v1',
        'Creative ASINs': 'B0FLASCHE1, B0FLASCHE2, B0FLASCHE3',
        'Ad Title': 'Für jeden Tag',
      },
      {
        ...base,
        Entity: 'Keyword',
        ...ids,
        State: 'enabled',
        Bid: { number: '0.90' },
        'Keyword Text': 'trinkflasche',
        'Match Type': 'exact',
      },
      {
        ...base,
        Entity: 'Product Targeting',
        ...ids,
        State: 'enabled',
        'Product Targeting Expression': 'category="12345"',
      },
      {
        ...base,
        Entity: 'Negative Keyword',
        ...ids,
        State: 'enabled',
        'Keyword Text': 'glas',
        'Match Type': 'negativePhrase',
      },
      {
        ...base,
        Entity: 'Negative Product Targeting',
        ...ids,
        State: 'enabled',
        'Product Targeting Expression': 'asin="B0FREMD002"',
      },
    ]);
  });

  it('legt eine Video-Anzeige mit Produktseite als Landing Page an; Vendoren ohne Marken-ID', () => {
    const { records, skipped } = build([
      create('c', { ...campaign, sb: { brandEntityId: null } }),
      create('v', {
        ...collection,
        format: 'video',
        brandEntityId: null,
        logoAssetId: null,
        videoAssetId: 'amzn1.assetlibrary.asset1.video:version_v1',
        adTitle: null,
        asins: ['B0FLASCHE1'],
        landingPageUrl: 'https://www.amazon.de/dp/B0FLASCHE1',
      }),
    ]);
    expect(skipped).toEqual([]);
    expect(records[0]).not.toHaveProperty('Brand Entity ID');
    expect(records[1]).toEqual({
      ...base,
      Entity: 'Video ad',
      ...ids,
      'Ad Name': NAME,
      State: 'enabled',
      'Landing Page URL': 'https://www.amazon.de/dp/B0FLASCHE1',
      'Landing Page Type': 'Detail Page',
      'Creative ASINs': 'B0FLASCHE1',
      'Video Asset IDs': 'amzn1.assetlibrary.asset1.video:version_v1',
    });
  });

  it('überspringt, was Sponsored Brands nicht kennt oder ungültig ist', () => {
    const { skipped } = build([
      create('no-sb', { ...campaign, sb: undefined }),
      create('strategy', { ...campaign, campaignId: 'B', biddingStrategy: 'SALES_DOWN_ONLY' }),
      create('two', { ...collection, name: 'Zwei', asins: ['B0FLASCHE1', 'B0FLASCHE2'] }),
      create('no-video', {
        ...collection,
        name: 'Video',
        format: 'video',
        asins: ['B0FLASCHE1'],
        landingPageUrl: 'https://www.amazon.de/dp/B0FLASCHE1',
      }),
      create('long-brand', { ...collection, name: 'Marke', brandName: 'x'.repeat(31) }),
      create('expanded', {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: { type: 'asinExpanded', value: 'B0FREMD001' },
        bid: null,
        state: 'ENABLED',
      }),
      create('placement', {
        type: 'create',
        entity: 'placement',
        campaignId: NAME,
        placement: 'PLACEMENT_TOP',
        percentage: '20',
      }),
      create('product-ad', {
        type: 'create',
        entity: 'productAd',
        ...parents,
        sku: 'FL-750',
        asin: null,
        state: 'ENABLED',
      }),
    ]);
    expect(skipped).toEqual([
      { ref: 'no-sb', reason: 'invalidValue' },
      { ref: 'strategy', reason: 'invalidValue' },
      { ref: 'two', reason: 'invalidValue' },
      { ref: 'no-video', reason: 'invalidValue' },
      { ref: 'long-brand', reason: 'invalidValue' },
      { ref: 'expanded', reason: 'invalidValue' },
      { ref: 'placement', reason: 'notSupportedInBulkFile' },
      { ref: 'product-ad', reason: 'notSupportedInBulkFile' },
    ]);
  });

  it('kennt SB-Anzeigen nicht in anderen Blättern und legt im älteren SB-Blatt nichts an', () => {
    expect(buildBulkSheet('sp', [create('a', collection)]).skipped).toEqual([
      { ref: 'a', reason: 'notSupportedInBulkFile' },
    ]);
    expect(buildBulkSheet('sb', [create('c', campaign)]).skipped).toEqual([
      { ref: 'c', reason: 'notSupportedInBulkFile' },
    ]);
  });
});
