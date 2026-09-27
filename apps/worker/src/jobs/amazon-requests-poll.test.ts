import { createMockAmazonAdsClient, createRequestMeter } from '@profitbash/amazon-ads';
import {
  createAmazonExportBatch,
  createAmazonRequest,
  createConnectionTokenStore,
  schema,
  updateAmazonRequest,
} from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createConnection, createOrganization, testKeyring } from '../testing';
import {
  MAX_RUNNING_EXPORTS_PER_TYPE,
  pollAmazonRequests,
  POLL_LIMITS,
} from './amazon-requests-poll';
import type { ConnectionJobData, ConnectionJobDeps, ConnectionQueue } from './connection-job';
import { syncConnectionProfiles } from './profiles-sync';

const {
  amazonAdsAdGroups,
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsReportRequests,
  amazonAdsTargets,
} = schema;

const SP = 'SPONSORED_PRODUCTS';
/** DE-Profil des Mocks (ID über `MAX_SAFE_INTEGER`). */
const DE = '9007199254740993';
const START = Date.parse('2026-09-27T06:00:00Z');

let testDb: TestDatabase;
let organizationId = '';
let connectionId = '';
let profileId = '';
let otherProfileIds: string[] = [];
let clock = START;
const enqueued: Array<{
  queue: ConnectionQueue;
  job: ConnectionJobData;
  startAfterSeconds?: number;
}> = [];

function deps(): ConnectionJobDeps {
  return {
    db: testDb.db,
    logger: () => {},
    amazonAds: createMockAmazonAdsClient({
      redirectUri: 'http://localhost/cb',
      consentUrl: 'http://localhost/consent',
      store: createConnectionTokenStore({ db: testDb.db, keyring: testKeyring }),
      rateLimit: { requestsPerSecond: 100 },
      simulation: { now: () => clock, processingMs: 60_000 },
    }),
    scheduleRetry: () => Promise.resolve(true),
    enqueue(queue, job, options) {
      enqueued.push({ queue, job, ...options });
      return Promise.resolve(true);
    },
    now: () => new Date(clock),
  };
}

const run = () => ({
  meter: createRequestMeter(),
  runId: null,
  extendLease: () => Promise.resolve(),
});
const poll = (d = deps()) => pollAmazonRequests(d, { organizationId, connectionId }, run());

const report = (overrides: { profileId?: string; startDate?: string; endDate?: string } = {}) =>
  createAmazonRequest(testDb.db, {
    organizationId,
    profileId,
    kind: 'report',
    adProduct: SP,
    reportType: 'spCampaigns',
    startDate: '2026-09-20',
    endDate: '2026-09-26',
    batchId: null,
    now: new Date(clock),
    ...overrides,
  });

async function requests() {
  return testDb.db
    .select()
    .from(amazonAdsReportRequests)
    .where(eq(amazonAdsReportRequests.profileId, profileId));
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
  connectionId = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: 'amzn1.account.MOCK',
  });
  await syncConnectionProfiles(deps(), { organizationId, connectionId }, run());
  const profiles = await testDb.db
    .select({ id: amazonAdsProfiles.id, amazonProfileId: amazonAdsProfiles.amazonProfileId })
    .from(amazonAdsProfiles);
  profileId = profiles.find((p) => p.amazonProfileId === DE)!.id;
  otherProfileIds = profiles.filter((p) => p.amazonProfileId !== DE).map((p) => p.id);
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  clock = START;
  enqueued.length = 0;
  await testDb.db.delete(amazonAdsReportRequests);
});

