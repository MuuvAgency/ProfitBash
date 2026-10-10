import { describe, expect, it } from 'vitest';
import {
  buildBulkSheet,
  SD_BULK_COLUMNS,
  type BulkFileChange,
  type BulkFileCreate,
} from './bulk-file';

/**
 * Anlagen für Sponsored Display (`phase-4.md` 4.9): Zeilen mit `Operation = Create` im Blatt „Sponsored Display
 * Campaigns“ nach dem Guide „How to create Sponsored Display campaigns with bulksheets“ (Taktik als ID, Budget
 * täglich, Kostenart an der Kampagne, Gebotsoptimierung an der Ad Group, Ausdrücke der Ziele). Das „Config“-Blatt der
 * echten Datei nennt für SD keine Pflichtspalten.
 */

function build(changes: BulkFileChange[]) {
  const result = buildBulkSheet('sd', changes);
  const [header, ...rows] = result.rows;
  return {
    ...result,
    header: header as string[],
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

const campaign: BulkFileCreate = {
  type: 'create',
  entity: 'campaign',
  campaignId: 'SD | RT-VIEW | Flaschen',
  name: 'SD | RT-VIEW | Flaschen',
  targetingType: 'manual',
  state: 'ENABLED',
  dailyBudget: '10.00',
  startDate: '2099-10-10',
  biddingStrategy: null,
  amazonPortfolioId: null,
  offAmazon: null,
  sd: { tactic: 'audience', costType: 'cpc' },
};
const parents = { campaignId: 'SD | RT-VIEW | Flaschen', adGroupId: 'SD | RT-VIEW | Flaschen' };
const base = { Product: 'Sponsored Display', Operation: 'Create' };

describe('buildBulkSheet(sd): Anlagen', () => {
  it('legt Kampagne, Ad Group, Anzeige und Zielgruppe unter den Text-IDs an', () => {
    const { records, skipped, header } = build([
      create('c', { ...campaign, amazonPortfolioId: '7001' }),
      create('g', {
        type: 'create',
        entity: 'adGroup',
        ...parents,
        name: 'SD | RT-VIEW | Flaschen',
        defaultBid: '0.55',
        state: 'ENABLED',
        bidOptimization: 'conversions',
      }),
      create('a', {
        type: 'create',
        entity: 'productAd',
        ...parents,
        sku: 'FL-750',
        asin: null,
        state: 'ENABLED',
      }),
      create('v', {
        type: 'create',
        entity: 'audienceTarget',
        ...parents,
        audience: 'views',
        lookbackDays: 30,
        bid: '0.60',
        state: 'ENABLED',
      }),
      create('p', {
        type: 'create',
        entity: 'audienceTarget',
        ...parents,
        audience: 'purchases',
        lookbackDays: 90,
        bid: null,
        state: 'ENABLED',
      }),
    ]);

    expect(skipped).toEqual([]);
    // Das echte Blatt hat keine beschreibbare Spalte „ASIN“; sie erscheint nur für Vendoren.
    expect(header).toEqual(SD_BULK_COLUMNS.filter((column) => column !== 'ASIN'));
    expect(records).toEqual([
      {
        ...base,
        Entity: 'Campaign',
        'Campaign ID': 'SD | RT-VIEW | Flaschen',
        'Portfolio ID': '7001',
        'Campaign Name': 'SD | RT-VIEW | Flaschen',
        'Start Date': '20991010',
        State: 'enabled',
        Tactic: 'T00030',
        'Budget Type': 'daily',
        Budget: { number: '10.00' },
        'Cost Type': 'CPC',
      },
      {
        ...base,
        Entity: 'Ad Group',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        'Ad Group Name': 'SD | RT-VIEW | Flaschen',
        State: 'enabled',
        'Ad Group Default Bid': { number: '0.55' },
        'Bid Optimization': 'Optimize for conversions',
      },
      {
        ...base,
        Entity: 'Product Ad',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        State: 'enabled',
        SKU: 'FL-750',
      },
      {
        ...base,
        Entity: 'Audience Targeting',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        State: 'enabled',
        Bid: { number: '0.60' },
        'Targeting Expression': 'views=(exact-product lookback=30)',
      },
      {
        ...base,
        Entity: 'Audience Targeting',
        ...{ 'Campaign ID': parents.campaignId, 'Ad Group ID': parents.adGroupId },
        State: 'enabled',
        'Targeting Expression': 'purchases=(exact-product lookback=90)',
      },
    ]);
  });

  it('legt kontextbezogene Kampagnen mit Produkten, Kategorien und negativen ASINs an', () => {
    const { records, skipped } = build([
      create('c', { ...campaign, sd: { tactic: 'contextual', costType: 'cpc' } }),
      create('g', {
        type: 'create',
        entity: 'adGroup',
        ...parents,
        name: 'SD | RT-VIEW | Flaschen',
        defaultBid: '0.50',
        state: 'ENABLED',
        bidOptimization: 'clicks',
      }),
      create('t', {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: { type: 'asin', value: 'B0FREMD001' },
        bid: '0.50',
        state: 'ENABLED',
      }),
      create('k', {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: { type: 'category', value: '12345' },
        bid: null,
        state: 'ENABLED',
      }),
      create('n', { type: 'create', entity: 'negativeProductTarget', ...parents, asin: 'B0FREMD002' }),
    ]);
    expect(skipped).toEqual([]);
    expect(records[0]).toMatchObject({ Tactic: 'T00020', 'Cost Type': 'CPC' });
    expect(records[1]).toMatchObject({ 'Bid Optimization': 'Optimize for page visits' });
    expect(records.slice(2).map((row) => [row.Entity, row['Targeting Expression']])).toEqual([
      ['Contextual Targeting', 'asin="B0FREMD001"'],
      ['Contextual Targeting', 'category="12345"'],
      ['Negative Product Targeting', 'asin="B0FREMD002"'],
    ]);
  });

  it('schreibt vCPM nur mit der Optimierung auf sichtbare Impressionen (freigeschaltet nach F-S7)', () => {
    const { records, skipped } = build([
      create('c', { ...campaign, sd: { tactic: 'audience', costType: 'vcpm' } }),
      create('g', {
        type: 'create',
        entity: 'adGroup',
        ...parents,
        name: 'G',
        defaultBid: '3.00',
        state: 'ENABLED',
        bidOptimization: 'reach',
      }),
    ]);
    expect(skipped).toEqual([]);
    expect(records[0]).toMatchObject({ 'Cost Type': 'vCPM' });
    expect(records[1]).toMatchObject({ 'Bid Optimization': 'Optimize for viewable impressions' });
  });

  it('schreibt bei Vendoren die ASIN in eine eigene Spalte (Guide „Product ad“)', () => {
    const { records, header } = build([
      create('a', {
        type: 'create',
        entity: 'productAd',
        ...parents,
        sku: null,
        asin: 'B0FLASCHE1',
        state: 'ENABLED',
      }),
    ]);
    expect(header).toContain('ASIN');
    expect(records[0]).toMatchObject({ ASIN: 'B0FLASCHE1' });
    expect(records[0]).not.toHaveProperty('SKU');
  });

  it('überspringt, was Display nicht kennt oder ungültig ist', () => {
    const { skipped } = build([
      // Ohne Taktik und Kostenart bzw. mit Gebotsstrategie von SP.
      create('no-sd', { ...campaign, sd: undefined }),
      create('strategy', { ...campaign, campaignId: 'B', biddingStrategy: 'SALES_DOWN_ONLY' }),
      // vCPM verlangt die Optimierung auf Reichweite, CPC verbietet sie.
      create('no-optimization', {
        type: 'create',
        entity: 'adGroup',
        ...parents,
        name: 'G',
        defaultBid: '0.50',
        state: 'ENABLED',
      }),
      create('expanded', {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: { type: 'asinExpanded', value: 'B0FREMD001' },
        bid: null,
        state: 'ENABLED',
      }),
      create('lookback', {
        type: 'create',
        entity: 'audienceTarget',
        ...parents,
        audience: 'views',
        lookbackDays: 45,
        bid: null,
        state: 'ENABLED',
      }),
      create('placement', {
        type: 'create',
        entity: 'placement',
        campaignId: parents.campaignId,
        placement: 'PLACEMENT_TOP',
        percentage: '20',
      }),
      create('negative-keyword', {
        type: 'create',
        entity: 'negativeKeyword',
        ...parents,
        keywordText: 'glas',
        matchType: 'negativeExact',
      }),
      create('keyword', {
        type: 'create',
        entity: 'keyword',
        ...parents,
        keywordText: 'flasche',
        matchType: 'exact',
        bid: null,
        state: 'ENABLED',
      }),
    ]);
    expect(skipped).toEqual([
      { ref: 'no-sd', reason: 'invalidValue' },
      { ref: 'strategy', reason: 'invalidValue' },
      { ref: 'no-optimization', reason: 'invalidValue' },
      { ref: 'expanded', reason: 'invalidValue' },
      { ref: 'lookback', reason: 'invalidValue' },
      { ref: 'placement', reason: 'notSupportedInBulkFile' },
      { ref: 'negative-keyword', reason: 'notSupportedInBulkFile' },
      { ref: 'keyword', reason: 'notSupportedInBulkFile' },
    ]);
  });

  it('lässt dieselbe Zielgruppe nur einmal zu', () => {
    const audience: BulkFileCreate = {
      type: 'create',
      entity: 'audienceTarget',
      ...parents,
      audience: 'views',
      lookbackDays: 30,
      bid: null,
      state: 'ENABLED',
    };
    expect(build([create('a', audience), create('b', audience)]).skipped).toEqual([
      { ref: 'b', reason: 'duplicate' },
    ]);
  });

  it('kennt Zielgruppen nicht im Blatt von Sponsored Products, SB-Anlagen erst mit 4.10', () => {
    expect(
      buildBulkSheet('sp', [
        create('v', {
          type: 'create',
          entity: 'audienceTarget',
          ...parents,
          audience: 'views',
          lookbackDays: 30,
          bid: null,
          state: 'ENABLED',
        }),
      ]).skipped,
    ).toEqual([{ ref: 'v', reason: 'notSupportedInBulkFile' }]);
    for (const kind of ['sb', 'sbMultiAdGroup'] as const) {
      expect(buildBulkSheet(kind, [create('c', campaign)]).skipped).toEqual([
        { ref: 'c', reason: 'notSupportedInBulkFile' },
      ]);
    }
  });
});
