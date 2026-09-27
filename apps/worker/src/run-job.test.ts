import { randomUUID } from 'node:crypto';
import { schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { LogEntry } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createJobRunner, JobFailure } from './run-job';

const { jobRuns, organizations } = schema;

const HEALTHCHECK_URL = 'https://hc-ping.test/ping/3f1c0f3e-token-refresh';
const pings: Array<{ path: string; rid: string | null }> = [];
const server = setupServer(
  http.all('https://hc-ping.test/*', ({ request }) => {
    const url = new URL(request.url);
    pings.push({ path: url.pathname, rid: url.searchParams.get('rid') });
    return new HttpResponse('OK');
  }),
);

let testDb: TestDatabase;
let organizationId = '';
const logs: LogEntry[] = [];
const logger = (entry: LogEntry) => logs.push(entry);

async function jobRun(id: string) {
  const [row] = await testDb.db.select().from(jobRuns).where(eq(jobRuns.id, id));
  if (!row) throw new Error('job_run fehlt');
  return row;
}

beforeAll(async () => {
  server.listen({ onUnhandledRequest: 'error' });
  testDb = await createTestDatabase();
  const [org] = await testDb.db
    .insert(organizations)
    .values({ name: 'Muuv', slug: 'muuv', type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  organizationId = org?.id ?? '';
});

afterAll(async () => {
  server.close();
  await testDb.close();
});

beforeEach(() => {
  pings.length = 0;
  logs.length = 0;
});

afterEach(() => {
  server.resetHandlers();
});

describe('runJob', () => {
  it('schreibt den Lauf als running und danach als success mit Zählern', async () => {
    const runJob = createJobRunner({ db: testDb.db, logger });
    let statusWhileRunning: string | undefined;

    const result = await runJob(
      'profiles-sync',
      { organizationId, scope: 'connection-1' },
      async ({ runId }) => {
        statusWhileRunning = (await jobRun(runId)).status;
        return { counters: { profiles: 4 } };
      },
    );

    expect(statusWhileRunning).toBe('running');
    expect(result.status).toBe('success');
    const row = await jobRun(result.runId);
    expect(row).toMatchObject({
      organizationId,
      job: 'profiles-sync',
      scope: 'connection-1',
      status: 'success',
      error: null,
      counters: { profiles: 4 },
    });
    expect(row.finishedAt).toBeInstanceOf(Date);
  });

  it('fängt Fehler ab und schreibt sie als failed mit Fehlertext', async () => {
    const runJob = createJobRunner({ db: testDb.db, logger });

    const result = await runJob('token-refresh', { organizationId: null, scope: null }, () =>
      Promise.reject(new Error('Amazon antwortet nicht.')),
    );

    expect(result).toMatchObject({ status: 'failed', error: 'Amazon antwortet nicht.' });
    const row = await jobRun(result.runId);
    expect(row).toMatchObject({
      organizationId: null,
      status: 'failed',
      error: 'Amazon antwortet nicht.',
    });
    expect(row.finishedAt).toBeInstanceOf(Date);
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'job.failed', job: 'token-refresh' }),
    );
  });

  it('übernimmt Meldung und Zähler einer JobFailure', async () => {
    const runJob = createJobRunner({ db: testDb.db, logger });
    const result = await runJob('profiles-sync', { organizationId, scope: null }, () =>
      Promise.reject(new JobFailure('Connection muss neu verbunden werden.', { profiles: 0 })),
    );
    const row = await jobRun(result.runId);
    expect(row).toMatchObject({
      status: 'failed',
      error: 'Connection muss neu verbunden werden.',
      counters: { profiles: 0 },
    });
  });

  it('nutzt eine vorgegebene Lauf-ID', async () => {
    const runJob = createJobRunner({ db: testDb.db, logger });
    const runId = randomUUID();
    const result = await runJob('profiles-sync', { organizationId, scope: null }, async () => {}, {
      runId,
    });
    expect(result).toEqual({ status: 'success', runId });
    expect((await jobRun(runId)).status).toBe('success');
  });

  it('ergänzt zusätzliche Zähler bei Erfolg und bei Fehlschlag', async () => {
    const runJob = createJobRunner({ db: testDb.db, logger });
    let requests = 0;
    const counters = () => ({ requests });

    const ok = await runJob(
      'profiles-sync',
      { organizationId, scope: null },
      async () => {
        requests = 3;
        return { counters: { profiles: 2 } };
      },
      { counters },
    );
    expect((await jobRun(ok.runId)).counters).toEqual({ profiles: 2, requests: 3 });

    const failed = await runJob(
      'profiles-sync',
      { organizationId, scope: null },
      async () => {
        requests = 5;
        throw new Error('kaputt');
      },
      { counters },
    );
    expect(await jobRun(failed.runId)).toMatchObject({
      status: 'failed',
      counters: { requests: 5 },
    });
  });

  it('schreibt bei fehlgeschlagenen Abfragen keine Parameterwerte in den Fehlertext', async () => {
    const runJob = createJobRunner({ db: testDb.db, logger });
    const secret = 'geheime-email@kunde.test';
    const result = await runJob('profiles-sync', { organizationId, scope: null }, async () => {
      // Verstößt gegen den Fremdschlüssel auf organizations.
      await testDb.db.insert(jobRuns).values({
        organizationId: '00000000-0000-4000-8000-000000000000',
        job: secret,
      });
    });
    const row = await jobRun(result.runId);
    expect(row.error).toBe('Datenbankabfrage fehlgeschlagen.');
    expect(JSON.stringify(logs)).not.toContain(secret);
  });

  it('pingt Healthchecks mit Start und Erfolg, gebunden an die Lauf-ID', async () => {
    const runJob = createJobRunner({
      db: testDb.db,
      logger,
      healthchecks: { 'token-refresh': HEALTHCHECK_URL },
    });
    const result = await runJob('token-refresh', { organizationId: null, scope: null }, () =>
      Promise.resolve(),
    );
    expect(pings).toEqual([
      { path: '/ping/3f1c0f3e-token-refresh/start', rid: result.runId },
      { path: '/ping/3f1c0f3e-token-refresh', rid: result.runId },
    ]);
  });

  it('pingt Healthchecks bei einem Fehler mit /fail', async () => {
    const runJob = createJobRunner({
      db: testDb.db,
      logger,
      healthchecks: { 'token-refresh': HEALTHCHECK_URL },
    });
    const result = await runJob('token-refresh', { organizationId: null, scope: null }, () =>
      Promise.reject(new Error('kaputt')),
    );
    expect(pings).toEqual([
      { path: '/ping/3f1c0f3e-token-refresh/start', rid: result.runId },
      { path: '/ping/3f1c0f3e-token-refresh/fail', rid: result.runId },
    ]);
  });

  it('pingt bei einer JobFailure ohne Alarm (z. B. neu eingeplant) Erfolg statt /fail', async () => {
    const runJob = createJobRunner({
      db: testDb.db,
      logger,
      healthchecks: { 'token-refresh': HEALTHCHECK_URL },
    });
    const result = await runJob('token-refresh', { organizationId: null, scope: null }, () =>
      Promise.reject(
        new JobFailure('Neuer Versuch in 90 s eingeplant.', undefined, { alert: false }),
      ),
    );
    expect(result.status).toBe('failed');
    expect(pings).toEqual([
      { path: '/ping/3f1c0f3e-token-refresh/start', rid: result.runId },
      { path: '/ping/3f1c0f3e-token-refresh', rid: result.runId },
    ]);
  });

  it('pingt nicht, wenn für den Job keine URL konfiguriert ist', async () => {
    const runJob = createJobRunner({
      db: testDb.db,
      logger,
      healthchecks: { 'token-refresh': HEALTHCHECK_URL },
    });
    await runJob('job-runs-cleanup', { organizationId: null, scope: null }, () =>
      Promise.resolve(),
    );
    expect(pings).toEqual([]);
  });

  it('lässt den Job nicht an einem nicht erreichbaren Healthcheck scheitern', async () => {
    server.use(http.all('https://hc-ping.test/*', () => HttpResponse.error()));
    const runJob = createJobRunner({
      db: testDb.db,
      logger,
      healthchecks: { 'token-refresh': HEALTHCHECK_URL },
    });
    const result = await runJob('token-refresh', { organizationId: null, scope: null }, () =>
      Promise.resolve(),
    );
    expect(result.status).toBe('success');
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'healthcheck.ping_failed', ping: 'start' }),
    );
    // Die Ping-URL ist ein Geheimnis (wer sie kennt, kann pingen) und gehört nicht ins Log.
    expect(JSON.stringify(logs)).not.toContain('3f1c0f3e');
  });
});
