import { randomUUID } from 'node:crypto';
import { acquireConnectionLease, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { LogEntry } from '@profitbash/shared';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JOB_EXPIRE_SECONDS } from '../queues';
import { createJobRunner, JobFailure } from '../run-job';
import { createConnection, createOrganization, stubAmazonAdsClient } from '../testing';
import {
  CONNECTION_LEASE_SECONDS,
  LEASE_DEFER_SECONDS,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionQueue,
} from './connection-job';
import { runConnectionJob, type ConnectionJobDefinition } from './run-connection-job';

const { connectionJobLeases, jobRuns } = schema;

let testDb: TestDatabase;
let organizationId = '';
let connectionId = '';
const logs: LogEntry[] = [];
const deferred: Array<{
  queue: ConnectionQueue;
  job: ConnectionJobData;
  startAfterSeconds: number;
}> = [];
let deferAccepted = true;

function context() {
  const logger = (entry: LogEntry) => logs.push(entry);
  const deps: ConnectionJobDeps = {
    db: testDb.db,
    logger,
    amazonAds: stubAmazonAdsClient(),
    scheduleRetry: () => Promise.resolve(true),
    enqueue: () => Promise.reject(new Error('nicht benutzt')),
  };
  return {
    db: testDb.db,
    logger,
    runJob: createJobRunner({ db: testDb.db, logger }),
    deps,
    defer(queue: ConnectionQueue, job: ConnectionJobData, startAfterSeconds: number) {
      deferred.push({ queue, job, startAfterSeconds });
      return Promise.resolve(deferAccepted);
    },
  };
}

const job = (overrides: Partial<ConnectionJobData> = {}): ConnectionJobData => ({
  organizationId,
  connectionId,
  ...overrides,
});

async function lease() {
  const [row] = await testDb.db
    .select()
    .from(connectionJobLeases)
    .where(eq(connectionJobLeases.connectionId, connectionId));
  return row;
}

async function runsOfConnection() {
  return testDb.db.select().from(jobRuns).where(eq(jobRuns.scope, connectionId));
}

async function holdLease(job = 'entities-sync') {
  const holder = randomUUID();
  await acquireConnectionLease(testDb.db, {
    organizationId,
    connectionId,
    job,
    jobRunId: holder,
    ttlSeconds: 600,
  });
  return holder;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  logs.length = 0;
  deferred.length = 0;
  deferAccepted = true;
  await testDb.db.delete(connectionJobLeases);
  await testDb.db.delete(jobRuns);
  connectionId = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: `amzn1.account.${randomUUID()}`,
  });
});

