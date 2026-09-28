import {
  AmazonAdsHttpError,
  createMockAmazonAdsClient,
  createRequestMeter,
  type AmazonAdsClient,
} from '@profitbash/amazon-ads';
import {
  createAmazonExportBatch,
  createConnectionTokenStore,
  schema,
  updateAmazonRequest,
  upsertPortfolios,
} from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { LogEntry } from '@profitbash/shared';
import { eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobFailure } from '../run-job';
import { createConnection, createOrganization, testKeyring } from '../testing';
import { DATA_JOB_TIME_BUDGET_MS, MAX_RUNNING_EXPORTS_PER_TYPE } from './amazon-context';
import {
  LeaseLostError,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionQueue,
  type ScheduledRetry,
} from './connection-job';
import { ENTITY_AD_PRODUCTS, syncConnectionEntities } from './entities-sync';
import { syncConnectionProfiles } from './profiles-sync';

const { amazonAdsPortfolios, amazonAdsProfiles, amazonAdsReportRequests } = schema;

const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const DE = '9007199254740993';
/** Exports je Batch (Kampagnen, Ad Groups, Targets, Ads). */
const EXPORTS_PER_BATCH = 4;
/** Batches je Profil: einer je Ad-Typ, auch ohne Kampagnen dieses Typs (1.9). */
const BATCHES_PER_PROFILE = ENTITY_AD_PRODUCTS.length;
/** Angeforderte Exports für so viele neue Batches; ab `MAX_RUNNING_EXPORTS_PER_TYPE` warten sie. */
const requestedFor = (batches: number) =>
  Math.min(batches, MAX_RUNNING_EXPORTS_PER_TYPE) * EXPORTS_PER_BATCH;
const START = Date.parse('2026-09-27T06:00:00Z');

let testDb: TestDatabase;
let organizationId = '';
let connectionId = '';
let profiles: Array<{ id: string; amazonProfileId: string }> = [];
let clock = START;
let client: AmazonAdsClient;
const retries: ScheduledRetry[] = [];
const logs: LogEntry[] = [];
let enqueueAccepted = true;
const enqueued: Array<{
  queue: ConnectionQueue;
  job: ConnectionJobData;
  startAfterSeconds?: number;
}> = [];

const deProfileId = () => profiles.find((p) => p.amazonProfileId === DE)!.id;

function deps(amazonAds: AmazonAdsClient = client): ConnectionJobDeps {
  return {
    db: testDb.db,
    logger: (entry) => logs.push(entry),
    amazonAds,
    scheduleRetry(retry) {
      retries.push(retry);
      return Promise.resolve(true);
    },
    enqueue(queue, job, options) {
      enqueued.push({ queue, job, ...options });
      return Promise.resolve(enqueueAccepted);
    },
    now: () => new Date(clock),
  };
}

const run = () => ({
  meter: createRequestMeter(),
  runId: null,
  extendLease: () => Promise.resolve(),
});
const sync = (job: Partial<ConnectionJobData> = {}, d = deps()) =>
  syncConnectionEntities(d, { organizationId, connectionId, ...job }, run());

async function exportsOf(profileId: string) {
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
  client = createMockAmazonAdsClient({
    redirectUri: 'http://localhost/cb',
    consentUrl: 'http://localhost/consent',
    store: createConnectionTokenStore({ db: testDb.db, keyring: testKeyring }),
    rateLimit: { requestsPerSecond: 100 },
    simulation: { now: () => clock, processingMs: 60_000 },
  });
  await syncConnectionProfiles(deps(), { organizationId, connectionId }, run());
  // Reihenfolge wie im Job (Fortsetzen nach Zeitbudget).
  profiles = await testDb.db
    .select({ id: amazonAdsProfiles.id, amazonProfileId: amazonAdsProfiles.amazonProfileId })
    .from(amazonAdsProfiles)
    .orderBy(amazonAdsProfiles.createdAt, amazonAdsProfiles.id);
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  clock = START;
  enqueued.length = 0;
  retries.length = 0;
  logs.length = 0;
  enqueueAccepted = true;
  await testDb.db.delete(amazonAdsReportRequests);
  await testDb.db.update(amazonAdsProfiles).set({ removedAt: null, isHidden: false });
});

