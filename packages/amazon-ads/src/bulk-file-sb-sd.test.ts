import { describe, expect, it } from 'vitest';
import {
  buildBulkSheet,
  SB_BULK_COLUMNS,
  SB_MULTI_AD_GROUP_BULK_COLUMNS,
  SD_BULK_COLUMNS,
  type BulkFileChange,
  type BulkFileSheetKind,
} from './bulk-file';

/**
 * Bulk-Datei für Sponsored Brands und Sponsored Display (`phase-3.md` 3.9): eigene Blätter und Spalten je
 * Anzeigentyp, Kopfzeilen wie in einer echten englischen Datei der Werbekonsole.
 */

const campaign = {
  amazonCampaignId: '1001',
  amazonPortfolioId: '9001',
  endDate: '2026-12-31',
  state: 'ENABLED',
};
const ids = { amazonCampaignId: '1001', amazonAdGroupId: '2001' };

/** Zeilen als Objekte je Spaltenname (nur belegte Zellen). */
function build(kind: BulkFileSheetKind, changes: BulkFileChange[]) {
  const result = buildBulkSheet(kind, changes);
  const [header, ...rows] = result.rows;
  return {
    ...result,
    header: header!,
    records: rows.map((row) =>
      Object.fromEntries(
        row.flatMap((cell, index) => (cell === null ? [] : [[header![index] as string, cell]])),
      ),
    ),
  };
}

const skippedReasons = (kind: BulkFileSheetKind, changes: BulkFileChange[]) => {
  const result = build(kind, changes);
  expect(result.records).toEqual([]);
  return result.skipped.map((entry) => entry.reason);
};

describe('Blätter und Kopfzeilen', () => {
  it('nennt je Anzeigentyp das Blatt der Werbekonsole und dessen Spalten', () => {
    expect(build('sb', []).sheetName).toBe('Sponsored Brands Campaigns');
    expect(build('sb', []).header).toEqual([...SB_BULK_COLUMNS]);
    expect(build('sbMultiAdGroup', []).sheetName).toBe('SB Multi Ad Group Campaigns');
    expect(build('sbMultiAdGroup', []).header).toEqual([...SB_MULTI_AD_GROUP_BULK_COLUMNS]);
    expect(build('sd', []).sheetName).toBe('Sponsored Display Campaigns');
    // Die Spalte „ASIN“ gibt es nur für Anlagen von Vendoren (4.9).
    expect(build('sd', []).header).toEqual(SD_BULK_COLUMNS.filter((column) => column !== 'ASIN'));
  });

  it('führt die Spalten, die die Zeilen brauchen, in der Schreibweise der echten Datei', () => {
    expect(SB_BULK_COLUMNS).toEqual(
      expect.arrayContaining([
        'Campaign ID',
        'Portfolio ID',
        'Ad Group ID',
        'Keyword ID',
        'Product Targeting ID',
        'End Date',
        'State',
        'Budget',
        'Bid',
        'Keyword Text',
        'Match Type',
        'Product Targeting Expression',
      ]),
    );
    expect(SB_MULTI_AD_GROUP_BULK_COLUMNS).toEqual(
      expect.arrayContaining(['Ad Group ID', 'Ad ID', 'Budget', 'Product Targeting Expression']),
    );
    expect(SD_BULK_COLUMNS).toEqual(
      expect.arrayContaining([
        'Ad ID',
        'Targeting ID',
        'Budget',
        'Ad Group Default Bid',
        'Targeting Expression',
      ]),
    );
    // Sponsored Display kennt weder Keywords noch die Spalten der Produkt-Targets von SP und SB.
    expect(SD_BULK_COLUMNS).not.toContain('Keyword ID');
    expect(SD_BULK_COLUMNS).not.toContain('Product Targeting ID');
  });
});

