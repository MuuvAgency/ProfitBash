import { describe, expect, it } from 'vitest';
import {
  buildSpBulkSheet,
  SP_BULK_COLUMNS,
  SP_BULK_SHEET_NAME,
  type BulkFileChange,
} from './bulk-file';

/** Bulk-Datei für Sponsored Products (`phase-3.md` 3.2b): Zeilen wie in Amazons Bulksheets-Doku, englisch. */

const campaign = {
  amazonCampaignId: '1001',
  amazonPortfolioId: '9001',
  endDate: '2026-12-31',
  state: 'ENABLED',
};

/** Zeilen als Objekte je Spaltenname (nur belegte Zellen). */
function build(changes: BulkFileChange[]) {
  const result = buildSpBulkSheet(changes);
  const [header, ...rows] = result.rows;
  return {
    ...result,
    header,
    records: rows.map((row) =>
      Object.fromEntries(
        row.flatMap((cell, index) => (cell === null ? [] : [[SP_BULK_COLUMNS[index]!, cell]])),
      ),
    ),
  };
}

describe('buildSpBulkSheet', () => {
  it('nennt das Blatt und die Spalten der Vorlage', () => {
    const { sheetName, header } = build([]);

    expect(sheetName).toBe(SP_BULK_SHEET_NAME);
    expect(sheetName).toBe('Sponsored Products Campaigns');
    expect(header).toEqual([
      'Product',
      'Entity',
      'Operation',
      'Campaign ID',
      'Ad Group ID',
      'Portfolio ID',
      'Ad ID',
      'Keyword ID',
      'Product Targeting ID',
      'Campaign Name',
      'Ad Group Name',
      'Start Date',
      'End Date',
      'Targeting Type',
      'State',
      'Daily Budget',
      'SKU',
      'ASIN',
      'Ad Group Default Bid',
      'Bid',
      'Keyword Text',
      'Match Type',
      'Bidding Strategy',
      'Placement',
      'Percentage',
      'Product Targeting Expression',
    ]);
  });

  it('schreibt beim Kampagnen-Update nur die geänderten Felder, dazu immer Portfolio und Enddatum', () => {
    const { records, skipped } = build([
      { ref: 'a', type: 'campaign', campaign, set: { dailyBudget: '35.50', state: 'PAUSED' } },
    ]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Products',
        Entity: 'Campaign',
        Operation: 'Update',
        'Campaign ID': '1001',
        // Ohne Portfolio-ID fiele die Kampagne aus dem Portfolio, ein leeres Enddatum entfernte es.
        'Portfolio ID': '9001',
        'End Date': '20261231',
        State: 'paused',
        'Daily Budget': { number: '35.50' },
      },
    ]);
  });

  it('lässt Portfolio und Enddatum leer, wenn die Kampagne keines hat, und setzt die neue Strategie', () => {
    const { records } = build([
      {
        ref: 'a',
        type: 'campaign',
        campaign: { ...campaign, amazonPortfolioId: null, endDate: null, state: 'enabled' },
        set: { biddingStrategy: 'NONE' },
      },
    ]);

    expect(records).toEqual([
      {
        Product: 'Sponsored Products',
        Entity: 'Campaign',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Bidding Strategy': 'Fixed bid',
      },
    ]);
  });

  it('überspringt Updates archivierter Kampagnen, auch wenn der neue Zustand „aktiv“ wäre', () => {
    const archived = { ...campaign, state: 'Archived' };
    const { records, skipped } = build([
      { ref: 'a', type: 'campaign', campaign: archived, set: { dailyBudget: '5' } },
      {
        ref: 'b',
        type: 'campaign',
        campaign: { ...archived, amazonCampaignId: '1002' },
        set: { state: 'ENABLED' },
      },
      { ref: 'c', type: 'campaign', campaign: { ...campaign, amazonCampaignId: '1003' }, set: {} },
      {
        ref: 'd',
        type: 'campaign',
        campaign: { ...campaign, amazonCampaignId: '1004', endDate: '2026-13-45' },
        set: { state: 'PAUSED' },
      },
      {
        ref: 'e',
        type: 'campaign',
        campaign: { ...campaign, amazonCampaignId: '1005', amazonPortfolioId: 'P1' },
        set: { state: 'PAUSED' },
      },
    ]);

    expect(records).toEqual([]);
    expect(skipped).toEqual([
      { ref: 'a', reason: 'entityArchived' },
      { ref: 'b', reason: 'entityArchived' },
      { ref: 'c', reason: 'nothingToChange' },
      { ref: 'd', reason: 'invalidValue' },
      { ref: 'e', reason: 'invalidValue' },
    ]);
  });

  it('lässt je Entity nur eine Zeile zu: eine zweite würde die erste beim Hochladen überschreiben', () => {
    const ids = { amazonCampaignId: '1001', amazonAdGroupId: '1101' };
    const { records, skipped } = build([
      { ref: 'c1', type: 'campaign', campaign, set: { dailyBudget: '35.50' } },
      { ref: 'c2', type: 'campaign', campaign, set: { state: 'PAUSED' } },
      { ref: 'k1', type: 'keyword', ...ids, amazonTargetId: '2001', bid: '0.5' },
      { ref: 'k2', type: 'archive', entity: 'keyword', ...ids, amazonId: '2001' },
      {
        ref: 'p1',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'NONE',
        placement: 'PLACEMENT_TOP',
        percentage: '10',
      },
      {
        ref: 'p2',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'NONE',
        placement: 'PLACEMENT_TOP',
        percentage: '20',
      },
      {
        ref: 'p3',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'NONE',
        placement: 'PLACEMENT_PRODUCT_PAGE',
        percentage: '20',
      },
    ]);

    expect(records.map((r) => r.Entity)).toEqual([
      'Campaign',
      'Keyword',
      'Bidding Adjustment',
      'Bidding Adjustment',
    ]);
    expect(skipped).toEqual([
      { ref: 'c2', reason: 'duplicate' },
      { ref: 'k2', reason: 'duplicate' },
      { ref: 'p2', reason: 'duplicate' },
    ]);
  });

  it('nimmt für Gebotsanpassungen die Strategie der Kampagnenzeile derselben Datei', () => {
    const { records } = build([
      {
        ref: 'p',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'SALES_DOWN_ONLY',
        placement: 'PLACEMENT_TOP',
        percentage: '10',
      },
      { ref: 'c', type: 'campaign', campaign, set: { biddingStrategy: 'NONE' } },
    ]);

    expect(records.map((r) => r['Bidding Strategy'])).toEqual(['Fixed bid', 'Fixed bid']);
  });

  it('überspringt Kinder einer Kampagne oder Ad Group, die dieselbe Datei archiviert', () => {
    const ids = { amazonCampaignId: '1001', amazonAdGroupId: '1101' };
    const other = { amazonCampaignId: '1002', amazonAdGroupId: '1201' };
    const { records, skipped } = build([
      { ref: 'k', type: 'keyword', ...ids, amazonTargetId: '2001', bid: '0.5' },
      { ref: 'g', type: 'adGroup', ...ids, state: 'PAUSED' },
      { ref: 'c', type: 'archive', entity: 'campaign', amazonCampaignId: '1001' },
      { ref: 'k2', type: 'keyword', ...other, amazonTargetId: '2002', bid: '0.5' },
      { ref: 'g2', type: 'archive', entity: 'adGroup', ...other },
      {
        ref: 'n',
        type: 'createNegative',
        amazonCampaignId: '1002',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: 'x', matchType: 'EXACT' },
      },
    ]);

    expect(records.map((r) => [r.Entity, r.Operation])).toEqual([
      ['Campaign', 'Archive'],
      ['Ad Group', 'Archive'],
      ['Campaign Negative Keyword', 'Create'],
    ]);
    expect(skipped).toEqual([
      { ref: 'k', reason: 'parentArchived' },
      { ref: 'g', reason: 'parentArchived' },
      { ref: 'k2', reason: 'parentArchived' },
    ]);
  });

  it('schreibt Gebotsanpassungen je Platzierung als eigene Zeile', () => {
    const { records } = build([
      {
        ref: 'a',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'SALES_UP_AND_DOWN',
        placement: 'PLACEMENT_TOP',
        percentage: '120',
      },
      {
        ref: 'b',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'SALES_UP_AND_DOWN',
        placement: 'SITE_AMAZON_BUSINESS',
        percentage: '0',
      },
    ]);

    expect(records).toEqual([
      {
        Product: 'Sponsored Products',
        Entity: 'Bidding Adjustment',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Bidding Strategy': 'Dynamic bids - up and down',
        Placement: 'Placement Top',
        Percentage: { number: '120' },
      },
      expect.objectContaining({
        Placement: 'Placement Amazon Business',
        Percentage: { number: '0' },
      }),
    ]);
  });

  it('schreibt Updates für Ad Group, Keyword, Produkt-Target und Product Ad nur mit IDs und geänderten Feldern', () => {
    const ids = { amazonCampaignId: '1001', amazonAdGroupId: '1101' };
    const { records } = build([
      { ref: 'g', type: 'adGroup', ...ids, defaultBid: '0.45' },
      { ref: 'k', type: 'keyword', ...ids, amazonTargetId: '2001', bid: '0.10', state: 'PAUSED' },
      { ref: 't', type: 'productTarget', ...ids, amazonTargetId: '3001', state: 'ENABLED' },
      { ref: 'p', type: 'productAd', ...ids, amazonAdId: '4001', state: 'PAUSED' },
    ]);

    expect(records).toEqual([
      {
        Product: 'Sponsored Products',
        Entity: 'Ad Group',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '1101',
        'Ad Group Default Bid': { number: '0.45' },
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Keyword',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '1101',
        'Keyword ID': '2001',
        State: 'paused',
        Bid: { number: '0.10' },
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Product Targeting',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '1101',
        'Product Targeting ID': '3001',
        State: 'enabled',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Product Ad',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '1101',
        'Ad ID': '4001',
        State: 'paused',
      },
    ]);
  });

  it('archiviert über die Operation mit den IDs der Entity', () => {
    const ids = { amazonCampaignId: '1001', amazonAdGroupId: '1101' };
    const { records } = build([
      { ref: 'c', type: 'archive', entity: 'campaign', amazonCampaignId: '1009' },
      {
        ref: 'g',
        type: 'archive',
        entity: 'adGroup',
        amazonCampaignId: '1002',
        amazonAdGroupId: '1201',
      },
      { ref: 'k', type: 'archive', entity: 'keyword', ...ids, amazonId: '2001' },
      { ref: 't', type: 'archive', entity: 'productTarget', ...ids, amazonId: '3001' },
      { ref: 'p', type: 'archive', entity: 'productAd', ...ids, amazonId: '4001' },
      { ref: 'n', type: 'archive', entity: 'negativeKeyword', ...ids, amazonId: '5001' },
      {
        ref: 'm',
        type: 'archive',
        entity: 'campaignNegativeKeyword',
        amazonCampaignId: '1001',
        amazonId: '5002',
      },
      { ref: 'o', type: 'archive', entity: 'negativeProductTarget', ...ids, amazonId: '5003' },
    ]);

    expect(records.map((r) => [r.Entity, r.Operation])).toEqual([
      ['Campaign', 'Archive'],
      ['Ad Group', 'Archive'],
      ['Keyword', 'Archive'],
      ['Product Targeting', 'Archive'],
      ['Product Ad', 'Archive'],
      ['Negative Keyword', 'Archive'],
      ['Campaign Negative Keyword', 'Archive'],
      ['Negative Product Targeting', 'Archive'],
    ]);
    expect(records[0]).toEqual({
      Product: 'Sponsored Products',
      Entity: 'Campaign',
      Operation: 'Archive',
      'Campaign ID': '1009',
    });
    expect(records[2]).toMatchObject({ 'Ad Group ID': '1101', 'Keyword ID': '2001' });
    expect(records[3]).toMatchObject({ 'Product Targeting ID': '3001' });
    expect(records[4]).toMatchObject({ 'Ad ID': '4001' });
    expect(records[5]).toMatchObject({ 'Keyword ID': '5001' });
    expect(records[6]).toMatchObject({ 'Keyword ID': '5002' });
    expect(records[6]).not.toHaveProperty('Ad Group ID');
    expect(records[7]).toMatchObject({ 'Product Targeting ID': '5003' });
  });

  it('legt negative Keywords und negative ASINs an', () => {
    const { records, skipped } = build([
      {
        ref: 'a',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        negative: { type: 'keyword', keywordText: 'gebraucht lampe', matchType: 'EXACT' },
      },
      {
        ref: 'b',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: 'kinder', matchType: 'PHRASE' },
      },
      {
        ref: 'c',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
    ]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Products',
        Entity: 'Negative Keyword',
        Operation: 'Create',
        'Campaign ID': '1001',
        'Ad Group ID': '1101',
        State: 'enabled',
        'Keyword Text': 'gebraucht lampe',
        'Match Type': 'negativeExact',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Campaign Negative Keyword',
        Operation: 'Create',
        'Campaign ID': '1001',
        State: 'enabled',
        'Keyword Text': 'kinder',
        'Match Type': 'negativePhrase',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Negative Product Targeting',
        Operation: 'Create',
        'Campaign ID': '1001',
        'Ad Group ID': '1101',
        State: 'enabled',
        'Product Targeting Expression': 'asin="B0FREMD001"',
      },
    ]);
  });

  it('überspringt, was die Bulk-Datei laut Doku nicht kennt', () => {
    const { records, skipped } = build([
      {
        ref: 'asin',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
      {
        ref: 'arch',
        type: 'archive',
        entity: 'campaignNegativeProductTarget',
        amazonCampaignId: '1001',
        amazonId: '5004',
      },
    ]);

    expect(records).toEqual([]);
    expect(skipped).toEqual([
      { ref: 'asin', reason: 'notSupportedInBulkFile' },
      { ref: 'arch', reason: 'notSupportedInBulkFile' },
    ]);
  });

  it.each<[string, BulkFileChange]>([
    [
      'ID nicht nur Ziffern',
      {
        ref: 'x',
        type: 'adGroup',
        amazonCampaignId: 'C1',
        amazonAdGroupId: '1101',
        state: 'PAUSED',
      },
    ],
    [
      'Betrag mit Exponent',
      {
        ref: 'x',
        type: 'keyword',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        amazonTargetId: '2001',
        bid: '1e3',
      },
    ],
    [
      'Betrag 0',
      {
        ref: 'x',
        type: 'keyword',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        amazonTargetId: '2001',
        bid: '0.00',
      },
    ],
    [
      'drei Nachkommastellen',
      {
        ref: 'x',
        type: 'adGroup',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        defaultBid: '0.755',
      },
    ],
    [
      'unbekannte Platzierung',
      {
        ref: 'x',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'NONE',
        placement: 'PLACEMENT_SOMEWHERE',
        percentage: '10',
      },
    ],
    [
      'Prozentsatz über 900',
      {
        ref: 'x',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'NONE',
        placement: 'PLACEMENT_TOP',
        percentage: '901',
      },
    ],
    [
      'Prozentsatz mit führender Null',
      {
        ref: 'x',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'NONE',
        placement: 'PLACEMENT_TOP',
        percentage: '050',
      },
    ],
    [
      'Strategie regelbasiert',
      {
        ref: 'x',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'RULE_BASED',
        placement: 'PLACEMENT_TOP',
        percentage: '10',
      },
    ],
    [
      'Strategie unbekannt',
      {
        ref: 'x',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: null,
        placement: 'PLACEMENT_TOP',
        percentage: '10',
      },
    ],
    [
      'ASIN zu kurz',
      {
        ref: 'x',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        negative: { type: 'product', asin: 'B0KURZ' },
      },
    ],
    [
      'leeres Keyword',
      {
        ref: 'x',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: '   ', matchType: 'EXACT' },
      },
    ],
    [
      'Keyword mit Zeilenumbruch',
      {
        ref: 'x',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: 'foo\nbar', matchType: 'EXACT' },
      },
    ],
  ])('überspringt als ungültig: %s', (_name, change) => {
    const { records, skipped } = build([change]);

    expect(records).toEqual([]);
    expect(skipped).toEqual([{ ref: 'x', reason: 'invalidValue' }]);
  });

  it('überspringt Änderungen ohne Feld und nimmt den höchsten Prozentsatz an', () => {
    const { records, skipped } = build([
      { ref: 'empty', type: 'adGroup', amazonCampaignId: '1001', amazonAdGroupId: '1101' },
      {
        ref: 'max',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'NONE',
        placement: 'PLACEMENT_TOP',
        percentage: '900',
      },
    ]);

    expect(skipped).toEqual([{ ref: 'empty', reason: 'nothingToChange' }]);
    expect(records).toHaveLength(1);
  });

  it('schreibt den Keyword-Text ohne Ränder', () => {
    const { records } = build([
      {
        ref: 'a',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: '  kinder lampe ', matchType: 'EXACT' },
      },
    ]);

    expect(records[0]!['Keyword Text']).toBe('kinder lampe');
  });

  it('entschärft nichts am Keyword-Text: Die Zelle ist Text, keine Formel', () => {
    const { records } = build([
      {
        ref: 'a',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: '=cmd|x', matchType: 'EXACT' },
      },
    ]);

    expect(records[0]!['Keyword Text']).toBe('=cmd|x');
  });
});