describe('syncConnectionEntities', () => {
  it('liest Portfolios direkt, fordert je Profil einen Export-Batch an und plant den Poll ein', async () => {
    const outcome = await sync();

    const batches = profiles.length * BATCHES_PER_PROFILE;
    expect(outcome.counters).toMatchObject({
      profiles: profiles.length,
      requested: requestedFor(batches),
      exportsWaiting: batches - Math.min(batches, MAX_RUNNING_EXPORTS_PER_TYPE),
    });
    expect(outcome.counters?.created).toBeGreaterThan(0);
    // Das erste Profil (Reihenfolge des Jobs) bekommt je Ad-Typ einen Batch mit vier Exports, beide
    // angefordert. Spätere Profile können auf einen Export-Platz warten.
    const exports = await exportsOf(profiles[0]!.id);
    for (const adProduct of [SP, SB]) {
      const batch = exports.filter((e) => e.adProduct === adProduct);
      expect(batch.map((e) => e.reportType).sort()).toEqual([
        'adGroups',
        'ads',
        'campaigns',
        'targets',
      ]);
      expect(new Set(batch.map((e) => e.batchId)).size).toBe(1);
    }
    expect(exports.every((e) => e.status === 'requested')).toBe(true);
    const portfolios = await testDb.db
      .select()
      .from(amazonAdsPortfolios)
      .where(eq(amazonAdsPortfolios.profileId, deProfileId()));
    expect(portfolios.length).toBeGreaterThan(0);
    // Wartende Batches sind sofort fällig: Der Poll prüft bald, ob ein Export-Platz frei ist.
    expect(enqueued).toEqual([
      {
        queue: 'amazon-requests-poll',
        job: { organizationId, connectionId },
        startAfterSeconds: 5,
      },
    ]);
  });

  it('startet keinen neuen Batch, solange der vorige offen ist', async () => {
    await sync();
    const second = await sync();
    expect(second.counters).toMatchObject({ requested: 0 });
    expect((await exportsOf(deProfileId())).length).toBe(BATCHES_PER_PROFILE * EXPORTS_PER_BATCH);
  });

  it('synchronisiert ausgeblendete Profile (F14), entfernte nicht', async () => {
    const [hidden, removed] = profiles.filter((p) => p.amazonProfileId !== DE);
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, hidden!.id));
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ removedAt: new Date(START) })
      .where(eq(amazonAdsProfiles.id, removed!.id));

    const outcome = await sync();

    expect(outcome.counters).toMatchObject({ profiles: profiles.length - 1 });
    expect((await exportsOf(hidden!.id)).length).toBe(BATCHES_PER_PROFILE * EXPORTS_PER_BATCH);
    expect(await exportsOf(removed!.id)).toEqual([]);
  });

  it('markiert Portfolios als entfernt, die Amazon nicht mehr liefert', async () => {
    await upsertPortfolios(
      testDb.db,
      { organizationId, profileId: deProfileId(), now: new Date(START) },
      [
        {
          amazonPortfolioId: 'pf-weg',
          name: 'Gelöscht',
          state: 'ENABLED',
          budgetAmount: null,
          budgetCurrencyCode: null,
          budgetPolicy: null,
          budgetStartDate: null,
          budgetEndDate: null,
          inBudget: null,
          amazonUpdatedAt: null,
          extra: {},
        },
      ],
    );
    // Bestand vor dem Lauf (die Uhr der Datenbank läuft real).
    clock = Date.parse('2100-01-01T00:00:00Z');

    const outcome = await sync();

    expect(outcome.counters).toMatchObject({ removed: 1 });
    const removed = await testDb.db
      .select({ id: amazonAdsPortfolios.amazonPortfolioId })
      .from(amazonAdsPortfolios)
      .where(isNotNull(amazonAdsPortfolios.removedAt));
    expect(removed).toEqual([{ id: 'pf-weg' }]);
  });

  it('legt Batches ohne freien Export-Platz nur an; der Poll fordert sie später an', async () => {
    const others = profiles.filter((p) => p.amazonProfileId !== DE);
    for (let i = 0; i < MAX_RUNNING_EXPORTS_PER_TYPE; i++) {
      const { requests } = await createAmazonExportBatch(testDb.db, {
        organizationId,
        profileId: others[i % others.length]!.id,
        adProduct: ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY'][Math.floor(i / 3)]!,
        exportTypes: ['campaigns', 'adGroups', 'targets', 'ads'],
        now: new Date(clock),
      });
      for (const request of requests) {
        await updateAmazonRequest(testDb.db, request, { status: 'requested' });
      }
    }

    const outcome = await sync();

    // SP für alle Profile, SB nur für DE (die übrigen haben schon einen offenen SB-Batch).
    expect(outcome.counters).toMatchObject({ requested: 0, exportsWaiting: profiles.length + 1 });
    const waiting = await exportsOf(deProfileId());
    expect(waiting.filter((e) => e.adProduct === SP).map((e) => e.status)).toEqual([
      'pending_request',
      'pending_request',
      'pending_request',
      'pending_request',
    ]);
  });

  it('plant mit chain danach reports-sync ein', async () => {
    await sync({ chain: true });
    expect(enqueued).toContainEqual({
      queue: 'reports-sync',
      job: { organizationId, connectionId },
    });
  });

  it('macht mit den übrigen Profilen weiter, wenn eines scheitert, und meldet den Lauf als gescheitert', async () => {
    const failing = createMockAmazonAdsClient({
      redirectUri: 'http://localhost/cb',
      consentUrl: 'http://localhost/consent',
      store: createConnectionTokenStore({ db: testDb.db, keyring: testKeyring }),
      rateLimit: { requestsPerSecond: 100 },
      simulation: { now: () => clock, processingMs: 60_000 },
    });
    const amazonAds: AmazonAdsClient = {
      ...failing,
      listPortfolios: (connection, amazonProfileId, options) =>
        amazonProfileId === DE
          ? Promise.reject(new AmazonAdsHttpError('Verboten', 'portfolios.list', 403, null, null))
          : failing.listPortfolios(connection, amazonProfileId, options),
    };

    const error = await sync({ chain: true }, deps(amazonAds)).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(JobFailure);
    expect((error as JobFailure).message).toMatch(/1 von \d+ Profilen/);
    expect((error as JobFailure).counters).toMatchObject({
      profileErrors: 1,
      requested: requestedFor((profiles.length - 1) * BATCHES_PER_PROFILE),
    });
    expect(await exportsOf(deProfileId())).toEqual([]);
    // Die Kette läuft trotzdem weiter (Reports der übrigen Profile).
    expect(enqueued).toContainEqual(expect.objectContaining({ queue: 'reports-sync' }));
  });

  it('setzt nach Ablauf des Zeitbudgets in einem neuen Lauf beim nächsten Profil fort', async () => {
    const slow: AmazonAdsClient = {
      ...client,
      listPortfolios: (connection, amazonProfileId, options) => {
        clock += DATA_JOB_TIME_BUDGET_MS + 1;
        return client.listPortfolios(connection, amazonProfileId, options);
      },
    };

    const outcome = await sync({ chain: true }, deps(slow));

    expect(outcome.counters).toMatchObject({ profiles: 1, continued: 1 });
    expect(enqueued).toContainEqual({
      queue: 'entities-sync',
      job: { organizationId, connectionId, chain: true, resumeFromProfileId: profiles[1]!.id },
    });
    // Die Kette geht erst nach dem letzten Profil weiter.
    expect(enqueued).not.toContainEqual(expect.objectContaining({ queue: 'reports-sync' }));

    enqueued.length = 0;
    const resumed = await sync({ chain: true, resumeFromProfileId: profiles[1]!.id });
    expect(resumed.counters).toMatchObject({ profiles: profiles.length - 1 });
    expect(await exportsOf(profiles[0]!.id)).toHaveLength(BATCHES_PER_PROFILE * EXPORTS_PER_BATCH);
    expect(enqueued).toContainEqual(expect.objectContaining({ queue: 'reports-sync' }));
  });

  it('setzt nach Retry-After beim gedrosselten Profil fort und behält die Zähler', async () => {
    const throttled: AmazonAdsClient = {
      ...client,
      listPortfolios: (connection, amazonProfileId, options) =>
        amazonProfileId === profiles[1]!.amazonProfileId
          ? Promise.reject(
              new AmazonAdsHttpError('Rate-Limit', 'portfolios.list', 429, null, null, 30_000),
            )
          : client.listPortfolios(connection, amazonProfileId, options),
    };

    const error = await sync({ chain: true }, deps(throttled)).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(JobFailure);
    expect((error as JobFailure).counters).toMatchObject({
      profiles: 2,
      requested: requestedFor(BATCHES_PER_PROFILE),
    });
    expect(retries).toEqual([
      {
        queue: 'entities-sync',
        job: {
          organizationId,
          connectionId,
          retryAttempt: 1,
          chain: true,
          resumeFromProfileId: profiles[1]!.id,
        },
        startAfterSeconds: 30,
      },
    ]);
  });

  it('bricht ab, wenn die Lease verloren geht, statt Profile als gescheitert zu zählen', async () => {
    let calls = 0;
    const lost = {
      meter: createRequestMeter(),
      runId: null,
      extendLease: () => {
        calls += 1;
        return calls > 1 ? Promise.reject(new LeaseLostError()) : Promise.resolve();
      },
    };

    await expect(
      syncConnectionEntities(deps(), { organizationId, connectionId, chain: true }, lost),
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(enqueued).not.toContainEqual(expect.objectContaining({ queue: 'reports-sync' }));
  });

  it('loggt, wenn die Kette wegfällt, weil für die Connection schon ein Job wartet', async () => {
    enqueueAccepted = false;
    await sync({ chain: true });
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: 'job.follow_up_dropped',
        job: 'entities-sync',
        followUp: 'reports-sync',
        connectionId,
      }),
    );
  });

  it('bricht bei einem abgelehnten Refresh-Token sofort ab', async () => {
    const reauth = await createConnection(testDb.db, {
      organizationId,
      externalAccountId: 'amzn1.account.REAUTH',
      status: 'reauth_required',
    });
    await expect(
      syncConnectionEntities(deps(), { organizationId, connectionId: reauth }, run()),
    ).rejects.toThrow(/neu verbunden/);
  });
});
