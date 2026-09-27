import { schema } from '@profitbash/db';
import type { ErrorResponse, Profile } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const { amazonAdsProfiles, auditEvents, clients, connections, organizations } = schema;

let ctx: TestContext;
let admin: string;
let editor: string;
let orgId: string;
let otherOrgId: string;
const ids = {
  connection: '',
  reauthConnection: '',
  otherOrgConnection: '',
  visible: '',
  hidden: '',
  removed: '',
  otherOrgProfile: '',
  client: '',
  otherOrgClient: '',
};

const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

function connectionRow(organizationId: string, externalAccountId: string) {
  return {
    organizationId,
    provider: 'amazon_ads' as const,
    region: 'eu' as const,
    externalAccountId,
    externalAccountEmail: `${externalAccountId}@amazon.test`,
    refreshTokenEncrypted: 'v1:k1:nicht-benutzt',
  };
}

function profileRow(organizationId: string, connectionId: string, amazonProfileId: string) {
  return {
    organizationId,
    connectionId,
    amazonProfileId,
    amazonAccountId: 'A1SELLER',
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    marketplaceId: 'A1PA6795UKMFR9',
    accountType: 'seller',
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  orgId = ctx.seeded.organizationId;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: orgId, role: 'editor' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');

  const { db } = ctx.testDb;
  const [other] = await db
    .insert(organizations)
    .values({ name: 'Andere', slug: 'andere', type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  otherOrgId = other!.id;

  const [connection, reauth, otherOrgConnection] = await db
    .insert(connections)
    .values([
      // Eigene Zeitstempel: In einem Insert hätten alle Zeilen dasselbe now().
      {
        ...connectionRow(orgId, 'amzn1.account.EINS'),
        createdAt: new Date('2026-09-01T10:00:00Z'),
        consentedAt: new Date('2026-09-01T10:00:05Z'),
      },
      {
        ...connectionRow(orgId, 'amzn1.account.ZWEI'),
        status: 'reauth_required' as const,
        createdAt: new Date('2026-09-02T10:00:00Z'),
      },
      connectionRow(otherOrgId, 'amzn1.account.FREMD'),
    ])
    .returning({ id: connections.id });
  ids.connection = connection!.id;
  ids.reauthConnection = reauth!.id;
  ids.otherOrgConnection = otherOrgConnection!.id;

  const [client, otherOrgClient] = await db
    .insert(clients)
    .values([
      { organizationId: orgId, name: 'Nordwind', slug: 'nordwind' },
      { organizationId: otherOrgId, name: 'Fremd', slug: 'fremd' },
    ])
    .returning({ id: clients.id });
  ids.client = client!.id;
  ids.otherOrgClient = otherOrgClient!.id;

  const [visible, hidden, removed, otherOrgProfile] = await db
    .insert(amazonAdsProfiles)
    .values([
      profileRow(orgId, ids.connection, '9007199254740993'),
      { ...profileRow(orgId, ids.connection, '2222222222222222'), isHidden: true },
      { ...profileRow(orgId, ids.connection, '3333333333333333'), removedAt: new Date() },
      profileRow(otherOrgId, ids.otherOrgConnection, '4444444444444444'),
    ])
    .returning({ id: amazonAdsProfiles.id });
  ids.visible = visible!.id;
  ids.hidden = hidden!.id;
  ids.removed = removed!.id;
  ids.otherOrgProfile = otherOrgProfile!.id;
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(auditEvents);
  ctx.jobs.profilesSync.length = 0;
  ctx.jobs.enqueuedInTransaction.length = 0;
});

async function errorCode(res: Response): Promise<string> {
  return (await readJson<ErrorResponse>(res)).error.code;
}

describe('Rechte', () => {
  it('alle Endpunkte verlangen eine Session und die Rolle admin', async () => {
    const calls: [string, string, unknown?][] = [
      ['GET', '/api/connections'],
      ['POST', `/api/connections/${ids.connection}/sync`, {}],
      ['GET', `/api/connections/${ids.connection}/profiles`],
      ['PATCH', `/api/profiles/${ids.visible}`, { isHidden: true }],
      ['GET', '/api/clients'],
      ['POST', '/api/clients', { name: 'Neu' }],
      ['PATCH', `/api/clients/${ids.client}`, { name: 'Neu' }],
    ];
    for (const [method, path, json] of calls) {
      expect((await request(ctx, path, { method, json })).status, `${method} ${path}`).toBe(401);
      const res = await request(ctx, path, { method, json, cookie: editor });
      expect(res.status, `${method} ${path}`).toBe(403);
    }
  });
});

describe('GET /api/connections', () => {
  it('listet nur die Connections der aktiven Organisation, ohne Token', async () => {
    const res = await request(ctx, '/api/connections', { cookie: admin });
    expect(res.status).toBe(200);
    const body = await readJson<{ connections: Record<string, unknown>[] }>(res);
    expect(body.connections.map((c) => c.externalAccountId)).toEqual([
      'amzn1.account.EINS',
      'amzn1.account.ZWEI',
    ]);
    expect(body.connections[0]).toEqual({
      id: ids.connection,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId: 'amzn1.account.EINS',
      externalAccountEmail: 'amzn1.account.EINS@amazon.test',
      status: 'active',
      lastRefreshedAt: null,
      consentedAt: '2026-09-01T10:00:05.000Z',
      refreshTokenExpiresAt: '2027-09-01T10:00:05.000Z',
      createdAt: expect.stringMatching(/Z$/),
      updatedAt: expect.stringMatching(/Z$/),
    });
    expect(JSON.stringify(body)).not.toContain('refreshTokenEncrypted');
    expect(JSON.stringify(body)).not.toContain('v1:k1:');
  });

  it('meldet den Ablauf ohne Einwilligungszeitpunkt als unbekannt (null)', async () => {
    const res = await request(ctx, '/api/connections', { cookie: admin });
    const body = await readJson<{ connections: Record<string, unknown>[] }>(res);
    expect(body.connections[1]).toMatchObject({
      externalAccountId: 'amzn1.account.ZWEI',
      consentedAt: null,
      refreshTokenExpiresAt: null,
    });
  });
});

describe('POST /api/connections/:id/sync', () => {
  it('plant den Profil-Sync mit Kette (Entities, Reports) ein und schreibt ein Audit-Event', async () => {
    const res = await request(ctx, `/api/connections/${ids.connection}/sync`, {
      method: 'POST',
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: 'queued' });
    expect(ctx.jobs.profilesSync).toEqual([
      { organizationId: orgId, connectionId: ids.connection, chain: true },
    ]);
    // Eingeplant in der Transaktion des Audit-Events: kein Job ohne Audit-Event.
    expect(ctx.jobs.enqueuedInTransaction).toEqual([true]);

    const events = await ctx.testDb.db.select().from(auditEvents);
    expect(events).toMatchObject([
      {
        organizationId: orgId,
        actorUserId: ctx.seeded.userId,
        action: 'connection.sync_request',
        target: { type: 'connection', id: ids.connection },
      },
    ]);
  });

  it('lehnt Connections fremder Organisationen und unbekannte IDs mit 404 ab', async () => {
    for (const id of [ids.otherOrgConnection, UNKNOWN_ID]) {
      const res = await request(ctx, `/api/connections/${id}/sync`, {
        method: 'POST',
        cookie: admin,
        json: {},
      });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe('CONNECTION_NOT_FOUND');
    }
    expect(ctx.jobs.profilesSync).toHaveLength(0);
  });

  it('verlangt bei reauth_required zuerst ein Neu-Verbinden (409)', async () => {
    const res = await request(ctx, `/api/connections/${ids.reauthConnection}/sync`, {
      method: 'POST',
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('CONNECTION_REAUTH_REQUIRED');
  });

  it('schreibt kein Audit-Event, wenn das Einplanen scheitert', async () => {
    ctx.jobs.failNext = true;
    const res = await request(ctx, `/api/connections/${ids.connection}/sync`, {
      method: 'POST',
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(500);
    expect(await ctx.testDb.db.select().from(auditEvents)).toHaveLength(0);
  });

  it('lehnt ungültige IDs mit 400 ab', async () => {
    const res = await request(ctx, '/api/connections/keine-uuid/sync', {
      method: 'POST',
      cookie: admin,
      json: {},
    });
    expect(res.status).toBe(400);
  });
});

describe('GET /api/connections/:id/profiles', () => {
  it('liefert alle Profile der Connection inkl. ausgeblendeter und entfernter, IDs als String', async () => {
    const res = await request(ctx, `/api/connections/${ids.connection}/profiles`, {
      cookie: admin,
    });
    expect(res.status).toBe(200);
    const { profiles } = await readJson<{ profiles: Profile[] }>(res);
    expect(profiles.map((p) => p.id).sort()).toEqual([ids.visible, ids.hidden, ids.removed].sort());
    const visible = profiles.find((p) => p.id === ids.visible);
    expect(visible).toEqual({
      id: ids.visible,
      connectionId: ids.connection,
      clientId: null,
      amazonProfileId: '9007199254740993',
      amazonAccountId: 'A1SELLER',
      accountName: 'Konto 9007199254740993',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      marketplaceId: 'A1PA6795UKMFR9',
      accountType: 'seller',
      isHidden: false,
      removedAt: null,
      syncedAt: null,
    });
    expect(profiles.find((p) => p.id === ids.removed)?.removedAt).toMatch(/Z$/);
  });

  it('lehnt Connections fremder Organisationen mit 404 ab', async () => {
    const res = await request(ctx, `/api/connections/${ids.otherOrgConnection}/profiles`, {
      cookie: admin,
    });
    expect(res.status).toBe(404);
    expect(await errorCode(res)).toBe('CONNECTION_NOT_FOUND');
  });
});

describe('PATCH /api/profiles/:id', () => {
  const patch = (id: string, json: unknown) =>
    request(ctx, `/api/profiles/${id}`, { method: 'PATCH', cookie: admin, json });

  it('ordnet einen Client zu und blendet aus, mit Audit-Event (vorher/nachher)', async () => {
    const res = await patch(ids.visible, { clientId: ids.client, isHidden: true });
    expect(res.status).toBe(200);
    expect(await readJson<Profile>(res)).toMatchObject({
      id: ids.visible,
      clientId: ids.client,
      isHidden: true,
    });

    const events = await ctx.testDb.db.select().from(auditEvents);
    expect(events).toMatchObject([
      {
        organizationId: orgId,
        actorUserId: ctx.seeded.userId,
        action: 'profile.update',
        target: {
          type: 'amazon_ads_profile',
          id: ids.visible,
          amazonProfileId: '9007199254740993',
          before: { clientId: null, isHidden: false },
          after: { clientId: ids.client, isHidden: true },
        },
      },
    ]);

    // Zurücksetzen: nur ein Feld ändern lässt das andere unberührt.
    const reset = await patch(ids.visible, { isHidden: false });
    expect(await readJson<Profile>(reset)).toMatchObject({ clientId: ids.client, isHidden: false });
    const cleared = await patch(ids.visible, { clientId: null });
    expect(await readJson<Profile>(cleared)).toMatchObject({ clientId: null, isHidden: false });
  });

  it('erlaubt Änderungen an ausgeblendeten und entfernten Profilen', async () => {
    expect((await patch(ids.hidden, { isHidden: false })).status).toBe(200);
    expect((await patch(ids.removed, { clientId: ids.client })).status).toBe(200);
    await patch(ids.hidden, { isHidden: true });
  });

  it('lehnt einen Client einer fremden Organisation ab und ändert nichts', async () => {
    const res = await patch(ids.visible, { clientId: ids.otherOrgClient });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('CLIENT_NOT_FOUND');
    const [row] = await ctx.testDb.db
      .select({ clientId: amazonAdsProfiles.clientId })
      .from(amazonAdsProfiles)
      .where(eq(amazonAdsProfiles.id, ids.visible));
    expect(row?.clientId).toBeNull();
    expect(await ctx.testDb.db.select().from(auditEvents)).toHaveLength(0);
  });

  it('lehnt Profile fremder Organisationen und unbekannte IDs mit 404 ab', async () => {
    for (const id of [ids.otherOrgProfile, UNKNOWN_ID]) {
      const res = await patch(id, { isHidden: true });
      expect(res.status).toBe(404);
      expect(await errorCode(res)).toBe('PROFILE_NOT_FOUND');
    }
  });

  it('verlangt mindestens ein bekanntes Feld', async () => {
    for (const json of [{}, { accountName: 'x' }, { isHidden: 'ja' }]) {
      const res = await patch(ids.visible, json);
      expect(res.status, JSON.stringify(json)).toBe(400);
      expect(await errorCode(res)).toBe('VALIDATION_ERROR');
    }
  });
});

describe('Clients', () => {
  it('GET /api/clients listet die Clients der aktiven Organisation, sortiert nach Name', async () => {
    const res = await request(ctx, '/api/clients', { cookie: admin });
    expect(res.status).toBe(200);
    const body = await readJson<{ clients: { id: string; name: string; slug: string }[] }>(res);
    expect(body.clients.map((c) => c.slug)).not.toContain('fremd');
    expect(body.clients.find((c) => c.id === ids.client)).toEqual({
      id: ids.client,
      name: 'Nordwind',
      slug: 'nordwind',
      createdAt: expect.stringMatching(/Z$/),
      updatedAt: expect.stringMatching(/Z$/),
    });
    const names = body.clients.map((c) => c.name);
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  it('POST /api/clients legt einen Client an, bildet den Slug aus dem Namen und schreibt ein Audit-Event', async () => {
    const res = await request(ctx, '/api/clients', {
      method: 'POST',
      cookie: admin,
      json: { name: '  Grüne Öle  ' },
    });
    expect(res.status).toBe(201);
    const client = await readJson<{ id: string; name: string; slug: string }>(res);
    expect(client).toMatchObject({ name: 'Grüne Öle', slug: 'gruene-oele' });

    const events = await ctx.testDb.db.select().from(auditEvents);
    expect(events).toMatchObject([
      {
        organizationId: orgId,
        actorUserId: ctx.seeded.userId,
        action: 'client.create',
        target: { type: 'client', id: client.id, name: 'Grüne Öle', slug: 'gruene-oele' },
      },
    ]);
  });

  it('POST /api/clients meldet einen vergebenen Slug mit 409', async () => {
    const res = await request(ctx, '/api/clients', {
      method: 'POST',
      cookie: admin,
      json: { name: 'NORDWIND' },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe('CLIENT_SLUG_TAKEN');
  });

  it('POST /api/clients: derselbe Slug in einer anderen Organisation ist erlaubt', async () => {
    const res = await request(ctx, '/api/clients', {
      method: 'POST',
      cookie: admin,
      json: { name: 'Fremd' },
    });
    expect(res.status).toBe(201);
  });

  it('POST /api/clients verlangt einen Slug, wenn der Name keinen hergibt', async () => {
    const res = await request(ctx, '/api/clients', {
      method: 'POST',
      cookie: admin,
      json: { name: '日本' },
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe('VALIDATION_ERROR');

    const ok = await request(ctx, '/api/clients', {
      method: 'POST',
      cookie: admin,
      json: { name: '日本', slug: 'japan' },
    });
    expect(ok.status).toBe(201);
  });

  it('POST /api/clients lehnt leere Namen und ungültige Slugs ab', async () => {
    for (const json of [{ name: '   ' }, { name: 'X', slug: 'Mit Leerzeichen' }, {}]) {
      const res = await request(ctx, '/api/clients', { method: 'POST', cookie: admin, json });
      expect(res.status, JSON.stringify(json)).toBe(400);
    }
  });

  it('PATCH /api/clients/:id benennt um und schreibt ein Audit-Event (vorher/nachher)', async () => {
    const res = await request(ctx, `/api/clients/${ids.client}`, {
      method: 'PATCH',
      cookie: admin,
      json: { name: 'Nordwind GmbH' },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      id: ids.client,
      name: 'Nordwind GmbH',
      slug: 'nordwind',
    });

    const events = await ctx.testDb.db.select().from(auditEvents);
    expect(events).toMatchObject([
      {
        action: 'client.update',
        target: {
          type: 'client',
          id: ids.client,
          before: { name: 'Nordwind', slug: 'nordwind' },
          after: { name: 'Nordwind GmbH', slug: 'nordwind' },
        },
      },
    ]);
  });

  it('PATCH /api/clients/:id: 404 für fremde Clients, 409 für vergebene Slugs', async () => {
    const foreign = await request(ctx, `/api/clients/${ids.otherOrgClient}`, {
      method: 'PATCH',
      cookie: admin,
      json: { name: 'Übernommen' },
    });
    expect(foreign.status).toBe(404);
    expect(await errorCode(foreign)).toBe('CLIENT_NOT_FOUND');

    const taken = await request(ctx, `/api/clients/${ids.client}`, {
      method: 'PATCH',
      cookie: admin,
      json: { slug: 'gruene-oele' },
    });
    expect(taken.status).toBe(409);
    expect(await errorCode(taken)).toBe('CLIENT_SLUG_TAKEN');

    const empty = await request(ctx, `/api/clients/${ids.client}`, {
      method: 'PATCH',
      cookie: admin,
      json: {},
    });
    expect(empty.status).toBe(400);
  });
});
