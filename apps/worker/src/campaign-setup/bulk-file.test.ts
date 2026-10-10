import type { CampaignSetupItemRow } from '@profitbash/db';
import { openXlsx } from '@profitbash/sheets';
import { describe, expect, it } from 'vitest';
import { buildSetupBulkFile } from './bulk-file';

/** Bulk-Datei einer Setup-Übermittlung (`phase-4.md` 4.4): je Anlage eine `Create`-Zeile mit Text-IDs. */

const NAME = 'SP | EXACT | Flaschen';
let position = 0;
const item = (
  payload: CampaignSetupItemRow['payload'],
  overrides: Partial<CampaignSetupItemRow> = {},
): CampaignSetupItemRow => ({
  id: `item-${position}`,
  submissionId: 'sub',
  position: position++,
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

const campaign = (
  overrides: Partial<Extract<CampaignSetupItemRow['payload'], { entity: 'campaign' }>> = {},
) =>
  item({
    entity: 'campaign',
    adProduct: 'SP',
    name: NAME,
    targetingType: 'manual',
    state: 'ENABLED',
    dailyBudget: '25.00',
    currencyCode: 'EUR',
    biddingStrategy: 'SALES_DOWN_ONLY',
    offAmazon: false,
    ...overrides,
  });

function read(content: Uint8Array) {
  const workbook = openXlsx(content);
  const rows: string[][] = [];
  workbook.forEachRow('Sponsored Products Campaigns', (cells) => rows.push(cells));
  const [header, ...data] = rows;
  return {
    sheets: workbook.sheets.map((sheet) => sheet.name),
    rows: data.map((cells) =>
      Object.fromEntries(
        header!.flatMap((column, index) => (cells[index] ? [[column, cells[index]]] : [])),
      ),
    ),
  };
}

describe('buildSetupBulkFile', () => {
  it('schreibt eine Zeile je Anlage mit Startdatum und Text-IDs', () => {
    const items = [
      campaign(),
      item({ entity: 'placement', placement: 'PLACEMENT_TOP', percentage: 20 }),
      item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' }),
      item({ entity: 'product_ad', asin: 'B0TEST0001', sku: 'SKU-1' }),
      item({ entity: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '0.90' }),
      item({
        entity: 'product_target',
        expression: { type: 'category', value: '12345' },
        bid: '0.40',
      }),
      item({ entity: 'negative_keyword', text: 'glas', matchType: 'negativePhrase' }),
      item({ entity: 'negative_product_target', asin: 'B0FREMD002' }),
    ];
    const file = buildSetupBulkFile(items, {
      countryCode: 'DE',
      accountType: 'seller',
      startDate: '2026-10-09',
    });
    expect(file.skipped).toEqual([]);
    expect(file.rows).toBe(8);
    const { sheets, rows } = read(file.content!);
    expect(sheets).toEqual(['Sponsored Products Campaigns']);
    expect(rows.map((row) => row.Entity)).toEqual([
      'Campaign',
      'Bidding Adjustment',
      'Ad Group',
      'Product Ad',
      'Keyword',
      'Product Targeting',
      'Negative Keyword',
      'Negative Product Targeting',
    ]);
    expect(rows[0]).toMatchObject({
      Operation: 'Create',
      'Campaign ID': NAME,
      'Campaign Name': NAME,
      'Start Date': '20261009',
      'Targeting Type': 'Manual',
      State: 'enabled',
      'Daily Budget': '25.00',
    });
    expect(rows[0]).not.toHaveProperty('Off-Amazon ad serving');
    expect(rows[3]).toMatchObject({ SKU: 'SKU-1', 'Ad Group ID': NAME });
    expect(rows[3]).not.toHaveProperty('ASIN');
  });

  it('schreibt bei Vendoren die ASIN der Anzeige', () => {
    const file = buildSetupBulkFile(
      [
        campaign(),
        item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' }),
        item({ entity: 'product_ad', asin: 'B0TEST0001', sku: null }),
      ],
      { countryCode: 'DE', accountType: 'vendor', startDate: '2026-10-09' },
    );
    expect(read(file.content!).rows[2]).toMatchObject({ ASIN: 'B0TEST0001' });
  });

  it('sperrt Off-Amazon in den USA, wenn es nicht freigeschaltet ist (F-S7)', () => {
    const blocked = buildSetupBulkFile([campaign()], {
      countryCode: 'US',
      accountType: 'seller',
      startDate: '2026-10-09',
    });
    expect(read(blocked.content!).rows[0]).toMatchObject({
      'Off-Amazon ad serving': 'Limit off-Amazon spend',
    });
    const unlocked = buildSetupBulkFile([campaign({ offAmazon: true })], {
      countryCode: 'US',
      accountType: 'seller',
      startDate: '2026-10-09',
    });
    expect(read(unlocked.content!).rows[0]).toMatchObject({
      'Off-Amazon ad serving': 'Increase reach',
    });
  });

  it('lässt Kinder weg, deren Kampagne bzw. Ad Group nicht in die Datei kommt', () => {
    const bad = campaign({ dailyBudget: '0' });
    const okCampaign = item(
      {
        entity: 'campaign',
        adProduct: 'SP',
        name: 'Zweite',
        targetingType: 'auto',
        state: 'PAUSED',
        dailyBudget: '10.00',
        currencyCode: 'EUR',
        biddingStrategy: 'NONE',
        offAmazon: false,
      },
      { campaignRef: 'Zweite' },
    );
    const badAdGroup = item(
      { entity: 'ad_group', name: 'Zweite', defaultBid: '0' },
      { campaignRef: 'Zweite', adGroupRef: 'Zweite' },
    );
    const items = [
      bad,
      item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' }),
      okCampaign,
      badAdGroup,
      item(
        { entity: 'product_ad', asin: 'B0TEST0001', sku: 'SKU-1' },
        { campaignRef: 'Zweite', adGroupRef: 'Zweite' },
      ),
    ];
    const file = buildSetupBulkFile(items, {
      countryCode: 'DE',
      accountType: 'seller',
      startDate: '2026-10-09',
    });
    expect(file.skipped.map(({ itemId, code }) => [itemId, code])).toEqual([
      [items[0]!.id, 'BULK_FILE_INVALID_VALUE'],
      [items[1]!.id, 'PARENT_NOT_CREATED'],
      [items[3]!.id, 'BULK_FILE_INVALID_VALUE'],
      [items[4]!.id, 'PARENT_NOT_CREATED'],
    ]);
    expect(read(file.content!).rows.map((row) => row['Campaign ID'])).toEqual(['Zweite']);
  });

  it('schreibt nach einer teilweisen Bestätigung nur Offenes, mit den echten IDs der Eltern', () => {
    const items = [
      campaign(),
      item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' }),
      item({ entity: 'keyword', text: 'flasche', matchType: 'exact', bid: '0.90' }),
      item({ entity: 'keyword', text: 'becher', matchType: 'exact', bid: '0.90' }),
    ];
    items[0]!.status = 'applied';
    items[0]!.amazonEntityId = '4401';
    items[1]!.status = 'applied';
    items[1]!.amazonEntityId = '5501';
    items[2]!.status = 'applied';
    items[2]!.amazonEntityId = '7701';
    const file = buildSetupBulkFile(items, {
      countryCode: 'DE',
      accountType: 'seller',
      startDate: '2026-10-09',
    });
    expect(file.skipped).toEqual([]);
    expect(read(file.content!).rows).toEqual([
      expect.objectContaining({
        Entity: 'Keyword',
        'Campaign ID': '4401',
        'Ad Group ID': '5501',
        'Keyword Text': 'becher',
      }),
    ]);
  });

  it('wartet mit Kindern, deren Eltern angelegt, aber noch nicht zugeordnet sind', () => {
    const items = [
      campaign(),
      item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' }),
      item({ entity: 'keyword', text: 'becher', matchType: 'exact', bid: '0.90' }),
    ];
    items[0]!.status = 'applied';
    items[1]!.status = 'applied';
    const file = buildSetupBulkFile(items, {
      countryCode: 'DE',
      accountType: 'seller',
      startDate: '2026-10-09',
    });
    // Nicht scheitern lassen: Der nächste Import trägt die IDs nach, dann geht es weiter.
    expect(file).toMatchObject({ content: null, rows: 0, skipped: [], waiting: [items[2]!.id] });
  });

  it('nimmt nur offene Zeilen; Kinder gescheiterter Kampagnen fallen weg', () => {
    const failed = campaign({ adProduct: 'SD' });
    failed.status = 'failed';
    const file = buildSetupBulkFile(
      [failed, item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' })],
      { countryCode: 'DE', accountType: 'seller', startDate: '2026-10-09' },
    );
    expect(file).toMatchObject({ content: null, rows: 0 });
    expect(file.skipped.map((skip) => skip.code)).toEqual(['PARENT_NOT_CREATED']);
  });

  it('negiert in der Quelle mit den echten IDs der bestehenden Kampagne (4.6)', () => {
    const source = (
      negative: Extract<CampaignSetupItemRow['payload'], { entity: 'source_negative' }>['negative'],
    ) =>
      item(
        {
          entity: 'source_negative',
          amazonCampaignId: '111',
          amazonAdGroupId: '222',
          negative,
          harvestMarkId: '00000000-0000-4000-8000-000000000001',
        },
        { campaignRef: 'SP | AUTO | Flaschen', adGroupRef: 'Auto' },
      );
    const applied = { status: 'applied', amazonEntityId: '9' } as const;
    const file = buildSetupBulkFile(
      [
        item(
          { entity: 'keyword', text: 'trinkflasche 1l', matchType: 'exact', bid: '0.9' },
          applied,
        ),
        item(
          {
            entity: 'product_target',
            expression: { type: 'asin', value: 'B0FREMD001' },
            bid: '0.5',
          },
          applied,
        ),
        source({ type: 'keyword', text: 'trinkflasche 1l', matchType: 'negativeExact' }),
        source({ type: 'product', asin: 'B0FREMD001', matchType: 'negativeExact' }),
      ],
      { countryCode: 'DE', accountType: 'seller', startDate: '2026-10-09' },
    );
    expect(file.skipped).toEqual([]);
    const { rows } = read(file.content!);
    expect(rows[0]).toMatchObject({
      Entity: 'Negative Keyword',
      Operation: 'Create',
      'Campaign ID': '111',
      'Ad Group ID': '222',
      'Keyword Text': 'trinkflasche 1l',
      'Match Type': 'negativeExact',
    });
    expect(rows[1]).toMatchObject({
      Entity: 'Negative Product Targeting',
      'Campaign ID': '111',
      'Ad Group ID': '222',
    });
  });

  it('schreibt das Negativ in der Quelle nur mit dem neuen Ziel des Begriffs', () => {
    const negative = (text: string) =>
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
    const covered = negative('trinkflasche');
    const orphan = negative('becher');
    const file = buildSetupBulkFile(
      [
        campaign(),
        item({ entity: 'ad_group', name: NAME, defaultBid: '0.85' }),
        item({ entity: 'keyword', text: 'Trinkflasche', matchType: 'exact', bid: '0.90' }),
        item(
          { entity: 'keyword', text: 'becher', matchType: 'exact', bid: '0.90' },
          { status: 'failed' },
        ),
        covered,
        orphan,
      ],
      { countryCode: 'DE', accountType: 'seller', startDate: '2026-10-09' },
    );
    expect(file.skipped).toEqual([
      expect.objectContaining({ itemId: orphan.id, code: 'HARVEST_TARGET_NOT_CREATED' }),
    ]);
    expect(read(file.content!).rows.map((row) => row['Keyword Text'])).toContain('trinkflasche');
  });

  it('schreibt neue Portfolios ins Blatt „Portfolios“ und das Portfolio an neue Kampagnen (4.7)', () => {
    const portfolioRow = item(
      {
        entity: 'portfolio',
        name: 'Garten',
        budget: {
          amount: '500.00',
          currencyCode: 'EUR',
          policy: 'monthlyRecurring',
          startDate: '2026-11-01',
          endDate: null,
        },
      },
      { campaignRef: 'Garten', adGroupRef: null },
    );
    const file = buildSetupBulkFile([portfolioRow], {
      countryCode: 'DE',
      accountType: 'seller',
      startDate: '2026-10-10',
    });
    expect(file.rows).toBe(1);
    const workbook = openXlsx(file.content!);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Portfolios']);
    const rows: string[][] = [];
    workbook.forEachRow('Portfolios', (cells) => rows.push(cells));
    expect(rows[1]).toEqual(
      expect.arrayContaining(['Portfolios', 'Portfolio', 'Create', 'Garten', 'monthlyRecurring']),
    );

    const withPortfolio = buildSetupBulkFile([campaign({ amazonPortfolioId: '7001' })], {
      countryCode: 'DE',
      accountType: 'seller',
      startDate: '2026-10-10',
    });
    expect(read(withPortfolio.content!).rows[0]).toMatchObject({ 'Portfolio ID': '7001' });
  });
});
