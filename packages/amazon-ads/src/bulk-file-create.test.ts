import { describe, expect, it } from 'vitest';
import {
  buildSpBulkSheet,
  SP_BULK_COLUMNS,
  type BulkFileChange,
  type BulkFileCreate,
} from './bulk-file';

/**
 * Anlagen für Sponsored Products (`phase-4.md` 4.4): Zeilen mit `Operation = Create` und vorläufigen Text-IDs für
 * Kampagne und Ad Group, wie im Guide „How to create Sponsored Products campaigns“ und nach den Pflichtspalten des
 * „Config“-Blatts der echten Datei.
 */

function build(changes: BulkFileChange[]) {
  const result = buildSpBulkSheet(changes);
  const [, ...rows] = result.rows;
  return {
    ...result,
    records: rows.map((row) =>
      Object.fromEntries(
        row.flatMap((cell, index) => (cell === null ? [] : [[SP_BULK_COLUMNS[index]!, cell]])),
      ),
    ),
  };
}

const create = (ref: string, change: BulkFileCreate): BulkFileChange => ({ ref, ...change });

const campaign: BulkFileCreate = {
  type: 'create',
  entity: 'campaign',
  campaignId: 'SP | EXACT | Flaschen',
  name: 'SP | EXACT | Flaschen',
  targetingType: 'manual',
  state: 'ENABLED',
  dailyBudget: '25.00',
  startDate: '2026-10-09',
  biddingStrategy: 'SALES_DOWN_ONLY',
  amazonPortfolioId: null,
  offAmazon: null,
};
const parents = { campaignId: 'SP | EXACT | Flaschen', adGroupId: 'SP | EXACT | Flaschen' };

