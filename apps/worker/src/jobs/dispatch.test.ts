import { stageAdChanges, submitAdChanges } from '@profitbash/db';
import { createTestDatabase, seedAdChangeFixture, type TestDatabase } from '@profitbash/db/testing';
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

  it('plant das Übermitteln von Änderungen nur für Connections mit offenen Übermittlungen ein', async () => {
    const f = await seedAdChangeFixture(testDb.db, 'aenderungen');
    const dispatch = async () => {
      const sent: ConnectionJobData[] = [];
      await dispatchConnectionJobs(
        {
          db: testDb.db,
          enqueue: (_queue, job) => {
            sent.push(job);
            return Promise.resolve(true);
          },
        },
        'ad-changes-submit',
      );
      return sent;
    };
    expect(await dispatch()).toEqual([]);

    const actor = { userId: f.ada, orgId: f.org };
    await stageAdChanges(testDb.db, {
      ...actor,
      origin: 'explorer',
      changes: [
        {
          operation: 'update',
          entityType: 'target',
          entityId: f.keyword,
          field: 'bid',
          value: '0.75',
        },
      ],
    });
    await submitAdChanges(testDb.db, { ...actor, channel: 'api', enqueue: async () => {} });

    expect(await dispatch()).toEqual([{ organizationId: f.org, connectionId: f.connection }]);
  });
});
