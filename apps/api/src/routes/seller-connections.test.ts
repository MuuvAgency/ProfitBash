import { MOCK_AMAZON_SP_REFRESH_TOKEN } from '@profitbash/amazon-sp';
import { schema } from '@profitbash/db';
import type {
  ErrorResponse,
  SellerAccount,
  SellerAccountsSync,
  SellerConnection,
} from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const { amazonSpAccounts, amazonSpCredentials, auditEvents, clients, connections, organizations } =
  schema;

let ctx: TestContext;
let admin: string;
let editor: string;
let otherAdmin: string;
let orgId: string;
let connectionId = '';
const UNKNOWN_ID = '11111111-1111-4111-8111-111111111111';

const body = (overrides: object = {}) => ({
  region: 'eu',
  amazonSellerId: 'A1MOCKSELLER01',
  clientId: 'amzn1.application-oa2-client.test',
  clientSecret: 'SECRET-CLIENT',
  refreshToken: MOCK_AMAZON_SP_REFRESH_TOKEN,
  ...overrides,
});

const post = (cookie: string, path: string, json?: unknown) =>
  request(ctx, path, { method: 'POST', cookie, ...(json !== undefined && { json }) });

async function list(cookie: string) {
  const res = await request(ctx, '/api/seller-connections', { cookie });
  return (await readJson<{ connections: SellerConnection[] }>(res)).connections;
}

beforeAll(async () => {
  ctx = await createTestContext();
  orgId = ctx.seeded.organizationId;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: orgId, role: 'editor' } });
  const [other] = await ctx.testDb.db
    .insert(organizations)
    .values({ name: 'Andere', slug: 'andere', type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  await createUser(ctx, { email: 'admin@andere.test', org: { id: other!.id, role: 'admin' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  otherAdmin = await signIn(ctx, 'admin@andere.test');
});

afterAll(async () => {
  await ctx.close();
});

describe('POST /api/seller-connections („Token eintragen“)', () => {
  it('ist Org-Admins vorbehalten', async () => {
    expect((await post(editor, '/api/seller-connections', body())).status).toBe(403);
    expect((await request(ctx, '/api/seller-connections', { cookie: editor })).status).toBe(403);
    expect((await request(ctx, '/api/seller-connections')).status).toBe(401);
  });

  it('lehnt ungültige Eingaben ab, bevor Amazon gefragt wird', async () => {
    for (const invalid of [
      body({ amazonSellerId: 'a:b' }),
      body({ refreshToken: 'kein-token' }),
      body({ clientSecret: '' }),
      body({ region: 'xx' }),
    ]) {
      expect((await post(admin, '/api/seller-connections', invalid)).status).toBe(400);
    }
  });

  it('speichert nichts, wenn Amazon den Refresh-Token ablehnt', async () => {
    const res = await post(admin, '/api/seller-connections', body({ refreshToken: 'Atzr|falsch' }));
    expect(res.status).toBe(400);
    expect((await readJson<ErrorResponse>(res)).error.code).toBe('SP_TOKEN_REJECTED');
    expect(await ctx.testDb.db.select().from(amazonSpCredentials)).toEqual([]);
  });

  it('prüft die Zugangsdaten, legt Connection und Seller-Konten an und gibt keine Secrets zurück', async () => {
    const res = await post(admin, '/api/seller-connections', body());
    expect(res.status).toBe(201);
    const text = await res.clone().text();
    expect(text).not.toMatch(/SECRET-CLIENT|Atzr\|/);
    const created = await readJson<SellerAccountsSync>(res);
    // Der Mock-Verkäufer nimmt in DE und FR teil, in UK nicht.
    expect(created).toMatchObject({ accounts: 2, skippedMarketplaceIds: [] });
    connectionId = created.connectionId;

    const [connection] = await list(admin);
    expect(connection).toMatchObject({
      id: connectionId,
      region: 'eu',
      amazonSellerId: 'A1MOCKSELLER01',
      status: 'active',
    });
    expect(connection!.accounts.map((a) => [a.countryCode, a.currencyCode, a.clientId])).toEqual([
      ['DE', 'EUR', null],
      ['FR', 'EUR', null],
    ]);
    expect(JSON.stringify(connection)).not.toMatch(/SECRET-CLIENT|Atzr\|/);
    expect(JSON.stringify(ctx.logs)).not.toMatch(/SECRET-CLIENT|Atzr\|/);

    const audit = await ctx.testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'connection.create'));
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ organizationId: orgId, actorUserId: ctx.seeded.userId });
  });

  it('verbindet dieselbe Seller-ID neu, statt eine zweite Connection anzulegen', async () => {
    const res = await post(admin, '/api/seller-connections', body({ clientSecret: 'SECRET-NEU' }));
    expect(res.status).toBe(200);
    expect((await readJson<SellerAccountsSync>(res)).connectionId).toBe(connectionId);
    expect(await list(admin)).toHaveLength(1);
  });

  it('zeigt Connections nur der eigenen Organisation und nie in der Ads-Liste', async () => {
    expect(await list(otherAdmin)).toEqual([]);
    const ads = await request(ctx, '/api/connections', { cookie: admin });
    expect((await readJson<{ connections: unknown[] }>(ads)).connections).toEqual([]);
    // Der Ads-Sync nimmt keine SP-Connection an.
    expect((await post(admin, `/api/connections/${connectionId}/sync`)).status).toBe(404);
  });
});

