import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, createOrganization } from '../testing';
import type { ConnectionJobData, ConnectionQueue } from './connection-job';
import { dispatchConnectionJobs } from './dispatch';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase();
});

afterAll(async () => {
  await testDb.close();
});

describe('dispatchConnectionJobs', () => {
  it('plant je aktiver Connection aller Organisationen einen Job ein', async () => {
    const muuv = await createOrganization(testDb.db, 'muuv');
    const other = await createOrganization(testDb.db, 'andere');
    const a = await createConnection(testDb.db, { organizationId: muuv, externalAccountId: 'A' });
    const b = await createConnection(testDb.db, { organizationId: other, externalAccountId: 'B' });
    await createConnection(testDb.db, {
      organizationId: muuv,
      externalAccountId: 'C',
      status: 'reauth_required',
    });

    const sent: Array<{ queue: ConnectionQueue; job: ConnectionJobData }> = [];
    const outcome = await dispatchConnectionJobs(
      {
        db: testDb.db,
        enqueue: (queue, job) => {
          sent.push({ queue, job });
          // Der zweite Job liegt schon in der Queue (pg-boss stately: send liefert null).
          return Promise.resolve(sent.length === 1);
        },
      },
      'profiles-sync',
    );

    expect(sent).toHaveLength(2);
    expect(sent).toEqual(
      expect.arrayContaining([
        { queue: 'profiles-sync', job: { organizationId: muuv, connectionId: a } },
        { queue: 'profiles-sync', job: { organizationId: other, connectionId: b } },
      ]),
    );
    expect(outcome.counters).toEqual({ connections: 2, queued: 1 });
  });
});