describe('buildSpBulkSheet: Anlagen', () => {
  it('legt eine Kampagne mit allen Pflichtspalten an', () => {
    const { records, skipped } = build([create('c', campaign)]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Products',
        Entity: 'Campaign',
        Operation: 'Create',
        'Campaign ID': 'SP | EXACT | Flaschen',
        'Campaign Name': 'SP | EXACT | Flaschen',
        'Start Date': '20261009',
        'Targeting Type': 'Manual',
        State: 'enabled',
        'Daily Budget': { number: '25.00' },
        'Bidding Strategy': 'Dynamic bids - down only',
      },
    ]);
  });

  it('schreibt die Spalte „Off-Amazon ad serving“ nur, wenn eine Zeile sie belegt (gibt es nur in den USA)', () => {
    expect(buildSpBulkSheet([create('c', campaign)]).rows[0]).not.toContain(
      'Off-Amazon ad serving',
    );
    expect(
      buildSpBulkSheet([create('c', { ...campaign, offAmazon: 'limitSpend' })]).rows[0],
    ).toContain('Off-Amazon ad serving');
  });

  it('setzt Portfolio, Auto-Targeting, pausiert und Off-Amazon, wenn genannt', () => {
    const { records } = build([
      create('c', {
        ...campaign,
        targetingType: 'auto',
        state: 'PAUSED',
        amazonPortfolioId: '9001',
        offAmazon: 'limitSpend',
      }),
      create('d', {
        ...campaign,
        campaignId: 'Zwei',
        name: 'Zwei',
        biddingStrategy: 'NONE',
        offAmazon: 'increaseReach',
      }),
    ]);

    expect(records[0]).toMatchObject({
      'Portfolio ID': '9001',
      'Targeting Type': 'Auto',
      State: 'paused',
      'Off-Amazon ad serving': 'Limit off-Amazon spend',
    });
    expect(records[1]).toMatchObject({
      'Bidding Strategy': 'Fixed bid',
      'Off-Amazon ad serving': 'Increase reach',
    });
  });

  it('legt Gebotsanpassung, Ad Group, Product Ad, Keyword, Produkt-Target und Negatives unter den Text-IDs an', () => {
    const { records, skipped } = build([
      create('c', campaign),
      create('p', {
        type: 'create',
        entity: 'placement',
        campaignId: parents.campaignId,
        placement: 'PLACEMENT_TOP',
        percentage: '20',
      }),
      create('ag', {
        type: 'create',
        entity: 'adGroup',
        campaignId: parents.campaignId,
        adGroupId: parents.adGroupId,
        name: 'SP | EXACT | Flaschen',
        defaultBid: '0.85',
        state: 'ENABLED',
      }),
      create('ad', {
        type: 'create',
        entity: 'productAd',
        ...parents,
        sku: 'FL-1L',
        asin: null,
        state: 'ENABLED',
      }),
      create('kw', {
        type: 'create',
        entity: 'keyword',
        ...parents,
        keywordText: 'trinkflasche 1l',
        matchType: 'exact',
        bid: '0.90',
        state: 'ENABLED',
      }),
      create('pt', {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: { type: 'asinExpanded', value: 'B000000001' },
        bid: null,
        state: 'ENABLED',
      }),
      create('cat', {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: { type: 'category', value: '5524098011' },
        bid: '0.40',
        state: 'ENABLED',
      }),
      create('nk', {
        type: 'create',
        entity: 'negativeKeyword',
        ...parents,
        keywordText: 'glas',
        matchType: 'negativePhrase',
      }),
      create('np', {
        type: 'create',
        entity: 'negativeProductTarget',
        ...parents,
        asin: 'B000000002',
      }),
    ]);

    expect(skipped).toEqual([]);
    expect(records.slice(1)).toEqual([
      {
        Product: 'Sponsored Products',
        Entity: 'Bidding Adjustment',
        Operation: 'Create',
        'Campaign ID': parents.campaignId,
        Placement: 'Placement Top',
        Percentage: { number: '20' },
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Ad Group',
        Operation: 'Create',
        'Campaign ID': parents.campaignId,
        'Ad Group ID': parents.adGroupId,
        'Ad Group Name': 'SP | EXACT | Flaschen',
        State: 'enabled',
        'Ad Group Default Bid': { number: '0.85' },
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Product Ad',
        Operation: 'Create',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        State: 'enabled',
        SKU: 'FL-1L',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Keyword',
        Operation: 'Create',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        State: 'enabled',
        Bid: { number: '0.90' },
        'Keyword Text': 'trinkflasche 1l',
        'Match Type': 'exact',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Product Targeting',
        Operation: 'Create',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        State: 'enabled',
        'Product Targeting Expression': 'asin-expanded="B000000001"',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Product Targeting',
        Operation: 'Create',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        State: 'enabled',
        Bid: { number: '0.40' },
        'Product Targeting Expression': 'category="5524098011"',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Negative Keyword',
        Operation: 'Create',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        State: 'enabled',
        'Keyword Text': 'glas',
        'Match Type': 'negativePhrase',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Negative Product Targeting',
        Operation: 'Create',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        State: 'enabled',
        'Product Targeting Expression': 'asin="B000000002"',
      },
    ]);
  });

  it('schreibt bei Vendoren die ASIN statt der SKU', () => {
    const { records } = build([
      create('ad', {
        type: 'create',
        entity: 'productAd',
        ...parents,
        sku: null,
        asin: 'B000000003',
        state: 'ENABLED',
      }),
    ]);
    expect(records[0]).toMatchObject({ ASIN: 'B000000003' });
    expect(records[0]).not.toHaveProperty('SKU');
  });

  it('überspringt ungültige Werte', () => {
    const invalid: BulkFileCreate[] = [
      // Eine Text-ID nur aus Ziffern wäre von einer echten ID nicht zu unterscheiden.
      { ...campaign, campaignId: '12345' },
      { ...campaign, campaignId: 'Leer', name: '  ' },
      { ...campaign, campaignId: 'Datum', startDate: '2026-02-30' },
      { ...campaign, campaignId: 'Budget', dailyBudget: '0' },
      { ...campaign, campaignId: 'Tab', name: 'mit\tTab' },
      {
        type: 'create',
        entity: 'productAd',
        ...parents,
        sku: null,
        asin: null,
        state: 'ENABLED',
      },
      {
        type: 'create',
        entity: 'productAd',
        ...parents,
        sku: 'X',
        asin: 'B000000003',
        state: 'ENABLED',
      },
      {
        type: 'create',
        entity: 'keyword',
        ...parents,
        keywordText: ' ',
        matchType: 'broad',
        bid: null,
        state: 'ENABLED',
      },
      {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: { type: 'asin', value: 'kurz' },
        bid: null,
        state: 'ENABLED',
      },
      {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: { type: 'category', value: '12a' },
        bid: null,
        state: 'ENABLED',
      },
      {
        type: 'create',
        entity: 'placement',
        campaignId: parents.campaignId,
        placement: 'PLACEMENT_TOP',
        percentage: '901',
      },
    ];
    const { records, skipped } = build(invalid.map((change, index) => create(`r${index}`, change)));

    expect(records).toEqual([]);
    expect(skipped).toEqual(
      invalid.map((_, index) => ({ ref: `r${index}`, reason: 'invalidValue' })),
    );
  });

  it('lässt dieselbe Anlage nur einmal zu', () => {
    const keyword: BulkFileCreate = {
      type: 'create',
      entity: 'keyword',
      ...parents,
      keywordText: 'Trinkflasche',
      matchType: 'exact',
      bid: null,
      state: 'ENABLED',
    };
    const { records, skipped } = build([
      create('a', campaign),
      create('b', campaign),
      create('k1', keyword),
      create('k2', { ...keyword, keywordText: 'trinkflasche' }),
      create('k3', { ...keyword, matchType: 'phrase' }),
    ]);

    expect(records.map((record) => record.Entity)).toEqual(['Campaign', 'Keyword', 'Keyword']);
    expect(skipped).toEqual([
      { ref: 'b', reason: 'duplicate' },
      { ref: 'k2', reason: 'duplicate' },
    ]);
  });

  it('nimmt für Eltern auch echte IDs (schon angelegte Kampagne bzw. Ad Group)', () => {
    const { records, skipped } = build([
      create('ag', {
        type: 'create',
        entity: 'adGroup',
        campaignId: '4401',
        adGroupId: 'Neue Gruppe',
        name: 'Neue Gruppe',
        defaultBid: '0.50',
        state: 'ENABLED',
      }),
      create('kw', {
        type: 'create',
        entity: 'keyword',
        campaignId: '4401',
        adGroupId: '5501',
        keywordText: 'flasche',
        matchType: 'exact',
        bid: null,
        state: 'ENABLED',
      }),
    ]);
    expect(skipped).toEqual([]);
    expect(records[1]).toMatchObject({ 'Campaign ID': '4401', 'Ad Group ID': '5501' });
  });

  it('verlangt bei Sponsored Products eine Gebotsstrategie und kennt keine SD-Angaben', () => {
    expect(build([create('c', { ...campaign, biddingStrategy: null })]).skipped).toEqual([
      { ref: 'c', reason: 'invalidValue' },
    ]);
    expect(
      build([create('c', { ...campaign, sd: { tactic: 'audience', costType: 'cpc' } })]).skipped,
    ).toEqual([{ ref: 'c', reason: 'invalidValue' }]);
  });
});
