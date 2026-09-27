import {
  MOCK_AMAZON_ADS_AUTHORIZATION_CODE,
  MOCK_AMAZON_ADS_IDENTITY,
} from '@profitbash/amazon-ads';
import { schema } from '@profitbash/db';
import type { ErrorResponse } from '@profitbash/shared';
import { connectionTokenAad, decrypt } from '@profitbash/shared/crypto';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MOCK_CONSENT_PATH } from '../amazon';
import { createApp } from '../app';
import { signOAuthState } from '../oauth-state';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  TEST_APP_URL,
  TEST_OAUTH_STATE_SECRET,
  type TestContext,
} from '../testing';

const { auditEvents, connections, members, verifications } = schema;

let ctx: TestContext;
let admin: string;
let editor: string;
let otherAdmin: string;
let otherAdminId: string;
let otherOrgId: string;

const CALLBACK = '/api/amazon/oauth/callback';
const RESULT_URL = `${TEST_APP_URL}/admin/connections?oauth=`;

beforeAll(async () => {
  ctx = await createTestContext();
  await createUser(ctx, {
    email: 'editor@muuv.test',
    org: { id: ctx.seeded.organizationId, role: 'editor' },
  });
  // Zweiter Admin derselben Organisation (für „fremde Session“).
  const second = await createUser(ctx, {
    email: 'zweiter-admin@muuv.test',
    org: { id: ctx.seeded.organizationId, role: 'admin' },
  });
  otherAdminId = second.id;
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  otherAdmin = await signIn(ctx, 'zweiter-admin@muuv.test');

  const [org] = await ctx.testDb.db
    .insert(schema.organizations)
    .values({ name: 'Andere Agentur', slug: 'andere', type: 'internal', createdAt: new Date() })
    .returning({ id: schema.organizations.id });
  otherOrgId = org!.id;
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(connections);
  await ctx.testDb.db.delete(auditEvents);
  ctx.jobs.profilesSync.length = 0;
});

async function start(cookie: string, json: unknown = {}) {
  return request(ctx, '/api/amazon/oauth/start', { method: 'POST', cookie, json });
}

/** Startet den Flow und liefert den `state` aus der Einwilligungs-URL. */
async function startState(cookie: string, json: unknown = {}): Promise<string> {
  const res = await start(cookie, json);
  expect(res.status).toBe(200);
  const { url } = await readJson<{ url: string }>(res);
  const state = new URL(url).searchParams.get('state');
  if (!state) throw new Error('state fehlt');
  return state;
}

function callback(params: Record<string, string>, cookie?: string) {
  return request(ctx, `${CALLBACK}?${new URLSearchParams(params)}`, cookie ? { cookie } : {});
}

async function connect(cookie: string, json: unknown = {}) {
  const state = await startState(cookie, json);
  return callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, cookie);
}

function expectResult(res: Response, result: string) {
  expect(res.status).toBe(302);
  expect(res.headers.get('location')).toBe(`${RESULT_URL}${result}`);
}

async function storedConnections() {
  return ctx.testDb.db.select().from(connections);
}

/** Einwilligungszeitpunkt liegt zwischen `after` und jetzt. */
function expectRecentConsent(consentedAt: Date | null, after: number) {
  expect(consentedAt).toBeInstanceOf(Date);
  expect(consentedAt!.getTime()).toBeGreaterThanOrEqual(after);
  expect(consentedAt!.getTime()).toBeLessThanOrEqual(Date.now());
}

function decryptToken(row: typeof connections.$inferSelect): string {
  return decrypt(row.refreshTokenEncrypted, {
    keyring: ctx.keyring,
    aad: connectionTokenAad(row),
  });
}

