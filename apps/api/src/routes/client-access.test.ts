import { schema } from '@profitbash/db';
import {
  memberListSchema,
  memberWithLinkSchema,
  type ErrorResponse,
  type FilterOptionsResponse,
  type Member,
  type MeResponse,
} from '@profitbash/shared';
import { asc, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

/**
 * Kundenzugang am Client (`phase-6.md` 6.3c, F3): Der Org-Admin der Agentur legt Kunden-Nutzer an (Kunden-Org
 * entsteht dabei), erzeugt Links neu und entzieht den Zugang. Audit im Log der Agentur als `client_access.*`.
 */

let ctx: TestContext;
let agency = '';
let admin = '';
let editor = '';
const ids = { nord: '', sued: '', foreign: '' };
const NEW_PASSWORD = 'ein-neues-passwort-456';

async function call<T>(method: string, path: string, cookie: string, json?: unknown) {
  const res = await request(ctx, `/api${path}`, { method, cookie, json });
  const body = res.status === 204 ? (undefined as T) : await readJson<T>(res);
  return { status: res.status, body };
}

const tokenOf = (url: string) => new URL(url).hash.slice(1);
const access = (clientId: string) => `/clients/${clientId}/access`;

const auditActions = async () =>
  (
    await ctx.testDb.db
      .select({
        action: schema.auditEvents.action,
        organizationId: schema.auditEvents.organizationId,
        target: schema.auditEvents.target,
      })
      .from(schema.auditEvents)
      .where(like(schema.auditEvents.action, 'client_access.%'))
      .orderBy(asc(schema.auditEvents.createdAt), asc(schema.auditEvents.id))
  ).map((event) => ({ ...event, target: event.target as Record<string, unknown> }));

beforeAll(async () => {
  ctx = await createTestContext();
  agency = ctx.seeded.organizationId;
  const { db } = ctx.testDb;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: agency, role: 'editor' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');

  const [otherAgency] = await db
    .insert(schema.organizations)
    .values({ name: 'Andere Agentur', slug: 'andere', type: 'internal', createdAt: new Date() })
    .returning({ id: schema.organizations.id });
  const [nord, sued, foreign] = await db
    .insert(schema.clients)
    .values([
      { organizationId: agency, name: 'Nordwind', slug: 'nordwind' },
      { organizationId: agency, name: 'Südhang', slug: 'suedhang' },
      { organizationId: otherAgency!.id, name: 'Fremd', slug: 'fremd' },
    ])
    .returning({ id: schema.clients.id });
  Object.assign(ids, { nord: nord!.id, sued: sued!.id, foreign: foreign!.id });
  await db.insert(schema.amazonAdsProfiles).values(
    [
      ['Konto Nord', ids.nord],
      ['Konto Süd', ids.sued],
    ].map(([accountName, clientId]) => ({
      organizationId: agency,
      clientId: clientId!,
      accountName: accountName!,
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
    })),
  );
});

afterAll(async () => {
  await ctx?.close();
});

describe('/api/clients/{id}/access', () => {
  it('nur Org-Admins; fremde und unbekannte Clients gibt es nicht', async () => {
    expect((await call('GET', access(ids.nord), '')).status).toBe(401);
    expect((await call('GET', access(ids.nord), editor)).status).toBe(403);
    const body = { email: 'x@nordwind.test', name: 'X' };
    expect((await call('POST', access(ids.nord), editor, body)).status).toBe(403);
    for (const clientId of [ids.foreign, '00000000-0000-4000-8000-000000000001']) {
      expect((await call('GET', access(clientId), admin)).status).toBe(404);
      expect((await call('POST', access(clientId), admin, body)).status).toBe(404);
    }
    expect(await auditActions()).toEqual([]);
  });

  it('ohne Kundenzugang: leere Liste, ohne dass eine Kunden-Org entsteht', async () => {
    const res = await call<{ members: Member[] }>('GET', access(ids.nord), admin);
    expect(res.status).toBe(200);
    expect(res.body.members).toEqual([]);
    const [client] = await ctx.testDb.db
      .select({ org: schema.clients.clientOrganizationId })
      .from(schema.clients)
      .where(eq(schema.clients.id, ids.nord));
    expect(client!.org).toBeNull();
  });

  it('anlegen: Kunden-Org mit Dashboard und Explorer, Nutzer als viewer, Link, Audit bei der Agentur', async () => {
    const created = await call<{ member: Member; link: { url: string; expiresAt: string } }>(
      'POST',
      access(ids.nord),
      admin,
      { email: ' Kim@Nordwind.TEST ', name: 'Kim Kunde' },
    );
    expect(created.status).toBe(201);
    expect(memberWithLinkSchema.safeParse(created.body).success).toBe(true);
    expect(created.body.member).toMatchObject({
      email: 'kim@nordwind.test',
      name: 'Kim Kunde',
      role: 'viewer',
      status: 'pending',
    });

    const { db } = ctx.testDb;
    const [client] = await db
      .select({ org: schema.clients.clientOrganizationId })
      .from(schema.clients)
      .where(eq(schema.clients.id, ids.nord));
    const [org] = await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, client!.org!));
    expect(org).toMatchObject({ name: 'Nordwind', type: 'client' });
    const entitlements = await db
      .select({ feature: schema.orgEntitlements.feature })
      .from(schema.orgEntitlements)
      .where(eq(schema.orgEntitlements.organizationId, org!.id));
    expect(entitlements.map((e) => e.feature).sort()).toEqual(['dashboard', 'sp-explorer']);

    const events = await auditActions();
    expect(events.map((e) => e.action)).toEqual([
      'client_access.org_create',
      'client_access.create',
    ]);
    expect(events.every((e) => e.organizationId === agency)).toBe(true);
    expect(events[1]!.target).toMatchObject({ clientId: ids.nord, email: 'kim@nordwind.test' });
    expect(JSON.stringify(events)).not.toContain(tokenOf(created.body.link.url));

    // Der Kunde setzt sein Passwort und sieht nur seinen Client.
    const redeemed = await call('POST', '/password-links/redeem', '', {
      token: tokenOf(created.body.link.url),
      password: NEW_PASSWORD,
    });
    expect(redeemed.status).toBe(204);
    const signedIn = await request(ctx, '/api/auth/sign-in/email', {
      method: 'POST',
      json: { email: 'kim@nordwind.test', password: NEW_PASSWORD },
    });
    const customer = signedIn.headers.get('set-cookie')!.split(';')[0]!;
    const me = await call<MeResponse>('GET', '/me', customer);
    expect(me.body.organizations).toEqual([
      expect.objectContaining({ id: org!.id, type: 'client', role: 'viewer' }),
    ]);
    const options = await call<FilterOptionsResponse>('POST', '/ads/filter-options', customer, {});
    expect(options.body.clients.map((c) => c.name)).toEqual(['Nordwind']);
    expect(options.body.profiles.map((p) => p.accountName)).toEqual(['Konto Nord']);
    // Der Kunde selbst verwaltet nichts.
    expect((await call('GET', access(ids.nord), customer)).status).toBe(403);

    const list = await call<{ members: Member[] }>('GET', access(ids.nord), admin);
    expect(memberListSchema.safeParse(list.body).success).toBe(true);
    expect(list.body.members.map((m) => [m.email, m.status])).toEqual([
      ['kim@nordwind.test', 'active'],
    ]);
    expect(
      (await call<{ members: Member[] }>('GET', access(ids.sued), admin)).body.members,
    ).toEqual([]);
    // In der Mitgliederliste der Agentur taucht der Kunde nicht auf.
    const members = await call<{ members: Member[] }>('GET', '/members', admin);
    expect(members.body.members.map((m) => m.email)).not.toContain('kim@nordwind.test');
  });

  it('ein zweiter Nutzer kommt in dieselbe Kunden-Org', async () => {
    const created = await call<{ member: Member }>('POST', access(ids.nord), admin, {
      email: 'lea@nordwind.test',
      name: 'Lea',
    });
    expect(created.status).toBe(201);
    const orgs = await ctx.testDb.db
      .select({ id: schema.organizations.id })
      .from(schema.organizations)
      .where(eq(schema.organizations.type, 'client'));
    expect(orgs).toHaveLength(1);
    expect((await auditActions()).map((e) => e.action)).toEqual([
      'client_access.org_create',
      'client_access.create',
      'client_access.create',
    ]);
  });

  it('wer schon Mitglied ist (Agentur oder anderer Kunde), kann kein Kunden-Nutzer werden', async () => {
    for (const [clientId, email] of [
      [ids.nord, 'editor@muuv.test'],
      [ids.sued, 'kim@nordwind.test'],
    ] as const) {
      const res = await call<ErrorResponse>('POST', access(clientId), admin, { email, name: 'X' });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('MEMBER_EMAIL_TAKEN');
    }
  });

  it('Link neu erzeugen und Zugang entziehen: Sessions enden, Audit bei der Agentur', async () => {
    const list = await call<{ members: Member[] }>('GET', access(ids.nord), admin);
    const kim = list.body.members.find((m) => m.email === 'kim@nordwind.test')!;
    const customer = await (async () => {
      const res = await request(ctx, '/api/auth/sign-in/email', {
        method: 'POST',
        json: { email: 'kim@nordwind.test', password: NEW_PASSWORD },
      });
      return res.headers.get('set-cookie')!.split(';')[0]!;
    })();

    // Über einen anderen Client lässt sich das Mitglied nicht ansprechen.
    expect((await call('DELETE', `${access(ids.sued)}/${kim.id}`, admin)).status).toBe(404);
    expect((await call('DELETE', `${access(ids.nord)}/${kim.id}`, editor)).status).toBe(403);

    const link = await call<{ url: string }>(
      'POST',
      `${access(ids.nord)}/${kim.id}/password-link`,
      admin,
    );
    expect(link.status).toBe(201);
    expect(tokenOf(link.body.url)).toHaveLength(43);

    expect((await call('DELETE', `${access(ids.nord)}/${kim.id}`, admin)).status).toBe(204);
    expect((await call('GET', '/me', customer)).status).toBe(401);
    expect(
      (await call('POST', '/password-links/inspect', '', { token: tokenOf(link.body.url) })).status,
    ).toBe(410);
    const after = await call<{ members: Member[] }>('GET', access(ids.nord), admin);
    expect(after.body.members.map((m) => m.email)).toEqual(['lea@nordwind.test']);

    const events = await auditActions();
    expect(events.slice(-2).map((e) => e.action)).toEqual([
      'client_access.link_create',
      'client_access.remove',
    ]);
    expect(
      events.every((e) => e.organizationId === agency && e.target.clientId !== undefined),
    ).toBe(true);
  });

  it('Mitglieder der Agentur lassen sich hier nicht entfernen', async () => {
    const members = await call<{ members: Member[] }>('GET', '/members', admin);
    const target = members.body.members.find((m) => m.email === 'editor@muuv.test')!;
    expect((await call('DELETE', `${access(ids.nord)}/${target.id}`, admin)).status).toBe(404);
  });
});
