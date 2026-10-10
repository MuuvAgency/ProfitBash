import {
  createFileImport,
  createFileProfile,
  schema,
  stageAdChanges,
  submitAdChanges,
  upsertAdGroups,
  type Db,
} from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { LogEntry } from '@profitbash/shared';
import { SheetReadError } from '@profitbash/sheets';
import { buildXlsx, type TestCell, type TestSheet } from '@profitbash/sheets/testing';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { FileImportRejectedError, importProfileFiles } from '../jobs/file-import';
import { createJobRunner } from '../run-job';
import { createOrganization } from '../testing';
import { importBulkFile } from './bulk';
import { FILE_IMPORTERS } from './importers';

const {
  adChangeSubmissions,
  adChanges,
  amazonAdsAdGroups,
  amazonAdsBrands,
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsEntityPeriodMetrics,
  amazonAdsNegativeTargets,
  amazonAdsPortfolios,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsSearchTermPeriodMetrics,
  amazonAdsTargets,
  fileImports,
  jobRuns,
  members,
  users,
} = schema;

const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const SD = 'SPONSORED_DISPLAY';
const NOW = new Date('2026-10-05T08:00:00Z');

// Erfundene IDs (15 Stellen wie in echten Dateien).
const P1 = '200000000000001';
const C1 = '300000000000001';
const C2 = '300000000000002';
const AG1 = '400000000000001';
const AG2 = '400000000000002';
const AD1 = '500000000000001';
const KW1 = '600000000000001';
const NK1 = '600000000000002';
const CNK1 = '600000000000003';
const PT1 = '700000000000001';
const PT2 = '700000000000002';
const NPT1 = '700000000000003';
const PT3 = '700000000000004';

let testDb: TestDatabase;
let db: Db;
const ids = { org: '', admin: '', profile: '' };
const logs: LogEntry[] = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  db = testDb.db;
  ids.org = await createOrganization(db, 'muuv');
  const [admin] = await db
    .insert(users)
    .values({ name: 'Ada', email: 'ada@muuv.test' })
    .returning({ id: users.id });
  ids.admin = admin!.id;
  await db
    .insert(members)
    .values({ organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() });
  ids.profile = (
    await createFileProfile(db, {
      userId: ids.admin,
      orgId: ids.org,
      input: {
        accountName: 'Waldkauz DE',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
        accountType: 'seller',
      },
    })
  ).id;
});

afterAll(() => testDb?.close());

beforeEach(async () => {
  for (const table of [
    adChanges,
    adChangeSubmissions,
    amazonAdsEntityPeriodMetrics,
    amazonAdsSearchTermPeriodMetrics,
    amazonAdsProductAds,
    amazonAdsNegativeTargets,
    amazonAdsTargets,
    amazonAdsAdGroups,
    amazonAdsCampaigns,
    amazonAdsPortfolios,
    amazonAdsBrands,
    fileImports,
    jobRuns,
  ]) {
    await db.delete(table);
  }
  logs.length = 0;
});

const run = (
  content: Uint8Array,
  options: {
    complete?: boolean;
    uploadedAt?: Date;
    profileId?: string;
    fileName?: string;
    period?: { startDate: string; endDate: string } | null;
  } = {},
) =>
  importBulkFile({
    db,
    logger: (entry) => logs.push(entry),
    organizationId: ids.org,
    profileId: options.profileId ?? ids.profile,
    fileName: options.fileName ?? 'bulk-test.xlsx',
    period: options.period,
    content,
    now: NOW,
    complete: options.complete ?? false,
    uploadedAt: options.uploadedAt ?? NOW,
  });

/** Blatt aus Kopfzeile und Zeilen als „Spalte → Wert“ (fehlende Spalten bleiben leer). */
function sheet(name: string, header: string[], rows: Array<Record<string, TestCell>>): TestSheet {
  return {
    name,
    rows: [header, ...rows.map((row) => header.map((column) => row[column] ?? null))],
  };
}

// ---------------------------------------------------------------------------
// Deutsche Datei (Kopfzeilen und Werte wie im Befund aus einer echten Datei)
// ---------------------------------------------------------------------------

const DE_SP_HEADER = [
  'Produkt',
  'Entität',
  'Operation',
  'Kampagnen-ID',
  'Anzeigengruppen-ID',
  'Portfolio-ID',
  'Anzeigen-ID',
  'Keyword-ID',
  'Produkt-Targeting-ID',
  'Kampagnenname',
  'Name der Anzeigengruppe',
  'Startdatum',
  'Enddatum',
  'Targeting-Typ',
  'Zustand',
  'Tagesbudget',
  'SKU',
  'ASIN (Nur zu Informationszwecken)',
  'Standardgebot für die Anzeigengruppe',
  'Gebot',
  'Keyword-Text',
  'Übereinstimmungstyp',
  'Gebotsstrategie',
  'Platzierung',
  'Prozentsatz',
  'Ausdruck für Produkt-Targeting',
  'Impressions',
  'Klicks',
  'Ausgaben',
];

const DE_PORTFOLIO_HEADER = [
  'Produkt',
  'Entität',
  'Operation',
  'Portfolio-ID',
  'Portfolioname',
  'Budget-Betrag',
  'Budgetwährungscode',
  'Budget-Linie',
  'Anfangsdatum des Budgets',
  'Budget-Enddatum',
  'Zustand',
];

const sp = (row: Record<string, TestCell>) => ({ Produkt: 'Sponsored Products', ...row });

const DE_SP_ROWS: Array<Record<string, TestCell>> = [
  sp({
    Entität: 'Kampagne',
    'Kampagnen-ID': C1,
    'Portfolio-ID': P1,
    Kampagnenname: 'Waldkauz Laufschuhe Manuell',
    Startdatum: '20260115',
    'Targeting-Typ': 'Manuell',
    Zustand: 'Aktiviert',
    Tagesbudget: 25.000000000000004,
    Gebotsstrategie: 'Dynamische Gebote\u00a0– nur senken',
    Impressions: 1000,
    Klicks: 12,
    Ausgaben: 9.87,
  }),
  sp({
    Entität: 'Gebotsanpassung',
    'Kampagnen-ID': C1,
    Platzierung: 'Top-Platzierung',
    Prozentsatz: 25,
  }),
  sp({
    Entität: 'Gebotsanpassung',
    'Kampagnen-ID': C1,
    Platzierung: 'Platzierung Produktseite',
    Prozentsatz: 10.000000000000002,
  }),
  sp({
    Entität: 'Anzeigengruppe',
    'Kampagnen-ID': C1,
    'Anzeigengruppen-ID': AG1,
    'Name der Anzeigengruppe': 'Laufschuhe Exakt',
    Zustand: 'Aktiviert',
    'Standardgebot für die Anzeigengruppe': 0.7499999999999999,
  }),
  sp({
    Entität: 'Produktanzeige',
    'Kampagnen-ID': C1,
    'Anzeigengruppen-ID': AG1,
    'Anzeigen-ID': AD1,
    SKU: 'WK-LAUF-01',
    'ASIN (Nur zu Informationszwecken)': 'B0WALDKAUZ1',
    Zustand: 'Angehalten',
  }),
  sp({
    Entität: 'Keyword',
    'Kampagnen-ID': C1,
    'Anzeigengruppen-ID': AG1,
    'Keyword-ID': KW1,
    'Keyword-Text': 'waldkauz laufschuhe',
    Übereinstimmungstyp: 'Genau Passend',
    Gebot: 1.2000000000000002,
    Zustand: 'Aktiviert',
  }),
  sp({
    Entität: 'Negatives Keyword',
    'Kampagnen-ID': C1,
    'Anzeigengruppen-ID': AG1,
    'Keyword-ID': NK1,
    'Keyword-Text': 'gratis',
    Übereinstimmungstyp: 'Negativ Genau Passend',
    Zustand: 'Aktiviert',
  }),
  sp({
    Entität: 'Negatives Keyword auf Kampagnenebene',
    'Kampagnen-ID': C1,
    'Keyword-ID': CNK1,
    'Keyword-Text': 'billig',
    Übereinstimmungstyp: 'Negative Wortgruppe',
    Zustand: 'Aktiviert',
  }),
  sp({
    Entität: 'Produkt-Targeting',
    'Kampagnen-ID': C1,
    'Anzeigengruppen-ID': AG1,
    'Produkt-Targeting-ID': PT1,
    'Ausdruck für Produkt-Targeting': 'asin="B0FREMD0001"',
    Gebot: 0.9,
    Zustand: 'Aktiviert',
  }),
  sp({
    Entität: 'Produkt-Targeting',
    'Kampagnen-ID': C1,
    'Anzeigengruppen-ID': AG1,
    'Produkt-Targeting-ID': PT3,
    'Ausdruck für Produkt-Targeting': 'category="123456"',
    Gebot: 0.4,
    Zustand: 'Aktiviert',
  }),
  sp({
    Entität: 'Negatives Produkt-Targeting',
    'Kampagnen-ID': C1,
    'Anzeigengruppen-ID': AG1,
    'Produkt-Targeting-ID': NPT1,
    'Ausdruck für Produkt-Targeting': 'asin="B0FREMD0002"',
    Zustand: 'Aktiviert',
  }),
  sp({
    Entität: 'Kampagne',
    'Kampagnen-ID': C2,
    Kampagnenname: 'Waldkauz Auto',
    Startdatum: '20260201',
    Enddatum: '20261231',
    'Targeting-Typ': 'Automatisch',
    Zustand: 'Angehalten',
    Tagesbudget: 10,
    Gebotsstrategie: 'Feste Gebote',
  }),
  sp({
    Entität: 'Anzeigengruppe',
    'Kampagnen-ID': C2,
    'Anzeigengruppen-ID': AG2,
    'Name der Anzeigengruppe': 'Auto',
    Zustand: 'Aktiviert',
    'Standardgebot für die Anzeigengruppe': 0.5,
  }),
  sp({
    Entität: 'Produkt-Targeting',
    'Kampagnen-ID': C2,
    'Anzeigengruppen-ID': AG2,
    'Produkt-Targeting-ID': PT2,
    'Ausdruck für Produkt-Targeting': 'close-match',
    Gebot: 0.5,
    Zustand: 'Aktiviert',
  }),
];

