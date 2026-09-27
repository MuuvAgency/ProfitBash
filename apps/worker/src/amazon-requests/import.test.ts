import type {
  AmazonAdsAdGroup,
  AmazonAdsAdGroupDailyMetric,
  AmazonAdsCampaign,
  AmazonAdsCampaignDailyMetric,
  AmazonAdsExportedTarget,
  AmazonAdsProductAd,
} from '@profitbash/amazon-ads';
import { schema, type AmazonRequest } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { LogEntry } from '@profitbash/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnection, createOrganization } from '../testing';
import { createAmazonImport } from './import';
import type { AmazonRequestFile } from './state-machine';

const {
  amazonAdsAdGroupDailyMetrics,
  amazonAdsAdGroups,
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProductAds,
  amazonAdsProfileMetricsImportedThrough,
  amazonAdsProfiles,
  amazonAdsTargets,
} = schema;

const SP = 'SPONSORED_PRODUCTS';
const BATCH_ID = '00000000-0000-4000-8000-0000000000b1';
const requestedAt = new Date('2026-09-27T06:00:00Z');
const importedAt = new Date('2026-09-27T06:10:00Z');

let testDb: TestDatabase;
let organizationId = '';
let profileId = '';
const logs: LogEntry[] = [];

function request(reportType: string, overrides: Partial<AmazonRequest> = {}): AmazonRequest {
  return {
    id: `req-${reportType}`,
    organizationId,
    profileId,
    kind: 'export',
    adProduct: SP,
    reportType,
    startDate: null,
    endDate: null,
    batchId: BATCH_ID,
    amazonRequestId: `amzn-${reportType}`,
    status: 'completed',
    attempts: 1,
    importAttempts: 0,
    errorCount: 0,
    requestCount: 1,
    nextPollAt: requestedAt,
    requestedAt,
    completedAt: requestedAt,
    importedAt: null,
    failureReason: null,
    rowCount: null,
    invalidRowCount: null,
    createdAt: requestedAt,
    updatedAt: requestedAt,
    ...overrides,
  };
}

const base = { adProduct: SP, state: 'ENABLED', amazonUpdatedAt: null, extra: {} };

const campaign = (id: string): AmazonAdsCampaign => ({
  ...base,
  amazonCampaignId: id,
  amazonPortfolioId: null,
  name: `Kampagne ${id}`,
  targetingType: 'MANUAL',
  budgetAmount: '10.5',
  budgetCurrencyCode: 'EUR',
  budgetType: 'DAILY',
  biddingStrategy: 'LEGACY_FOR_SALES',
  startDate: '2026-01-01',
  endDate: null,
});

const adGroup = (id: string, campaignId: string): AmazonAdsAdGroup => ({
  ...base,
  amazonAdGroupId: id,
  amazonCampaignId: campaignId,
  name: `Ad Group ${id}`,
  defaultBid: '0.75',
  defaultBidCurrencyCode: 'EUR',
});

const target = (
  id: string,
  adGroupId: string,
  campaignId: string | null,
): AmazonAdsExportedTarget => ({
  kind: 'target',
  target: {
    ...base,
    amazonTargetId: id,
    amazonCampaignId: campaignId,
    amazonAdGroupId: adGroupId,
    targetType: 'keyword',
    keywordText: 'laufschuhe',
    matchType: 'EXACT',
    expression: {},
    bid: '0.005',
    bidCurrencyCode: 'EUR',
  },
});

const campaignNegative = (id: string, campaignId: string): AmazonAdsExportedTarget => ({
  kind: 'negative',
  target: {
    ...base,
    amazonTargetId: id,
    amazonCampaignId: campaignId,
    amazonAdGroupId: null,
    level: 'campaign',
    targetType: 'keyword',
    keywordText: 'gratis',
    matchType: 'NEGATIVE_EXACT',
    expression: {},
  },
});

const ad = (id: string, adGroupId: string): AmazonAdsProductAd => ({
  ...base,
  amazonAdId: id,
  amazonAdGroupId: adGroupId,
  amazonCampaignId: null,
  asin: 'B000000001',
  sku: null,
});

interface BatchContent {
  campaigns: AmazonAdsCampaign[];
  adGroups: AmazonAdsAdGroup[];
  targets: AmazonAdsExportedTarget[];
  ads: AmazonAdsProductAd[];
}