describe('POST /api/seller-connections/{id}/sync', () => {
  it('gleicht die Seller-Konten mit Amazon ab und schreibt ein Audit-Event', async () => {
    const { db } = ctx.testDb;
    // Ein Konto, das Amazon nicht mehr liefert, wird als entfernt markiert.
    const [de] = await db.select().from(amazonSpAccounts).limit(1);
    await db.insert(amazonSpAccounts).values({
      ...de!,
      id: undefined,
      marketplaceId: 'A1805IZSGTT6HS',
      countryCode: 'NL',
    });

    const res = await post(admin, `/api/seller-connections/${connectionId}/sync`);

    expect(res.status).toBe(200);
    expect(await readJson<SellerAccountsSync>(res)).toMatchObject({ connectionId, accounts: 2 });
    const [connection] = await list(admin);
    const nl = connection!.accounts.find((a) => a.countryCode === 'NL');
    expect(nl!.removedAt).not.toBeNull();
    const audit = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'connection.sync_request'));
    expect(audit).toHaveLength(1);
  });

  it('kennt fremde, unbekannte und Ads-Connections nicht', async () => {
    expect((await post(otherAdmin, `/api/seller-connections/${connectionId}/sync`)).status).toBe(
      404,
    );
    expect((await post(admin, `/api/seller-connections/${UNKNOWN_ID}/sync`)).status).toBe(404);
    expect((await post(editor, `/api/seller-connections/${connectionId}/sync`)).status).toBe(403);
  });

  it('markiert die Connection, wenn Amazon den gespeicherten Token ablehnt', async () => {
    const { db } = ctx.testDb;
    const res0 = await post(
      admin,
      '/api/seller-connections',
      body({ region: 'na', amazonSellerId: 'A2ZWEITERSELLER' }),
    );
    const second = (await readJson<SellerAccountsSync>(res0)).connectionId;
    // Der Mock nimmt nur seinen Token an: ein anderer gespeicherter Wert gilt als widerrufen.
    const { connectionTokenAad, encrypt } = await import('@profitbash/shared/crypto');
    const [row] = await db.select().from(connections).where(eq(connections.id, second));
    await db
      .update(connections)
      .set({
        refreshTokenEncrypted: encrypt('Atzr|widerrufen', {
          keyring: ctx.keyring,
          aad: connectionTokenAad(row!),
        }),
      })
      .where(eq(connections.id, second));
    ctx.deps.amazonSp.client.invalidateAccessToken(second);

    const res = await post(admin, `/api/seller-connections/${second}/sync`);

    expect(res.status).toBe(409);
    expect((await readJson<ErrorResponse>(res)).error.code).toBe('CONNECTION_REAUTH_REQUIRED');
    const connection = (await list(admin)).find((c) => c.id === second);
    expect(connection!.status).toBe('reauth_required');
  });
});

describe('PATCH /api/seller-accounts/{id}', () => {
  it('ordnet ein Konto einem Client zu, blendet es aus und protokolliert vorher/nachher', async () => {
    const { db } = ctx.testDb;
    const [client] = await db
      .insert(clients)
      .values({ organizationId: orgId, name: 'Nordwind', slug: 'nordwind' })
      .returning({ id: clients.id });
    const [connection] = await list(admin);
    const account = connection!.accounts[0]!;

    const res = await request(ctx, `/api/seller-accounts/${account.id}`, {
      method: 'PATCH',
      cookie: admin,
      json: { clientId: client!.id, isHidden: true },
    });

    expect(res.status).toBe(200);
    expect(await readJson<SellerAccount>(res)).toMatchObject({
      id: account.id,
      clientId: client!.id,
      isHidden: true,
    });
    const [audit] = await db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'seller_account.update'));
    expect(audit!.target).toMatchObject({
      id: account.id,
      before: { clientId: null, isHidden: false },
      after: { clientId: client!.id, isHidden: true },
    });
  });

  it('lehnt fremde Konten, fremde Clients und Nicht-Admins ab', async () => {
    const { db } = ctx.testDb;
    const [connection] = await list(admin);
    const account = connection!.accounts[0]!;
    const [foreignClient] = await db
      .insert(clients)
      .values({
        organizationId: (
          await db.select().from(organizations).where(eq(organizations.slug, 'andere'))
        )[0]!.id,
        name: 'Fremd',
        slug: 'fremd',
      })
      .returning({ id: clients.id });
    const patch = (cookie: string, id: string, json: object) =>
      request(ctx, `/api/seller-accounts/${id}`, { method: 'PATCH', cookie, json });

    expect((await patch(otherAdmin, account.id, { isHidden: false })).status).toBe(404);
    expect((await patch(admin, UNKNOWN_ID, { isHidden: false })).status).toBe(404);
    expect((await patch(admin, account.id, { clientId: foreignClient!.id })).status).toBe(400);
    expect((await patch(editor, account.id, { isHidden: false })).status).toBe(403);
    expect((await patch(admin, account.id, {})).status).toBe(400);
  });
});
