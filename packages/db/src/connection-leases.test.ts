import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  acquireConnectionLease,
  extendConnectionLease,
  releaseConnectionLease,
} from './connection-leases';
import { connectionJobLeases, connections, organizations } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let organizationId = '';
let otherOrganizationId = '';
let connectionId = '';
let otherConnectionId = '';

async function createOrganization(slug: string): Promise<string> {
  const [org] = await testDb.db
    .insert(organizations)
    .values({ name: slug, slug, type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  if (!org) throw new Error('Organisation fehlt');
  return org.id;
}

async function createConnection(orgId: string, externalAccountId: string): Promise<string> {
  const [row] = await testDb.db
    .insert(connections)
    .values({
      organizationId: orgId,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId,
      refreshTokenEncrypted: 'verschlüsselt',
    })
    .returning({ id: connections.id });
  if (!row) throw new Error('Connection fehlt');
  return row.id;
}

const lease = (jobRunId: string, overrides: { connectionId?: string; job?: string } = {}) => ({
  organizationId,
  connectionId: overrides.connectionId ?? connectionId,
  job: overrides.job ?? 'profiles-sync',
  jobRunId,
  ttlSeconds: 900,
});

async function leaseRow(id = connectionId) {
  const [row] = await testDb.db
    .select()
    .from(connectionJobLeases)
    .where(eq(connectionJobLeases.connectionId, id));
  return row;
}

async function expireLease(id = connectionId) {
  await testDb.db
    .update(connectionJobLeases)
    .set({ expiresAt: sql`now() - interval '1 second'` })
    .where(eq(connectionJobLeases.connectionId, id));
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization('muuv');
  otherOrganizationId = await createOrganization('andere');
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(connectionJobLeases);
  await testDb.db.delete(connections);
  connectionId = await createConnection(organizationId, 'amzn1.account.A');
  otherConnectionId = await createConnection(organizationId, 'amzn1.account.B');
});

describe('acquireConnectionLease', () => {
  it('nimmt eine freie Lease und hält Job, Lauf und Ablauf fest', async () => {
    const runId = randomUUID();
    await expect(acquireConnectionLease(testDb.db, lease(runId))).resolves.toEqual({
      acquired: true,
    });
    const row = await leaseRow();
    expect(row).toMatchObject({ organizationId, job: 'profiles-sync', jobRunId: runId });
    const ttl = (row!.expiresAt.getTime() - row!.acquiredAt.getTime()) / 1000;
    expect(ttl).toBeCloseTo(900, 0);
  });

  it('verweigert eine belegte Lease und nennt den Halter', async () => {
    const holder = randomUUID();
    await acquireConnectionLease(testDb.db, lease(holder, { job: 'entities-sync' }));
    const result = await acquireConnectionLease(testDb.db, lease(randomUUID()));
    expect(result).toMatchObject({
      acquired: false,
      heldBy: { job: 'entities-sync', jobRunId: holder },
    });
    expect((await leaseRow())?.jobRunId).toBe(holder);
  });

  it('übernimmt eine abgelaufene Lease (Absturz des Halters)', async () => {
    await acquireConnectionLease(testDb.db, lease(randomUUID()));
    await expireLease();
    const next = randomUUID();
    await expect(acquireConnectionLease(testDb.db, lease(next))).resolves.toEqual({
      acquired: true,
    });
    expect((await leaseRow())?.jobRunId).toBe(next);
  });

  it('führt Leases je Connection getrennt', async () => {
    await acquireConnectionLease(testDb.db, lease(randomUUID()));
    await expect(
      acquireConnectionLease(testDb.db, lease(randomUUID(), { connectionId: otherConnectionId })),
    ).resolves.toEqual({ acquired: true });
  });

  it('lässt sich nicht für die Connection einer fremden Organisation nehmen', async () => {
    const foreign = await createConnection(otherOrganizationId, 'amzn1.account.FREMD');
    await expect(
      acquireConnectionLease(testDb.db, lease(randomUUID(), { connectionId: foreign })),
    ).rejects.toThrow();
    expect(await leaseRow(foreign)).toBeUndefined();
  });

  it('übernimmt eine abgelaufene Lease nicht aus dem Kontext einer fremden Organisation', async () => {
    const holder = randomUUID();
    await acquireConnectionLease(testDb.db, lease(holder));
    await expireLease();
    await expect(
      acquireConnectionLease(testDb.db, {
        ...lease(randomUUID()),
        organizationId: otherOrganizationId,
      }),
    ).resolves.toEqual({ acquired: false, heldBy: null });
    expect(await leaseRow()).toMatchObject({ organizationId, jobRunId: holder });
  });
});

describe('extendConnectionLease', () => {
  it('verlängert nur die eigene Lease', async () => {
    const runId = randomUUID();
    await acquireConnectionLease(testDb.db, lease(runId));
    await expireLease();
    await expect(
      extendConnectionLease(testDb.db, {
        organizationId,
        connectionId,
        jobRunId: runId,
        ttlSeconds: 600,
      }),
    ).resolves.toBe(true);
    expect((await leaseRow())!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 590_000);
  });

  it('meldet false, wenn ein anderer Lauf die Lease inzwischen hält', async () => {
    const runId = randomUUID();
    await acquireConnectionLease(testDb.db, lease(runId));
    await expireLease();
    await acquireConnectionLease(testDb.db, lease(randomUUID()));
    await expect(
      extendConnectionLease(testDb.db, {
        organizationId,
        connectionId,
        jobRunId: runId,
        ttlSeconds: 600,
      }),
    ).resolves.toBe(false);
  });
});

describe('releaseConnectionLease', () => {
  it('gibt die eigene Lease frei', async () => {
    const runId = randomUUID();
    await acquireConnectionLease(testDb.db, lease(runId));
    await expect(
      releaseConnectionLease(testDb.db, { organizationId, connectionId, jobRunId: runId }),
    ).resolves.toBe(true);
    expect(await leaseRow()).toBeUndefined();
  });

  it('lässt die Lease eines anderen Laufs stehen', async () => {
    const holder = randomUUID();
    await acquireConnectionLease(testDb.db, lease(holder));
    await expect(
      releaseConnectionLease(testDb.db, { organizationId, connectionId, jobRunId: randomUUID() }),
    ).resolves.toBe(false);
    await expect(
      releaseConnectionLease(testDb.db, {
        organizationId: otherOrganizationId,
        connectionId,
        jobRunId: holder,
      }),
    ).resolves.toBe(false);
    expect((await leaseRow())?.jobRunId).toBe(holder);
  });
});

describe('Löschen', () => {
  it('entfernt die Lease mit ihrer Connection', async () => {
    await acquireConnectionLease(testDb.db, lease(randomUUID()));
    await testDb.db.delete(connections).where(eq(connections.id, connectionId));
    expect(await leaseRow()).toBeUndefined();
  });
});
