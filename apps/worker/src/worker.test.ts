import { randomUUID } from 'node:crypto';
import { createMockAmazonAdsClient } from '@profitbash/amazon-ads';
import { acquireConnectionLease, createConnectionTokenStore, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { EcbRate } from '@profitbash/ecb';
import type { LogEntry } from '@profitbash/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, createOrganization, testKeyring } from './testing';
import { startJobQueue, startWorker, type Worker } from './worker';

const { amazonAdsProfiles, amazonAdsReportRequests, connectionJobLeases, fxRates, jobRuns } =
  schema;

let testDb: TestDatabase;
let organizationId = '';
let fetchFxRates = async (): Promise<EcbRate[]> => [
  { date: '2026-09-28', currency: 'USD', rate: '1.1378' },
];
const logs: LogEntry[] = [];

async function queuedJobs(name: string) {
  const rows = await testDb.db.execute<{ singleton_key: string | null; state: string }>(
    sql`select singleton_key, state from pgboss.job where name = ${name} order by created_on`,
  );
  return [...rows];
}

async function queuedFxRetries() {
  const rows = await testDb.db.execute<{ data: unknown; start_after: string }>(
    sql`select data, start_after::text as start_after from pgboss.job
        where name = 'fx-rates-sync' and state = 'created' and data is not null
        order by created_on`,
  );
  return [...rows];
}

async function waitFor<T>(fn: () => Promise<T | undefined>, timeoutMs = 10_000): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (value !== undefined) return value;
    if (Date.now() - started > timeoutMs) throw new Error('Zeitüberschreitung beim Warten');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
});

afterAll(async () => {
  await testDb.close();
});