function germanFile(
  options: { spRows?: Array<Record<string, TestCell>>; portfolioCurrency?: string } = {},
) {
  return buildXlsx([
    sheet('Portfolios', DE_PORTFOLIO_HEADER, [
      {
        Produkt: 'Portfolios',
        Entität: 'Portfolio',
        'Portfolio-ID': P1,
        Portfolioname: 'Marke Waldkauz',
        'Budget-Betrag': 500.00000000000006,
        Budgetwährungscode: options.portfolioCurrency ?? 'EUR',
        'Budget-Linie': 'Keine Obergrenze',
        Zustand: 'Aktiviert',
      },
    ]),
    sheet('Sponsored Products-Kampagnen', DE_SP_HEADER, options.spRows ?? DE_SP_ROWS),
    sheet('Sponsored Brands-Kampagnen', DE_SP_HEADER, []),
    sheet(
      'SP Bericht „Suchbegriff“',
      ['Kampagnen-ID', 'Suchbegriff', 'Klicks'],
      [{ 'Kampagnen-ID': C1, Suchbegriff: 'waldkauz', Klicks: 3 }],
    ),
    { name: 'Config', rows: [['Entity'], ['Campaign']], state: 'veryHidden' },
    { name: 'Sheet8', rows: [['Version (1.0)']] },
  ]);
}

const byAmazonId = async <T extends { amazonId: string }>(rows: Promise<T[]>) =>
  new Map((await rows).map((row) => [row.amazonId, row]));

