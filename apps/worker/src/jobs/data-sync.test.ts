import {
  createMockAmazonAdsClient,
  createRequestMeter,
  REPORT_AD_PRODUCT_SELECTION,
  type AmazonAdsClient,
} from '@profitbash/amazon-ads';
import {
  createConnectionTokenStore,
  metricsImportedThroughSql,
  nextAmazonRequestPollAt,
  schema,
} from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { asc, eq, sql } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, createOrganization, testKeyring } from '../testing';
import { pollAmazonRequests } from './amazon-requests-poll';
import type { ConnectionJobDeps } from './connection-job';
import { syncConnectionEntities } from './entities-sync';
import { syncConnectionProfiles } from './profiles-sync';
import { syncConnectionReports } from './reports-sync';

/**
 * Definition of Done von Phase 1 mit dem Mock-Anbieter: Die Jobs füllen alle Entity- und
 * Kennzahl-Tabellen eines Profils, ein zweiter Lauf ändert nichts, geänderte Werte kommen per Upsert,
 * und ein Neustart während eines laufenden Reports verliert nichts.
 */

const {
  amazonAdsAdGroupDailyMetrics,
  amazonAdsAdGroups,
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsPortfolios,
  amazonAdsProductAdDailyMetrics,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsReportRequests,
  amazonAdsSearchTermDailyMetrics,
  amazonAdsTargetDailyMetrics,
  amazonAdsTargets,
} = schema;

const DE = '9007199254740993';
const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const SD = 'SPONSORED_DISPLAY';
const START = Date.parse('2026-09-27T06:00:00Z');

let testDb: TestDatabase;
let organizationId = '';
let connectionId = '';
let profileId = '';
let clock = START;

/** Ein Amazon-Client je „Prozess“; ein neuer Client simuliert einen Neustart. */
function newClient() {
  return createMockAmazonAdsClient({
    redirectUri: 'http://localhost/cb',
    consentUrl: 'http://localhost/consent',
    store: createConnectionTokenStore({ db: testDb.db, keyring: testKeyring }),
    rateLimit: { requestsPerSecond: 100 },
    simulation: { now: () => clock, processingMs: 60_000 },
  });
}

let client: AmazonAdsClient;

function deps(): ConnectionJobDeps {
  return {
    db: testDb.db,
    logger: () => {},
    amazonAds: client,
    scheduleRetry: () => Promise.resolve(true),
    // Die Folgejobs ruft der Test selbst auf.
    enqueue: () => Promise.resolve(true),
    now: () => new Date(clock),
  };
}

const run = () => ({
  meter: createRequestMeter(),
  runId: null,
  extendLease: () => Promise.resolve(),
});
const job = () => ({ organizationId, connectionId });

/** Pollt, bis nichts mehr offen ist; die Uhr springt jeweils zum nächsten Termin. */
async function drain() {
  const counters: Record<string, number> = {};
  for (let i = 0; i < 100; i++) {
    const next = await nextAmazonRequestPollAt(testDb.db, job());
    if (next === null) return counters;
    clock = Math.max(clock, next.getTime());
    const outcome = await pollAmazonRequests(deps(), job(), run());
    for (const [key, value] of Object.entries(outcome.counters ?? {})) {
      counters[key] = (counters[key] ?? 0) + value;
    }
  }
  throw new Error('Aufträge wurden nicht fertig.');
}

async function fullSync() {
  await syncConnectionEntities(deps(), job(), run());
  await syncConnectionReports(deps(), job(), run());
  return drain();
}

const ENTITY_TABLES = {
  portfolios: amazonAdsPortfolios,
  campaigns: amazonAdsCampaigns,
  adGroups: amazonAdsAdGroups,
  targets: amazonAdsTargets,
  negativeTargets: amazonAdsNegativeTargets,
  productAds: amazonAdsProductAds,
};
const METRIC_TABLES = {
  campaign: amazonAdsCampaignDailyMetrics,
  adGroup: amazonAdsAdGroupDailyMetrics,
  target: amazonAdsTargetDailyMetrics,
  productAd: amazonAdsProductAdDailyMetrics,
  searchTerm: amazonAdsSearchTermDailyMetrics,
};

async function rowCounts(tables: Record<string, PgTable>) {
  const counts: Record<string, number> = {};
  for (const [name, table] of Object.entries(tables)) {
    const [row] = await testDb.db.execute<{ n: number }>(
      sql`select count(*)::int as n from ${table} where profile_id = ${profileId}`,
    );
    counts[name] = row!.n;
  }
  return counts;
}

