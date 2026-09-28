import { createMockAmazonAdsClient } from '@profitbash/amazon-ads';
import { createConnectionTokenStore, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadDemoData, type DemoClock } from './demo';
import { createOrganization, testKeyring } from './testing';

const {
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsProfiles,
  amazonAdsSearchTermDailyMetrics,
  auditEvents,
  clients,
  connections,
} = schema;

const DE = '9007199254740993';
const FR = '1234567890123456';
const UK = '2345678901234567';
const CLIENTS = [
  { name: 'Eins (Demo)', slug: 'eins-demo', amazonProfileIds: [DE, FR] },
  { name: 'Zwei (Demo)', slug: 'zwei-demo', amazonProfileIds: [UK] },
];

let testDb: TestDatabase;
let organizationId = '';
let clock = Date.parse('2026-09-27T06:00:00Z');
const demoClock: DemoClock = {
  now: () => clock,
  sleep: (ms) => {
    clock += ms;
    return Promise.resolve();
  },
};

function load() {
  return loadDemoData({
    db: testDb.db,
    keyring: testKeyring,
    amazonAds: createMockAmazonAdsClient({
      redirectUri: 'http://localhost/cb',
      consentUrl: 'http://localhost/consent',
      store: createConnectionTokenStore({ db: testDb.db, keyring: testKeyring }),
      rateLimit: { requestsPerSecond: 1_000 },
      simulation: { now: () => clock, processingMs: 0 },
    }),
    clients: CLIENTS,
    clock: demoClock,
    logger: () => {},
  });
}

const count = async (query: Promise<Array<{ n: number }>>) => (await query)[0]!.n;

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
}, 60_000);
afterAll(() => testDb?.close());

describe('loadDemoData', () => {
  it('scheitert ohne Organisation „muuv“ mit Hinweis auf den Seed', async () => {
    const empty = await createTestDatabase();
    try {
      await expect(
        loadDemoData({
          db: empty.db,
          keyring: testKeyring,
          amazonAds: createMockAmazonAdsClient({
            redirectUri: 'http://localhost/cb',
            consentUrl: 'http://localhost/consent',
            store: createConnectionTokenStore({ db: empty.db, keyring: testKeyring }),
          }),
          clients: CLIENTS,
          clock: demoClock,
          logger: () => {},
        }),
      ).rejects.toThrow(/db:seed/);
    } finally {
      await empty.close();
    }
  }, 60_000);

  it('füllt Profile, Entities und Kennzahlen aller Ad-Typen über den Sync und ordnet Clients zu', async () => {
    const result = await load();
    expect(result.profiles).toBe(4);

    const adProducts = await testDb.db
      .selectDistinct({ adProduct: amazonAdsCampaignDailyMetrics.adProduct })
      .from(amazonAdsCampaignDailyMetrics)
      .orderBy(asc(amazonAdsCampaignDailyMetrics.adProduct));
    expect(adProducts.map((row) => row.adProduct)).toEqual([
      'SPONSORED_BRANDS',
      'SPONSORED_DISPLAY',
      'SPONSORED_PRODUCTS',
    ]);
    // Historie: SP reicht mehr als 60 Tage zurück (rollierendes Fenster + Merker aus 1.7).
    const [span] = await testDb.db.execute<{ days: number }>(
      sql`select (max(date) - min(date))::int as days from ${amazonAdsCampaignDailyMetrics}
          where ad_product = 'SPONSORED_PRODUCTS'`,
    );
    expect(span!.days).toBeGreaterThan(60);
    expect(
      await count(
        testDb.db.select({ n: sql<number>`count(*)::int` }).from(amazonAdsSearchTermDailyMetrics),
      ),
    ).toBeGreaterThan(0);

    const assigned = await testDb.db
      .select({ amazonProfileId: amazonAdsProfiles.amazonProfileId, slug: clients.slug })
      .from(amazonAdsProfiles)
      .leftJoin(clients, eq(clients.id, amazonAdsProfiles.clientId))
      .orderBy(asc(amazonAdsProfiles.amazonProfileId));
    expect(assigned).toEqual([
      { amazonProfileId: FR, slug: 'eins-demo' },
      { amazonProfileId: UK, slug: 'zwei-demo' },
      { amazonProfileId: '3456789012345678', slug: null },
      { amazonProfileId: DE, slug: 'eins-demo' },
    ]);

    const actions = await testDb.db
      .select({ action: auditEvents.action, actor: auditEvents.actorUserId })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, organizationId))
      .orderBy(asc(auditEvents.action));
    expect(actions).toEqual([
      { action: 'client.create', actor: null },
      { action: 'client.create', actor: null },
      { action: 'connection.create', actor: null },
      { action: 'profile.update', actor: null },
      { action: 'profile.update', actor: null },
      { action: 'profile.update', actor: null },
    ]);
  }, 120_000);

  it('ist wiederholbar: keine doppelten Connections, Clients oder Kennzahlen', async () => {
    const before = await count(
      testDb.db.select({ n: sql<number>`count(*)::int` }).from(amazonAdsCampaignDailyMetrics),
    );
    const campaigns = await count(
      testDb.db.select({ n: sql<number>`count(*)::int` }).from(amazonAdsCampaigns),
    );
    await load();
    expect(await count(testDb.db.select({ n: sql<number>`count(*)::int` }).from(connections))).toBe(
      1,
    );
    expect(await count(testDb.db.select({ n: sql<number>`count(*)::int` }).from(clients))).toBe(2);
    expect(
      await count(
        testDb.db.select({ n: sql<number>`count(*)::int` }).from(amazonAdsCampaignDailyMetrics),
      ),
    ).toBeGreaterThanOrEqual(before);
    expect(
      await count(
        testDb.db
          .select({ n: sql<number>`count(*)::int` })
          .from(amazonAdsCampaigns)
          .where(and(isNull(amazonAdsCampaigns.removedAt))),
      ),
    ).toBe(campaigns);
  }, 120_000);
});