describe('importBulkFile', () => {
  it('schreibt eine deutsche SP-Datei in der Schreibweise des API-Syncs', async () => {
    const counters = await run(germanFile());
    expect(counters).toEqual({
      portfolios: 1,
      campaigns: 2,
      adGroups: 2,
      targets: 4,
      negatives: 3,
      productAds: 1,
      created: 13,
      updated: 0,
      placeholdersFilled: 0,
      placeholdersCreated: 0,
      invalidRows: 0,
      removed: 0,
    });

    const [portfolio] = await db.select().from(amazonAdsPortfolios);
    expect(portfolio).toMatchObject({
      amazonPortfolioId: P1,
      name: 'Marke Waldkauz',
      state: 'ENABLED',
      budgetAmount: '500',
      budgetCurrencyCode: 'EUR',
      budgetPolicy: 'NO_CAP',
      budgetStartDate: null,
      syncedAt: NOW,
      removedAt: null,
    });

    const campaigns = await byAmazonId(
      db
        .select({ amazonId: amazonAdsCampaigns.amazonCampaignId, row: amazonAdsCampaigns })
        .from(amazonAdsCampaigns),
    );
    expect(campaigns.get(C1)!.row).toMatchObject({
      adProduct: SP,
      portfolioId: portfolio!.id,
      name: 'Waldkauz Laufschuhe Manuell',
      state: 'ENABLED',
      targetingType: 'MANUAL',
      budgetAmount: '25',
      budgetCurrencyCode: 'EUR',
      budgetType: 'DAILY',
      biddingStrategy: 'SALES_DOWN_ONLY',
      startDate: '2026-01-15',
      endDate: null,
      syncedAt: NOW,
      extra: {
        placementBidAdjustments: [
          { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: '10' },
          { placement: 'PLACEMENT_TOP', percentage: '25' },
        ],
      },
    });
    expect(campaigns.get(C2)!.row).toMatchObject({
      portfolioId: null,
      state: 'PAUSED',
      targetingType: 'AUTO',
      biddingStrategy: 'NONE',
      startDate: '2026-02-01',
      endDate: '2026-12-31',
      extra: {},
    });

    const adGroups = await byAmazonId(
      db
        .select({ amazonId: amazonAdsAdGroups.amazonAdGroupId, row: amazonAdsAdGroups })
        .from(amazonAdsAdGroups),
    );
    expect(adGroups.get(AG1)!.row).toMatchObject({
      campaignId: campaigns.get(C1)!.row.id,
      adProduct: SP,
      name: 'Laufschuhe Exakt',
      state: 'ENABLED',
      defaultBid: '0.75',
      defaultBidCurrencyCode: 'EUR',
    });

    const [ad] = await db.select().from(amazonAdsProductAds);
    expect(ad).toMatchObject({
      amazonAdId: AD1,
      campaignId: campaigns.get(C1)!.row.id,
      adGroupId: adGroups.get(AG1)!.row.id,
      asin: 'B0WALDKAUZ1',
      sku: 'WK-LAUF-01',
      state: 'PAUSED',
    });

    const targets = await byAmazonId(
      db
        .select({ amazonId: amazonAdsTargets.amazonTargetId, row: amazonAdsTargets })
        .from(amazonAdsTargets),
    );
    expect(targets.get(KW1)!.row).toMatchObject({
      adGroupId: adGroups.get(AG1)!.row.id,
      targetType: 'keyword',
      keywordText: 'waldkauz laufschuhe',
      matchType: 'EXACT',
      expression: { matchType: 'EXACT', keyword: 'waldkauz laufschuhe' },
      bid: '1.2',
      bidCurrencyCode: 'EUR',
      state: 'ENABLED',
    });
    expect(targets.get(PT1)!.row).toMatchObject({
      targetType: 'product',
      keywordText: null,
      matchType: 'PRODUCT_EXACT',
      expression: { matchType: 'PRODUCT_EXACT', asin: 'B0FREMD0001' },
      bid: '0.9',
    });
    expect(targets.get(PT3)!.row).toMatchObject({
      targetType: 'category',
      expression: { productCategoryId: '123456' },
    });
    expect(targets.get(PT2)!.row).toMatchObject({
      campaignId: campaigns.get(C2)!.row.id,
      targetType: 'auto',
      matchType: 'SEARCH_CLOSE_MATCH',
      expression: { matchType: 'SEARCH_CLOSE_MATCH' },
    });

    const negatives = await byAmazonId(
      db
        .select({
          amazonId: amazonAdsNegativeTargets.amazonTargetId,
          row: amazonAdsNegativeTargets,
        })
        .from(amazonAdsNegativeTargets),
    );
    expect(negatives.get(NK1)!.row).toMatchObject({
      level: 'ad_group',
      adGroupId: adGroups.get(AG1)!.row.id,
      targetType: 'keyword',
      keywordText: 'gratis',
      matchType: 'EXACT',
      expression: { matchType: 'EXACT', keyword: 'gratis' },
    });
    expect(negatives.get(CNK1)!.row).toMatchObject({
      level: 'campaign',
      campaignId: campaigns.get(C1)!.row.id,
      adGroupId: null,
      matchType: 'PHRASE',
    });
    expect(negatives.get(NPT1)!.row).toMatchObject({
      level: 'ad_group',
      targetType: 'product',
      expression: { matchType: 'PRODUCT_EXACT', asin: 'B0FREMD0002' },
    });

    // Zeitraumsummen (Impressions, Klicks, Ausgaben) sind keine Tageswerte.
    expect(await db.select().from(amazonAdsCampaignDailyMetrics)).toEqual([]);
  });

  it('ändert beim zweiten Import derselben Datei nichts', async () => {
    await run(germanFile());
    const campaignsBefore = await db.select().from(amazonAdsCampaigns);
    const counters = await run(germanFile());
    expect(counters).toMatchObject({ created: 0, updated: 0, placeholdersFilled: 0 });
    const campaignsAfter = await db.select().from(amazonAdsCampaigns);
    expect(campaignsAfter.map((c) => c.updatedAt)).toEqual(campaignsBefore.map((c) => c.updatedAt));
  });

  it('bestätigt offene Übermittlungen per Bulk-Datei, deren neuen Wert die Datei jetzt trägt (3.3)', async () => {
    await run(germanFile());
    const [keyword] = await db
      .select({ id: amazonAdsTargets.id })
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.amazonTargetId, KW1));
    const [campaign] = await db
      .select({ id: amazonAdsCampaigns.id })
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.amazonCampaignId, C1));
    const actor = { userId: ids.admin, orgId: ids.org };
    await stageAdChanges(db, {
      ...actor,
      origin: 'explorer',
      changes: [
        {
          operation: 'update',
          entityType: 'target',
          entityId: keyword!.id,
          field: 'bid',
          value: '1.35',
        },
        {
          operation: 'update',
          entityType: 'campaign',
          entityId: campaign!.id,
          field: 'budget',
          value: '30',
        },
      ],
    });
    await submitAdChanges(db, { ...actor, channel: 'bulk_file', enqueue: async () => {} });

    // Nach dem Hochladen in der Werbekonsole trägt die nächste Datei das neue Gebot, das Budget noch nicht.
    const spRows = DE_SP_ROWS.map((row) =>
      row['Keyword-ID'] === KW1 ? { ...row, Gebot: 1.35 } : row,
    );
    const counters = await run(germanFile({ spRows }));

    expect(counters).toMatchObject({ changesConfirmed: 1 });
    const changes = await db
      .select({ field: adChanges.field, status: adChanges.status })
      .from(adChanges)
      .orderBy(asc(adChanges.field));
    expect(changes).toEqual([
      { field: 'bid', status: 'applied' },
      { field: 'budget', status: 'submitted' },
    ]);
    const [submission] = await db.select().from(adChangeSubmissions);
    expect(submission).toMatchObject({ status: 'pending' });
    expect(await run(germanFile({ spRows }))).not.toHaveProperty('changesConfirmed');
  });

  it('liest englische Kopfzeilen und Werte, SB- und SD-Blätter', async () => {
    const SBC = '310000000000001';
    const SBC_LEGACY = '310000000000009';
    const SBAG = '410000000000001';
    const SBKW = '610000000000001';
    const SBNK = '610000000000002';
    const SBPT = '710000000000001';
    const SDC = '320000000000001';
    const SDAG = '420000000000001';
    const SDAD = '520000000000001';
    const SDT1 = '720000000000001';
    const SDT2 = '720000000000002';
    const SDT3 = '720000000000003';
    const SPC = '330000000000001';
    const SPCNK = '630000000000001';
    const spHeader = [
      'Product',
      'Entity',
      'Operation',
      'Campaign Id',
      'Ad Group Id',
      'Portfolio Id',
      'Keyword Id',
      'Campaign Name',
      'Start Date',
      'Targeting Type',
      'State',
      'Daily Budget',
      'Keyword Text',
      'Match Type',
      'Bidding Strategy',
      'Placement',
      'Percentage',
    ];
    const sbHeader = [
      'Product',
      'Entity',
      'Operation',
      'Campaign ID',
      'Portfolio ID',
      'Ad Group ID',
      'Ad ID',
      'Keyword ID',
      'Product Targeting ID',
      'Campaign Name',
      'Ad Group Name',
      'Start Date',
      'End Date',
      'State',
      'Budget Type',
      'Budget',
      'Bid',
      'Keyword Text',
      'Match Type',
      'Product Targeting Expression',
      'Resolved Product Targeting Expression (Informational only)',
      'Cost Type',
    ];
    const sdHeader = [
      'Product',
      'Entity',
      'Operation',
      'Campaign ID',
      'Portfolio ID',
      'Ad Group ID',
      'Ad ID',
      'Targeting ID',
      'Campaign Name',
      'Ad Group Name',
      'Start Date',
      'End Date',
      'State',
      'Tactic',
      'Budget Type',
      'Budget',
      'Cost Type',
      'SKU',
      'ASIN',
      'Ad Group Default Bid',
      'Bid',
      'Targeting Expression',
      'Resolved Targeting Expression (Informational only)',
    ];
    const file = buildXlsx([
      sheet('Sponsored Products Campaigns', spHeader, [
        {
          Entity: 'Campaign',
          'Campaign Id': SPC,
          'Campaign Name': 'Waldkauz EN',
          'Start Date': '20260301',
          'Targeting Type': 'Manual',
          State: 'enabled',
          'Daily Budget': 15.5,
          'Bidding Strategy': 'Dynamic bids - up and down',
        },
        {
          Entity: 'Bidding Adjustment',
          'Campaign Id': SPC,
          'Bidding Strategy': 'Dynamic bids - up and down',
          Placement: 'Placement Top',
          Percentage: 50,
        },
        {
          Entity: 'Campaign Negative Keyword',
          'Campaign Id': SPC,
          'Keyword Id': SPCNK,
          'Keyword Text': 'kostenlos',
          'Match Type': 'negativeExact',
          State: 'enabled',
        },
      ]),
      sheet('SB Multi Ad Group Campaigns', sbHeader, [
        {
          Product: 'Sponsored Brands',
          Entity: 'Campaign',
          'Campaign ID': SBC,
          'Campaign Name': 'Waldkauz Marke',
          'Start Date': '20260401',
          State: 'enabled',
          'Budget Type': 'lifetime',
          Budget: 1500,
          'Cost Type': 'cpc',
        },
        {
          Entity: 'Ad Group',
          'Campaign ID': SBC,
          'Ad Group ID': SBAG,
          'Ad Group Name': 'Marke AG',
          State: 'enabled',
        },
        {
          Entity: 'Keyword',
          'Campaign ID': SBC,
          'Ad Group ID': SBAG,
          'Keyword ID': SBKW,
          'Keyword Text': 'waldkauz',
          'Match Type': 'broad',
          Bid: 1.1,
          State: 'enabled',
        },
        {
          Entity: 'Product Targeting',
          'Campaign ID': SBC,
          'Ad Group ID': SBAG,
          'Product Targeting ID': SBPT,
          'Product Targeting Expression': 'category="12345" brand="678"',
          'Resolved Product Targeting Expression (Informational only)':
            'category="Laufschuhe" brand="Waldkauz"',
          Bid: 0.8,
          State: 'paused',
        },
        {
          Entity: 'Negative Keyword',
          'Campaign ID': SBC,
          'Keyword ID': SBNK,
          'Keyword Text': 'gebraucht',
          'Match Type': 'negativePhrase',
          State: 'enabled',
        },
        {
          Entity: 'Video Ad',
          'Campaign ID': SBC,
          'Ad Group ID': SBAG,
          'Ad ID': '510000000000001',
          State: 'enabled',
        },
        // Unbekannte Entities werden übergangen und geloggt.
        {
          Entity: 'Theme',
          'Campaign ID': SBC,
          'Ad Group ID': SBAG,
          'Keyword ID': '610000000000009',
        },
      ]),
      // Älteres SB-Blatt: Kampagnen ohne eigene Ad-Group-Zeilen.
      sheet('Sponsored Brands Campaigns', sbHeader, [
        {
          Product: 'Sponsored Brands',
          Entity: 'Campaign',
          'Campaign ID': SBC_LEGACY,
          'Campaign Name': 'Waldkauz Marke alt',
          'Start Date': '20260401',
          State: 'enabled',
          'Budget Type': 'daily',
          Budget: 40,
        },
      ]),
      sheet('Sponsored Display Campaigns', sdHeader, [
        {
          Entity: 'Campaign',
          'Campaign ID': SDC,
          'Campaign Name': 'Waldkauz Remarketing',
          'Start Date': '20260501',
          State: 'paused',
          Tactic: 'T00030',
          'Budget Type': 'daily',
          Budget: 20,
          'Cost Type': 'vcpm',
        },
        {
          Entity: 'Ad Group',
          'Campaign ID': SDC,
          'Ad Group ID': SDAG,
          'Ad Group Name': 'Besucher',
          State: 'enabled',
          'Ad Group Default Bid': 0.55,
        },
        // Ohne Kampagnen-ID: Kampagne über die Ad Group derselben Datei.
        {
          Entity: 'Product Ad',
          'Ad Group ID': SDAG,
          'Ad ID': SDAD,
          SKU: 'WK-SD-01',
          State: 'enabled',
        },
        {
          Entity: 'Audience Targeting',
          'Campaign ID': SDC,
          'Ad Group ID': SDAG,
          'Targeting ID': SDT1,
          'Targeting Expression': 'views=(exactProduct lookback=30)',
          Bid: 0.6,
          State: 'enabled',
        },
        {
          Entity: 'Contextual Targeting',
          'Ad Group ID': SDAG,
          'Targeting ID': SDT2,
          'Targeting Expression': 'asin="B0FREMD0003"',
          Bid: 0.45,
          State: 'enabled',
        },
        // Zielgruppe mit einem Ausdruck, den der Leser nicht kennt: Die Entity der Zeile entscheidet.
        {
          Entity: 'Audience Targeting',
          'Campaign ID': SDC,
          'Ad Group ID': SDAG,
          'Targeting ID': SDT3,
          'Targeting Expression': 'neueZielgruppe=(irgendwas)',
          Bid: 0.5,
          State: 'enabled',
        },
      ]),
    ]);

    const counters = await run(file);
    expect(counters).toMatchObject({
      portfolios: 0,
      campaigns: 4,
      adGroups: 2,
      targets: 5,
      negatives: 2,
      // SD-Anzeige und SB-Video (seit 4.10).
      productAds: 2,
      invalidRows: 0,
      removed: 0,
    });

    const campaigns = await byAmazonId(
      db
        .select({ amazonId: amazonAdsCampaigns.amazonCampaignId, row: amazonAdsCampaigns })
        .from(amazonAdsCampaigns),
    );
    expect(campaigns.get(SPC)!.row).toMatchObject({
      adProduct: SP,
      targetingType: 'MANUAL',
      budgetAmount: '15.5',
      budgetType: 'DAILY',
      biddingStrategy: 'SALES_UP_AND_DOWN',
      extra: { placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: '50' }] },
    });
    expect(campaigns.get(SBC)!.row).toMatchObject({
      adProduct: SB,
      targetingType: null,
      budgetAmount: '1500',
      budgetType: 'LIFETIME',
      biddingStrategy: null,
      // Das Blatt der Kampagne braucht die Bulk-Datei für Änderungen (3.9).
      extra: { costType: 'CPC', multiAdGroups: true },
    });
    expect(campaigns.get(SBC_LEGACY)!.row).toMatchObject({
      adProduct: SB,
      extra: { multiAdGroups: false },
    });
    // Nur SB-Kampagnen tragen die Angabe.
    expect(campaigns.get(SDC)!.row.extra).toEqual({ costType: 'VCPM' });
    expect(campaigns.get(SDC)!.row).toMatchObject({
      adProduct: SD,
      state: 'PAUSED',
      targetingType: 'T00030',
      budgetAmount: '20',
      budgetType: 'DAILY',
      extra: { costType: 'VCPM' },
    });

    const targets = await byAmazonId(
      db
        .select({ amazonId: amazonAdsTargets.amazonTargetId, row: amazonAdsTargets })
        .from(amazonAdsTargets),
    );
    expect(targets.get(SBKW)!.row).toMatchObject({
      adProduct: SB,
      targetType: 'keyword',
      matchType: 'BROAD',
      bid: '1.1',
    });
    expect(targets.get(SBPT)!.row).toMatchObject({
      targetType: 'category',
      state: 'PAUSED',
      expression: {
        productCategoryId: '12345',
        productCategoryResolved: 'Laufschuhe',
        productBrand: '678',
        productBrandResolved: 'Waldkauz',
      },
    });
    expect(targets.get(SDT1)!.row).toMatchObject({
      adProduct: SD,
      targetType: 'audience',
      expression: { event: 'VIEWS', lookback: 30 },
      bid: '0.6',
    });
    expect(targets.get(SDT2)!.row).toMatchObject({
      campaignId: campaigns.get(SDC)!.row.id,
      targetType: 'product',
      expression: { matchType: 'PRODUCT_EXACT', asin: 'B0FREMD0003' },
    });
    expect(targets.get(SDT3)!.row).toMatchObject({ adProduct: SD, targetType: 'audience' });

    const negatives = await byAmazonId(
      db
        .select({
          amazonId: amazonAdsNegativeTargets.amazonTargetId,
          row: amazonAdsNegativeTargets,
        })
        .from(amazonAdsNegativeTargets),
    );
    expect(negatives.get(SPCNK)!.row).toMatchObject({ level: 'campaign', matchType: 'EXACT' });
    // SB-Negative ohne Ad Group gilt für die Kampagne.
    expect(negatives.get(SBNK)!.row).toMatchObject({
      level: 'campaign',
      adGroupId: null,
      adProduct: SB,
      matchType: 'PHRASE',
    });

    const [ad] = await db
      .select()
      .from(amazonAdsProductAds)
      .where(eq(amazonAdsProductAds.adProduct, SD));
    expect(ad).toMatchObject({
      amazonAdId: SDAD,
      adProduct: SD,
      campaignId: campaigns.get(SDC)!.row.id,
      sku: 'WK-SD-01',
      asin: null,
    });
    // SB-Anzeigen liest der Import seit 4.10 (eigener Test); Themen bleiben übergangen und geloggt, nicht ungültig.
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.entity_skipped', entity: 'unsupported' }),
    );
  });

  it('liest Marken aus „Brand Assets Data“ und SB-Anzeigen mit Format und Namen (4.10)', async () => {
    const SBC = '310000000000001';
    const SBAG = '410000000000001';
    const header = [
      'Product',
      'Entity',
      'Operation',
      'Campaign ID',
      'Ad Group ID',
      'Ad ID',
      'Campaign Name',
      'Ad Group Name',
      'Ad Name',
      'State',
      'Budget Type',
      'Budget',
      'Creative ASINs',
    ];
    const sb = (row: Record<string, TestCell>) => ({ Product: 'Sponsored Brands', ...row });
    const content = buildXlsx([
      sheet(
        'Brand Assets Data (Read-only)',
        ['Brand Entity ID', 'Brand Name'],
        [
          { 'Brand Entity ID': 'ENTITYWALD', 'Brand Name': 'Waldkauz' },
          { 'Brand Entity ID': 'ENTITYZWEI', 'Brand Name': 'Zweitmarke' },
        ],
      ),
      sheet('SB Multi Ad Group Campaigns', header, [
        sb({
          Entity: 'Campaign',
          'Campaign ID': SBC,
          'Campaign Name': 'SB | HEADER | Flaschen',
          State: 'enabled',
          'Budget Type': 'Daily',
          Budget: 15,
        }),
        sb({
          Entity: 'Ad Group',
          'Campaign ID': SBC,
          'Ad Group ID': SBAG,
          'Ad Group Name': 'SB | HEADER | Flaschen',
          State: 'enabled',
        }),
        sb({
          Entity: 'Manual Collection ad',
          'Campaign ID': SBC,
          'Ad Group ID': SBAG,
          'Ad ID': '510000000000001',
          'Ad Name': 'SB | HEADER | Flaschen',
          State: 'enabled',
          'Creative ASINs': 'B0TEST0001, B0TEST0002, B0TEST0003',
        }),
        sb({
          Entity: 'Video ad',
          'Campaign ID': SBC,
          'Ad Group ID': SBAG,
          'Ad ID': '510000000000002',
          'Ad Name': 'SB | VIDEO',
          State: 'paused',
          'Creative ASINs': 'B0TEST0001',
        }),
      ]),
    ]);
    await run(content);

    const ads = await db
      .select()
      .from(amazonAdsProductAds)
      .orderBy(asc(amazonAdsProductAds.amazonAdId));
    expect(ads.map((ad) => [ad.amazonAdId, ad.adProduct, ad.asin, ad.state, ad.extra])).toEqual([
      [
        '510000000000001',
        SB,
        null,
        'ENABLED',
        {
          adType: 'MANUAL_COLLECTION',
          name: 'SB | HEADER | Flaschen',
          asins: ['B0TEST0001', 'B0TEST0002', 'B0TEST0003'],
        },
      ],
      ['510000000000002', SB, 'B0TEST0001', 'PAUSED', { adType: 'VIDEO', name: 'SB | VIDEO' }],
    ]);
    const brands = await db
      .select({ id: amazonAdsBrands.brandEntityId, name: amazonAdsBrands.name })
      .from(amazonAdsBrands)
      .where(eq(amazonAdsBrands.profileId, ids.profile))
      .orderBy(asc(amazonAdsBrands.brandEntityId));
    expect(brands).toEqual([
      { id: 'ENTITYWALD', name: 'Waldkauz' },
      { id: 'ENTITYZWEI', name: 'Zweitmarke' },
    ]);
  });

  it('löst die Kampagne über eine vorhandene Ad Group auf, sonst zählt die Zeile als ungültig', async () => {
    await upsertAdGroups(db, { organizationId: ids.org, profileId: ids.profile, now: NOW }, [
      {
        amazonAdGroupId: AG2,
        amazonCampaignId: C2,
        adProduct: SD,
        name: 'Vorhanden',
        state: 'ENABLED',
        defaultBid: null,
        defaultBidCurrencyCode: null,
        amazonUpdatedAt: null,
        extra: {},
      },
    ]);
    const file = buildXlsx([
      sheet(
        'Sponsored Display Campaigns',
        ['Entity', 'Campaign ID', 'Ad Group ID', 'Targeting ID', 'State', 'Targeting Expression'],
        [
          {
            Entity: 'Contextual Targeting',
            'Ad Group ID': AG2,
            'Targeting ID': PT1,
            State: 'enabled',
            'Targeting Expression': 'asin="B0FREMD0004"',
          },
          {
            Entity: 'Contextual Targeting',
            'Ad Group ID': '499999999999999',
            'Targeting ID': PT2,
            State: 'enabled',
            'Targeting Expression': 'asin="B0FREMD0005"',
          },
        ],
      ),
    ]);
    const counters = await run(file);
    expect(counters).toMatchObject({ targets: 1, invalidRows: 1 });
    const [target] = await db.select().from(amazonAdsTargets);
    const [campaign] = await db
      .select()
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.amazonCampaignId, C2));
    expect(target).toMatchObject({ amazonTargetId: PT1, campaignId: campaign!.id });
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: 'bulk_import.invalid_row',
        sheet: 'Sponsored Display Campaigns',
        row: 3,
        column: 'Kampagnen-ID',
      }),
    );
  });

  it('überspringt ungültige Zeilen, zählt sie und loggt keine Zellinhalte', async () => {
    const rows = [
      DE_SP_ROWS[0]!,
      // ID als Zahlzelle (könnte Stellen verloren haben).
      sp({
        Entität: 'Anzeigengruppe',
        'Kampagnen-ID': C1,
        'Anzeigengruppen-ID': 4000000000000009,
        'Name der Anzeigengruppe': 'Geheim Gruppe',
        Zustand: 'Aktiviert',
      }),
      sp({ ...DE_SP_ROWS[3]! }),
      // Betrag nicht lesbar.
      sp({ ...DE_SP_ROWS[5]!, Gebot: 'viel' }),
      // Pflicht-ID fehlt.
      sp({ ...DE_SP_ROWS[5]!, 'Keyword-ID': null, 'Keyword-Text': 'geheimes keyword' }),
      // Tag nicht lesbar.
      sp({ ...DE_SP_ROWS[11]!, Startdatum: '2026-02-01' }),
    ];
    const counters = await run(germanFile({ spRows: rows }));
    expect(counters).toMatchObject({ campaigns: 1, adGroups: 1, targets: 0, invalidRows: 4 });
    const invalid = logs.filter((entry) => entry.msg === 'bulk_import.invalid_row');
    expect(invalid).toEqual([
      expect.objectContaining({ row: 3, column: 'Anzeigengruppen-ID' }),
      expect.objectContaining({ row: 5, column: 'Gebot' }),
      expect.objectContaining({ row: 6, column: 'Keyword-ID' }),
      expect.objectContaining({ row: 7, column: 'Startdatum' }),
    ]);
    const logged = JSON.stringify(logs);
    for (const secret of [
      'viel',
      'geheim',
      'Geheim',
      '4000000000000009',
      'Waldkauz',
      '2026-02-01',
    ]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('übergeht Gebotsanpassungen ohne Prozentsatz still und verlangt Ad Groups außerhalb von SB', async () => {
    const rows = [
      DE_SP_ROWS[0]!,
      DE_SP_ROWS[1]!,
      sp({
        Entität: 'Gebotsanpassung',
        'Kampagnen-ID': C1,
        Platzierung: 'Platzierung Rest der Suche',
      }),
      DE_SP_ROWS[3]!,
      // SP-Keyword ohne Ad Group: nicht still zum Kampagnen-Target machen.
      sp({ ...DE_SP_ROWS[5]!, 'Anzeigengruppen-ID': null }),
    ];
    const counters = await run(germanFile({ spRows: rows }));
    expect(counters).toMatchObject({ campaigns: 1, targets: 0, invalidRows: 1 });
    const [campaign] = await db.select().from(amazonAdsCampaigns);
    expect(campaign!.extra).toEqual({
      placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: '25' }],
    });
    expect(logs.filter((entry) => entry.msg === 'bulk_import.invalid_row')).toEqual([
      expect.objectContaining({ row: 6, column: 'Anzeigengruppen-ID' }),
    ]);
  });

  it('reicht unbekannte Werte unverändert durch und loggt sie einmal ohne Inhalt', async () => {
    const rows = [
      { ...DE_SP_ROWS[0]!, Zustand: 'Entwurf' },
      { ...DE_SP_ROWS[11]!, Zustand: 'Entwurf' },
      { ...DE_SP_ROWS[13]!, 'Ausdruck für Produkt-Targeting': 'neu="x"' },
      DE_SP_ROWS[12]!,
    ];
    const counters = await run(germanFile({ spRows: rows }));
    expect(counters).toMatchObject({ campaigns: 2, targets: 1, invalidRows: 0 });
    const campaigns = await db.select().from(amazonAdsCampaigns);
    expect(campaigns.map((c) => c.state)).toEqual(['Entwurf', 'Entwurf']);
    const [target] = await db.select().from(amazonAdsTargets);
    expect(target).toMatchObject({
      targetType: 'product',
      expression: { bulkExpression: 'neu="x"' },
    });
    const unknown = logs.filter((entry) => entry.msg === 'bulk_import.unknown_value');
    expect(unknown).toEqual([
      expect.objectContaining({ field: 'state', sheet: 'Sponsored Products-Kampagnen', row: 2 }),
      expect.objectContaining({ field: 'productTargetingExpression', row: 4 }),
    ]);
    expect(JSON.stringify(logs)).not.toContain('Entwurf');
  });

  it('lehnt Dateien ohne Kampagnen-Blatt ab', async () => {
    const file = buildXlsx([
      sheet('Portfolios', DE_PORTFOLIO_HEADER, []),
      sheet('SP Bericht „Suchbegriff“', ['Kampagnen-ID'], [{ 'Kampagnen-ID': C1 }]),
    ]);
    await expect(run(file)).rejects.toThrow(FileImportRejectedError);
    await expect(run(file)).rejects.toThrow(/keine Bulk-Datei/);
  });

  it('lehnt eine Datei mit fremder Portfolio-Währung ab, ohne etwas zu schreiben', async () => {
    await expect(run(germanFile({ portfolioCurrency: 'USD' }))).rejects.toThrow(
      /Währung.*USD.*EUR|anderes Profil/,
    );
    expect(await db.select().from(amazonAdsCampaigns)).toEqual([]);
  });

  it('lehnt eine Datei ab, deren Entity-Zeilen alle ungültig sind', async () => {
    const rows = [
      { ...DE_SP_ROWS[0]!, Tagesbudget: 'viel' },
      { ...DE_SP_ROWS[11]!, 'Kampagnen-ID': 3000000000000002 },
    ];
    const file = buildXlsx([sheet('Sponsored Products-Kampagnen', DE_SP_HEADER, rows)]);
    await expect(run(file)).rejects.toThrow(/2 ungültig/);
    expect(await db.select().from(amazonAdsCampaigns)).toEqual([]);
  });

  it('lehnt ein Kampagnen-Blatt ohne Pflichtspalte ab und nennt sie', async () => {
    const header = DE_SP_HEADER.filter((column) => column !== 'Kampagnen-ID');
    const file = buildXlsx([sheet('Sponsored Products-Kampagnen', header, [DE_SP_ROWS[0]!])]);
    await expect(run(file)).rejects.toThrow(/Sponsored Products-Kampagnen.*Kampagnen-ID/);
  });

  it('lehnt eine Datei ohne Entities ab', async () => {
    const file = buildXlsx([sheet('Sponsored Products-Kampagnen', DE_SP_HEADER, [])]);
    await expect(run(file)).rejects.toThrow(FileImportRejectedError);
  });

  it('meldet Dateien, die kein XLSX sind, als SheetReadError', async () => {
    await expect(run(new TextEncoder().encode('kein excel'))).rejects.toThrow(SheetReadError);
  });
});