const fullBatch = (): BatchContent => ({
  campaigns: [campaign('c-1'), campaign('c-2')],
  adGroups: [adGroup('ag-1', 'c-1'), adGroup('ag-2', 'c-2')],
  targets: [
    target('t-1', 'ag-1', 'c-1'),
    target('t-2', 'ag-2', null),
    campaignNegative('n-1', 'c-2'),
  ],
  ads: [ad('ad-1', 'ag-1'), ad('ad-2', 'ag-2')],
});

function files(content: BatchContent, invalid: Partial<Record<keyof BatchContent, number>> = {}) {
  return (Object.keys(content) as Array<keyof BatchContent>).map((type): AmazonRequestFile => ({
    request: request(type),
    rows: content[type],
    invalidRowCount: invalid[type] ?? 0,
  }));
}

function setup(now = importedAt) {
  return createAmazonImport({ now: () => now, logger: (entry) => logs.push(entry) });
}

async function importBatch(content: BatchContent, invalid = {}, now = importedAt) {
  const importer = setup(now);
  await testDb.db.transaction((tx) =>
    importer.import(tx, { kind: 'export', batchId: BATCH_ID, files: files(content, invalid) }),
  );
  return importer.takeCounters();
}

/** Nicht entfernte Kampagnen bzw. Product Ads des Profils. */
async function active(table: 'campaigns' | 'productAds'): Promise<number> {
  const rows =
    table === 'campaigns'
      ? await testDb.db
          .select({ id: amazonAdsCampaigns.id })
          .from(amazonAdsCampaigns)
          .where(
            and(eq(amazonAdsCampaigns.profileId, profileId), isNull(amazonAdsCampaigns.removedAt)),
          )
      : await testDb.db
          .select({ id: amazonAdsProductAds.id })
          .from(amazonAdsProductAds)
          .where(
            and(
              eq(amazonAdsProductAds.profileId, profileId),
              isNull(amazonAdsProductAds.removedAt),
            ),
          );
  return rows.length;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
  const connectionId = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: 'amzn1.account.A',
  });
  const [profile] = await testDb.db
    .insert(amazonAdsProfiles)
    .values({
      organizationId,
      connectionId,
      amazonProfileId: '111',
      accountName: 'Konto',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
    })
    .returning({ id: amazonAdsProfiles.id });
  profileId = profile!.id;
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(amazonAdsAdGroupDailyMetrics);
  await testDb.db.delete(amazonAdsCampaignDailyMetrics);
  await testDb.db.delete(amazonAdsProductAds);
  await testDb.db.delete(amazonAdsNegativeTargets);
  await testDb.db.delete(amazonAdsTargets);
  await testDb.db.delete(amazonAdsAdGroups);
  await testDb.db.delete(amazonAdsCampaigns);
  logs.length = 0;
});

