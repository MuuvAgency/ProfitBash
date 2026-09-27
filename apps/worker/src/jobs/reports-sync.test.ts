import { createMockAmazonAdsClient, createRequestMeter } from '@profitbash/amazon-ads';
import { createConnectionTokenStore, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobFailure } from '../run-job';
import { createConnection, createOrganization, testKeyring } from '../testing';
import type { ConnectionJobData, ConnectionJobDeps, ConnectionQueue } from './connection-job';
import { syncConnectionProfiles } from './profiles-sync';
import { syncConnectionReports } from './reports-sync';

const { amazonAdsBackfills, amazonAdsProfiles, amazonAdsReportRequests, jobRuns } = schema;

const SP = 'SPONSORED_PRODUCTS';
const DE = '9007199254740993';
/** 08:00 in Berlin: heute 27.09., gestern 26.09., Fenster 28.08.–26.09. */
const START = Date.parse('2026-09-27T06:00:00Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let testDb: TestDatabase;
let organizationId = '';
let connectionId = '';
let profileId = '';
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

const run = (runId: string | null = null) => ({
  meter: createRequestMeter(),
  runId,
  extendLease: () => Promise.resolve(),
});
const sync = (runId: string | null = null) =>
  syncConnectionReports(deps(), { organizationId, connectionId }, run(runId));

async function reportsOf(reportType: string) {
  const rows = await testDb.db
    .select()
    .from(amazonAdsReportRequests)
    .where(
      and(
        eq(amazonAdsReportRequests.profileId, profileId),
        eq(amazonAdsReportRequests.reportType, reportType),
      ),
    )
    .orderBy(amazonAdsReportRequests.startDate);
  return rows;
}

const ranges = (rows: Array<{ startDate: string | null; endDate: string | null }>) =>
  rows.map((row) => `${row.startDate}..${row.endDate}`);

async function setStatus(reportType: string, status: 'imported' | 'failed') {
  await testDb.db
    .update(amazonAdsReportRequests)
    .set({ status, nextPollAt: null })
    .where(
      and(
        eq(amazonAdsReportRequests.profileId, profileId),
        eq(amazonAdsReportRequests.reportType, reportType),
      ),
    );
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
  connectionId = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: 'amzn1.account.MOCK',
  });
  await syncConnectionProfiles(deps(), { organizationId, connectionId }, run());
  const [de] = await testDb.db
    .select({ id: amazonAdsProfiles.id })
    .from(amazonAdsProfiles)
    .where(eq(amazonAdsProfiles.amazonProfileId, DE));
  profileId = de!.id;
  // Nur das DE-Profil (Zeitzone Berlin) bleibt aktiv; die übrigen zählen als entfernt.
  await testDb.db.update(amazonAdsProfiles).set({ removedAt: new Date(START) });
  await testDb.db
    .update(amazonAdsProfiles)
    .set({ removedAt: null, isHidden: true, timezone: 'Europe/Berlin' })
    .where(eq(amazonAdsProfiles.id, profileId));
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  clock = START;
  enqueued.length = 0;
  await testDb.db.delete(amazonAdsReportRequests);
  await testDb.db.delete(amazonAdsBackfills);
  await testDb.db.delete(jobRuns);
});