describe('runConnectionJob mit Lease (Amazon-Datenjobs)', () => {
  it('hält die Lease länger, als pg-boss einen Job laufen lässt', () => {
    // Sonst könnte ein von pg-boss als abgelaufen geführter, aber noch laufender Job die Connection
    // verlieren, während der nächste startet.
    expect(CONNECTION_LEASE_SECONDS).toBeGreaterThan(JOB_EXPIRE_SECONDS);
  });

  it('hält die Lease während des Laufs unter der Lauf-ID und gibt sie danach frei', async () => {
    let during: Awaited<ReturnType<typeof lease>>;
    let runIdSeen = '';
    const definition: ConnectionJobDefinition = {
      lease: true,
      run: async () => {
        during = await lease();
        return { counters: { profiles: 1 } };
      },
    };

    const result = await runConnectionJob(context(), 'profiles-sync', definition, job());

    expect(result.status).toBe('success');
    if (result.status !== 'deferred') runIdSeen = result.runId;
    expect(during).toMatchObject({ organizationId, job: 'profiles-sync', jobRunId: runIdSeen });
    const ttl = (during!.expiresAt.getTime() - during!.acquiredAt.getTime()) / 1000;
    expect(ttl).toBeCloseTo(CONNECTION_LEASE_SECONDS, 0);
    expect(await lease()).toBeUndefined();
  });

  it('gibt dem Lauf seine ID und verlängert die Lease auf Wunsch (lange Schritte)', async () => {
    let seenRunId: string | undefined;
    let extended: Awaited<ReturnType<typeof lease>>;
    const definition: ConnectionJobDefinition = {
      lease: true,
      run: async (_deps, _job, run) => {
        seenRunId = run.runId;
        await testDb.db
          .update(connectionJobLeases)
          .set({ expiresAt: sql`now() + interval '1 minute'` });
        await run.extendLease();
        extended = await lease();
        return {};
      },
    };

    const result = await runConnectionJob(context(), 'profiles-sync', definition, job());

    expect(result.status === 'success' && result.runId).toBe(seenRunId);
    const remaining = (extended!.expiresAt.getTime() - Date.now()) / 1000;
    expect(remaining).toBeGreaterThan(CONNECTION_LEASE_SECONDS - 60);
  });

  it('bricht ab, wenn die Lease inzwischen einem anderen Lauf gehört', async () => {
    const definition: ConnectionJobDefinition = {
      lease: true,
      run: async (_deps, _job, run) => {
        await testDb.db.update(connectionJobLeases).set({ jobRunId: randomUUID() });
        await run.extendLease();
        return {};
      },
    };
    const result = await runConnectionJob(context(), 'profiles-sync', definition, job());
    expect(result).toMatchObject({ status: 'failed', error: expect.stringMatching(/Lease/) });
  });

  it('schreibt Anfragen, 429, Wiederholungen und Zurückstellungen in die Zähler', async () => {
    const definition: ConnectionJobDefinition = {
      lease: true,
      run: async (_deps, _job, { meter }) => {
        meter.requests += 4;
        meter.throttled += 1;
        meter.retries += 1;
        return { counters: { profiles: 2 } };
      },
    };
    await runConnectionJob(context(), 'profiles-sync', definition, job({ deferredCount: 2 }));
    const [run] = await runsOfConnection();
    expect(run?.counters).toEqual({
      profiles: 2,
      requests: 4,
      throttled: 1,
      retries: 1,
      deferred: 2,
    });
  });

  it('gibt die Lease auch nach einem Fehlschlag frei und behält die Zähler', async () => {
    const definition: ConnectionJobDefinition = {
      lease: true,
      run: async (_deps, _job, { meter }) => {
        meter.requests += 1;
        meter.throttled += 1;
        throw new JobFailure('Amazon verlangt eine Pause.', undefined, { alert: false });
      },
    };
    const result = await runConnectionJob(context(), 'profiles-sync', definition, job());
    expect(result.status).toBe('failed');
    expect(await lease()).toBeUndefined();
    const [run] = await runsOfConnection();
    expect(run?.counters).toMatchObject({ requests: 1, throttled: 1, deferred: 0 });
  });

  it('stellt den Job zurück, wenn ein anderer Datenjob die Connection hält', async () => {
    const holder = await holdLease('entities-sync');
    let ran = false;
    const definition: ConnectionJobDefinition = {
      lease: true,
      run: async () => {
        ran = true;
        return {};
      },
    };

    const result = await runConnectionJob(
      context(),
      'profiles-sync',
      definition,
      job({ retryAttempt: 1 }),
    );

    expect(result).toEqual({ status: 'deferred', queued: true });
    expect(ran).toBe(false);
    // Kein Lauf: Zurückstellen ist kein Ergebnis, der spätere Lauf zählt es (`deferred`).
    expect(await runsOfConnection()).toEqual([]);
    expect(deferred).toEqual([
      {
        queue: 'profiles-sync',
        job: { organizationId, connectionId, retryAttempt: 1, deferredCount: 1 },
        startAfterSeconds: LEASE_DEFER_SECONDS,
      },
    ]);
    expect((await lease())?.jobRunId).toBe(holder);
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: 'job.deferred',
        job: 'profiles-sync',
        connectionId,
        heldBy: 'entities-sync',
      }),
    );
  });

  it('zählt Zurückstellungen ohne Obergrenze weiter', async () => {
    await holdLease();
    const definition: ConnectionJobDefinition = { lease: true, run: async () => ({}) };
    await runConnectionJob(context(), 'profiles-sync', definition, job({ deferredCount: 7 }));
    expect(deferred[0]?.job.deferredCount).toBe(8);
  });

  it('verwirft den Job, wenn für die Connection schon einer wartet (erledigt dieselbe Arbeit)', async () => {
    await holdLease();
    deferAccepted = false;
    const definition: ConnectionJobDefinition = { lease: true, run: async () => ({}) };
    const result = await runConnectionJob(context(), 'profiles-sync', definition, job());
    expect(result).toEqual({ status: 'deferred', queued: false });
  });

  it('meldet eine unbekannte Connection als fehlgeschlagenen Lauf, ohne Lease', async () => {
    let ran = false;
    const definition: ConnectionJobDefinition = {
      lease: true,
      run: async () => {
        ran = true;
        return {};
      },
    };
    const unknown = randomUUID();
    const result = await runConnectionJob(
      context(),
      'profiles-sync',
      definition,
      job({ connectionId: unknown }),
    );
    expect(result).toMatchObject({ status: 'failed', error: 'Connection nicht gefunden.' });
    expect(ran).toBe(false);
    expect(deferred).toEqual([]);
    const [run] = await testDb.db.select().from(jobRuns).where(eq(jobRuns.scope, unknown));
    expect(run).toMatchObject({ status: 'failed', organizationId });
  });

  it('übernimmt eine abgelaufene Lease', async () => {
    await holdLease();
    await testDb.db
      .update(connectionJobLeases)
      .set({ expiresAt: sql`now() - interval '1 second'` })
      .where(eq(connectionJobLeases.connectionId, connectionId));
    const definition: ConnectionJobDefinition = { lease: true, run: async () => ({}) };
    const result = await runConnectionJob(context(), 'profiles-sync', definition, job());
    expect(result.status).toBe('success');
    expect(deferred).toEqual([]);
  });
});

describe('runConnectionJob ohne Lease (token-refresh)', () => {
  it('läuft, auch wenn ein Datenjob die Connection hält, und ohne Anfragezähler', async () => {
    const holder = await holdLease();
    const definition: ConnectionJobDefinition = {
      lease: false,
      run: async () => ({ counters: { refreshed: 1 } }),
    };
    const result = await runConnectionJob(context(), 'token-refresh', definition, job());
    expect(result.status).toBe('success');
    const [run] = await runsOfConnection();
    expect(run?.counters).toEqual({ refreshed: 1 });
    expect((await lease())?.jobRunId).toBe(holder);
  });
});