describe('Import eines Entity-Batches', () => {
  it('schreibt alle Ebenen in Hierarchie-Reihenfolge und ergänzt Kampagnen über die Ad Groups', async () => {
    const counters = await importBatch(fullBatch());

    expect(counters).toEqual({
      created: 9,
      updated: 0,
      removed: 0,
      placeholdersFilled: 0,
      placeholdersCreated: 0,
    });
    const ads = await testDb.db
      .select({
        amazonAdId: amazonAdsProductAds.amazonAdId,
        campaign: amazonAdsCampaigns.amazonCampaignId,
      })
      .from(amazonAdsProductAds)
      .innerJoin(amazonAdsCampaigns, eq(amazonAdsCampaigns.id, amazonAdsProductAds.campaignId))
      .orderBy(amazonAdsProductAds.amazonAdId);
    expect(ads).toEqual([
      { amazonAdId: 'ad-1', campaign: 'c-1' },
      { amazonAdId: 'ad-2', campaign: 'c-2' },
    ]);
    const [t2] = await testDb.db
      .select({ campaign: amazonAdsCampaigns.amazonCampaignId })
      .from(amazonAdsTargets)
      .innerJoin(amazonAdsCampaigns, eq(amazonAdsCampaigns.id, amazonAdsTargets.campaignId))
      .where(eq(amazonAdsTargets.amazonTargetId, 't-2'));
    expect(t2).toEqual({ campaign: 'c-2' });
    const negatives = await testDb.db.select().from(amazonAdsNegativeTargets);
    expect(negatives).toEqual([
      expect.objectContaining({ amazonTargetId: 'n-1', level: 'campaign', adGroupId: null }),
    ]);
  });

  it('ändert beim zweiten gleichen Import nichts', async () => {
    await importBatch(fullBatch());
    const counters = await importBatch(fullBatch(), {}, new Date('2026-09-28T06:10:00Z'));
    expect(counters).toEqual({
      created: 0,
      updated: 0,
      removed: 0,
      placeholdersFilled: 0,
      placeholdersCreated: 0,
    });
  });

  it('markiert fehlende Entities als entfernt, die vor dem Anfordern existierten', async () => {
    await importBatch(fullBatch());
    // Die ersten Zeilen entstanden vor dem Anfordern des zweiten Batches.
    await testDb.db.update(amazonAdsCampaigns).set({ createdAt: new Date('2026-09-01T00:00:00Z') });
    await testDb.db
      .update(amazonAdsProductAds)
      .set({ createdAt: new Date('2026-09-01T00:00:00Z') });
    const content = fullBatch();
    content.campaigns = [campaign('c-1')];
    content.ads = [ad('ad-1', 'ag-1')];

    const counters = await importBatch(content, {}, new Date('2026-09-28T06:10:00Z'));

    expect(counters.removed).toBe(2);
    expect(await active('campaigns')).toBe(1);
    expect(await active('productAds')).toBe(1);
  });

  it('entfernt nichts aus einem Batch mit ungültigen Zeilen', async () => {
    await importBatch(fullBatch());
    await testDb.db.update(amazonAdsCampaigns).set({ createdAt: new Date('2026-09-01T00:00:00Z') });
    const content = fullBatch();
    content.campaigns = [campaign('c-1')];

    const counters = await importBatch(content, { targets: 1 });

    expect(counters.removed).toBe(0);
    expect(await active('campaigns')).toBe(2);
  });

  it('überspringt Zeilen ohne auflösbare Kampagne, loggt sie und entfernt dann nichts', async () => {
    await importBatch(fullBatch());
    await testDb.db
      .update(amazonAdsProductAds)
      .set({ createdAt: new Date('2026-09-01T00:00:00Z') });
    const content = fullBatch();
    content.ads = [ad('ad-1', 'ag-unbekannt')];

    const counters = await importBatch(content);

    expect(counters.removed).toBe(0);
    expect(await active('productAds')).toBe(2);
    expect(
      await testDb.db
        .select()
        .from(amazonAdsAdGroups)
        .where(eq(amazonAdsAdGroups.amazonAdGroupId, 'ag-unbekannt')),
    ).toEqual([]);
    expect(logs).toContainEqual(
      expect.objectContaining({ msg: 'entities_import.unresolved_campaign', rows: 1 }),
    );
  });
});

describe('Kampagne über vorhandene Ad Groups', () => {
  it('löst die Kampagne über eine Ad Group aus der DB auf, wenn sie im Batch fehlt', async () => {
    await importBatch(fullBatch());
    // Die Exports eines Batches können zeitversetzt laufen: Die Ad Group fehlt im späteren Export.
    const content = fullBatch();
    content.adGroups = [adGroup('ag-1', 'c-1')];
    content.ads = [ad('ad-1', 'ag-1'), ad('ad-2', 'ag-2')];
    content.targets = [target('t-2', 'ag-2', null)];

    const counters = await importBatch(content);

    expect(logs).not.toContainEqual(
      expect.objectContaining({ msg: 'entities_import.unresolved_campaign' }),
    );
    expect(counters.created).toBe(0);
  });
});

describe('Import eines Reports', () => {
  it('schreibt die Zeilen über replaceDailyMetrics in die Ebene des Report-Typs', async () => {
    const row: AmazonAdsAdGroupDailyMetric = {
      date: '2026-09-26',
      amazonCampaignId: 'c-9',
      campaignName: 'Aus dem Report',
      amazonAdGroupId: 'ag-9',
      adGroupName: 'Ad Group aus dem Report',
      impressions: 100,
      clicks: 3,
      cost: '0.005',
      sales7d: '1234567.89',
      sales14d: null,
      salesSameSku7d: null,
      salesSameSku14d: null,
      purchases7d: 1,
      purchases14d: null,
      purchasesSameSku7d: null,
      purchasesSameSku14d: null,
      units7d: 1,
      units14d: null,
      unitsSameSku7d: null,
      unitsSameSku14d: null,
      extra: {},
    };
    const importer = setup();
    await testDb.db.transaction((tx) =>
      importer.import(tx, {
        kind: 'report',
        ranges: [{ startDate: '2026-09-20', endDate: '2026-09-26' }],
        request: request('spAdGroups', {
          kind: 'report',
          batchId: null,
          startDate: '2026-09-20',
          endDate: '2026-09-26',
        }),
        rows: [row],
        invalidRowCount: 0,
      }),
    );

    expect(importer.takeCounters()).toEqual({ placeholdersCreated: 2 });
    const metrics = await testDb.db.select().from(amazonAdsAdGroupDailyMetrics);
    expect(metrics).toEqual([
      expect.objectContaining({ date: '2026-09-26', cost: '0.005', sales7d: '1234567.89' }),
    ]);
    expect(importer.takeCounters()).toEqual({});
  });
});