describe('Sponsored Brands, älteres Blatt', () => {
  it('schreibt die Kampagnenzeile mit Portfolio und Enddatum, das Budget in die Spalte „Budget“', () => {
    const { records, skipped } = build('sb', [
      { ref: 'c', type: 'campaign', campaign, set: { state: 'PAUSED', dailyBudget: '150.00' } },
    ]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Brands',
        Entity: 'Campaign',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Portfolio ID': '9001',
        'End Date': '20261231',
        State: 'paused',
        Budget: { number: '150.00' },
      },
    ]);
  });

  it('ändert Keywords und Produkt-Targets, auch ohne Ad Group', () => {
    const { records, skipped } = build('sb', [
      {
        ref: 'k',
        type: 'keyword',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        amazonTargetId: '3001',
        bid: '1.25',
      },
      { ref: 't', type: 'productTarget', ...ids, amazonTargetId: '3002', state: 'PAUSED' },
    ]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Brands',
        Entity: 'Keyword',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Keyword ID': '3001',
        Bid: { number: '1.25' },
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Product Targeting',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        'Product Targeting ID': '3002',
        State: 'paused',
      },
    ]);
  });

  it('legt Negatives an der Kampagne an und archiviert sie (das Blatt hat keine Ad-Group-Zeilen)', () => {
    const { records, skipped } = build('sb', [
      {
        ref: 'nk',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: ' gratis ', matchType: 'PHRASE' },
      },
      {
        ref: 'np',
        type: 'createNegative',
        ...ids,
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
      {
        ref: 'ak',
        type: 'archive',
        entity: 'campaignNegativeKeyword',
        amazonCampaignId: '1001',
        amazonId: '4001',
      },
      {
        ref: 'ap',
        type: 'archive',
        entity: 'campaignNegativeProductTarget',
        amazonCampaignId: '1001',
        amazonId: '4002',
      },
      { ref: 'c', type: 'archive', entity: 'campaign', amazonCampaignId: '1002' },
    ]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Brands',
        Entity: 'Negative Keyword',
        Operation: 'Create',
        'Campaign ID': '1001',
        State: 'enabled',
        'Keyword Text': 'gratis',
        'Match Type': 'negativePhrase',
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Negative Product Targeting',
        Operation: 'Create',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        State: 'enabled',
        'Product Targeting Expression': 'asin="B0FREMD001"',
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Negative Keyword',
        Operation: 'Archive',
        'Campaign ID': '1001',
        'Keyword ID': '4001',
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Negative Product Targeting',
        Operation: 'Archive',
        'Campaign ID': '1001',
        'Product Targeting ID': '4002',
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Campaign',
        Operation: 'Archive',
        'Campaign ID': '1002',
      },
    ]);
  });

  it('überspringt, was das Blatt nicht kennt: Ad Groups, Anzeigen, Gebotsstrategie, Platzierungen', () => {
    expect(
      skippedReasons('sb', [
        { ref: 'g', type: 'adGroup', ...ids, state: 'PAUSED' },
        { ref: 'ga', type: 'archive', entity: 'adGroup', ...ids, amazonAdGroupId: '2009' },
        { ref: 'a', type: 'productAd', ...ids, amazonAdId: '5001', state: 'PAUSED' },
        { ref: 'aa', type: 'archive', entity: 'productAd', ...ids, amazonId: '5001' },
        { ref: 's', type: 'campaign', campaign, set: { biddingStrategy: 'NONE' } },
        {
          ref: 'p',
          type: 'placement',
          amazonCampaignId: '1001',
          biddingStrategy: 'NONE',
          placement: 'PLACEMENT_TOP',
          percentage: '50',
        },
      ]),
    ).toEqual(Array(6).fill('notSupportedInBulkFile'));
  });
});