describe('syncConnectionReports', () => {
  it('fordert je Report-Typ das rollierende Fenster und die Historie in 31-Tage-Stücken an', async () => {
    const outcome = await sync();

    // 5 Fenster, je 3 Stücke Historie (95 Tage) bzw. 2 bei Suchbegriffen (65 Tage).
    expect(outcome.counters).toMatchObject({ profiles: 1, requested: 19, failedSinceLastRun: 0 });
    expect(ranges(await reportsOf('spCampaigns'))).toEqual([
      '2026-06-26..2026-07-26',
      '2026-07-27..2026-08-26',
      '2026-08-27..2026-08-27',
      '2026-08-28..2026-09-26',
    ]);
    expect(ranges(await reportsOf('spSearchTerm'))).toEqual([
      '2026-07-26..2026-08-25',
      '2026-08-26..2026-08-27',
      '2026-08-28..2026-09-26',
    ]);
    expect((await reportsOf('spAdGroups')).every((r) => r.adProduct === SP)).toBe(true);
    const backfills = await testDb.db.select().from(amazonAdsBackfills);
    expect(backfills).toHaveLength(5);
    expect(backfills.find((b) => b.reportType === 'spCampaigns')).toMatchObject({
      fromDate: '2026-06-26',
      completedAt: null,
    });
    expect(enqueued).toEqual([
      {
        queue: 'amazon-requests-poll',
        job: { organizationId, connectionId },
        startAfterSeconds: 60,
      },
    ]);
  });

  it('fordert nichts doppelt an, solange Aufträge offen sind', async () => {
    await sync();
    const second = await sync();
    expect(second.counters).toMatchObject({ requested: 0 });
  });

  it('schließt die Historie ab, sobald alle Stücke importiert sind, und schiebt das Fenster täglich weiter', async () => {
    await sync();
    await setStatus('spCampaigns', 'imported');
    clock += DAY_MS;

    const outcome = await sync();

    expect(outcome.counters?.backfillsCompleted).toBe(1);
    const [marker] = await testDb.db
      .select()
      .from(amazonAdsBackfills)
      .where(eq(amazonAdsBackfills.reportType, 'spCampaigns'));
    expect(marker?.completedAt).toEqual(new Date(clock));
    // Neues Fenster, keine neuen Stücke (der 28.08. lag im Fenster von gestern).
    expect(ranges(await reportsOf('spCampaigns'))).toEqual([
      '2026-06-26..2026-07-26',
      '2026-07-27..2026-08-26',
      '2026-08-27..2026-08-27',
      '2026-08-28..2026-09-26',
      '2026-08-29..2026-09-27',
    ]);
  });

  it('fordert gescheiterte Stücke erneut an, soweit Amazon sie noch vorhält', async () => {
    await sync();
    await setStatus('spSearchTerm', 'failed');
    clock += 10 * DAY_MS;

    // Die gescheiterten Aufträge melden sich als Alarm; die Stücke kommen trotzdem neu.
    await expect(sync()).rejects.toThrow(/Amazon-Aufträge seit dem letzten Lauf gescheitert/);

    // Heute 07.10.: Suchbegriffe reichen bis 05.08. zurück, das Fenster beginnt am 07.09.
    const open = (await reportsOf('spSearchTerm')).filter((r) => r.status !== 'failed');
    expect(ranges(open)).toEqual([
      '2026-08-05..2026-09-04',
      '2026-09-05..2026-09-06',
      '2026-09-07..2026-10-06',
    ]);
  });

  it('zählt Aufträge, die seit dem letzten Lauf gescheitert sind', async () => {
    await testDb.db.insert(jobRuns).values({
      organizationId,
      job: 'reports-sync',
      scope: connectionId,
      status: 'success',
      startedAt: new Date(START - 2 * DAY_MS),
      finishedAt: new Date(START - DAY_MS),
    });
    await testDb.db.insert(jobRuns).values({
      organizationId,
      job: 'reports-sync',
      scope: 'andere-connection',
      status: 'success',
      startedAt: new Date(START),
      finishedAt: new Date(START),
    });
    await sync();
    await setStatus('spTargeting', 'failed');
    // Die Stücke der Historie scheiterten vor dem letzten Lauf, das Fenster danach.
    await testDb.db
      .update(amazonAdsReportRequests)
      .set({ updatedAt: new Date(START - 3 * DAY_MS) })
      .where(eq(amazonAdsReportRequests.reportType, 'spTargeting'));
    await testDb.db
      .update(amazonAdsReportRequests)
      .set({ updatedAt: new Date(START) })
      .where(
        and(
          eq(amazonAdsReportRequests.reportType, 'spTargeting'),
          eq(amazonAdsReportRequests.startDate, '2026-08-28'),
        ),
      );

    const [current] = await testDb.db
      .insert(jobRuns)
      .values({ organizationId, job: 'reports-sync', scope: connectionId })
      .returning({ id: jobRuns.id });
    // Der Lauf scheitert (Healthcheck-Alarm), erledigt seine Arbeit aber vorher.
    const error = await sync(current!.id).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(JobFailure);
    expect((error as JobFailure).message).toMatch(/1 Amazon-Auftrag .* gescheitert/);
    expect((error as JobFailure).counters).toMatchObject({ failedSinceLastRun: 1 });
    expect(enqueued).toContainEqual(expect.objectContaining({ queue: 'amazon-requests-poll' }));
  });
});