describe('„Daten bis“ je Profil und Ad-Typ', () => {
  const campaignRow = (date: string): AmazonAdsCampaignDailyMetric => ({
    date,
    amazonCampaignId: 'c-1',
    campaignName: 'Aus dem Report',
    impressions: 10,
    clicks: 1,
    cost: '0.1',
    sales7d: null,
    sales14d: null,
    salesSameSku7d: null,
    salesSameSku14d: null,
    purchases7d: null,
    purchases14d: null,
    purchasesSameSku7d: null,
    purchasesSameSku14d: null,
    units7d: null,
    units14d: null,
    unitsSameSku7d: null,
    unitsSameSku14d: null,
    extra: {},
  });

  /** Tag des Ad-Typs SP; andere Ad-Typen dürfen keinen Tag haben. */
  async function importedThrough() {
    const marks = await testDb.db
      .select({
        adProduct: amazonAdsProfileMetricsImportedThrough.adProduct,
        date: amazonAdsProfileMetricsImportedThrough.importedThrough,
      })
      .from(amazonAdsProfileMetricsImportedThrough)
      .where(eq(amazonAdsProfileMetricsImportedThrough.profileId, profileId));
    expect(marks.filter((mark) => mark.adProduct !== SP)).toEqual([]);
    return marks[0]?.date ?? null;
  }

  function importReport(
    reportType: string,
    period: { startDate: string; endDate: string },
    ranges: Array<{ startDate: string; endDate: string }>,
    rows: unknown[],
  ) {
    const importer = setup();
    return testDb.db.transaction((tx) =>
      importer.import(tx, {
        kind: 'report',
        ranges,
        request: request(reportType, { kind: 'report', batchId: null, ...period }),
        rows,
        invalidRowCount: 0,
      }),
    );
  }

  beforeEach(async () => {
    await testDb.db
      .delete(amazonAdsProfileMetricsImportedThrough)
      .where(eq(amazonAdsProfileMetricsImportedThrough.profileId, profileId));
  });

  it('setzt das Ende des Kampagnen-Reports, auch wenn neuere Reports einen Teil schon abdecken', async () => {
    const period = { startDate: '2026-08-28', endDate: '2026-09-26' };
    // Die letzten Tage deckt ein neuerer, schon importierter Report ab (nicht in `ranges`).
    await importReport(
      'spCampaigns',
      period,
      [{ startDate: '2026-08-28', endDate: '2026-09-20' }],
      [campaignRow('2026-09-01')],
    );
    expect(await importedThrough()).toBe('2026-09-26');
  });

  it('setzt das Datum auch ohne Zeilen (Profil ohne Aktivität)', async () => {
    const period = { startDate: '2026-08-28', endDate: '2026-09-26' };
    await importReport('spCampaigns', period, [period], []);
    expect(await importedThrough()).toBe('2026-09-26');
  });

  it('setzt ein älteres Stück der Historie nicht zurück', async () => {
    const window = { startDate: '2026-08-28', endDate: '2026-09-26' };
    const history = { startDate: '2026-07-28', endDate: '2026-08-27' };
    await importReport('spCampaigns', window, [window], []);
    await importReport('spCampaigns', history, [history], []);
    expect(await importedThrough()).toBe('2026-09-26');
  });

  it('bleibt bei Reports anderer Ebenen unverändert', async () => {
    const period = { startDate: '2026-08-28', endDate: '2026-09-26' };
    await importReport('spAdGroups', period, [period], []);
    expect(await importedThrough()).toBeNull();
  });
});