describe('Sponsored Brands, Blatt mit mehreren Ad Groups', () => {
  it('ändert Kampagne, Ad Group, Keyword und Produkt-Target und archiviert sie', () => {
    const { records, skipped } = build('sbMultiAdGroup', [
      { ref: 'c', type: 'campaign', campaign, set: { dailyBudget: '80' } },
      { ref: 'g', type: 'adGroup', ...ids, state: 'PAUSED' },
      { ref: 'k', type: 'keyword', ...ids, amazonTargetId: '3001', bid: '2.10', state: 'ENABLED' },
      { ref: 't', type: 'archive', entity: 'productTarget', ...ids, amazonId: '3002' },
      { ref: 'ga', type: 'archive', entity: 'adGroup', ...ids, amazonAdGroupId: '2002' },
      {
        ref: 'n',
        type: 'createNegative',
        ...ids,
        negative: { type: 'keyword', keywordText: 'billig', matchType: 'EXACT' },
      },
    ]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Brands',
        Entity: 'Campaign',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Portfolio ID': '9001',
        'End Date': '20261231',
        Budget: { number: '80' },
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Ad Group',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        State: 'paused',
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Keyword',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        'Keyword ID': '3001',
        State: 'enabled',
        Bid: { number: '2.10' },
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Product Targeting',
        Operation: 'Archive',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        'Product Targeting ID': '3002',
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Ad Group',
        Operation: 'Archive',
        'Campaign ID': '1001',
        'Ad Group ID': '2002',
      },
      {
        Product: 'Sponsored Brands',
        Entity: 'Negative Keyword',
        Operation: 'Create',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        State: 'enabled',
        'Keyword Text': 'billig',
        'Match Type': 'negativeExact',
      },
    ]);
  });

  it('überspringt Standardgebot, Anzeigen und Negatives der Kampagne; ohne Ad Group ist ein Target ungültig', () => {
    expect(
      skippedReasons('sbMultiAdGroup', [
        { ref: 'g', type: 'adGroup', ...ids, defaultBid: '0.50' },
        { ref: 'a', type: 'productAd', ...ids, amazonAdId: '5001', state: 'PAUSED' },
        {
          ref: 'n',
          type: 'createNegative',
          amazonCampaignId: '1001',
          amazonAdGroupId: null,
          negative: { type: 'keyword', keywordText: 'billig', matchType: 'EXACT' },
        },
        {
          ref: 'an',
          type: 'archive',
          entity: 'campaignNegativeKeyword',
          amazonCampaignId: '1001',
          amazonId: '4001',
        },
        {
          ref: 'k',
          type: 'keyword',
          amazonCampaignId: '1001',
          amazonAdGroupId: null,
          amazonTargetId: '3001',
          bid: '1',
        },
      ]),
    ).toEqual([
      'notSupportedInBulkFile',
      'notSupportedInBulkFile',
      'notSupportedInBulkFile',
      'notSupportedInBulkFile',
      'invalidValue',
    ]);
  });
});