describe('Konto-Prüfung und vollständige Dateien (Dominik, 2026-10-07)', () => {
  const BEFORE_UPLOAD = new Date('2026-10-01T00:00:00Z');
  const UPLOADED_AT = new Date('2026-10-05T07:00:00Z');
  const X = '399999999999991';
  const campaign = (
    profileId: string,
    amazonCampaignId: string,
    options: {
      adProduct?: string;
      createdAt?: Date;
      placeholder?: boolean;
      removed?: boolean;
    } = {},
  ) => ({
    organizationId: ids.org,
    profileId,
    amazonCampaignId,
    adProduct: options.adProduct ?? SP,
    name: amazonCampaignId,
    state: 'ENABLED',
    createdAt: options.createdAt ?? BEFORE_UPLOAD,
    syncedAt: options.placeholder ? null : BEFORE_UPLOAD,
    removedAt: options.removed ? BEFORE_UPLOAD : null,
  });
  const otherProfile = async (
    accountName: string,
    patch: { isHidden?: boolean; removedAt?: Date } = {},
  ) => {
    const created = await createFileProfile(db, {
      userId: ids.admin,
      orgId: ids.org,
      input: {
        accountName,
        countryCode: 'FR',
        currencyCode: 'EUR',
        timezone: 'Europe/Paris',
        accountType: 'seller',
      },
    });
    if (patch.isHidden !== undefined || patch.removedAt !== undefined) {
      await db.update(amazonAdsProfiles).set(patch).where(eq(amazonAdsProfiles.id, created.id));
    }
    return created.id;
  };
  const removedIds = async () =>
    new Map(
      (
        await db
          .select({
            id: amazonAdsCampaigns.amazonCampaignId,
            removedAt: amazonAdsCampaigns.removedAt,
          })
          .from(amazonAdsCampaigns)
      ).map((row) => [row.id, row.removedAt !== null]),
    );
  const completeRun = (file: Uint8Array) => run(file, { complete: true, uploadedAt: UPLOADED_AT });

  /** Vorhandener Baum unter Kampagne X (vor dem Upload angelegt), den die Datei nicht mehr enthält. */
  async function seedMissingTree() {
    const [x] = await db
      .insert(amazonAdsCampaigns)
      .values([campaign(ids.profile, C1), campaign(ids.profile, X)])
      .returning({ id: amazonAdsCampaigns.id });
    const [xCampaign] = await db
      .select({ id: amazonAdsCampaigns.id })
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.amazonCampaignId, X));
    void x;
    const base = {
      organizationId: ids.org,
      profileId: ids.profile,
      adProduct: SP,
      createdAt: BEFORE_UPLOAD,
    };
    const [group] = await db
      .insert(amazonAdsAdGroups)
      .values({
        ...base,
        campaignId: xCampaign!.id,
        amazonAdGroupId: '499999999999991',
        name: 'g',
        state: 'ENABLED',
      })
      .returning({ id: amazonAdsAdGroups.id });
    await db.insert(amazonAdsTargets).values({
      ...base,
      campaignId: xCampaign!.id,
      adGroupId: group!.id,
      amazonTargetId: '699999999999991',
      targetType: 'keyword',
      state: 'ENABLED',
      expression: {},
    });
    await db.insert(amazonAdsProductAds).values({
      ...base,
      campaignId: xCampaign!.id,
      adGroupId: group!.id,
      amazonAdId: '599999999999991',
      state: 'ENABLED',
    });
    await db.insert(amazonAdsNegativeTargets).values({
      ...base,
      campaignId: xCampaign!.id,
      adGroupId: group!.id,
      amazonTargetId: '699999999999992',
      level: 'ad_group',
      targetType: 'keyword',
      state: 'ENABLED',
      expression: {},
    });
    await db.insert(amazonAdsPortfolios).values({
      organizationId: ids.org,
      profileId: ids.profile,
      amazonPortfolioId: '299999999999991',
      name: 'alt',
      createdAt: BEFORE_UPLOAD,
    });
  }

  const removedCount = async (
    table:
      | typeof amazonAdsAdGroups
      | typeof amazonAdsTargets
      | typeof amazonAdsProductAds
      | typeof amazonAdsNegativeTargets
      | typeof amazonAdsPortfolios,
  ) =>
    (await db.select({ removedAt: table.removedAt }).from(table)).filter(
      (r) => r.removedAt !== null,
    ).length;

  it('lehnt eine Datei ab, deren Kampagnen schon zu einem anderen Profil gehören', async () => {
    const other = await otherProfile('Lumen FR');
    await db.insert(amazonAdsCampaigns).values(campaign(other, C1));
    await expect(run(germanFile())).rejects.toThrow(/anderen Profil.*Lumen FR/);
    expect((await db.select().from(amazonAdsCampaigns)).map((c) => c.profileId)).toEqual([other]);
  });

  it('erkennt fremde Kampagnen auch nur über Ad Groups und Targets der Datei', async () => {
    const other = await otherProfile('Lumen FR');
    await db.insert(amazonAdsCampaigns).values(campaign(other, C1));
    // Nur Ad Group und Keyword, keine Kampagnen-Zeile.
    await expect(run(germanFile({ spRows: [DE_SP_ROWS[3]!, DE_SP_ROWS[5]!] }))).rejects.toThrow(
      /anderen Profil/,
    );
  });

  it('nennt ausgeblendete Profile nicht beim Namen und übergeht entfernte Profile', async () => {
    const hidden = await otherProfile('Versteckt FR', { isHidden: true });
    await db.insert(amazonAdsCampaigns).values(campaign(hidden, C1));
    await expect(run(germanFile())).rejects.toThrow(/einem anderen Profil der Organisation/);
    await expect(run(germanFile())).rejects.not.toThrow(/Versteckt/);
    await db.delete(amazonAdsCampaigns);

    const removed = await otherProfile('Alt FR', { removedAt: BEFORE_UPLOAD });
    await db.insert(amazonAdsCampaigns).values(campaign(removed, C1));
    await expect(run(germanFile())).resolves.toMatchObject({ campaigns: 2 });
  });

  it('weist darauf hin, wenn keine Kampagne der Datei zu den echten Kampagnen des Profils passt', async () => {
    await db.insert(amazonAdsCampaigns).values(campaign(ids.profile, X));
    const counters = await run(germanFile());
    expect(counters).toMatchObject({ campaigns: 2, unmatchedCampaigns: 2 });
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'bulk_import.no_matching_campaigns' }),
    );
    logs.length = 0;
    expect(await run(germanFile())).not.toHaveProperty('unmatchedCampaigns');
  });

  it('gibt keinen Hinweis bei Platzhaltern oder entfernten Kampagnen des Profils', async () => {
    await db
      .insert(amazonAdsCampaigns)
      .values([
        campaign(ids.profile, X, { placeholder: true }),
        campaign(ids.profile, '399999999999992', { removed: true }),
      ]);
    expect(await run(germanFile())).not.toHaveProperty('unmatchedCampaigns');
  });

  it('markiert bei vollständiger Datei fehlende Entities aller Ebenen als entfernt', async () => {
    await seedMissingTree();
    const counters = await completeRun(germanFile());
    expect(counters).toMatchObject({ removed: 6 });
    expect((await removedIds()).get(X)).toBe(true);
    expect((await removedIds()).get(C1)).toBe(false);
    for (const table of [
      amazonAdsAdGroups,
      amazonAdsTargets,
      amazonAdsProductAds,
      amazonAdsNegativeTargets,
      amazonAdsPortfolios,
    ]) {
      expect(await removedCount(table)).toBe(1);
    }
  });

  it('holt eine entfernte Entity zurück, sobald eine Datei sie wieder enthält', async () => {
    await db
      .insert(amazonAdsCampaigns)
      .values([campaign(ids.profile, C1), campaign(ids.profile, C2)]);
    // Datei ohne die Zeilen von C2.
    await completeRun(germanFile({ spRows: DE_SP_ROWS.slice(0, 11) }));
    expect((await removedIds()).get(C2)).toBe(true);
    await completeRun(germanFile());
    expect((await removedIds()).get(C2)).toBe(false);
  });

  it('entfernt nichts von Typen ohne Zeile in der Datei (leeres Blatt, fehlendes Blatt) oder nach Upload Entstandenes', async () => {
    await db.insert(amazonAdsCampaigns).values([
      campaign(ids.profile, C1),
      // SB-Blatt steht leer in der Datei: sagt nichts über SB.
      campaign(ids.profile, '399999999999992', { adProduct: SB }),
      // SD-Blatt fehlt.
      campaign(ids.profile, '399999999999993', { adProduct: SD }),
      // Erst nach dem Upload entstanden (z. B. Platzhalter aus einem Bericht).
      campaign(ids.profile, '399999999999994', { createdAt: new Date('2026-10-05T07:59:00Z') }),
    ]);
    expect(await completeRun(germanFile())).toMatchObject({ removed: 0 });
    expect([...(await removedIds()).values()].every((removed) => !removed)).toBe(true);
  });

  it('entfernt keine Eltern, auf die Zeilen der Datei verweisen', async () => {
    // AG1 fehlt als eigene Zeile, Product Ad und Keyword darunter stehen in der Datei.
    const [c1] = await db
      .insert(amazonAdsCampaigns)
      .values(campaign(ids.profile, C1))
      .returning({ id: amazonAdsCampaigns.id });
    await db.insert(amazonAdsAdGroups).values({
      organizationId: ids.org,
      profileId: ids.profile,
      campaignId: c1!.id,
      amazonAdGroupId: AG1,
      adProduct: SP,
      name: 'g',
      state: 'ENABLED',
      createdAt: BEFORE_UPLOAD,
    });
    const rows = DE_SP_ROWS.filter((_, index) => index !== 3);
    await completeRun(germanFile({ spRows: rows }));
    const [group] = await db
      .select({ removedAt: amazonAdsAdGroups.removedAt })
      .from(amazonAdsAdGroups)
      .where(eq(amazonAdsAdGroups.amazonAdGroupId, AG1));
    expect(group?.removedAt).toBeNull();
  });

  it('markiert nichts ohne Häkchen, bei ungültigen Zeilen, bei nicht abgebildeten Zeilen oder fremd wirkender Datei', async () => {
    await seedMissingTree();
    expect(await run(germanFile())).toMatchObject({ removed: 0 });

    const invalid = [...DE_SP_ROWS, sp({ ...DE_SP_ROWS[5]!, Gebot: 'viel' })];
    expect(await completeRun(germanFile({ spRows: invalid }))).toMatchObject({
      removed: 0,
      invalidRows: 1,
    });
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.removal_skipped', reason: 'invalid_rows' }),
    );

    const unsupported = [...DE_SP_ROWS, sp({ Entität: 'Portfolio', 'Kampagnen-ID': C1 })];
    // SP wurde nicht ganz gelesen: der SP-Baum bleibt; das Portfolio-Blatt ist vollständig, das alte Portfolio geht.
    expect(await completeRun(germanFile({ spRows: unsupported }))).toMatchObject({ removed: 1 });
    expect(await removedCount(amazonAdsAdGroups)).toBe(0);
    expect(await removedCount(amazonAdsPortfolios)).toBe(1);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.removal_skipped', reason: 'partially_read' }),
    );
    expect((await removedIds()).get(X)).toBe(false);
  });

  it('markiert nichts, wenn keine Kampagne der Datei zum Profil passt (fremd wirkende Datei)', async () => {
    await db.insert(amazonAdsCampaigns).values(campaign(ids.profile, X));
    expect(await completeRun(germanFile())).toMatchObject({ removed: 0, unmatchedCampaigns: 2 });
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.removal_skipped', reason: 'unmatched' }),
    );
    expect((await removedIds()).get(X)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Suchbegriff-Blätter (`phase-2b.md` 2b.1): Summen über den Zeitraum der Datei
// ---------------------------------------------------------------------------

const DE_SEARCH_TERM_HEADER = [
  'Produkt',
  'Kampagnen-ID',
  'Anzeigengruppen-ID',
  'Keyword-ID',
  'Produkt-Targeting-ID',
  'Kampagnenname (Nur zu Informationszwecken)',
  'Name der Anzeigengruppe (Nur zu Informationszwecken)',
  'Portfolioname (Nur zu Informationszwecken)',
  'Zustand',
  'Kampagnenstatus (Nur zu Informationszwecken)',
  'Gebot',
  'Keyword-Text',
  'Übereinstimmungstyp',
  'Ausdruck für Produkt-Targeting',
  'Suchbegriff eines Kunden',
  'Impressions',
  'Klicks',
  'Klickrate',
  'Ausgaben',
  'Verkäufe',
  'Bestellungen',
  'Einheiten',
  'Conversion-Rate',
  'ACOS',
  'CPC',
  'ROAS',
];

const EN_SEARCH_TERM_HEADER = [
  'Product',
  'Campaign ID',
  'Ad Group ID',
  'Keyword ID',
  'Product Targeting ID',
  'Campaign Name (Informational only)',
  'State',
  'Keyword Text',
  'Match Type',
  'Customer Search Term',
  'Impressions',
  'Clicks',
  'Click-through Rate',
  'Spend',
  'Sales',
  'Orders',
  'Units',
  'ACOS',
];

const DE_SEARCH_TERM_ROWS: Array<Record<string, TestCell>> = [
  {
    Produkt: 'Sponsored Products',
    'Kampagnen-ID': C1,
    'Anzeigengruppen-ID': AG1,
    'Keyword-ID': KW1,
    'Suchbegriff eines Kunden': 'eulen nistkasten',
    Impressions: 1200,
    Klicks: 34,
    Klickrate: 0.028333333333333332,
    Ausgaben: 12.340000000000002,
    Verkäufe: 89.9,
    Bestellungen: 3,
    Einheiten: 4,
    ACOS: 0.13726362625139044,
  },
  {
    Produkt: 'Sponsored Products',
    'Kampagnen-ID': C2,
    'Anzeigengruppen-ID': AG2,
    'Produkt-Targeting-ID': PT2,
    'Suchbegriff eines Kunden': 'b0erfunden01',
    Impressions: 50,
    Klicks: 0,
    Ausgaben: 0,
    Verkäufe: 0,
    Bestellungen: 0,
    Einheiten: 0,
  },
];

function searchTermFile(
  rows: Array<Record<string, TestCell>> = DE_SEARCH_TERM_ROWS,
  options: {
    header?: string[];
    sheetName?: string;
    spRows?: Array<Record<string, TestCell>>;
  } = {},
) {
  return buildXlsx([
    sheet('Sponsored Products-Kampagnen', DE_SP_HEADER, options.spRows ?? DE_SP_ROWS),
    sheet(
      options.sheetName ?? 'SP Bericht „Suchbegriff“',
      options.header ?? DE_SEARCH_TERM_HEADER,
      rows,
    ),
    sheet('SB Bericht „Suchbegriff“', DE_SEARCH_TERM_HEADER, []),
  ]);
}

const SEPTEMBER = 'bulk-a1b2c3-20260901-20260930-1.xlsx';

const searchTerms = () =>
  db
    .select()
    .from(amazonAdsSearchTermPeriodMetrics)
    .orderBy(
      asc(amazonAdsSearchTermPeriodMetrics.periodStart),
      asc(amazonAdsSearchTermPeriodMetrics.searchTerm),
    );

describe('Suchbegriff-Blätter der Bulk-Datei (2b.1)', () => {
  it('speichert die Suchbegriffe als Summen über den Zeitraum der Datei, nicht als Tageswerte', async () => {
    const counters = await run(searchTermFile(), { fileName: SEPTEMBER });
    expect(counters).toMatchObject({ campaigns: 2, searchTerms: 2 });

    const rows = await searchTerms();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      organizationId: ids.org,
      profileId: ids.profile,
      adProduct: SP,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      amazonCampaignId: C2,
      amazonAdGroupId: AG2,
      amazonTargetId: PT2,
      searchTerm: 'b0erfunden01',
      currencyCode: 'EUR',
      impressions: 50,
      clicks: 0,
      cost: '0',
      sales: '0',
      purchases: 0,
      units: 0,
      importedAt: NOW,
    });
    // Beträge ohne Gleitkomma-Reste, Keyword-ID als Target.
    expect(rows[1]).toMatchObject({
      amazonCampaignId: C1,
      amazonAdGroupId: AG1,
      amazonTargetId: KW1,
      searchTerm: 'eulen nistkasten',
      impressions: 1200,
      clicks: 34,
      cost: '12.34',
      sales: '89.9',
      purchases: 3,
      units: 4,
    });
    expect(await db.select().from(amazonAdsCampaignDailyMetrics)).toEqual([]);
  });

  it('liest das englische Blatt', async () => {
    const file = searchTermFile(
      [
        {
          Product: 'Sponsored Products',
          'Campaign ID': C1,
          'Ad Group ID': AG1,
          'Keyword ID': KW1,
          'Customer Search Term': 'owl nest box',
          Impressions: 10,
          Clicks: 2,
          Spend: 1.5,
          Sales: 20,
          Orders: 1,
          Units: 1,
        },
      ],
      { header: EN_SEARCH_TERM_HEADER, sheetName: 'SP Search Term Report' },
    );
    expect(await run(file, { fileName: SEPTEMBER })).toMatchObject({ searchTerms: 1 });
    expect(await searchTerms()).toMatchObject([
      { searchTerm: 'owl nest box', clicks: 2, cost: '1.5', sales: '20', purchases: 1 },
    ]);
  });

  it('ersetzt denselben Zeitraum beim erneuten Upload und lässt andere Zeiträume stehen', async () => {
    await run(searchTermFile(), { fileName: SEPTEMBER });
    await run(searchTermFile([{ ...DE_SEARCH_TERM_ROWS[0]!, Klicks: 40 }]), {
      fileName: 'bulk-a1b2c3-20260901-20260930-2.xlsx',
    });
    await run(searchTermFile([DE_SEARCH_TERM_ROWS[1]!]), {
      fileName: 'bulk-a1b2c3-20260915-20261007-3.xlsx',
    });

    expect(
      (await searchTerms()).map((r) => [r.periodStart, r.periodEnd, r.searchTerm, r.clicks]),
    ).toEqual([
      ['2026-09-01', '2026-09-30', 'eulen nistkasten', 40],
      ['2026-09-15', '2026-10-07', 'b0erfunden01', 0],
    ]);
  });

  it('behält vorhandene Suchbegriffe, wenn die neue Datei desselben Zeitraums keine enthält', async () => {
    await run(searchTermFile(), { fileName: SEPTEMBER });
    // Download ohne Leistungsdaten: leeres Blatt.
    expect(await run(searchTermFile([]), { fileName: SEPTEMBER })).not.toHaveProperty(
      'searchTerms',
    );
    expect(await searchTerms()).toHaveLength(2);
  });

  it('importiert ohne Zeitraum im Dateinamen die Entities, aber keine Suchbegriffe, und zählt das', async () => {
    const counters = await run(searchTermFile(), { fileName: 'kunde-oktober.xlsx' });
    expect(counters).toMatchObject({ campaigns: 2, searchTermsWithoutPeriod: 2 });
    expect(counters).not.toHaveProperty('searchTerms');
    expect(await searchTerms()).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'bulk_import.search_terms_without_period' }),
    );
  });

  it('nutzt bei umbenannter Datei den beim Upload angegebenen Zeitraum (2b.2c)', async () => {
    const counters = await run(searchTermFile(), {
      fileName: 'kunde-oktober.xlsx',
      period: { startDate: '2026-09-08', endDate: '2026-10-07' },
    });
    expect(counters).toMatchObject({ campaigns: 2, searchTerms: 2 });
    expect(counters).not.toHaveProperty('searchTermsWithoutPeriod');
    expect((await searchTerms()).map((r) => [r.periodStart, r.periodEnd])).toEqual([
      ['2026-09-08', '2026-10-07'],
      ['2026-09-08', '2026-10-07'],
    ]);
    expect(logs).not.toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.search_terms_without_period' }),
    );
  });

  it('zieht den Zeitraum im Dateinamen dem angegebenen vor', async () => {
    await run(searchTermFile(), {
      fileName: SEPTEMBER,
      period: { startDate: '2026-08-01', endDate: '2026-08-31' },
    });
    expect((await searchTerms()).map((r) => [r.periodStart, r.periodEnd])).toEqual([
      ['2026-09-01', '2026-09-30'],
      ['2026-09-01', '2026-09-30'],
    ]);
  });

  it('reicht den am Import gespeicherten Zeitraum über den Job an den Importer', async () => {
    await createFileImport(db, {
      userId: ids.admin,
      orgId: ids.org,
      profileId: ids.profile,
      kind: 'bulk',
      fileName: 'kunde-september.xlsx',
      period: { startDate: '2026-09-01', endDate: '2026-09-30' },
      now: NOW,
      content: searchTermFile(),
      enqueue: async () => {},
    });
    const runJob = createJobRunner({ db, logger: (entry) => logs.push(entry) });
    await importProfileFiles(
      runJob,
      {
        db,
        logger: (entry) => logs.push(entry),
        importers: FILE_IMPORTERS,
        now: () => NOW,
        enqueueFollowUp: async () => {},
      },
      { organizationId: ids.org, profileId: ids.profile },
    );
    const [imported] = await db.select({ counters: fileImports.counters }).from(fileImports);
    expect(imported?.counters).toMatchObject({ searchTerms: 2 });
    expect((await searchTerms()).map((r) => [r.periodStart, r.periodEnd])).toEqual([
      ['2026-09-01', '2026-09-30'],
      ['2026-09-01', '2026-09-30'],
    ]);
  });

  it('überspringt ungültige Zeilen, zählt sie getrennt und fasst doppelte zusammen', async () => {
    const [first] = DE_SEARCH_TERM_ROWS;
    const counters = await run(
      searchTermFile([
        first!,
        { ...first!, Klicks: 6, Ausgaben: 0.66, Impressions: 100 },
        { ...first!, 'Keyword-ID': null, 'Suchbegriff eines Kunden': 'geheim ohne target' },
        { ...first!, 'Suchbegriff eines Kunden': 'geheim kaputt', Klicks: 'viele' },
        { ...first!, 'Suchbegriff eines Kunden': null },
      ]),
      { fileName: SEPTEMBER, complete: true },
    );
    expect(counters).toMatchObject({ searchTerms: 1, invalidSearchTermRows: 3, invalidRows: 0 });
    expect(await searchTerms()).toMatchObject([
      { searchTerm: 'eulen nistkasten', impressions: 1300, clicks: 40, cost: '13' },
    ]);
    // Logs nennen Blatt, Zeile und Spalte, nie Zellinhalte (Kundendaten).
    expect(JSON.stringify(logs)).not.toContain('geheim');
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.invalid_search_term_row', row: 4 }),
    );
  });

  it('übergeht ein Suchbegriff-Blatt ohne die nötigen Spalten, ohne die Datei abzulehnen', async () => {
    const counters = await run(germanFile(), { fileName: SEPTEMBER });
    expect(counters).not.toHaveProperty('searchTerms');
    expect(await searchTerms()).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.search_term_sheet_skipped' }),
    );
  });

  const ONLY_C1 = DE_SP_ROWS.filter((row) => row['Kampagnen-ID'] === C1);
  const existingCampaign = (profileId: string, amazonCampaignId: string) => ({
    organizationId: ids.org,
    profileId,
    amazonCampaignId,
    adProduct: SP,
    name: amazonCampaignId,
    state: 'ENABLED',
    createdAt: new Date('2026-10-01T00:00:00Z'),
    syncedAt: new Date('2026-10-01T00:00:00Z'),
  });

  it('ersetzt bei einer Teilmenge nur die Kampagnen der Datei, bei „vollständig“ den ganzen Zeitraum', async () => {
    await run(searchTermFile(), { fileName: SEPTEMBER });
    // Download „nur bestimmte Kampagnen“: Die Datei kennt nur C1.
    const subset = searchTermFile([{ ...DE_SEARCH_TERM_ROWS[0]!, Klicks: 40 }], {
      spRows: ONLY_C1,
    });
    await run(subset, { fileName: SEPTEMBER });
    expect((await searchTerms()).map((r) => [r.amazonCampaignId, r.clicks])).toEqual([
      [C2, 0],
      [C1, 40],
    ]);

    await run(subset, { fileName: SEPTEMBER, complete: true });
    expect((await searchTerms()).map((r) => r.amazonCampaignId)).toEqual([C1]);
  });

  it('speichert keine Suchbegriffe einer fremd wirkenden Datei (keine Kampagne passt zum Profil)', async () => {
    await db.insert(amazonAdsCampaigns).values(existingCampaign(ids.profile, '399999999999991'));
    const counters = await run(searchTermFile(), { fileName: SEPTEMBER });
    expect(counters).toMatchObject({ unmatchedCampaigns: 2 });
    expect(counters).not.toHaveProperty('searchTerms');
    expect(await searchTerms()).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.search_terms_skipped_unmatched' }),
    );
  });

  it('lehnt die Datei ab, wenn Suchbegriffe zu Kampagnen eines anderen Profils gehören', async () => {
    const other = await createFileProfile(db, {
      userId: ids.admin,
      orgId: ids.org,
      input: {
        accountName: 'Reiher FR',
        countryCode: 'FR',
        currencyCode: 'EUR',
        timezone: 'Europe/Paris',
        accountType: 'seller',
      },
    });
    const foreign = '399999999999992';
    await db.insert(amazonAdsCampaigns).values(existingCampaign(other.id, foreign));
    const file = searchTermFile([{ ...DE_SEARCH_TERM_ROWS[0]!, 'Kampagnen-ID': foreign }]);
    await expect(run(file, { fileName: SEPTEMBER })).rejects.toThrow(/anderen Profil/);
    expect(await searchTerms()).toEqual([]);
    await db.delete(amazonAdsCampaigns);
    await db.delete(amazonAdsProfiles).where(eq(amazonAdsProfiles.id, other.id));
  });

  it('meldet ein Suchbegriff-Blatt mit unbekanntem Namen im Log, statt es still zu übergehen', async () => {
    await run(searchTermFile(DE_SEARCH_TERM_ROWS, { sheetName: 'Suchbegriff-Bericht' }), {
      fileName: SEPTEMBER,
    });
    expect(await searchTerms()).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.search_term_sheet_skipped' }),
    );
  });

  it('hält über den Job fest, aus welcher Datei die Suchbegriffe stammen', async () => {
    const created = await createFileImport(db, {
      userId: ids.admin,
      orgId: ids.org,
      profileId: ids.profile,
      kind: 'bulk',
      fileName: SEPTEMBER,
      content: searchTermFile(),
      enqueue: async () => {},
    });
    const runJob = createJobRunner({ db, logger: (entry) => logs.push(entry) });
    await importProfileFiles(
      runJob,
      {
        db,
        logger: (entry) => logs.push(entry),
        importers: FILE_IMPORTERS,
        now: () => NOW,
        enqueueFollowUp: async () => {},
      },
      { organizationId: ids.org, profileId: ids.profile },
    );
    expect((await searchTerms()).map((r) => r.fileImportId)).toEqual([created.id, created.id]);
    // Der Verlauf darf gelöscht werden, die Summen bleiben.
    await db.delete(fileImports);
    expect((await searchTerms()).map((r) => r.fileImportId)).toEqual([null, null]);
  });

  it('schreibt keine Suchbegriffe, wenn die Datei abgelehnt wird', async () => {
    const file = buildXlsx([
      sheet('Sponsored Products-Kampagnen', DE_SP_HEADER, []),
      sheet('SP Bericht „Suchbegriff“', DE_SEARCH_TERM_HEADER, DE_SEARCH_TERM_ROWS),
    ]);
    await expect(run(file, { fileName: SEPTEMBER })).rejects.toThrow(FileImportRejectedError);
    expect(await searchTerms()).toEqual([]);
  });
});

