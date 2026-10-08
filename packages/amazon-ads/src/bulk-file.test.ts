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
  name: 'SP Lampen',
  startDate: '2026-01-05',
  endDate: '2026-12-31',
  targetingType: 'MANUAL',
  state: 'ENABLED',
  dailyBudget: '20',
  biddingStrategy: 'SALES_DOWN_ONLY',
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
      'Campaign Id',
      'Ad Group Id',
      'Portfolio Id',
      'Ad Id',
      'Keyword Id',
      'Product Targeting Id',
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

  it('schreibt ein Kampagnen-Update mit dem vollständigen Stand, damit Portfolio und Enddatum bleiben', () => {
    const { records, skipped } = build([
      { ref: 'a', type: 'campaign', campaign, set: { dailyBudget: '35.50', state: 'PAUSED' } },
    ]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Products',
        Entity: 'Campaign',
        Operation: 'Update',
        'Campaign Id': '1001',
        'Portfolio Id': '9001',
        'Campaign Name': 'SP Lampen',
        'Start Date': '20260105',
        'End Date': '20261231',
        'Targeting Type': 'Manual',
        State: 'paused',
        'Daily Budget': { number: '35.50' },
        'Bidding Strategy': 'Dynamic bids - down only',
      },
    ]);
  });

  it('lässt Portfolio und Enddatum leer, wenn die Kampagne keines hat, und setzt die neue Strategie', () => {
    const { records } = build([
      {
        ref: 'a',
        type: 'campaign',
        campaign: { ...campaign, amazonPortfolioId: null, endDate: null, targetingType: 'AUTO' },
        set: { biddingStrategy: 'NONE' },
      },
    ]);

    expect(records[0]).toMatchObject({
      'Targeting Type': 'Auto',
      State: 'enabled',
      'Daily Budget': { number: '20' },
      'Bidding Strategy': 'Fixed bid',
    });
    expect(records[0]).not.toHaveProperty('Portfolio Id');
    expect(records[0]).not.toHaveProperty('End Date');
  });

  it('überspringt ein Kampagnen-Update, dessen Stand unvollständig oder nicht abbildbar ist', () => {
    const { records, skipped } = build([
      {
        ref: 'a',
        type: 'campaign',
        campaign: { ...campaign, name: null },
        set: { state: 'PAUSED' },
      },
      {
        ref: 'b',
        type: 'campaign',
        campaign: { ...campaign, biddingStrategy: 'RULE_BASED' },
        set: { state: 'PAUSED' },
      },
      {
        ref: 'c',
        type: 'campaign',
        campaign: { ...campaign, state: 'ARCHIVED' },
        set: { dailyBudget: '5' },
      },
    ]);

    expect(records).toEqual([]);
    expect(skipped).toEqual([
      { ref: 'a', reason: 'campaignIncomplete' },
      { ref: 'b', reason: 'campaignIncomplete' },
      { ref: 'c', reason: 'campaignIncomplete' },
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
        Entity: 'Bidding adjustment',
        Operation: 'Update',
        'Campaign Id': '1001',
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
        Entity: 'Ad group',
        Operation: 'Update',
        'Campaign Id': '1001',
        'Ad Group Id': '1101',
        'Ad Group Default Bid': { number: '0.45' },
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Keyword',
        Operation: 'Update',
        'Campaign Id': '1001',
        'Ad Group Id': '1101',
        'Keyword Id': '2001',
        State: 'paused',
        Bid: { number: '0.10' },
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Product targeting',
        Operation: 'Update',
        'Campaign Id': '1001',
        'Ad Group Id': '1101',
        'Product Targeting Id': '3001',
        State: 'enabled',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Product ad',
        Operation: 'Update',
        'Campaign Id': '1001',
        'Ad Group Id': '1101',
        'Ad Id': '4001',
        State: 'paused',
      },
    ]);
  });

  it('archiviert über die Operation mit den IDs der Entity', () => {
    const ids = { amazonCampaignId: '1001', amazonAdGroupId: '1101' };
    const { records } = build([
      { ref: 'c', type: 'archive', entity: 'campaign', amazonCampaignId: '1001' },
      { ref: 'g', type: 'archive', entity: 'adGroup', ...ids },
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
      ['Ad group', 'Archive'],
      ['Keyword', 'Archive'],
      ['Product targeting', 'Archive'],
      ['Product ad', 'Archive'],
      ['Negative keyword', 'Archive'],
      ['Campaign negative keyword', 'Archive'],
      ['Negative product targeting', 'Archive'],
    ]);
    expect(records[0]).toEqual({
      Product: 'Sponsored Products',
      Entity: 'Campaign',
      Operation: 'Archive',
      'Campaign Id': '1001',
    });
    expect(records[2]).toMatchObject({ 'Ad Group Id': '1101', 'Keyword Id': '2001' });
    expect(records[3]).toMatchObject({ 'Product Targeting Id': '3001' });
    expect(records[4]).toMatchObject({ 'Ad Id': '4001' });
    expect(records[5]).toMatchObject({ 'Keyword Id': '5001' });
    expect(records[6]).toMatchObject({ 'Keyword Id': '5002' });
    expect(records[6]).not.toHaveProperty('Ad Group Id');
    expect(records[7]).toMatchObject({ 'Product Targeting Id': '5003' });
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
        Entity: 'Negative keyword',
        Operation: 'Create',
        'Campaign Id': '1001',
        'Ad Group Id': '1101',
        State: 'enabled',
        'Keyword Text': 'gebraucht lampe',
        'Match Type': 'negativeExact',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Campaign negative keyword',
        Operation: 'Create',
        'Campaign Id': '1001',
        State: 'enabled',
        'Keyword Text': 'kinder',
        'Match Type': 'negativePhrase',
      },
      {
        Product: 'Sponsored Products',
        Entity: 'Negative product targeting',
        Operation: 'Create',
        'Campaign Id': '1001',
        'Ad Group Id': '1101',
        State: 'enabled',
        'Product Targeting Expression': 'asin="B0FREMD001"',
      },
    ]);
  });

  it('überspringt, was die Bulk-Datei laut Doku nicht kennt oder was ungültig ist, und nennt den Grund', () => {
    const { records, skipped } = build([
      {
        ref: 'asin',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
      {
        ref: 'id',
        type: 'adGroup',
        amazonCampaignId: 'C1',
        amazonAdGroupId: '1101',
        state: 'PAUSED',
      },
      {
        ref: 'bid',
        type: 'keyword',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        amazonTargetId: '2001',
        bid: '1e3',
      },
      { ref: 'empty', type: 'adGroup', amazonCampaignId: '1001', amazonAdGroupId: '1101' },
      {
        ref: 'pct',
        type: 'placement',
        amazonCampaignId: '1001',
        biddingStrategy: 'NONE',
        placement: 'PLACEMENT_SOMEWHERE',
        percentage: '10',
      },
      {
        ref: 'ok',
        type: 'adGroup',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        state: 'PAUSED',
      },
    ]);

    expect(skipped).toEqual([
      { ref: 'asin', reason: 'notSupportedInBulkFile' },
      { ref: 'id', reason: 'invalidValue' },
      { ref: 'bid', reason: 'invalidValue' },
      { ref: 'empty', reason: 'nothingToChange' },
      { ref: 'pct', reason: 'invalidValue' },
    ]);
    expect(records).toHaveLength(1);
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