/** Kennzahlen ohne Verwaltungsspalten, für den Vergleich zweier Läufe. */
async function campaignMetrics() {
  const rows = await testDb.db
    .select({
      campaignId: amazonAdsCampaignDailyMetrics.campaignId,
      date: amazonAdsCampaignDailyMetrics.date,
      impressions: amazonAdsCampaignDailyMetrics.impressions,
      clicks: amazonAdsCampaignDailyMetrics.clicks,
      cost: amazonAdsCampaignDailyMetrics.cost,
      sales7d: amazonAdsCampaignDailyMetrics.sales7d,
      sales14d: amazonAdsCampaignDailyMetrics.sales14d,
      salesSameSku14d: amazonAdsCampaignDailyMetrics.salesSameSku14d,
      salesClicks14d: amazonAdsCampaignDailyMetrics.salesClicks14d,
      viewableImpressions: amazonAdsCampaignDailyMetrics.viewableImpressions,
    })
    .from(amazonAdsCampaignDailyMetrics)
    .where(eq(amazonAdsCampaignDailyMetrics.profileId, profileId))
    .orderBy(
      asc(amazonAdsCampaignDailyMetrics.date),
      asc(amazonAdsCampaignDailyMetrics.campaignId),
    );
  return rows;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
  connectionId = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: 'amzn1.account.MOCK',
  });
  client = newClient();
  await syncConnectionProfiles(deps(), job(), run());
  // Nur das DE-Profil (große IDs), damit der Test kurz bleibt.
  await testDb.db.update(amazonAdsProfiles).set({ removedAt: new Date(START) });
  const [de] = await testDb.db
    .update(amazonAdsProfiles)
    .set({ removedAt: null })
    .where(eq(amazonAdsProfiles.amazonProfileId, DE))
    .returning({ id: amazonAdsProfiles.id });
  profileId = de!.id;
});

afterAll(async () => {
  await testDb.close();
});

