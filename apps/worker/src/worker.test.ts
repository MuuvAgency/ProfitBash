import { randomUUID } from 'node:crypto';
import { createMockAmazonAdsClient } from '@profitbash/amazon-ads';
import { acquireConnectionLease, createConnectionTokenStore, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { LogEntry } from '@profitbash/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { PgBoss } from 'pg-boss';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, createOrganization, testKeyring } from './testing';
import { startJobQueue, startWorker, type Worker } from './worker';

const { amazonAdsProfiles, connectionJobLeases, jobRuns } = schema;

let testDb: TestDatabase;
let organizationId = '';
const logs: LogEntry[] = [];

async function queuedJobs(name: string) {
  const rows = await testDb.db.execute<{ singleton_key: string | null; state: string }>(
    sql`select singleton_key, state from pgboss.job where name = ${name} order by created_on`,
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
      }),
      logger: (entry) => logs.push(entry),
      pollingIntervalSeconds: 0.5,
    });
  });

  afterAll(async () => {
    await worker.stop();
  });

  it('richtet die Zeitpläne ein (stündlicher Refresh, Sync 05:00 Berlin, täglicher Cleanup)', async () => {
    const rows = await testDb.db.execute<{ name: string; cron: string; timezone: string }>(
      sql`select name, cron, timezone from pgboss.schedule order by name`,
    );
    expect([...rows]).toEqual([
      { name: 'job-runs-cleanup', cron: '30 3 * * *', timezone: 'Europe/Berlin' },
      { name: 'profiles-sync-all', cron: '0 5 * * *', timezone: 'Europe/Berlin' },
      { name: 'token-refresh-all', cron: '0 * * * *', timezone: 'UTC' },
    ]);
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