describe('pollAmazonRequests', () => {
  it('fordert offene Reports an, plant sich neu ein und importiert sie, sobald Amazon fertig ist', async () => {
    await report();

    const first = await poll();
    expect(first.counters).toMatchObject({ requested: 1 });
    expect(enqueued).toEqual([
      {
        queue: 'amazon-requests-poll',
        job: { organizationId, connectionId },
        startAfterSeconds: 60,
      },
    ]);

    clock += 60_000;
    enqueued.length = 0;
    const second = await poll();

    expect(second.counters).toMatchObject({ imported: 1, rows: expect.any(Number) as number });
    expect(second.counters?.placeholdersCreated).toBeGreaterThan(0);
    expect((await requests())[0]).toMatchObject({ status: 'imported' });
    const metrics = await testDb.db
      .select()
      .from(amazonAdsCampaignDailyMetrics)
      .where(eq(amazonAdsCampaignDailyMetrics.profileId, profileId));
    expect(metrics.length).toBe(second.counters?.rows);
    // Nichts mehr offen: kein weiterer Poll.
    expect(enqueued).toEqual([]);
  });

  it('importiert einen Entity-Batch, sobald alle Exports fertig sind', async () => {
    await createAmazonExportBatch(testDb.db, {
      organizationId,
      profileId,
      adProduct: SP,
      exportTypes: ['campaigns', 'adGroups', 'targets', 'ads'],
      now: new Date(clock),
    });

    expect((await poll()).counters).toMatchObject({ requested: 4 });
    clock += 60_000;
    const outcome = await poll();

    expect(outcome.counters).toMatchObject({ imported: 4, removed: 0 });
    expect(outcome.counters?.created).toBeGreaterThan(0);
    for (const table of [amazonAdsCampaigns, amazonAdsAdGroups, amazonAdsTargets]) {
      const rows = await testDb.db.select().from(table).where(eq(table.profileId, profileId));
      expect(rows.length).toBeGreaterThan(0);
    }
    const ads = await testDb.db
      .select()
      .from(amazonAdsProductAds)
      .where(eq(amazonAdsProductAds.profileId, profileId));
    expect(ads.length).toBeGreaterThan(0);
  });

  it(`hält Exports zurück, solange ${MAX_RUNNING_EXPORTS_PER_TYPE} desselben Typs an der Connection laufen`, async () => {
    for (let i = 0; i < MAX_RUNNING_EXPORTS_PER_TYPE; i++) {
      const { requests: batch } = await createAmazonExportBatch(testDb.db, {
        organizationId,
        profileId: otherProfileIds[i % otherProfileIds.length]!,
        adProduct: ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS'][Math.floor(i / 3)]!,
        exportTypes: ['campaigns'],
        now: new Date(clock),
      });
      await updateAmazonRequest(testDb.db, batch[0]!, {
        status: 'requested',
        amazonRequestId: `laeuft-${i}`,
        nextPollAt: new Date(clock + 600_000),
      });
    }
    await createAmazonExportBatch(testDb.db, {
      organizationId,
      profileId,
      adProduct: SP,
      exportTypes: ['campaigns', 'adGroups'],
      now: new Date(clock),
    });

    const outcome = await poll();

    expect(outcome.counters).toMatchObject({ requested: 1, exportsWaiting: 1 });
    const waiting = (await requests()).find((r) => r.reportType === 'campaigns');
    // Erst wieder fällig, wenn einer der laufenden Exports fertig sein kann.
    expect(waiting).toMatchObject({
      status: 'pending_request',
      nextPollAt: new Date(clock + 600_000),
    });
  });

  it(`bearbeitet höchstens ${POLL_LIMITS.maxRequests} Aufträge je Lauf und plant sofort den nächsten ein`, async () => {
    for (let day = 1; day <= POLL_LIMITS.maxRequests + 2; day++) {
      const date = `2026-08-${String(day).padStart(2, '0')}`;
      await report({ startDate: date, endDate: date });
    }

    const outcome = await poll();

    expect(outcome.counters).toMatchObject({ requested: POLL_LIMITS.maxRequests });
    expect(enqueued).toEqual([expect.objectContaining({ startAfterSeconds: 5 })]);
  });

  it('bleibt bei den Profilen der eigenen Connection', async () => {
    const otherConnectionId = await createConnection(testDb.db, {
      organizationId,
      externalAccountId: 'amzn1.account.OTHER',
    });
    await report();
    const outcome = await pollAmazonRequests(
      deps(),
      { organizationId, connectionId: otherConnectionId },
      run(),
    );
    expect(outcome.counters).toMatchObject({ requested: 0 });
    expect((await requests())[0]).toMatchObject({ status: 'pending_request' });
  });

  it('läuft nicht für Connections, die neu verbunden werden müssen', async () => {
    const reauth = await createConnection(testDb.db, {
      organizationId,
      externalAccountId: 'amzn1.account.REAUTH',
      status: 'reauth_required',
    });
    await expect(
      pollAmazonRequests(deps(), { organizationId, connectionId: reauth }, run()),
    ).rejects.toThrow(/neu verbunden/);
  });
});
