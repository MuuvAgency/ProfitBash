import {
  buildBulkSheet,
  buildSpBulkSheet,
  type BulkFileChange,
  type BulkFileSheetKind,
} from '@profitbash/amazon-ads';
import { openXlsx, writeXlsx } from '@profitbash/sheets';
import { describe, expect, it } from 'vitest';
import {
  BIDDING_STRATEGIES,
  classifySheet,
  entityKind,
  isSbMultiAdGroupSheet,
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

/**
 * Rundlauf für Sponsored Brands und Sponsored Display (`phase-3.md` 3.9): eine Arbeitsmappe mit den drei Blättern,
 * gelesen mit denselben Abbildungen wie oben.
 */
describe('Bulk-Datei für SB und SD: Rundlauf mit dem Leser des Bulk-Imports', () => {
  const CAMPAIGN = '9007199254740993456';
  const campaign = {
    amazonCampaignId: CAMPAIGN,
    amazonPortfolioId: '9001',
    endDate: '2027-01-31',
    state: 'ENABLED',
  };
  const ids = { amazonCampaignId: CAMPAIGN, amazonAdGroupId: '1201' };
  const bySheet: Record<Exclude<BulkFileSheetKind, 'sp'>, BulkFileChange[]> = {
    sb: [
      { ref: 'c', type: 'campaign', campaign, set: { dailyBudget: '150.00', state: 'PAUSED' } },
      {
        ref: 'k',
        type: 'keyword',
        amazonCampaignId: CAMPAIGN,
        amazonAdGroupId: null,
        amazonTargetId: '2101',
        bid: '1.20',
      },
      {
        ref: 'n',
        type: 'createNegative',
        amazonCampaignId: CAMPAIGN,
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: 'gratis lampe', matchType: 'EXACT' },
      },
      {
        ref: 'a',
        type: 'archive',
        entity: 'campaignNegativeProductTarget',
        amazonCampaignId: CAMPAIGN,
        amazonId: '2102',
      },
    ],
    sbMultiAdGroup: [
      { ref: 'g', type: 'adGroup', ...ids, state: 'PAUSED' },
      { ref: 't', type: 'productTarget', ...ids, amazonTargetId: '2201', bid: '0.95' },
      {
        ref: 'n',
        type: 'createNegative',
        ...ids,
        negative: { type: 'product', asin: 'B0FREMD002' },
      },
    ],
    sd: [
      { ref: 'c', type: 'campaign', campaign, set: { dailyBudget: '20' } },
      { ref: 'g', type: 'adGroup', ...ids, defaultBid: '0.55' },
      { ref: 'p', type: 'productAd', ...ids, amazonAdId: '4101', state: 'PAUSED' },
      {
        ref: 't1',
        type: 'productTarget',
        ...ids,
        amazonTargetId: '2301',
        bid: '0.70',
        sdTargeting: 'contextual',
      },
      {
        ref: 't2',
        type: 'archive',
        entity: 'productTarget',
        ...ids,
        amazonId: '2302',
        sdTargeting: 'audience',
      },
      {
        ref: 'n',
        type: 'createNegative',
        ...ids,
        negative: { type: 'product', asin: 'B0FREMD003' },
      },
    ],
  };

  function readSheets() {
    const built = (['sb', 'sbMultiAdGroup', 'sd'] as const).map((kind) => {
      const sheet = buildBulkSheet(kind, bySheet[kind]);
      expect(sheet.skipped, kind).toEqual([]);
      return { name: sheet.sheetName, rows: sheet.rows };
    });
    const workbook = openXlsx(writeXlsx(built));
    const read = (name: string) => {
      const rows: { cells: string[]; numeric: ReadonlySet<number> }[] = [];
      workbook.forEachRow(name, (cells, _rowNumber, info) =>
        rows.push({ cells, numeric: new Set(info.numericColumns) }),
      );
      const [header, ...data] = rows;
      const columns = mapHeader(header!.cells);
      const cell = (row: number, column: BulkColumn) =>
        data[row]!.cells[columns.get(column)!] ?? '';
      return {
        columns,
        cell,
        isNumeric: (row: number, column: BulkColumn) =>
          data[row]!.numeric.has(columns.get(column)!),
        entity: (row: number) => entityKind(cell(row, 'entity')),
        // Die Spalte „Operation“ liest der Import nicht (heruntergeladene Dateien lassen sie leer).
        operations: data.map((row) => row.cells[header!.cells.indexOf('Operation')] ?? ''),
      };
    };
    const [sb, multi, sd] = built.map((sheet) => read(sheet.name)) as [
      ReturnType<typeof read>,
      ReturnType<typeof read>,
      ReturnType<typeof read>,
    ];
    return { workbook, sb, multi, sd };
  }

  it('erkennt die drei Blätter, das SB-Blatt mit mehreren Ad Groups und die Kopfzeilen', () => {
    const { workbook, sb, multi, sd } = readSheets();

    expect(workbook.sheets.map((sheet) => classifySheet(sheet.name))).toEqual(['sb', 'sb', 'sd']);
    expect(workbook.sheets.map((sheet) => isSbMultiAdGroupSheet(sheet.name))).toEqual([
      false,
      true,
      false,
    ]);
    const common = ['entity', 'campaignId', 'portfolioId', 'adGroupId'] as const;
    const targets = ['keywordId', 'productTargetingId', 'productTargetingExpression'] as const;
    for (const column of [...common, ...targets, 'endDate', 'state', 'budget', 'bid'] as const) {
      expect(sb.columns.has(column), `sb ${column}`).toBe(true);
      expect(multi.columns.has(column), `multi ${column}`).toBe(true);
    }
    for (const column of [
      ...common,
      'adId',
      'targetingId',
      'targetingExpression',
      'endDate',
      'state',
      'budget',
      'adGroupDefaultBid',
      'bid',
    ] as const) {
      expect(sd.columns.has(column), `sd ${column}`).toBe(true);
    }
  });

  it('liest das ältere SB-Blatt zurück: Kampagne, Keyword ohne Ad Group, Negatives', () => {
    const { sb } = readSheets();

    expect(sb.operations).toEqual(['Update', 'Update', 'Create', 'Archive']);
    expect(sb.entity(0)).toBe('campaign');
    expect(parseBulkId(sb.cell(0, 'campaignId'), sb.isNumeric(0, 'campaignId'))).toBe(CAMPAIGN);
    expect(sb.cell(0, 'portfolioId')).toBe('9001');
    expect(parseBulkDate(sb.cell(0, 'endDate'))).toBe('2027-01-31');
    expect(parseBulkAmount(sb.cell(0, 'budget'))).toBe('150');
    expect(sb.isNumeric(0, 'budget')).toBe(true);
    expect(mapValue(STATES, sb.cell(0, 'state'))).toEqual({ value: 'PAUSED', known: true });

    expect(sb.entity(1)).toBe('keyword');
    expect(sb.cell(1, 'adGroupId')).toBe('');
    expect(sb.cell(1, 'keywordId')).toBe('2101');
    expect(sb.cell(1, 'bid')).toBe('1.20');

    expect(sb.entity(2)).toBe('negativeKeyword');
    expect(sb.cell(2, 'keywordText')).toBe('gratis lampe');
    expect(mapValue(MATCH_TYPES, sb.cell(2, 'matchType'))).toEqual({ value: 'EXACT', known: true });

    expect(sb.entity(3)).toBe('negativeProductTargeting');
    expect(sb.cell(3, 'productTargetingId')).toBe('2102');
  });

  it('liest das SB-Blatt mit mehreren Ad Groups zurück', () => {
    const { multi } = readSheets();

    expect(multi.entity(0)).toBe('adGroup');
    expect(multi.cell(0, 'adGroupId')).toBe('1201');
    expect(mapValue(STATES, multi.cell(0, 'state'))).toEqual({ value: 'PAUSED', known: true });
    expect(multi.entity(1)).toBe('productTargeting');
    expect(multi.cell(1, 'productTargetingId')).toBe('2201');
    expect(parseBulkAmount(multi.cell(1, 'bid'))).toBe('0.95');
    expect(multi.entity(2)).toBe('negativeProductTargeting');
    expect(parseTargetExpression(multi.cell(2, 'productTargetingExpression'), '')).toMatchObject({
      targetType: 'product',
      expression: { asin: 'B0FREMD002' },
    });
  });

  it('liest das SD-Blatt zurück: Kampagne, Ad Group, Product Ad, Targets je Art, negative ASIN', () => {
    const { sd } = readSheets();

    expect(sd.operations).toEqual(['Update', 'Update', 'Update', 'Update', 'Archive', 'Create']);
    expect(sd.entity(0)).toBe('campaign');
    expect(parseBulkAmount(sd.cell(0, 'budget'))).toBe('20');
    expect(sd.cell(0, 'portfolioId')).toBe('9001');
    expect(sd.entity(1)).toBe('adGroup');
    expect(parseBulkAmount(sd.cell(1, 'adGroupDefaultBid'))).toBe('0.55');
    expect(sd.entity(2)).toBe('productAd');
    expect(sd.cell(2, 'adId')).toBe('4101');
    expect(sd.entity(3)).toBe('contextualTargeting');
    expect(sd.cell(3, 'targetingId')).toBe('2301');
    expect(sd.cell(3, 'bid')).toBe('0.70');
    expect(sd.entity(4)).toBe('audienceTargeting');
    expect(sd.cell(4, 'targetingId')).toBe('2302');
    expect(sd.entity(5)).toBe('negativeProductTargeting');
    expect(parseTargetExpression(sd.cell(5, 'targetingExpression'), '')).toMatchObject({
      targetType: 'product',
      expression: { asin: 'B0FREMD003' },
    });
  });
});
