import { AmazonAdsHttpError, createRequestMeter } from '@profitbash/amazon-ads';
import {
  AmazonSpRoleMissingError,
  createMockAmazonSpClient,
  MOCK_AMAZON_SP_REFRESH_TOKEN,
  type AmazonSpClient,
} from '@profitbash/amazon-sp';
import { createConnectionTokenStore, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobFailure } from '../run-job';
import { createConnection, createOrganization, testKeyring } from '../testing';
import type { ConnectionJobData, ConnectionJobDeps, ConnectionQueue } from './connection-job';
import {
  SP_ORDERS_BY_DATE,
  SP_ORDERS_BY_UPDATE,
  SP_ORDERS_LIMITS,
  syncSpOrders,
} from './sp-orders-sync';

const {
  amazonSpAccounts,
  amazonSpDailySales,
  amazonSpOrderItems,
  amazonSpReportRequests,
  connections,
} = schema;

const START = Date.parse('2026-10-16T04:00:00Z');
const HOUR = 3_600_000;

let testDb: TestDatabase;
let organizationId = '';
let clock = START;
const enqueued: Array<{
  queue: ConnectionQueue;
  job: ConnectionJobData;
  startAfterSeconds?: number;
}> = [];

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
});

afterAll(async () => {
  await testDb.close();
});

async function createSellerConnection(
  sellerId: string,
  refreshToken = MOCK_AMAZON_SP_REFRESH_TOKEN,
) {
  const connectionId = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: sellerId,
    provider: 'amazon_sp',
    refreshToken,
  });
  const account = (marketplaceId: string, countryCode: string) => ({
    organizationId,
    connectionId,
    amazonSellerId: sellerId,
    marketplaceId,
    storeName: 'Mock Seller',
    countryCode,
    currencyCode: 'EUR',
    timezone: countryCode === 'DE' ? 'Europe/Berlin' : 'Europe/Paris',
  });
  const rows = await testDb.db
    .insert(amazonSpAccounts)
    .values([account('A1PA6795UKMFR9', 'DE'), account('A13V1IB3VIYZZH', 'FR')])
    .returning({ id: amazonSpAccounts.id });
  return { connectionId, de: rows[0]!.id, fr: rows[1]!.id };
}

