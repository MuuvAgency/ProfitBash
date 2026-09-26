import {
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
  type AmazonAdsProfile,
  type ConnectionRef,
} from '@profitbash/amazon-ads';
import { schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { LogEntry } from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { JobFailure } from '../run-job';
import { amazonProfile, createConnection, createOrganization } from '../testing';
import type { ConnectionJobDeps, ScheduledRetry } from './connection-job';
import { syncConnectionProfiles } from './profiles-sync';

const { amazonAdsProfiles, auditEvents, clients, connections } = schema;

let testDb: TestDatabase;
let organizationId = '';
let otherOrganizationId = '';
let connectionA = '';
let connectionB = '';

/** Antworten von Amazon je Connection-ID: Profilliste oder Fehler. */
const amazon = new Map<string, AmazonAdsProfile[] | Error>();
const listed: string[] = [];
const retries: ScheduledRetry[] = [];
/** Antwort von `scheduleRetry`: `false` = für die Connection wartet schon ein Job. */
let retryAccepted = true;
const logs: LogEntry[] = [];

function deps(): ConnectionJobDeps {
  return {
    db: testDb.db,
    logger: (entry) => logs.push(entry),
    amazonAds: {
      listProfiles(connection: ConnectionRef) {
        listed.push(connection.id);
        const answer = amazon.get(connection.id);
        if (answer instanceof Error) return Promise.reject(answer);
        return Promise.resolve(answer ?? []);
      },
      getAccessToken: () => Promise.reject(new Error('nicht benutzt')),
      invalidateAccessToken: () => {},
    },
    scheduleRetry(retry) {
      retries.push(retry);
      return Promise.resolve(retryAccepted);
    },
  };
}

const sync = (connectionId: string, retryAttempt?: number) =>
  syncConnectionProfiles(deps(), {
    organizationId,
    connectionId,
    ...(retryAttempt !== undefined && { retryAttempt }),
  });

async function profile(amazonProfileId: string, orgId = organizationId) {
  const [row] = await testDb.db
    .select()
    .from(amazonAdsProfiles)
    .where(
      and(
        eq(amazonAdsProfiles.organizationId, orgId),
        eq(amazonAdsProfiles.amazonProfileId, amazonProfileId),
      ),
    );
  return row;
}

async function connectionStatus(id: string) {
  const [row] = await testDb.db
    .select({ status: connections.status })
    .from(connections)
    .where(eq(connections.id, id));
  return row?.status;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
  otherOrganizationId = await createOrganization(testDb.db, 'fremd');
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(amazonAdsProfiles);
  await testDb.db.delete(auditEvents);
  await testDb.db.delete(connections);
  connectionA = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: 'amzn1.account.A',
  });
  connectionB = await createConnection(testDb.db, {
    organizationId,
    externalAccountId: 'amzn1.account.B',
  });
  amazon.clear();
  listed.length = 0;
  retries.length = 0;
  retryAccepted = true;
  logs.length = 0;
});