describe('POST /api/amazon/oauth/start', () => {
  it('verlangt eine Session und die Rolle admin', async () => {
    expect(
      (await request(ctx, '/api/amazon/oauth/start', { method: 'POST', json: {} })).status,
    ).toBe(401);
    const res = await start(editor);
    expect(res.status).toBe(403);
    expect((await readJson<ErrorResponse>(res)).error.code).toBe('FORBIDDEN');
  });

  it('liefert die Einwilligungs-URL (Mock) mit Region EU als Standard', async () => {
    const res = await start(admin);
    expect(res.status).toBe(200);
    const url = new URL((await readJson<{ url: string }>(res)).url);
    expect(`${url.origin}${url.pathname}`).toBe(`${TEST_APP_URL}${MOCK_CONSENT_PATH}`);
    expect(url.searchParams.get('scope')).toBe('advertising::campaign_management profile');
    expect(url.searchParams.get('state')).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it('speichert die Nonce einmal verwendbar in verifications', async () => {
    await startState(admin);
    const rows = await ctx.testDb.db
      .select()
      .from(verifications)
      .where(like(verifications.identifier, 'amazon-ads-oauth:%'));
    expect(rows.length).toBeGreaterThan(0);
    const expiresIn = rows.at(-1)!.expiresAt.getTime() - Date.now();
    expect(expiresIn).toBeGreaterThan(9 * 60_000);
    expect(expiresIn).toBeLessThanOrEqual(10 * 60_000);
  });

  it('lehnt eine unbekannte connectionId mit 404 ab', async () => {
    const res = await start(admin, { connectionId: '11111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(404);
    expect((await readJson<ErrorResponse>(res)).error.code).toBe('CONNECTION_NOT_FOUND');
  });

  it('lehnt eine Region ab, die nicht zur neu zu verbindenden Connection passt', async () => {
    await connect(admin);
    const [row] = await storedConnections();
    const res = await start(admin, { connectionId: row!.id, region: 'na' });
    expect(res.status).toBe(400);
    expect((await readJson<ErrorResponse>(res)).error.code).toBe('VALIDATION_ERROR');
  });
});

describe('Mock-Einwilligungsseite', () => {
  it('führt über „Erlauben“ zum Callback und verbindet das Mock-Konto', async () => {
    const res = await start(admin);
    const consentUrl = new URL((await readJson<{ url: string }>(res)).url);
    const page = await request(ctx, `${consentUrl.pathname}${consentUrl.search}`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(page.headers.get('content-security-policy')).toContain("default-src 'none'");

    const html = await page.text();
    const allow = /href="([^"]+)">Erlauben/.exec(html)?.[1]?.replaceAll('&amp;', '&');
    expect(allow).toBeDefined();
    const target = new URL(allow!);
    expect(`${target.origin}${target.pathname}`).toBe(`${TEST_APP_URL}${CALLBACK}`);

    const before = Date.now();
    expectResult(
      await request(ctx, `${target.pathname}${target.search}`, { cookie: admin }),
      'connected',
    );
    const rows = await storedConnections();
    expect(rows).toHaveLength(1);
    expectRecentConsent(rows[0]!.consentedAt, before);
  });

  it('lehnt einen fehlenden oder überlangen state ab', async () => {
    expect((await request(ctx, MOCK_CONSENT_PATH)).status).toBe(400);
    expect((await request(ctx, `${MOCK_CONSENT_PATH}?state=${'a'.repeat(2000)}`)).status).toBe(400);
  });
});

describe('GET /api/amazon/oauth/callback', () => {
  it('legt die Connection mit verschlüsseltem Token an, plant den Sync und schreibt ein Audit-Event', async () => {
    const before = Date.now();
    expectResult(await connect(admin), 'connected');

    const [row] = await storedConnections();
    expectRecentConsent(row!.consentedAt, before);
    expect(row).toMatchObject({
      organizationId: ctx.seeded.organizationId,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId: MOCK_AMAZON_ADS_IDENTITY.userId,
      externalAccountEmail: MOCK_AMAZON_ADS_IDENTITY.email,
      status: 'active',
      createdBy: ctx.seeded.userId,
    });
    expect(row!.refreshTokenEncrypted).toMatch(/^v1:k1:/);
    expect(decryptToken(row!)).toMatch(/^Atzr\|mock-refresh-/);

    expect(ctx.jobs.profilesSync).toEqual([
      { organizationId: ctx.seeded.organizationId, connectionId: row!.id },
    ]);

    const events = await ctx.testDb.db.select().from(auditEvents);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      organizationId: ctx.seeded.organizationId,
      actorUserId: ctx.seeded.userId,
      action: 'connection.create',
      target: {
        type: 'connection',
        id: row!.id,
        provider: 'amazon_ads',
        region: 'eu',
        externalAccountId: MOCK_AMAZON_ADS_IDENTITY.userId,
        consentedAt: row!.consentedAt!.toISOString(),
      },
    });
    expect(JSON.stringify(events[0]!.target)).not.toContain('Atzr');
  });

  it('Neu-Verbinden aktualisiert die Connection statt sie zu duplizieren, und der Token bleibt entschlüsselbar', async () => {
    expectResult(await connect(admin), 'connected');
    const [first] = await storedConnections();
    // Einwilligung liegt fast ein Jahr zurück: Neu-Verbinden startet die 365 Tage neu.
    await ctx.testDb.db
      .update(connections)
      .set({ status: 'reauth_required', consentedAt: new Date('2025-10-01T00:00:00Z') })
      .where(eq(connections.id, first!.id));

    const before = Date.now();
    expectResult(await connect(admin, { connectionId: first!.id }), 'connected');

    const rows = await storedConnections();
    expect(rows).toHaveLength(1);
    const [second] = rows;
    expect(second!.id).toBe(first!.id);
    expect(second!.status).toBe('active');
    expect(second!.refreshTokenEncrypted).not.toBe(first!.refreshTokenEncrypted);
    expect(decryptToken(second!)).toMatch(/^Atzr\|mock-refresh-/);
    expect(decryptToken(second!)).not.toBe(decryptToken(first!));

    // Der Token funktioniert danach wirklich (Mock-LWA akzeptiert ihn beim Refresh).
    const ref = { id: second!.id, organizationId: second!.organizationId, region: 'eu' as const };
    await expect(ctx.deps.amazonAds.client.getAccessToken(ref)).resolves.toMatch(/^Atza\|/);

    expectRecentConsent(second!.consentedAt, before);

    const events = await ctx.testDb.db.select().from(auditEvents);
    expect(events.map((e) => e.action)).toEqual(['connection.create', 'connection.reconnect']);
    expect(events[1]!.target).toMatchObject({ consentedAt: second!.consentedAt!.toISOString() });
  });

  it('Verbinden ohne connectionId mit demselben Konto aktualisiert ebenfalls, samt Einwilligung', async () => {
    await connect(admin);
    await ctx.testDb.db.update(connections).set({ consentedAt: null });
    const before = Date.now();
    await connect(admin);
    const rows = await storedConnections();
    expect(rows).toHaveLength(1);
    expectRecentConsent(rows[0]!.consentedAt, before);
  });

  it('verwirft nach dem Neu-Verbinden das gecachte Access-Token', async () => {
    await connect(admin);
    const [row] = await storedConnections();
    const ref = { id: row!.id, organizationId: row!.organizationId, region: 'eu' as const };
    const before = await ctx.deps.amazonAds.client.getAccessToken(ref);
    expect(await ctx.deps.amazonAds.client.getAccessToken(ref)).toBe(before);

    await connect(admin, { connectionId: row!.id });
    expect(await ctx.deps.amazonAds.client.getAccessToken(ref)).not.toBe(before);
  });

  it('lehnt eine fremde Session am Callback ab und legt nichts an', async () => {
    const state = await startState(admin);
    const res = await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, otherAdmin);
    expectResult(res, 'session_mismatch');
    expect(await storedConnections()).toHaveLength(0);
    expect(ctx.jobs.profilesSync).toHaveLength(0);
  });

  it('lehnt den Callback ohne Session ab', async () => {
    const state = await startState(admin);
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }),
      'session_mismatch',
    );
    expect(await storedConnections()).toHaveLength(0);
  });

  it('lehnt einen wiederverwendeten state ab', async () => {
    const state = await startState(admin);
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, admin),
      'connected',
    );
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, admin),
      'state_used',
    );
  });

  it('lehnt einen abgelaufenen state ab', async () => {
    const state = signOAuthState(
      {
        organizationId: ctx.seeded.organizationId,
        userId: ctx.seeded.userId,
        connectionId: null,
        region: 'eu',
        nonce: 'abgelaufene-nonce-0000000000',
        expiresAt: Date.now() - 1000,
      },
      TEST_OAUTH_STATE_SECRET,
    );
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, admin),
      'state_expired',
    );
  });

  it('lehnt einen gefälschten oder fehlenden state ab', async () => {
    const forged = signOAuthState(
      {
        organizationId: ctx.seeded.organizationId,
        userId: ctx.seeded.userId,
        connectionId: null,
        region: 'eu',
        nonce: 'gefaelschte-nonce-00000000000',
        expiresAt: Date.now() + 60_000,
      },
      'ein-anderes-secret-mit-mindestens-32-zeichen',
    );
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state: forged }, admin),
      'invalid_state',
    );
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE }, admin),
      'invalid_state',
    );
  });

  it('lehnt einen korrekt signierten state ohne gespeicherte Nonce ab', async () => {
    const state = signOAuthState(
      {
        organizationId: ctx.seeded.organizationId,
        userId: ctx.seeded.userId,
        connectionId: null,
        region: 'eu',
        nonce: 'nie-gespeicherte-nonce-000000',
        expiresAt: Date.now() + 60_000,
      },
      TEST_OAUTH_STATE_SECRET,
    );
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, admin),
      'state_used',
    );
  });

  it('lehnt ab, wenn der Nutzer inzwischen kein Admin der Organisation mehr ist', async () => {
    const state = await startState(otherAdmin);
    await ctx.testDb.db
      .update(members)
      .set({ role: 'editor' })
      .where(
        and(
          eq(members.userId, otherAdminId),
          eq(members.organizationId, ctx.seeded.organizationId),
        ),
      );
    try {
      expectResult(
        await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, otherAdmin),
        'forbidden',
      );
      expect(await storedConnections()).toHaveLength(0);
    } finally {
      await ctx.testDb.db
        .update(members)
        .set({ role: 'admin' })
        .where(
          and(
            eq(members.userId, otherAdminId),
            eq(members.organizationId, ctx.seeded.organizationId),
          ),
        );
    }
  });

  it('nutzt die Organisation aus dem state, nicht die aktive Organisation', async () => {
    // Nicht-Mitglied der anderen Org: ein state für diese Org (korrekt signiert) wird abgelehnt.
    const nonce = 'fremde-org-nonce-000000000000';
    await ctx.testDb.db.insert(verifications).values({
      identifier: `amazon-ads-oauth:${nonce}`,
      value: ctx.seeded.userId,
      expiresAt: new Date(Date.now() + 60_000),
    });
    const state = signOAuthState(
      {
        organizationId: otherOrgId,
        userId: ctx.seeded.userId,
        connectionId: null,
        region: 'eu',
        nonce,
        expiresAt: Date.now() + 60_000,
      },
      TEST_OAUTH_STATE_SECRET,
    );
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, admin),
      'forbidden',
    );
    expect(await storedConnections()).toHaveLength(0);
  });

  it('zeigt eine abgelehnte Einwilligung als Hinweis und verbraucht den state', async () => {
    const state = await startState(admin);
    expectResult(
      await callback({ error: 'access_denied', error_description: 'nein', state }, admin),
      'access_denied',
    );
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, admin),
      'state_used',
    );
    expect(await storedConnections()).toHaveLength(0);
  });

  it('meldet einen von Amazon abgelehnten Code als amazon_error, ohne den Code zu loggen', async () => {
    const state = await startState(admin);
    const code = 'ungueltiger-code-geheim';
    expectResult(await callback({ code, state }, admin), 'amazon_error');
    expect(await storedConnections()).toHaveLength(0);
    expect(JSON.stringify(ctx.logs)).not.toContain(code);
    expect(JSON.stringify(ctx.logs)).not.toContain(state);
  });

  it('lehnt beim Neu-Verbinden eine gelöschte Connection ab', async () => {
    await connect(admin);
    const [row] = await storedConnections();
    const state = await startState(admin, { connectionId: row!.id });
    await ctx.testDb.db.delete(connections);
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, admin),
      'connection_not_found',
    );
    expect(await storedConnections()).toHaveLength(0);
  });

  it('lehnt beim Neu-Verbinden ein anderes Amazon-Konto ab', async () => {
    await connect(admin);
    const [row] = await storedConnections();
    await ctx.testDb.db
      .update(connections)
      .set({ externalAccountId: 'amzn1.account.ANDERESKONTO' })
      .where(eq(connections.id, row!.id));
    const state = await startState(admin, { connectionId: row!.id });
    expectResult(
      await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, admin),
      'account_mismatch',
    );
    expect(await storedConnections()).toHaveLength(1);
  });

  it('leitet auch bei unerwarteten Fehlern mit Hinweis zurück statt eine JSON-Seite zu zeigen', async () => {
    const { client } = ctx.deps.amazonAds;
    const app = createApp({
      ...ctx.deps,
      amazonAds: {
        ...ctx.deps.amazonAds,
        client: { ...client, exchangeCode: () => Promise.reject(new Error('DB weg')) },
      },
    });
    const state = await startState(admin);
    const res = await app.request(
      `${CALLBACK}?${new URLSearchParams({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state })}`,
      { headers: { cookie: admin } },
    );
    expectResult(res, 'internal_error');
    expect(ctx.logs.some((entry) => entry.msg === 'amazon_oauth.callback_error')).toBe(true);
  });

  it('meldet einen nicht eingeplanten Sync, behält aber die Connection', async () => {
    ctx.jobs.failNext = true;
    expectResult(await connect(admin), 'connected_sync_failed');
    expect(await storedConnections()).toHaveLength(1);
  });

  it('loggt den Callback ohne Query-String (Code und state bleiben aus dem Log)', async () => {
    const state = await startState(admin);
    ctx.logs.length = 0;
    await callback({ code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE, state }, admin);
    const requestLog = ctx.logs.find((entry) => entry.msg === 'request');
    expect(requestLog?.path).toBe(CALLBACK);
    expect(JSON.stringify(ctx.logs)).not.toContain(state);
  });
});