function deps(amazonSp?: AmazonSpClient): ConnectionJobDeps {
  return {
    db: testDb.db,
    logger: () => {},
    amazonAds: {} as ConnectionJobDeps['amazonAds'],
    amazonSp:
      amazonSp ??
      createMockAmazonSpClient({
        store: createConnectionTokenStore({ db: testDb.db, keyring: testKeyring }),
        simulation: { now: () => clock, processingMs: 5_000 },
        http: { sleep: async () => {} },
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

const requestsOf = (sellerAccountId: string) =>
  testDb.db
    .select()
    .from(amazonSpReportRequests)
    .where(eq(amazonSpReportRequests.sellerAccountId, sellerAccountId))
    .orderBy(amazonSpReportRequests.dataStart);

beforeEach(() => {
  clock = START;
  enqueued.length = 0;
});

describe('syncSpOrders gegen den Mock', () => {
  let ids: Awaited<ReturnType<typeof createSellerConnection>>;
  const job = () => ({ organizationId, connectionId: ids.connectionId });

  beforeAll(async () => {
    ids = await createSellerConnection('A1MOCKSELLER01');
  });

  it('plant je Konto 12 Monate Historie in 30-Tage-Scheiben und das rollierende Fenster', async () => {
    const outcome = await syncSpOrders(deps(), job(), run());

    const de = await requestsOf(ids.de);
    expect(de.filter((r) => r.reportType === SP_ORDERS_BY_DATE)).toHaveLength(12);
    const rolling = de.filter((r) => r.reportType === SP_ORDERS_BY_UPDATE);
    expect(rolling).toHaveLength(1);
    expect(rolling[0]!.dataEnd.getTime() - rolling[0]!.dataStart.getTime()).toBe(30 * 24 * HOUR);
    for (const request of de) {
      expect(request.dataEnd.getTime() - request.dataStart.getTime()).toBeLessThanOrEqual(
        30 * 24 * HOUR,
      );
    }
    // Lückenlos: von 365 Tagen vor dem Ende bis zum Ende des rollierenden Fensters.
    expect(de[0]!.dataStart.getTime()).toBe(rolling[0]!.dataEnd.getTime() - 365 * 24 * HOUR);
    expect(await requestsOf(ids.fr)).toHaveLength(13);
    expect(outcome.counters).toMatchObject({
      planned: 26,
      requested: SP_ORDERS_LIMITS.maxRequests,
    });
    // Das rollierende Fenster geht vor der Historie.
    const fr = await requestsOf(ids.fr);
    for (const request of [...de, ...fr].filter((r) => r.reportType === SP_ORDERS_BY_UPDATE)) {
      expect(request.status).toBe('requested');
    }
    const accounts = await testDb.db.select().from(amazonSpAccounts);
    expect(accounts.every((a) => a.ordersHistoryRequestedAt !== null)).toBe(true);
    expect(enqueued).toEqual([expect.objectContaining({ queue: 'sp-orders-sync', job: job() })]);
  });

  it('lädt die Berichte, speichert Positionen ohne Käuferdaten und verdichtet Tageswerte', async () => {
    for (let i = 0; i < 20; i += 1) {
      clock += 10 * 60_000;
      await syncSpOrders(deps(), job(), run());
      const open = (await requestsOf(ids.de))
        .concat(await requestsOf(ids.fr))
        .filter((r) => r.status !== 'imported');
      if (open.length === 0) break;
    }
    const all = [...(await requestsOf(ids.de)), ...(await requestsOf(ids.fr))];
    expect(all.every((r) => r.status === 'imported')).toBe(true);

    const items = await testDb.db
      .select()
      .from(amazonSpOrderItems)
      .where(eq(amazonSpOrderItems.sellerAccountId, ids.de));
    expect(items.length).toBeGreaterThan(300);
    expect(JSON.stringify(items)).not.toMatch(/Musterstadt|12345|Nordwind T-Shirt/);

    // 22:30 UTC ist in Berlin im Sommer (UTC+2) schon der nächste Tag.
    const late = items.find(
      (item) => item.purchasedAt.getUTCHours() === 22 && item.purchasedAt.getUTCMonth() === 8,
    )!;
    const nextDay = new Date(late.purchasedAt.getTime() + 2 * HOUR).toISOString().slice(0, 10);
    expect(late.purchaseDate).toBe(nextDay);

    // Tageswerte = nicht stornierte Positionen.
    const [expected] = await testDb.db
      .select({ units: sql<number>`sum(${amazonSpOrderItems.quantity})::int` })
      .from(amazonSpOrderItems)
      .where(
        and(
          eq(amazonSpOrderItems.sellerAccountId, ids.de),
          sql`${amazonSpOrderItems.orderStatus} <> 'Cancelled'`,
        ),
      );
    const [actual] = await testDb.db
      .select({ units: sql<number>`sum(${amazonSpDailySales.units})::int` })
      .from(amazonSpDailySales)
      .where(eq(amazonSpDailySales.sellerAccountId, ids.de));
    expect(actual!.units).toBe(expected!.units);
    expect(items.some((item) => item.orderStatus === 'Cancelled')).toBe(true);
  });

  it('plant das rollierende Fenster erst nach 20 h erneut, die Historie nie wieder', async () => {
    const before = (await requestsOf(ids.de)).length;
    clock += 10 * 60 * 60_000;
    await syncSpOrders(deps(), job(), run());
    expect(await requestsOf(ids.de)).toHaveLength(before);

    clock += 24 * HOUR;
    await syncSpOrders(deps(), job(), run());
    const after = await requestsOf(ids.de);
    expect(after).toHaveLength(before + 1);
    expect(after.at(-1)!.reportType).toBe(SP_ORDERS_BY_UPDATE);
  });
});

describe('syncSpOrders: Grenzfälle', () => {
  type Overrides = Partial<AmazonSpClient>;
  function stub(overrides: Overrides): AmazonSpClient {
    const unused = () => Promise.reject(new Error('nicht benutzt'));
    return {
      getMarketplaceParticipations: unused,
      createReport: () => Promise.resolve({ reportId: 'r-1' }),
      getReport: unused,
      getReportDocument: () =>
        Promise.resolve({ url: 'https://x.s3.amazonaws.com/doc', compressionAlgorithm: null }),
      downloadReportDocument: unused,
      invalidateAccessToken: () => {},
      ...overrides,
    };
  }

  /** Neue Connection mit genau einem offenen Auftrag (Historie als angefordert markiert). */
  async function setup() {
    const ids = await createSellerConnection(`A1EDGE${Math.random().toString(36).slice(2, 8)}`);
    await testDb.db
      .update(amazonSpAccounts)
      .set({ ordersHistoryRequestedAt: new Date(clock) })
      .where(eq(amazonSpAccounts.connectionId, ids.connectionId));
    await testDb.db
      .update(amazonSpAccounts)
      .set({ removedAt: new Date(clock) })
      .where(eq(amazonSpAccounts.id, ids.fr));
    return { ...ids, job: { organizationId, connectionId: ids.connectionId } };
  }

  async function runUntilSettled(client: AmazonSpClient, job: ConnectionJobData, rounds = 6) {
    let error: unknown = null;
    for (let i = 0; i < rounds; i += 1) {
      try {
        await syncSpOrders(deps(client), job, run());
      } catch (err) {
        error = err;
      }
      clock += 30 * 60_000;
    }
    return error;
  }

  it('CANCELLED gilt als leerer Bericht', async () => {
    const { de, job } = await setup();
    const client = stub({ getReport: () => Promise.resolve({ status: 'CANCELLED' }) });

    await syncSpOrders(deps(client), job, run());
    clock += 2 * 60_000;
    await syncSpOrders(deps(client), job, run());

    const [request] = await requestsOf(de);
    expect(request).toMatchObject({ status: 'imported', rowCount: 0 });
  });

  it('FATAL lässt den Auftrag scheitern und den Lauf mit Hinweis enden', async () => {
    const { de, job } = await setup();
    const client = stub({ getReport: () => Promise.resolve({ status: 'FATAL' }) });

    await syncSpOrders(deps(client), job, run());
    clock += 2 * 60_000;
    await expect(syncSpOrders(deps(client), job, run())).rejects.toThrow(JobFailure);

    const [request] = await requestsOf(de);
    expect(request!.status).toBe('failed');
  });

  it('fordert neu an, wenn Amazon den Bericht nicht mehr kennt, höchstens dreimal', async () => {
    const { de, job } = await setup();
    let created = 0;
    const client = stub({
      createReport: () => Promise.resolve({ reportId: `r-${(created += 1)}` }),
      getReport: () => Promise.resolve({ status: 'NOT_FOUND' }),
    });

    await runUntilSettled(client, job);

    const [request] = await requestsOf(de);
    expect(created).toBe(3);
    expect(request).toMatchObject({ status: 'failed', requestCount: 3 });
  });

  it('holt die Dokument-URL erneut, wenn sie abgelaufen ist, und lädt dann', async () => {
    const { de, job } = await setup();
    let downloads = 0;
    const client = stub({
      getReport: () => Promise.resolve({ status: 'DONE', reportDocumentId: 'd-1' }),
      downloadReportDocument: () =>
        Promise.resolve(
          (downloads += 1) === 1
            ? { status: 'expired' as const }
            : {
                status: 'ok' as const,
                text: 'amazon-order-id\tpurchase-date\tlast-updated-date\torder-status\tsku\tquantity\tship-city\n302-9\t2026-10-01T09:00:00+00:00\t2026-10-01T09:00:00+00:00\tShipped\tNW-1\t2\tMusterstadt\n',
              },
        ),
    });

    await syncSpOrders(deps(client), job, run());
    clock += 2 * 60_000;
    await syncSpOrders(deps(client), job, run());

    const [request] = await requestsOf(de);
    expect(request).toMatchObject({ status: 'imported', rowCount: 1 });
    expect(downloads).toBe(2);
  });

  it('meldet eine fehlende Rolle am Auftrag (SP_ROLE_MISSING)', async () => {
    const { de, job } = await setup();
    const client = stub({
      createReport: () =>
        Promise.reject(new AmazonSpRoleMissingError('reports.create', null, null)),
    });

    await expect(syncSpOrders(deps(client), job, run())).rejects.toThrow(/SP_ROLE_MISSING|Rolle/);

    const [request] = await requestsOf(de);
    expect(request!.status).toBe('failed');
    expect(request!.failureReason).toMatch(/SP_ROLE_MISSING|Rolle/);
  });

  it('versucht es bei vorübergehenden Fehlern später erneut', async () => {
    const { de, job } = await setup();
    const client = stub({
      createReport: () =>
        Promise.reject(new AmazonAdsHttpError('kaputt', 'reports.create', 503, null, null)),
    });

    await syncSpOrders(deps(client), job, run());

    const [request] = await requestsOf(de);
    expect(request).toMatchObject({ status: 'pending_request', errorCount: 1 });
    expect(request!.nextPollAt!.getTime()).toBeGreaterThan(clock);
  });

  it('lässt offene Aufträge eines entfernten Kontos scheitern und plant dafür nichts Neues', async () => {
    const { de, job } = await setup();
    const client = stub({});
    await syncSpOrders(deps(client), job, run());
    await testDb.db
      .update(amazonSpAccounts)
      .set({ removedAt: new Date(clock) })
      .where(eq(amazonSpAccounts.id, de));
    clock += 2 * 60_000;
    enqueued.length = 0;

    await syncSpOrders(deps(client), job, run());

    const requests = await requestsOf(de);
    expect(requests.map((r) => r.status)).toEqual(['failed']);
    expect(enqueued).toEqual([]);
  });

  it('markiert die Connection bei abgelehntem Refresh-Token zum Neu-Verbinden', async () => {
    const ids = await createSellerConnection('A1REVOKED', 'Atzr|widerrufen');

    await expect(
      syncSpOrders(deps(), { organizationId, connectionId: ids.connectionId }, run()),
    ).rejects.toThrow(/neu verbunden/);

    const [connection] = await testDb.db
      .select()
      .from(connections)
      .where(eq(connections.id, ids.connectionId));
    expect(connection!.status).toBe('reauth_required');
  });
});
