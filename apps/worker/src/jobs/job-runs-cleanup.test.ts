import { AMAZON_ADS_OAUTH_NONCE_PREFIX, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { asc } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cleanupJobRuns } from './job-runs-cleanup';

const { jobRuns, verifications } = schema;

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2026-09-26T03:30:00Z');
const ago = (ms: number) => new Date(now.getTime() - ms);

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(jobRuns);
  await testDb.db.delete(verifications);
});

describe('cleanupJobRuns', () => {
  it('löscht Jobläufe, die älter als 90 Tage sind', async () => {
    await testDb.db.insert(jobRuns).values([
      { job: 'alt', status: 'success', startedAt: ago(91 * DAY) },
      { job: 'grenze', status: 'success', startedAt: ago(89 * DAY) },
      { job: 'neu', status: 'failed', startedAt: ago(DAY) },
    ]);

    const outcome = await cleanupJobRuns({ db: testDb.db, now: () => now });

    const rows = await testDb.db.select().from(jobRuns).orderBy(asc(jobRuns.startedAt));
    expect(rows.map((row) => row.job)).toEqual(['grenze', 'neu']);
    expect(outcome.counters).toMatchObject({ deletedJobRuns: 1 });
  });

  it('schließt Läufe ab, die seit Stunden auf running hängen (Worker abgestürzt)', async () => {
    await testDb.db.insert(jobRuns).values([
      { job: 'haengt', status: 'running', startedAt: ago(7 * 60 * 60 * 1000) },
      { job: 'laeuft', status: 'running', startedAt: ago(5 * 60 * 1000) },
    ]);

    const outcome = await cleanupJobRuns({ db: testDb.db, now: () => now });

    const rows = await testDb.db.select().from(jobRuns).orderBy(asc(jobRuns.startedAt));
    expect(rows).toEqual([
      expect.objectContaining({
        job: 'haengt',
        status: 'failed',
        finishedAt: now,
        error: expect.stringMatching(/abgebrochen/i) as unknown,
      }),
      expect.objectContaining({ job: 'laeuft', status: 'running', finishedAt: null }),
    ]);
    expect(outcome.counters).toMatchObject({ abandonedJobRuns: 1 });
  });

  it('löscht abgelaufene OAuth-Nonces, aber keine gültigen und keine von better-auth', async () => {
    await testDb.db.insert(verifications).values([
      { identifier: `${AMAZON_ADS_OAUTH_NONCE_PREFIX}alt`, value: 'u', expiresAt: ago(1000) },
      {
        identifier: `${AMAZON_ADS_OAUTH_NONCE_PREFIX}gueltig`,
        value: 'u',
        expiresAt: new Date(now.getTime() + 60_000),
      },
      { identifier: 'email-verification:x', value: 'u', expiresAt: ago(1000) },
    ]);

    const outcome = await cleanupJobRuns({ db: testDb.db, now: () => now });

    const rows = await testDb.db
      .select({ identifier: verifications.identifier })
      .from(verifications);
    expect(rows.map((row) => row.identifier).sort()).toEqual([
      `${AMAZON_ADS_OAUTH_NONCE_PREFIX}gueltig`,
      'email-verification:x',
    ]);
    expect(outcome.counters).toMatchObject({ deletedOAuthNonces: 1 });
  });
});
