import { buildSpBulkSheet, type BulkFileChange } from '@profitbash/amazon-ads';
import { openXlsx, writeXlsx } from '@profitbash/sheets';
import { describe, expect, it } from 'vitest';
import {
  BIDDING_STRATEGIES,
  classifySheet,
  entityKind,
  mapHeader,
  mapValue,
  MATCH_TYPES,
  parseBulkAmount,
  parseBulkDate,
  parseBulkId,
  parseTargetExpression,
  PLACEMENTS,
  STATES,
  type BulkColumn,
} from './bulk-columns';

/**
 * Rundlauf (`phase-3.md` 3.2b): Die erzeugte Bulk-Datei wird mit dem Leser und den Abbildungen des Bulk-Imports
 * (1.11d) gelesen. So bleiben Schreiben und Lesen bei Blattnamen, Kopfzeilen und Werten beieinander.
 */

const changes: BulkFileChange[] = [
  {
    ref: 'campaign',
    type: 'campaign',
    campaign: {
      amazonCampaignId: '9007199254740993123',
      amazonPortfolioId: '9001',
      endDate: '2026-12-31',
      state: 'ENABLED',
    },
    set: { dailyBudget: '35.50', biddingStrategy: 'SALES_UP_AND_DOWN', state: 'PAUSED' },
  },
  {
    ref: 'placement',
    type: 'placement',
    amazonCampaignId: '9007199254740993123',
    biddingStrategy: 'SALES_UP_AND_DOWN',
    placement: 'PLACEMENT_REST_OF_SEARCH',
    percentage: '120',
  },
  {
    ref: 'keyword',
    type: 'keyword',
    amazonCampaignId: '9007199254740993123',
    amazonAdGroupId: '1101',
    amazonTargetId: '2001',
    bid: '0.10',
    state: 'PAUSED',
  },
  {
    ref: 'negative',
    type: 'createNegative',
    amazonCampaignId: '9007199254740993123',
    amazonAdGroupId: '1101',
    negative: { type: 'keyword', keywordText: 'gebraucht lampe', matchType: 'PHRASE' },
  },
  {
    ref: 'campaignNegative',
    type: 'createNegative',
    amazonCampaignId: '9007199254740993123',
    amazonAdGroupId: null,
    negative: { type: 'keyword', keywordText: 'kinder', matchType: 'EXACT' },
  },
  {
    ref: 'adGroup',
    type: 'adGroup',
    amazonCampaignId: '9007199254740993123',
    amazonAdGroupId: '1102',
    defaultBid: '0.45',
  },
  {
    ref: 'productAd',
    type: 'productAd',
    amazonCampaignId: '9007199254740993123',
    amazonAdGroupId: '1101',
    amazonAdId: '4001',
    state: 'PAUSED',
  },
  {
    ref: 'archive',
    type: 'archive',
    entity: 'productTarget',
    amazonCampaignId: '9007199254740993123',
    amazonAdGroupId: '1101',
    amazonId: '3001',
  },
  {
    ref: 'asin',
    type: 'createNegative',
    amazonCampaignId: '9007199254740993123',
    amazonAdGroupId: '1101',
    negative: { type: 'product', asin: 'B0FREMD001' },
  },
];

function readBack() {
  const sheet = buildSpBulkSheet(changes);
  expect(sheet.skipped).toEqual([]);
  const file = writeXlsx([{ name: sheet.sheetName, rows: sheet.rows }]);
  const workbook = openXlsx(file);
  const rows: { cells: string[]; numeric: ReadonlySet<number> }[] = [];
  workbook.forEachRow(sheet.sheetName, (cells, _rowNumber, info) =>
    rows.push({ cells, numeric: new Set(info.numericColumns) }),
  );
  const [header, ...data] = rows;
  const columns = mapHeader(header!.cells);
  const cell = (row: number, column: BulkColumn) => data[row]!.cells[columns.get(column)!] ?? '';
  const isNumeric = (row: number, column: BulkColumn) =>
    data[row]!.numeric.has(columns.get(column)!);
  return {
    workbook,
    columns,
    cell,
    isNumeric,
    entity: (row: number) => entityKind(cell(row, 'entity')),
  };
}