describe('syncConnectionProfiles', () => {
  it('legt die Profile mit allen Feldern an; große IDs bleiben Text', async () => {
    amazon.set(connectionA, [
      amazonProfile('9007199254740993', { accountType: 'vendor', countryCode: 'UK' }),
      amazonProfile('2'),
    ]);

    const outcome = await sync(connectionA);

    expect(outcome.counters).toMatchObject({ profiles: 2, created: 2, removed: 0 });
    expect(await profile('9007199254740993')).toMatchObject({
      connectionId: connectionA,
      amazonAccountId: 'A1SELLER',
      accountName: 'Konto 9007199254740993',
      countryCode: 'UK',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      marketplaceId: 'A1PA6795UKMFR9',
      accountType: 'vendor',
      isHidden: false,
      removedAt: null,
      clientId: null,
    });
    expect((await profile('2'))?.syncedAt).toBeInstanceOf(Date);
  });

  it('aktualisiert bestehende Profile und lässt Ausblenden und Client unberührt', async () => {
    amazon.set(connectionA, [amazonProfile('1')]);
    await sync(connectionA);
    const [client] = await testDb.db
      .insert(clients)
      .values({ organizationId, name: 'Nordwind', slug: 'nordwind' })
      .returning({ id: clients.id });
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true, clientId: client?.id ?? null })
      .where(eq(amazonAdsProfiles.amazonProfileId, '1'));

    amazon.set(connectionA, [amazonProfile('1', { accountName: 'Neuer Name' })]);
    const outcome = await sync(connectionA);

    expect(outcome.counters).toMatchObject({ profiles: 1, created: 0 });
    expect(await profile('1')).toMatchObject({
      accountName: 'Neuer Name',
      isHidden: true,
      clientId: client?.id,
    });
  });

  it('markiert Profile als entfernt, die Amazon über keine Connection mehr liefert', async () => {
    amazon.set(connectionA, [amazonProfile('1'), amazonProfile('2')]);
    await sync(connectionA);

    amazon.set(connectionA, [amazonProfile('1')]);
    amazon.set(connectionB, [amazonProfile('3')]);
    const outcome = await sync(connectionA);

    expect(outcome.counters).toMatchObject({ removed: 1 });
    expect((await profile('2'))?.removedAt).toBeInstanceOf(Date);
    expect((await profile('1'))?.removedAt).toBeNull();
    // Nichts wird gelöscht, und Profile anderer Connections bleiben unberührt.
    expect(await profile('3')).toBeUndefined();
  });

  it('setzt removed_at zurück, wenn ein Profil wieder auftaucht', async () => {
    amazon.set(connectionA, [amazonProfile('1')]);
    await sync(connectionA);
    amazon.set(connectionA, []);
    await sync(connectionA);
    expect((await profile('1'))?.removedAt).toBeInstanceOf(Date);

    amazon.set(connectionA, [amazonProfile('1')]);
    await sync(connectionA);
    expect((await profile('1'))?.removedAt).toBeNull();
  });

  it('hängt ein Profil an eine andere Connection der Org, die es noch liefert', async () => {
    amazon.set(connectionA, [amazonProfile('1')]);
    await sync(connectionA);

    amazon.set(connectionA, []);
    amazon.set(connectionB, [amazonProfile('1')]);
    const outcome = await sync(connectionA);

    expect(outcome.counters).toMatchObject({ removed: 0, reassigned: 1 });
    expect(await profile('1')).toMatchObject({ connectionId: connectionB, removedAt: null });
  });

  it('entfernt nichts, wenn sich eine andere Connection nicht abfragen lässt', async () => {
    amazon.set(connectionA, [amazonProfile('1')]);
    await sync(connectionA);

    amazon.set(connectionA, []);
    amazon.set(connectionB, new AmazonAdsHttpError('Fehler', 'profiles.list', 500, null, null));
    const outcome = await sync(connectionA);

    expect(outcome.counters).toMatchObject({ removed: 0, removalDeferred: 1 });
    expect((await profile('1'))?.removedAt).toBeNull();
    expect(logs).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'profiles_sync.removal_deferred' }),
    );
  });

  it('fragt andere Connections nur ab, wenn es Kandidaten zum Entfernen gibt', async () => {
    amazon.set(connectionA, [amazonProfile('1')]);
    await sync(connectionA);
    expect(listed).toEqual([connectionA]);
  });

  it('fragt keine Connections mit reauth_required oder fremder Orgs ab', async () => {
    amazon.set(connectionA, [amazonProfile('1')]);
    await sync(connectionA);
    await testDb.db
      .update(connections)
      .set({ status: 'reauth_required' })
      .where(eq(connections.id, connectionB));
    const foreign = await createConnection(testDb.db, {
      organizationId: otherOrganizationId,
      externalAccountId: 'amzn1.account.A',
    });
    amazon.set(foreign, [amazonProfile('1')]);
    listed.length = 0;

    amazon.set(connectionA, []);
    const outcome = await sync(connectionA);

    expect(listed).toEqual([connectionA]);
    expect(outcome.counters).toMatchObject({ removed: 1 });
  });

  it('übernimmt ein Profil, das bisher an einer anderen Connection hing', async () => {
    amazon.set(connectionB, [amazonProfile('1')]);
    await sync(connectionB);

    amazon.set(connectionA, [amazonProfile('1')]);
    await sync(connectionA);

    expect(await profile('1')).toMatchObject({ connectionId: connectionA, removedAt: null });
  });

  it('markiert die Connection bei abgelehntem Refresh-Token als reauth_required', async () => {
    amazon.set(connectionA, new AmazonAdsReauthRequiredError('lwa.refresh', 400, null));

    const error = await sync(connectionA).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(JobFailure);
    expect((error as Error).message).toMatch(/neu verbunden/);
    expect(await connectionStatus(connectionA)).toBe('reauth_required');
    const audit = await testDb.db.select().from(auditEvents);
    expect(audit).toEqual([
      expect.objectContaining({
        organizationId,
        actorUserId: null,
        action: 'connection.reauth_required',
        target: { type: 'connection', id: connectionA },
      }),
    ]);
  });

  it('fragt Amazon für Connections mit reauth_required gar nicht erst ab', async () => {
    await testDb.db
      .update(connections)
      .set({ status: 'reauth_required' })
      .where(eq(connections.id, connectionA));

    await expect(sync(connectionA)).rejects.toThrow(/neu verbunden/);
    expect(listed).toEqual([]);
  });

  it('meldet eine unbekannte Connection als Fehlschlag', async () => {
    await expect(
      syncConnectionProfiles(deps(), {
        organizationId: otherOrganizationId,
        connectionId: connectionA,
      }),
    ).rejects.toThrow(/nicht gefunden/);
    expect(listed).toEqual([]);
  });

  it('plant bei Retry-After von Amazon einen neuen Versuch mit dieser Wartezeit ein', async () => {
    amazon.set(
      connectionA,
      new AmazonAdsHttpError('Rate-Limit', 'profiles.list', 429, null, null, 90_500),
    );

    await expect(sync(connectionA)).rejects.toThrow(/91 s/);

    expect(retries).toEqual([
      {
        queue: 'profiles-sync',
        job: { organizationId, connectionId: connectionA, retryAttempt: 1 },
        startAfterSeconds: 91,
      },
    ]);
    expect(await connectionStatus(connectionA)).toBe('active');
  });

  it('plant nicht neu ein, wenn Amazon länger als eine Stunde Pause verlangt', async () => {
    amazon.set(
      connectionA,
      new AmazonAdsHttpError('Rate-Limit', 'profiles.list', 429, null, null, 3_601_000),
    );
    await expect(sync(connectionA)).rejects.toThrow(/nächste reguläre Lauf/);
    expect(retries).toEqual([]);
  });

  it('meldet, wenn für die Connection schon ein Job wartet', async () => {
    retryAccepted = false;
    amazon.set(
      connectionA,
      new AmazonAdsHttpError('Rate-Limit', 'profiles.list', 429, null, null, 60_000),
    );
    const error = await sync(connectionA).catch((err: unknown) => err);
    expect((error as Error).message).toMatch(/bereits ein Job/);
    expect(error).toMatchObject({ alert: false });
  });

  it('gibt nach drei Retry-After-Versuchen auf', async () => {
    amazon.set(
      connectionA,
      new AmazonAdsHttpError('Rate-Limit', 'profiles.list', 429, null, null, 60_000),
    );
    await expect(sync(connectionA, 3)).rejects.toThrow(/keine weiteren Versuche/);
    expect(retries).toEqual([]);
  });
});