describe('Kennzahlen der Kampagnen-Blätter (5.1)', () => {
  const DE_METRICS_HEADER = [...DE_SP_HEADER, 'Verkäufe', 'Bestellungen', 'Einheiten', 'ACOS'];
  const m = (
    impressions: number,
    clicks: number,
    spend: number,
    sales: number,
    orders: number,
  ) => ({
    Impressions: impressions,
    Klicks: clicks,
    Ausgaben: spend,
    Verkäufe: sales,
    Bestellungen: orders,
    Einheiten: orders,
    ACOS: 0.5,
  });
  const withMetrics = (): Array<Record<string, TestCell>> => [
    { ...DE_SP_ROWS[0]!, ...m(1000, 12, 9.870000000000001, 40, 2) },
    { ...DE_SP_ROWS[1]!, ...m(600, 8, 7.5, 30, 1) },
    DE_SP_ROWS[2]!,
    { ...DE_SP_ROWS[3]!, ...m(1000, 12, 9.87, 40, 2) },
    { ...DE_SP_ROWS[4]!, ...m(1000, 12, 9.87, 40, 2) },
    { ...DE_SP_ROWS[5]!, ...m(900, 11, 9, 40, 2) },
    { ...DE_SP_ROWS[6]!, ...m(0, 0, 0, 0, 0) },
  ];
  const stored = () =>
    db
      .select({
        adProduct: amazonAdsEntityPeriodMetrics.adProduct,
        level: amazonAdsEntityPeriodMetrics.level,
        amazonCampaignId: amazonAdsEntityPeriodMetrics.amazonCampaignId,
        amazonEntityId: amazonAdsEntityPeriodMetrics.amazonEntityId,
        periodStart: amazonAdsEntityPeriodMetrics.periodStart,
        periodEnd: amazonAdsEntityPeriodMetrics.periodEnd,
        impressions: amazonAdsEntityPeriodMetrics.impressions,
        clicks: amazonAdsEntityPeriodMetrics.clicks,
        cost: amazonAdsEntityPeriodMetrics.cost,
        sales: amazonAdsEntityPeriodMetrics.sales,
        purchases: amazonAdsEntityPeriodMetrics.purchases,
        units: amazonAdsEntityPeriodMetrics.units,
        viewableImpressions: amazonAdsEntityPeriodMetrics.viewableImpressions,
        salesViewsClicks: amazonAdsEntityPeriodMetrics.salesViewsClicks,
        purchasesViewsClicks: amazonAdsEntityPeriodMetrics.purchasesViewsClicks,
        unitsViewsClicks: amazonAdsEntityPeriodMetrics.unitsViewsClicks,
        fileImportId: amazonAdsEntityPeriodMetrics.fileImportId,
      })
      .from(amazonAdsEntityPeriodMetrics)
      .orderBy(
        asc(amazonAdsEntityPeriodMetrics.level),
        asc(amazonAdsEntityPeriodMetrics.amazonEntityId),
      );

  it('übernimmt Summen je Kampagne, Platzierung, Ad Group, Anzeige und Target; Negatives nicht', async () => {
    const file = buildXlsx([
      sheet('Sponsored Products-Kampagnen', DE_METRICS_HEADER, withMetrics()),
    ]);
    const counters = await run(file, { fileName: SEPTEMBER });
    expect(counters).toMatchObject({ entityMetrics: 5 });
    const rows = await stored();
    expect(rows.map((r) => [r.level, r.amazonEntityId])).toEqual([
      ['adGroup', AG1],
      ['campaign', C1],
      ['placement', 'PLACEMENT_TOP'],
      ['productAd', AD1],
      ['target', KW1],
    ]);
    expect(rows.find((r) => r.level === 'campaign')).toEqual({
      adProduct: SP,
      level: 'campaign',
      amazonCampaignId: C1,
      amazonEntityId: C1,
      periodStart: '2026-09-01',
      periodEnd: '2026-09-30',
      impressions: 1000,
      clicks: 12,
      cost: '9.87',
      sales: '40',
      purchases: 2,
      units: 2,
      viewableImpressions: null,
      salesViewsClicks: null,
      purchasesViewsClicks: null,
      unitsViewsClicks: null,
      fileImportId: null,
    });
    expect(rows.find((r) => r.level === 'placement')).toMatchObject({
      amazonCampaignId: C1,
      clicks: 8,
      cost: '7.5',
    });
  });

  it('liest die SD-Spalten mit Views getrennt und ordnet Zeilen ohne Kampagnen-ID über die Ad Group zu', async () => {
    const header = [
      'Product',
      'Entity',
      'Operation',
      'Campaign ID',
      'Ad Group ID',
      'Ad ID',
      'Campaign Name',
      'Ad Group Name',
      'State',
      'Tactic',
      'Budget Type',
      'Budget',
      'SKU',
      'Cost Type',
      'Impressions',
      'Clicks',
      'Spend',
      'Sales',
      'Orders',
      'Units',
      'Viewable Impressions',
      'Sales (Views & Clicks)',
      'Orders (Views & Clicks)',
      'Units (Views & Clicks)',
    ];
    const metrics = {
      Impressions: 500,
      Clicks: 5,
      Spend: 3,
      Sales: 20,
      Orders: 1,
      Units: 1,
      'Viewable Impressions': 400,
      'Sales (Views & Clicks)': 55.5,
      'Orders (Views & Clicks)': 3,
      'Units (Views & Clicks)': 4,
    };
    const file = buildXlsx([
      sheet('Sponsored Display Campaigns', header, [
        {
          Product: 'Sponsored Display',
          Entity: 'Campaign',
          'Campaign ID': C2,
          'Campaign Name': 'Waldkauz SD',
          State: 'enabled',
          Tactic: 'T00020',
          'Budget Type': 'daily',
          Budget: 10,
          'Cost Type': 'cpc',
          ...metrics,
        },
        {
          Product: 'Sponsored Display',
          Entity: 'Ad Group',
          'Campaign ID': C2,
          'Ad Group ID': AG2,
          'Ad Group Name': 'Kategorie',
          State: 'enabled',
          ...metrics,
        },
        {
          Product: 'Sponsored Display',
          Entity: 'Product Ad',
          'Ad Group ID': AG2,
          'Ad ID': '500000000000009',
          SKU: 'WK-SD-09',
          State: 'enabled',
          ...metrics,
        },
      ]),
    ]);
    expect(await run(file, { fileName: SEPTEMBER })).toMatchObject({ entityMetrics: 3 });
    const rows = await stored();
    expect(rows.find((r) => r.level === 'productAd')).toMatchObject({
      adProduct: SD,
      amazonCampaignId: C2,
      amazonEntityId: '500000000000009',
      sales: '20',
      purchases: 1,
      viewableImpressions: 400,
      salesViewsClicks: '55.5',
      purchasesViewsClicks: 3,
      unitsViewsClicks: 4,
    });
  });

  it('schreibt ohne Zeitraum keine Kennzahlen und zählt die Zeilen', async () => {
    const file = buildXlsx([
      sheet('Sponsored Products-Kampagnen', DE_METRICS_HEADER, withMetrics()),
    ]);
    const counters = await run(file, { fileName: 'kunde-oktober.xlsx' });
    expect(counters).toMatchObject({ entityMetricsWithoutPeriod: 5 });
    expect(counters).not.toHaveProperty('entityMetrics');
    expect(await stored()).toEqual([]);
  });

  it('übernimmt nichts aus einer Datei ohne vollständige Kennzahlen-Spalten (Leistungsdaten abgewählt)', async () => {
    const file = buildXlsx([sheet('Sponsored Products-Kampagnen', DE_SP_HEADER, DE_SP_ROWS)]);
    const counters = await run(file, { fileName: SEPTEMBER });
    expect(counters).not.toHaveProperty('entityMetrics');
    expect(await stored()).toEqual([]);
  });

  it('überspringt eine ungültige Kennzahl, ohne die Entity zu verwerfen', async () => {
    const rows = withMetrics();
    rows[0] = { ...rows[0]!, Klicks: 'viele' };
    const file = buildXlsx([sheet('Sponsored Products-Kampagnen', DE_METRICS_HEADER, rows)]);
    const counters = await run(file, { fileName: SEPTEMBER });
    expect(counters).toMatchObject({ campaigns: 1, entityMetrics: 4, invalidEntityMetricRows: 1 });
    expect((await stored()).some((r) => r.level === 'campaign')).toBe(false);
  });
});