describe('Bulk-Datei: Rundlauf mit dem Leser des Bulk-Imports', () => {
  it('erkennt Blatt und Kopfzeilen', () => {
    const { workbook, columns } = readBack();

    expect(workbook.sheets.map((sheet) => classifySheet(sheet.name))).toEqual(['sp']);
    for (const column of [
      'entity',
      'campaignId',
      'adGroupId',
      'portfolioId',
      'adId',
      'keywordId',
      'productTargetingId',
      'campaignName',
      'startDate',
      'endDate',
      'targetingType',
      'state',
      'dailyBudget',
      'adGroupDefaultBid',
      'bid',
      'keywordText',
      'matchType',
      'biddingStrategy',
      'placement',
      'percentage',
      'productTargetingExpression',
    ] as const) {
      expect(columns.has(column), column).toBe(true);
    }
  });

  it('liest die Kampagnenzeile mit denselben Werten zurück', () => {
    const { cell, isNumeric, entity } = readBack();

    expect(entity(0)).toBe('campaign');
    expect(parseBulkId(cell(0, 'campaignId'), isNumeric(0, 'campaignId'))).toBe(
      '9007199254740993123',
    );
    expect(isNumeric(0, 'campaignId')).toBe(false);
    expect(cell(0, 'portfolioId')).toBe('9001');
    expect(cell(0, 'campaignName')).toBe('');
    expect(parseBulkDate(cell(0, 'endDate'))).toBe('2026-12-31');
    expect(mapValue(STATES, cell(0, 'state'))).toEqual({ value: 'PAUSED', known: true });
    expect(parseBulkAmount(cell(0, 'dailyBudget'))).toBe('35.5');
    expect(isNumeric(0, 'dailyBudget')).toBe(true);
    expect(mapValue(BIDDING_STRATEGIES, cell(0, 'biddingStrategy'))).toEqual({
      value: 'SALES_UP_AND_DOWN',
      known: true,
    });
  });

  it('liest Gebotsanpassung, Keyword und Negatives zurück', () => {
    const { cell, entity } = readBack();

    expect(entity(1)).toBe('biddingAdjustment');
    expect(mapValue(PLACEMENTS, cell(1, 'placement'))).toEqual({
      value: 'PLACEMENT_REST_OF_SEARCH',
      known: true,
    });
    expect(parseBulkAmount(cell(1, 'percentage'))).toBe('120');

    expect(entity(2)).toBe('keyword');
    expect(cell(2, 'keywordId')).toBe('2001');
    expect(cell(2, 'bid')).toBe('0.10');
    expect(mapValue(STATES, cell(2, 'state'))).toEqual({ value: 'PAUSED', known: true });

    expect(entity(3)).toBe('negativeKeyword');
    expect(cell(3, 'keywordText')).toBe('gebraucht lampe');
    expect(mapValue(MATCH_TYPES, cell(3, 'matchType'))).toEqual({ value: 'PHRASE', known: true });

    expect(entity(4)).toBe('campaignNegativeKeyword');
    expect(cell(4, 'adGroupId')).toBe('');
    expect(entity(5)).toBe('adGroup');
    expect(parseBulkAmount(cell(5, 'adGroupDefaultBid'))).toBe('0.45');
    expect(entity(6)).toBe('productAd');
    expect(cell(6, 'adId')).toBe('4001');
    expect(entity(7)).toBe('productTargeting');
    expect(cell(7, 'productTargetingId')).toBe('3001');

    expect(entity(8)).toBe('negativeProductTargeting');
    expect(parseTargetExpression(cell(8, 'productTargetingExpression'), '')).toMatchObject({
      targetType: 'product',
      expression: { asin: 'B0FREMD001' },
    });
  });
});
