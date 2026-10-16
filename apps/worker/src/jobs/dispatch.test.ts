import { createSpReportRequests, schema, stageAdChanges, submitAdChanges } from '@profitbash/db';
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
      'profiles-sync-all',
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
        'ad-changes-submit-all',
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

  it('plant SP-Bestellungen täglich für alle aktiven SP-Connections, alle 10 Min. nur bei fälligen Berichten', async () => {
    const org = await createOrganization(testDb.db, 'seller');
    const connectionId = await createConnection(testDb.db, {
      organizationId: org,
      externalAccountId: 'A1SELLER',
      provider: 'amazon_sp',
    });
    const [account] = await testDb.db
      .insert(schema.amazonSpAccounts)
      .values({
        organizationId: org,
        connectionId,
        amazonSellerId: 'A1SELLER',
        marketplaceId: 'A1PA6795UKMFR9',
        storeName: 'Nordwind',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
      })
      .returning();
    const dispatch = async (dispatcher: 'sp-orders-sync-all' | 'sp-orders-poll-all') => {
      const sent: Array<{ queue: ConnectionQueue; job: ConnectionJobData }> = [];
      await dispatchConnectionJobs(
        {
          db: testDb.db,
          enqueue: (queue, job) => {
            sent.push({ queue, job });
            return Promise.resolve(true);
          },
        },
        dispatcher,
      );
      return sent;
    };
    const expected = [{ queue: 'sp-orders-sync', job: { organizationId: org, connectionId } }];

    expect(await dispatch('sp-orders-sync-all')).toEqual(expected);
    expect(await dispatch('sp-orders-poll-all')).toEqual([]);

    await createSpReportRequests(testDb.db, {
      organizationId: org,
      sellerAccountId: account!.id,
      requests: [{ reportType: 'R', dataStart: new Date(0), dataEnd: new Date(1) }],
      markHistory: false,
      now: new Date(Date.now() - 1000),
    });
    expect(await dispatch('sp-orders-poll-all')).toEqual(expected);
  });
});