describe('Sponsored Display', () => {
  it('ändert Kampagne, Ad Group, Product Ad und Targets je Art des Targetings', () => {
    const { records, skipped } = build('sd', [
      { ref: 'c', type: 'campaign', campaign, set: { dailyBudget: '25.50', state: 'ENABLED' } },
      { ref: 'g', type: 'adGroup', ...ids, defaultBid: '0.45', state: 'PAUSED' },
      { ref: 'a', type: 'productAd', ...ids, amazonAdId: '5001', state: 'PAUSED' },
      {
        ref: 't1',
        type: 'productTarget',
        ...ids,
        amazonTargetId: '3001',
        bid: '0.80',
        sdTargeting: 'contextual',
      },
      {
        ref: 't2',
        type: 'productTarget',
        ...ids,
        amazonTargetId: '3002',
        state: 'PAUSED',
        sdTargeting: 'audience',
      },
    ]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Display',
        Entity: 'Campaign',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Portfolio ID': '9001',
        'End Date': '20261231',
        State: 'enabled',
        Budget: { number: '25.50' },
      },
      {
        Product: 'Sponsored Display',
        Entity: 'Ad Group',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        State: 'paused',
        'Ad Group Default Bid': { number: '0.45' },
      },
      {
        Product: 'Sponsored Display',
        Entity: 'Product Ad',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        'Ad ID': '5001',
        State: 'paused',
      },
      {
        Product: 'Sponsored Display',
        Entity: 'Contextual Targeting',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        'Targeting ID': '3001',
        Bid: { number: '0.80' },
      },
      {
        Product: 'Sponsored Display',
        Entity: 'Audience Targeting',
        Operation: 'Update',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        'Targeting ID': '3002',
        State: 'paused',
      },
    ]);
  });

  it('archiviert Entities und legt negative ASINs in der Ad Group an', () => {
    const { records, skipped } = build('sd', [
      {
        ref: 't',
        type: 'archive',
        entity: 'productTarget',
        ...ids,
        amazonId: '3001',
        sdTargeting: 'audience',
      },
      { ref: 'n', type: 'archive', entity: 'negativeProductTarget', ...ids, amazonId: '4001' },
      { ref: 'a', type: 'archive', entity: 'productAd', ...ids, amazonId: '5001' },
      {
        ref: 'c',
        type: 'createNegative',
        ...ids,
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
    ]);

    expect(skipped).toEqual([]);
    expect(records).toEqual([
      {
        Product: 'Sponsored Display',
        Entity: 'Audience Targeting',
        Operation: 'Archive',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        'Targeting ID': '3001',
      },
      {
        Product: 'Sponsored Display',
        Entity: 'Negative Product Targeting',
        Operation: 'Archive',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        'Targeting ID': '4001',
      },
      {
        Product: 'Sponsored Display',
        Entity: 'Product Ad',
        Operation: 'Archive',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        'Ad ID': '5001',
      },
      {
        Product: 'Sponsored Display',
        Entity: 'Negative Product Targeting',
        Operation: 'Create',
        'Campaign ID': '1001',
        'Ad Group ID': '2001',
        State: 'enabled',
        'Targeting Expression': 'asin="B0FREMD001"',
      },
    ]);
  });

  it('überspringt Keywords, negative Keywords, Negatives der Kampagne und Platzierungen', () => {
    expect(
      skippedReasons('sd', [
        { ref: 'k', type: 'keyword', ...ids, amazonTargetId: '3001', bid: '1' },
        { ref: 'ak', type: 'archive', entity: 'negativeKeyword', ...ids, amazonId: '4001' },
        {
          ref: 'nk',
          type: 'createNegative',
          ...ids,
          negative: { type: 'keyword', keywordText: 'billig', matchType: 'EXACT' },
        },
        {
          ref: 'np',
          type: 'createNegative',
          amazonCampaignId: '1001',
          amazonAdGroupId: null,
          negative: { type: 'product', asin: 'B0FREMD001' },
        },
        {
          ref: 'p',
          type: 'placement',
          amazonCampaignId: '1001',
          biddingStrategy: 'NONE',
          placement: 'PLACEMENT_TOP',
          percentage: '50',
        },
      ]),
    ).toEqual(Array(5).fill('notSupportedInBulkFile'));
  });

  it('lehnt ein Target ohne Art des Targetings als ungültig ab', () => {
    expect(
      skippedReasons('sd', [
        { ref: 't', type: 'productTarget', ...ids, amazonTargetId: '3001', bid: '1' },
      ]),
    ).toEqual(['invalidValue']);
  });
});

describe('gemeinsame Regeln aller Blätter', () => {
  it.each(['sb', 'sbMultiAdGroup', 'sd'] as const)(
    '%s: je Entity eine Zeile, Kinder archivierter Kampagnen entfallen, ungültige Werte auch',
    (kind) => {
      const target = {
        type: 'productTarget',
        ...ids,
        sdTargeting: 'contextual',
      } as const;
      const result = build(kind, [
        { ref: 'first', ...target, amazonTargetId: '3001', bid: '1.00' },
        { ref: 'again', ...target, amazonTargetId: '3001', bid: '2.00' },
        { ref: 'zero', ...target, amazonTargetId: '3002', bid: '0.00' },
        { ref: 'badId', ...target, amazonTargetId: 'abc', bid: '1.00' },
        { ref: 'archive', type: 'archive', entity: 'campaign', amazonCampaignId: '7001' },
        {
          ref: 'child',
          ...target,
          amazonCampaignId: '7001',
          amazonTargetId: '3003',
          bid: '1.00',
        },
        {
          ref: 'archived',
          type: 'campaign',
          campaign: { ...campaign, amazonCampaignId: '8001', state: 'ARCHIVED' },
          set: { dailyBudget: '10' },
        },
      ]);

      expect(result.records).toHaveLength(2);
      expect(result.skipped).toEqual([
        { ref: 'again', reason: 'duplicate' },
        { ref: 'zero', reason: 'invalidValue' },
        { ref: 'badId', reason: 'invalidValue' },
        { ref: 'child', reason: 'parentArchived' },
        { ref: 'archived', reason: 'entityArchived' },
      ]);
    },
  );
});
