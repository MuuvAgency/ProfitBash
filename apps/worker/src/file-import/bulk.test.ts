import {
  createFileImport,
  createFileProfile,
  schema,
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
  amazonAdsAdGroups,
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsPortfolios,
  amazonAdsProductAds,
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
    amazonAdsProductAds,
    amazonAdsNegativeTargets,
    amazonAdsTargets,
    amazonAdsAdGroups,
    amazonAdsCampaigns,
    amazonAdsPortfolios,
    fileImports,
    jobRuns,
  ]) {
    await db.delete(table);
  }
  logs.length = 0;
});

const run = (
  content: Uint8Array,
  options: { complete?: boolean; uploadedAt?: Date; profileId?: string } = {},
) =>
  importBulkFile({
    db,
    logger: (entry) => logs.push(entry),
    organizationId: ids.org,
    profileId: options.profileId ?? ids.profile,
    fileName: 'bulk-test.xlsx',
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

  it('liest englische Kopfzeilen und Werte, SB- und SD-Blätter', async () => {
    const SBC = '310000000000001';
    const SBAG = '410000000000001';
    const SBKW = '610000000000001';
    const SBNK = '610000000000002';
    const SBPT = '710000000000001';
    const SDC = '320000000000001';
    const SDAG = '420000000000001';
    const SDAD = '520000000000001';
    const SDT1 = '720000000000001';
    const SDT2 = '720000000000002';
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
        { Entity: 'Video Ad', 'Campaign ID': SBC, 'Ad Group ID': SBAG, 'Ad ID': '510000000000001' },
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
      ]),
    ]);

    const counters = await run(file);
    expect(counters).toMatchObject({
      portfolios: 0,
      campaigns: 3,
      adGroups: 2,
      targets: 4,
      negatives: 2,
      productAds: 1,
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
      extra: { costType: 'CPC' },
    });
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

    const [ad] = await db.select().from(amazonAdsProductAds);
    expect(ad).toMatchObject({
      amazonAdId: SDAD,
      adProduct: SD,
      campaignId: campaigns.get(SDC)!.row.id,
      sku: 'WK-SD-01',
      asin: null,
    });
    // SB-Ads kommen erst mit 1.9: übergangen und geloggt, nicht ungültig.
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'bulk_import.entity_skipped', entity: 'unsupported' }),
    );
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
  const campaign = (
    profileId: string,
    amazonCampaignId: string,
    adProduct = SP,
    createdAt = BEFORE_UPLOAD,
  ) => ({
    organizationId: ids.org,
    profileId,
    amazonCampaignId,
    adProduct,
    name: amazonCampaignId,
    state: 'ENABLED',
    createdAt,
  });

  it('lehnt eine Datei ab, deren Kampagnen schon zu einem anderen Profil gehören', async () => {
    const other = await createFileProfile(db, {
      userId: ids.admin,
      orgId: ids.org,
      input: {
        accountName: 'Lumen FR',
        countryCode: 'FR',
        currencyCode: 'EUR',
        timezone: 'Europe/Paris',
        accountType: 'seller',
      },
    });
    await db.insert(amazonAdsCampaigns).values(campaign(other.id, C1));
    await expect(run(germanFile())).rejects.toThrow(/anderen Profil.*Lumen FR/);
    expect((await db.select().from(amazonAdsCampaigns)).map((c) => c.profileId)).toEqual([
      other.id,
    ]);
  });

  it('weist darauf hin, wenn keine Kampagne der Datei zu den Kampagnen des Profils passt', async () => {
    await db.insert(amazonAdsCampaigns).values(campaign(ids.profile, '399999999999999'));
    const counters = await run(germanFile());
    expect(counters).toMatchObject({ campaigns: 2, unmatchedCampaigns: 2 });
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'bulk_import.no_matching_campaigns' }),
    );
    // Passt mindestens eine, kein Hinweis.
    logs.length = 0;
    expect(await run(germanFile())).not.toHaveProperty('unmatchedCampaigns');
  });

  it('markiert bei vollständiger Datei fehlende Entities der enthaltenen Ad-Typen als entfernt', async () => {
    await db.insert(amazonAdsCampaigns).values([
      campaign(ids.profile, '399999999999991'),
      // SB-Blatt ist in der Datei (leer): Auch SB-Kampagnen fehlen also wirklich.
      campaign(ids.profile, '399999999999992', SB),
      // SD-Blatt fehlt in der Datei: nichts zu SD sagen.
      campaign(ids.profile, '399999999999993', SD),
      // Erst nach dem Upload entstanden (z. B. Platzhalter aus einem Bericht): bleibt.
      campaign(ids.profile, '399999999999994', SP, new Date('2026-10-05T07:59:00Z')),
    ]);
    const counters = await run(germanFile(), {
      complete: true,
      uploadedAt: new Date('2026-10-05T07:00:00Z'),
    });
    expect(counters).toMatchObject({ removed: 2 });
    const rows = await db
      .select({ id: amazonAdsCampaigns.amazonCampaignId, removedAt: amazonAdsCampaigns.removedAt })
      .from(amazonAdsCampaigns)
      .orderBy(asc(amazonAdsCampaigns.amazonCampaignId));
    expect(rows.filter((r) => r.removedAt !== null).map((r) => r.id)).toEqual([
      '399999999999991',
      '399999999999992',
    ]);
  });

  it('markiert nichts ohne Häkchen „vollständig“ oder bei ungültigen Zeilen', async () => {
    await db.insert(amazonAdsCampaigns).values(campaign(ids.profile, '399999999999991'));
    expect(await run(germanFile())).toMatchObject({ removed: 0 });
    const rows = [...DE_SP_ROWS, sp({ ...DE_SP_ROWS[5]!, Gebot: 'viel' })];
    expect(await run(germanFile({ spRows: rows }), { complete: true })).toMatchObject({
      removed: 0,
      invalidRows: 1,
    });
    expect(logs).toContainEqual(expect.objectContaining({ msg: 'bulk_import.removal_skipped' }));
    const [kept] = await db
      .select({ removedAt: amazonAdsCampaigns.removedAt })
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.amazonCampaignId, '399999999999991'));
    expect(kept?.removedAt).toBeNull();
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