describe('Sync mit dem Mock-Anbieter (DoD Phase 1)', () => {
  it('füllt alle Entity- und Kennzahl-Tabellen des Profils, exakt und mit großen IDs', async () => {
    const counters = await fullSync();

    expect(counters.failed ?? 0).toBe(0);
    const entities = await rowCounts(ENTITY_TABLES);
    const metrics = await rowCounts(METRIC_TABLES);
    for (const count of [...Object.values(entities), ...Object.values(metrics)]) {
      expect(count).toBeGreaterThan(0);
    }
    // Entities kommen aus dem Export, nicht als Platzhalter aus den Reports.
    const placeholders = await testDb.db
      .select()
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.profileId, profileId));
    expect(placeholders.every((c) => c.syncedAt !== null)).toBe(true);
    expect(
      placeholders.some((c) => BigInt(c.amazonCampaignId) > BigInt(Number.MAX_SAFE_INTEGER)),
    ).toBe(true);
    const values = await campaignMetrics();
    expect(values.map((v) => v.cost)).toContain('0.005');
    expect(values.map((v) => v.sales7d)).toContain('1234567.89');
  });

  it('holt SB- und SD-Kennzahlen mit dem nächsten reports-sync, sobald deren Kampagnen da sind (1.9)', async () => {
    // Der erste Lauf hat SB- und SD-Entities importiert, deren Reports aber noch nicht angefordert (keine
    // Kampagne).
    const campaigns = await testDb.db
      .select({ id: amazonAdsCampaigns.id, adProduct: amazonAdsCampaigns.adProduct })
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.profileId, profileId));
    const sbCampaignIds = new Set(campaigns.filter((c) => c.adProduct === SB).map((c) => c.id));
    const sdCampaignIds = new Set(campaigns.filter((c) => c.adProduct === SD).map((c) => c.id));
    expect(sbCampaignIds.size).toBeGreaterThan(0);
    expect(sdCampaignIds.size).toBeGreaterThan(0);
    const adsOf = async (adProduct: string) =>
      testDb.db
        .select()
        .from(amazonAdsProductAds)
        .where(
          sql`${amazonAdsProductAds.profileId} = ${profileId} and ${amazonAdsProductAds.adProduct} = ${adProduct}`,
        );
    expect((await adsOf(SB)).map((ad) => ad.extra.adType).sort()).toEqual([
      'PRODUCT_COLLECTION',
      'VIDEO',
    ]);
    const sdAds = await adsOf(SD);
    expect(sdAds.map((ad) => ad.extra.adType).sort()).toEqual(['IMAGE', 'PRODUCT_AD']);
    // Bekannte Lücke (1.10 prüft): Nennt der Export nur die SKU, bleibt die ASIN leer, obwohl
    // `sdAdvertisedProduct` sie liefert.
    expect(sdAds.find((ad) => ad.extra.adType === 'PRODUCT_AD')).toMatchObject({
      asin: null,
      sku: 'MOCK-SKU-0001',
    });
    const dataThrough = async () => {
      const [row] = await testDb.db
        .select({ date: metricsImportedThroughSql(REPORT_AD_PRODUCT_SELECTION) })
        .from(amazonAdsProfiles)
        .where(eq(amazonAdsProfiles.id, profileId));
      return row!.date;
    };
    // Das Profil nutzt SB und SD, beide haben aber noch keinen Tag: „Daten bis“ wartet darauf.
    expect(await dataThrough()).toBeNull();

    await syncConnectionReports(deps(), job(), run());
    const counters = await drain();

    expect(counters.failed ?? 0).toBe(0);
    const metrics = await testDb.db
      .select()
      .from(amazonAdsCampaignDailyMetrics)
      .where(eq(amazonAdsCampaignDailyMetrics.profileId, profileId));
    const sb = metrics.filter((m) => m.adProduct === SB);
    const sp = metrics.filter((m) => m.adProduct === SP);
    expect(sb.length).toBeGreaterThan(0);
    expect(sb.every((m) => sbCampaignIds.has(m.campaignId) && m.sales7d === null)).toBe(true);
    expect(sb.every((m) => m.salesClicks14d !== null && m.purchasesClicks14d !== null)).toBe(true);
    expect(sp.every((m) => m.salesClicks14d === null)).toBe(true);
    const sd = metrics.filter((m) => m.adProduct === SD);
    expect(sd.length).toBeGreaterThan(0);
    expect(sd.every((m) => sdCampaignIds.has(m.campaignId) && m.salesClicks14d !== null)).toBe(
      true,
    );
    // Sichtbare Impressionen nur bei SD.
    expect(sd.every((m) => m.viewableImpressions !== null)).toBe(true);
    expect([...sp, ...sb].every((m) => m.viewableImpressions === null)).toBe(true);
    const countOf = async (table: PgTable, adProduct: string) => {
      const [row] = await testDb.db.execute<{ n: number }>(
        sql`select count(*)::int as n from ${table} where profile_id = ${profileId} and ad_product = ${adProduct}`,
      );
      return row!.n;
    };
    for (const [level, table] of Object.entries(METRIC_TABLES)) {
      expect(await countOf(table, SB)).toBeGreaterThan(0);
      // SD hat keinen Suchbegriff-Report.
      if (level === 'searchTerm') expect(await countOf(table, SD)).toBe(0);
      else expect(await countOf(table, SD)).toBeGreaterThan(0);
    }
    // Gestern in Paris (Zeitzone des Profils): 26.09.
    expect(await dataThrough()).toBe('2026-09-26');
  });

  it('ändert bei einem zweiten Lauf nichts', async () => {
    const before = await campaignMetrics();
    const entitiesBefore = await rowCounts(ENTITY_TABLES);
    const metricsBefore = await rowCounts(METRIC_TABLES);

    const counters = await fullSync();

    expect(counters).toMatchObject({ created: 0, updated: 0, removed: 0, failed: 0 });
    expect(await campaignMetrics()).toEqual(before);
    expect(await rowCounts(ENTITY_TABLES)).toEqual(entitiesBefore);
    expect(await rowCounts(METRIC_TABLES)).toEqual(metricsBefore);
  });

  it('übernimmt geänderte Werte per Upsert', async () => {
    const [campaign] = await testDb.db
      .update(amazonAdsCampaigns)
      .set({ name: 'Lokal verändert', budgetAmount: '1' })
      .where(eq(amazonAdsCampaigns.profileId, profileId))
      .returning();
    await testDb.db
      .update(amazonAdsCampaignDailyMetrics)
      .set({ cost: '999' })
      .where(eq(amazonAdsCampaignDailyMetrics.profileId, profileId));

    const counters = await fullSync();

    expect(counters.updated).toBeGreaterThan(0);
    const [restored] = await testDb.db
      .select()
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.id, campaign!.id));
    expect(restored?.name).not.toBe('Lokal verändert');
    // Das rollierende Fenster lädt die letzten 30 Tage neu.
    const costs = (await campaignMetrics()).map((m) => m.cost);
    expect(costs.filter((cost) => cost !== '999').length).toBeGreaterThan(0);
  });

  it('verliert nichts, wenn der Prozess neu startet, während Amazon einen Report erstellt', async () => {
    clock += 24 * 60 * 60 * 1000;
    await syncConnectionReports(deps(), job(), run());
    const open = await testDb.db
      .select()
      .from(amazonAdsReportRequests)
      .where(eq(amazonAdsReportRequests.status, 'requested'));
    expect(open.length).toBeGreaterThan(0);

    // Neuer Prozess: neuer Client ohne Wissen über laufende Reports.
    client = newClient();
    const counters = await drain();

    expect(counters.imported).toBe(open.length);
    const statuses = await testDb.db
      .select({ status: amazonAdsReportRequests.status })
      .from(amazonAdsReportRequests)
      .where(eq(amazonAdsReportRequests.profileId, profileId));
    expect(statuses.every((s) => s.status === 'imported')).toBe(true);
  });
});