describe('startWorker', () => {
  let worker: Worker;
  let connectionId = '';

  beforeAll(async () => {
    connectionId = await createConnection(testDb.db, {
      organizationId,
      externalAccountId: 'amzn1.account.MOCK',
    });
    worker = await startWorker({
      connectionString: testDb.url,
      db: testDb.db,
      amazonAds: createMockAmazonAdsClient({
        redirectUri: 'http://localhost:5173/api/amazon/oauth/callback',
        consentUrl: 'http://localhost:5173/api/amazon/oauth/mock-consent',
        store: createConnectionTokenStore({ db: testDb.db, keyring: testKeyring }),
        // Ohne Budget-Pause: Der Standard (2/s je Profil) machte die Kette im Test langsam.
        rateLimit: { requestsPerSecond: 100 },
      }),
      logger: (entry) => logs.push(entry),
      pollingIntervalSeconds: 0.5,
      // Kein Aufruf der echten EZB: ein Kurs, damit der Lauf beim Start etwas schreibt.
      fetchFxRates: () => fetchFxRates(),
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  it('richtet die Zeitpläne ein (Refresh stündlich, Profile 05:00, Entities, Reports und Kurse 06:00 Berlin, Poll alle 10 Min.)', async () => {
    const rows = await testDb.db.execute<{ name: string; cron: string; timezone: string }>(
      sql`select name, cron, timezone from pgboss.schedule order by name`,
    );
    expect([...rows]).toEqual([
      { name: 'amazon-requests-poll-all', cron: '*/10 * * * *', timezone: 'UTC' },
      { name: 'entities-sync-all', cron: '0 6 * * *', timezone: 'Europe/Berlin' },
      { name: 'file-import-all', cron: '*/10 * * * *', timezone: 'UTC' },
      { name: 'fx-rates-sync', cron: '0 6 * * *', timezone: 'Europe/Berlin' },
      { name: 'job-runs-cleanup', cron: '30 3 * * *', timezone: 'Europe/Berlin' },
      { name: 'profiles-sync-all', cron: '0 5 * * *', timezone: 'Europe/Berlin' },
      { name: 'reports-sync-all', cron: '0 6 * * *', timezone: 'Europe/Berlin' },
      { name: 'token-refresh-all', cron: '0 * * * *', timezone: 'UTC' },
    ]);
  });

  it('lädt beim Start die Wechselkurse, solange noch keine gespeichert sind (plattformweit)', async () => {
    const run = await waitFor(async () => {
      const [row] = await testDb.db
        .select()
        .from(jobRuns)
        .where(and(eq(jobRuns.job, 'fx-rates-sync'), isNull(jobRuns.organizationId)));
      return row?.status === 'running' ? undefined : row;
    });
    expect(run).toMatchObject({
      status: 'success',
      scope: null,
      counters: expect.objectContaining({ fetched: 1, inserted: 1 }) as unknown,
    });
    expect(await testDb.db.select().from(fxRates)).toHaveLength(1);
  });

  it('versucht einen gescheiterten Kursabruf nach einer Stunde erneut, höchstens dreimal', async () => {
    fetchFxRates = () => Promise.reject(new Error('EZB nicht erreichbar.'));
    const boss = new PgBoss({ connectionString: testDb.url, supervise: false, schedule: false });
    await boss.start();
    try {
      await boss.send('fx-rates-sync', { retry: 3 });
      await waitFor(async () => {
        const [row] = await testDb.db
          .select()
          .from(jobRuns)
          .where(and(eq(jobRuns.job, 'fx-rates-sync'), eq(jobRuns.status, 'failed')));
        return row;
      });
      // Dritter Wiederholungsversuch gescheitert: kein weiterer.
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(await queuedFxRetries()).toEqual([]);

      await boss.send('fx-rates-sync', null);
      const retry = await waitFor(async () => (await queuedFxRetries())[0]);
      expect(retry.data).toEqual({ retry: 1 });
      const delayMs = Date.parse(retry.start_after) - Date.now();
      expect(delayMs).toBeGreaterThan(55 * 60_000);
      expect(delayMs).toBeLessThanOrEqual(60 * 60_000);
    } finally {
      await boss.stop({ graceful: false });
      fetchFxRates = async () => [];
    }
  });

  it('plant nichts ein, wenn die Transaktion des Aufrufers zurückrollt', async () => {
    await testDb.db
      .transaction(async (tx) => {
        await worker.jobs.enqueueProfilesSync({ organizationId, connectionId }, { tx });
        throw new Error('Rollback');
      })
      .catch(() => {});
    expect(await queuedJobs('profiles-sync')).toEqual([]);
  });

  it('führt einen eingeplanten Profil-Sync aus und schreibt job_runs', async () => {
    await testDb.db.transaction(async (tx) => {
      await worker.jobs.enqueueProfilesSync({ organizationId, connectionId }, { tx });
    });

    const run = await waitFor(async () => {
      const [row] = await testDb.db.select().from(jobRuns).where(eq(jobRuns.scope, connectionId));
      return row?.status === 'running' ? undefined : row;
    });

    expect(run).toMatchObject({
      organizationId,
      job: 'profiles-sync',
      status: 'success',
      // Anfragezähler aus dem Amazon-Client (1.3); die Lease ist danach wieder frei.
      counters: expect.objectContaining({
        profiles: 4,
        created: 4,
        requests: 1,
        throttled: 0,
        retries: 0,
        deferred: 0,
      }) as unknown,
    });
    expect(await testDb.db.select().from(connectionJobLeases)).toEqual([]);
    const [big] = await testDb.db
      .select()
      .from(amazonAdsProfiles)
      .where(eq(amazonAdsProfiles.amazonProfileId, '9007199254740993'));
    expect(big).toMatchObject({ connectionId, countryCode: 'DE' });
  });

  it('kettet bei „Jetzt synchronisieren“ Profile → Entities → Reports', async () => {
    await worker.jobs.enqueueProfilesSync({ organizationId, connectionId, chain: true });

    const finished = async (job: string) => {
      const [row] = await testDb.db
        .select()
        .from(jobRuns)
        .where(and(eq(jobRuns.job, job), eq(jobRuns.scope, connectionId)));
      return row && row.status !== 'running' ? row : undefined;
    };
    const entities = await waitFor(() => finished('entities-sync'), 20_000);
    const reports = await waitFor(() => finished('reports-sync'), 20_000);

    expect(entities).toMatchObject({ status: 'success' });
    expect(entities.counters.requested).toBeGreaterThan(0);
    expect(reports).toMatchObject({ status: 'success' });
    expect(reports.counters.requested).toBeGreaterThan(0);
    // Der Poll wartet auf den ersten Termin (1 Min.) der angeforderten Aufträge.
    expect(await queuedJobs('amazon-requests-poll')).toContainEqual({
      singleton_key: connectionId,
      state: 'created',
    });
  }, 30_000);

  it('plant beim Poll-Auslöser nur Connections mit fälligen Aufträgen ein', async () => {
    await testDb.db.execute(sql`delete from pgboss.job where name = 'amazon-requests-poll'`);
    await testDb.db
      .update(amazonAdsReportRequests)
      .set({ nextPollAt: new Date(Date.now() - 1000) });
    const boss = new PgBoss({ connectionString: testDb.url, supervise: false, schedule: false });
    await boss.start();
    try {
      await boss.send('amazon-requests-poll-all', {});
    } finally {
      await boss.stop();
    }

    const dispatch = await waitFor(async () => {
      const [row] = await testDb.db
        .select()
        .from(jobRuns)
        .where(and(eq(jobRuns.job, 'amazon-requests-poll'), isNull(jobRuns.scope)));
      return row && row.status !== 'running' ? row : undefined;
    });
    expect(dispatch).toMatchObject({ status: 'success', counters: { connections: 1, queued: 1 } });
    const poll = await waitFor(async () => {
      const [row] = await testDb.db
        .select()
        .from(jobRuns)
        .where(and(eq(jobRuns.job, 'amazon-requests-poll'), eq(jobRuns.scope, connectionId)));
      return row && row.status !== 'running' ? row : undefined;
    });
    expect(poll).toMatchObject({ status: 'success' });
    // Keine weiteren Polls in den folgenden Tests (sie hielten die Lease der Connection).
    await testDb.db.execute(
      sql`delete from pgboss.job where name = 'amazon-requests-poll' and state = 'created'`,
    );
  });

  it('plant beim stündlichen Auslöser je aktiver Connection einen token-refresh ein', async () => {
    // Wie der Cron von pg-boss: ein Job in der Auslöser-Queue.
    const boss = new PgBoss({ connectionString: testDb.url, supervise: false, schedule: false });
    await boss.start();
    try {
      await boss.send('token-refresh-all', {});
    } finally {
      await boss.stop();
    }

    const finished = (row?: { status: string }) =>
      row && row.status !== 'running' ? row : undefined;
    const dispatch = await waitFor(async () => {
      const [row] = await testDb.db
        .select()
        .from(jobRuns)
        .where(and(eq(jobRuns.job, 'token-refresh'), isNull(jobRuns.scope)));
      return finished(row);
    });
    expect(dispatch).toMatchObject({
      organizationId: null,
      status: 'success',
      counters: { connections: 1, queued: 1 },
    });
    const refresh = await waitFor(async () => {
      const [row] = await testDb.db
        .select()
        .from(jobRuns)
        .where(and(eq(jobRuns.job, 'token-refresh'), eq(jobRuns.scope, connectionId)));
      return finished(row);
    });
    expect(refresh).toMatchObject({
      organizationId,
      status: 'success',
      counters: { refreshed: 1 },
    });
  });

  it('stellt einen Profil-Sync zurück, solange ein anderer Datenjob die Connection hält', async () => {
    await acquireConnectionLease(testDb.db, {
      organizationId,
      connectionId,
      job: 'entities-sync',
      jobRunId: randomUUID(),
      ttlSeconds: 600,
    });
    const runsBefore = (await testDb.db.select().from(jobRuns)).length;
    try {
      await worker.jobs.enqueueProfilesSync({ organizationId, connectionId });

      const waiting = await waitFor(async () => {
        const rows = await testDb.db.execute<{ deferred: string | null; delay_s: number }>(
          sql`select data->>'deferredCount' as deferred,
                     extract(epoch from start_after - now())::float as delay_s
              from pgboss.job
              where name = 'profiles-sync' and state = 'created' and singleton_key = ${connectionId}`,
        );
        const row = [...rows][0];
        return row?.deferred === '1' ? row : undefined;
      });
      expect(waiting.delay_s).toBeGreaterThan(30);
      expect((await testDb.db.select().from(jobRuns)).length).toBe(runsBefore);
      expect(logs).toContainEqual(
        expect.objectContaining({ msg: 'job.deferred', connectionId, heldBy: 'entities-sync' }),
      );
    } finally {
      await testDb.db.delete(connectionJobLeases);
      await testDb.db.execute(
        sql`delete from pgboss.job where name = 'profiles-sync' and state = 'created'`,
      );
    }
  });

  it('arbeitet hochgeladene Dateien über die Queue file-import ab (1.11c)', async () => {
    const { createFileImport, createFileProfile } = await import('@profitbash/db');
    const [admin] = await testDb.db
      .insert(schema.users)
      .values({ name: 'Ada', email: 'ada-worker@muuv.test' })
      .returning({ id: schema.users.id });
    await testDb.db.insert(schema.members).values({
      organizationId,
      userId: admin!.id,
      role: 'admin',
      createdAt: new Date(),
    });
    const { id: profileId } = await createFileProfile(testDb.db, {
      userId: admin!.id,
      orgId: organizationId,
      input: {
        accountName: 'Datei',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
        accountType: 'seller',
      },
    });
    const created = await createFileImport(testDb.db, {
      userId: admin!.id,
      orgId: organizationId,
      profileId,
      kind: 'daily_report',
      fileName: 'bericht.csv',
      content: new TextEncoder().encode('x'),
      enqueue: (tx) => worker.jobs.enqueueFileImport({ organizationId, profileId }, { tx }),
    });

    const done = await waitFor(async () => {
      const [row] = await testDb.db
        .select()
        .from(schema.fileImports)
        .where(eq(schema.fileImports.id, created.id));
      return row && ['imported', 'failed'].includes(row.status) ? row : undefined;
    });
    // Der Tagesbericht hat bis 1.11e keinen Importer: Der Weg bis zum Job ist trotzdem belegt.
    expect(done.status).toBe('failed');
    const [run] = await testDb.db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.job, 'file-import'), eq(jobRuns.scope, profileId)));
    expect(run).toMatchObject({ organizationId, status: 'failed', counters: { files: 1 } });

    // Ohne eingeplanten Job (verloren nach Absturz oder Deploy) holt der Auslöser alle 10 Min. die Datei.
    const orphan = await createFileImport(testDb.db, {
      userId: admin!.id,
      orgId: organizationId,
      profileId,
      kind: 'daily_report',
      fileName: 'verwaist.csv',
      content: new TextEncoder().encode('x'),
      enqueue: async () => {},
    });
    const boss = new PgBoss({ connectionString: testDb.url, supervise: false, schedule: false });
    await boss.start();
    try {
      await boss.send('file-import-all', {});
    } finally {
      await boss.stop();
    }
    const swept = await waitFor(async () => {
      const [row] = await testDb.db
        .select()
        .from(schema.fileImports)
        .where(eq(schema.fileImports.id, orphan.id));
      return row && ['imported', 'failed'].includes(row.status) ? row : undefined;
    });
    expect(swept.status).toBe('failed');
    const [dispatch] = await testDb.db
      .select()
      .from(jobRuns)
      .where(and(eq(jobRuns.job, 'file-import'), isNull(jobRuns.scope)));
    expect(dispatch).toMatchObject({ status: 'success', counters: { profiles: 1, queued: 1 } });
  });
});

describe('startJobQueue', () => {
  it('hält je Connection höchstens einen wartenden Job (singletonKey = Connection-ID)', async () => {
    const queue = await startJobQueue({ connectionString: testDb.url, logger: () => {} });
    try {
      const a = '00000000-0000-4000-8000-00000000000a';
      const b = '00000000-0000-4000-8000-00000000000b';
      await queue.jobs.enqueueProfilesSync({ organizationId, connectionId: a });
      await queue.jobs.enqueueProfilesSync({ organizationId, connectionId: a });
      await queue.jobs.enqueueProfilesSync({ organizationId, connectionId: b });

      const created = (await queuedJobs('profiles-sync')).filter((job) => job.state === 'created');
      expect(created.map((job) => job.singleton_key)).toEqual([a, b]);
    } finally {
      await queue.stop();
    }
  });
});
