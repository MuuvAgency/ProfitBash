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
import { eq, isNotNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobFailure } from '../run-job';
import { createConnection, createOrganization, testKeyring } from '../testing';
import { MAX_RUNNING_EXPORTS_PER_TYPE } from './amazon-context';
import type { ConnectionJobData, ConnectionJobDeps, ConnectionQueue } from './connection-job';
import { syncConnectionEntities } from './entities-sync';
import { syncConnectionProfiles } from './profiles-sync';

const { amazonAdsPortfolios, amazonAdsProfiles, amazonAdsReportRequests } = schema;

const SP = 'SPONSORED_PRODUCTS';
const DE = '9007199254740993';
const START = Date.parse('2026-09-27T06:00:00Z');

let testDb: TestDatabase;
let organizationId = '';
let connectionId = '';
let profiles: Array<{ id: string; amazonProfileId: string }> = [];
let clock = START;
let client: AmazonAdsClient;
const enqueued: Array<{
  queue: ConnectionQueue;
  job: ConnectionJobData;
  startAfterSeconds?: number;
}> = [];

const deProfileId = () => profiles.find((p) => p.amazonProfileId === DE)!.id;

function deps(amazonAds: AmazonAdsClient = client): ConnectionJobDeps {
  return {
    db: testDb.db,
    logger: () => {},
    amazonAds,
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
  profiles = await testDb.db
    .select({ id: amazonAdsProfiles.id, amazonProfileId: amazonAdsProfiles.amazonProfileId })
    .from(amazonAdsProfiles);
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  clock = START;
  enqueued.length = 0;
  await testDb.db.delete(amazonAdsReportRequests);
  await testDb.db.update(amazonAdsProfiles).set({ removedAt: null, isHidden: false });
});

describe('syncConnectionEntities', () => {
  it('liest Portfolios direkt, fordert je Profil einen Export-Batch an und plant den Poll ein', async () => {
    const outcome = await sync();

    expect(outcome.counters).toMatchObject({
      profiles: profiles.length,
      requested: profiles.length * 4,
      exportsWaiting: 0,
    });
    expect(outcome.counters?.created).toBeGreaterThan(0);
    const exports = await exportsOf(deProfileId());
    expect(exports.map((e) => e.reportType).sort()).toEqual([
      'adGroups',
      'ads',
      'campaigns',
      'targets',
    ]);
    expect(new Set(exports.map((e) => e.batchId)).size).toBe(1);
    expect(exports.every((e) => e.status === 'requested' && e.adProduct === SP)).toBe(true);
    const portfolios = await testDb.db
      .select()
      .from(amazonAdsPortfolios)
      .where(eq(amazonAdsPortfolios.profileId, deProfileId()));
    expect(portfolios.length).toBeGreaterThan(0);
    expect(enqueued).toEqual([
      {
        queue: 'amazon-requests-poll',
        job: { organizationId, connectionId },
        startAfterSeconds: 60,
      },
    ]);
  });

  it('startet keinen neuen Batch, solange der vorige offen ist', async () => {
    await sync();
    const second = await sync();
    expect(second.counters).toMatchObject({ requested: 0 });
    expect((await exportsOf(deProfileId())).length).toBe(4);
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
    expect((await exportsOf(hidden!.id)).length).toBe(4);
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

    expect(outcome.counters).toMatchObject({ requested: 0, exportsWaiting: profiles.length });
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
      requested: (profiles.length - 1) * 4,
    });
    expect(await exportsOf(deProfileId())).toEqual([]);
    // Die Kette läuft trotzdem weiter (Reports der übrigen Profile).
    expect(enqueued).toContainEqual(expect.objectContaining({ queue: 'reports-sync' }));
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