describe('Bulk-Import über den Job', () => {
  it('importiert eine hochgeladene Bulk-Datei; der zweite Import derselben Datei ändert nichts', async () => {
    const content = germanFile();
    const upload = () =>
      createFileImport(db, {
        userId: ids.admin,
        orgId: ids.org,
        profileId: ids.profile,
        kind: 'bulk',
        fileName: 'bulk-a1b2c3-20260901-20260930-1.xlsx',
        content,
        enqueue: async () => {},
      });
    const runJob = createJobRunner({ db, logger: (entry) => logs.push(entry) });
    const importOnce = () =>
      importProfileFiles(
        runJob,
        {
          db,
          logger: (entry) => logs.push(entry),
          importers: FILE_IMPORTERS,
          now: () => NOW,
          enqueueFollowUp: async () => {},
        },
        { organizationId: ids.org, profileId: ids.profile },
      );

    await upload();
    expect((await importOnce())?.status).toBe('success');
    await upload();
    expect((await importOnce())?.status).toBe('success');

    const imports = await db
      .select({ status: fileImports.status, counters: fileImports.counters })
      .from(fileImports)
      .orderBy(asc(fileImports.createdAt));
    expect(imports).toEqual([
      { status: 'imported', counters: expect.objectContaining({ created: 13, campaigns: 2 }) },
      {
        status: 'imported',
        counters: expect.objectContaining({ created: 0, updated: 0, campaigns: 2 }),
      },
    ]);
    const campaigns = await db.select().from(amazonAdsCampaigns);
    expect(campaigns.map((c) => c.state).sort()).toEqual(['ENABLED', 'PAUSED']);
  });
});
