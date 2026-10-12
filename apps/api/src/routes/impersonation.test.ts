import { schema } from '@profitbash/db';
import type { ErrorResponse, MeResponse, PlatformMemberList } from '@profitbash/shared';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const { auditEvents, clients, organizations, sessions } = schema;

/**
 * Impersonation (6.5, F4): Ein Superadmin handelt mit den vollen Rechten eines Nutzers, höchstens eine Stunde.
 * Jedes Audit-Event nennt ihn als Handelnden und den Nutzer im `target`.
 */

let ctx: TestContext;
let root: string;
const ids = { ina: '', root2: '', kim: '', customerOrg: '', client: '' };
const PATH = '/api/platform/impersonation';

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const agency = ctx.seeded.organizationId;
  ids.ina = (
    await createUser(ctx, { email: 'ina@muuv.test', org: { id: agency, role: 'admin' } })
  ).id;
  ids.root2 = (
    await createUser(ctx, {
      email: 'root2@muuv.test',
      role: 'superadmin',
      org: { id: agency, role: 'viewer' },
    })
  ).id;
  const [customerOrg] = await db
    .insert(organizations)
    .values({
      name: 'Nordwind GmbH',
      slug: 'kunde-nordwind',
      type: 'client',
      createdAt: new Date(),
    })
    .returning({ id: organizations.id });
  ids.customerOrg = customerOrg!.id;
  const [client] = await db
    .insert(clients)
    .values({
      organizationId: agency,
      name: 'Nordwind',
      slug: 'nordwind',
      clientOrganizationId: ids.customerOrg,
    })
    .returning({ id: clients.id });
  ids.client = client!.id;
  ids.kim = (
    await createUser(ctx, {
      email: 'kim@nordwind.test',
      org: { id: ids.customerOrg, role: 'viewer' },
    })
  ).id;
  root = await signIn(ctx, ctx.seeded.email);
});

afterAll(async () => {
  await ctx?.close();
});

const errorCodeOf = async (res: Response) => (await readJson<ErrorResponse>(res)).error.code;

/** Cookie-Header nach einer Antwort: gesetzte Cookies ersetzen, gelöschte (leer oder Max-Age=0) entfallen. */
function applyCookies(cookie: string, res: Response): string {
  const jar = new Map(cookie.split('; ').map((pair) => pair.split(/=(.*)/s) as [string, string]));
  for (const header of res.headers.getSetCookie()) {
    const [name, value] = header.split(';')[0]!.split(/=(.*)/s) as [string, string];
    if (value === '' || /max-age=0/i.test(header)) jar.delete(name);
    else jar.set(name, value);
  }
  return [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function start(userId: string, cookie = root) {
  const res = await request(ctx, PATH, { method: 'POST', cookie, json: { userId } });
  return { res, cookie: applyCookies(cookie, res) };
}

async function stop(cookie: string) {
  const res = await request(ctx, PATH, { method: 'DELETE', cookie });
  return { res, cookie: applyCookies(cookie, res) };
}

const me = async (cookie: string) =>
  readJson<MeResponse>(await request(ctx, '/api/me', { cookie }));

const lastAudit = async (action: string) => {
  const [row] = await ctx.testDb.db
    .select({
      organizationId: auditEvents.organizationId,
      actorUserId: auditEvents.actorUserId,
      target: auditEvents.target,
    })
    .from(auditEvents)
    .where(eq(auditEvents.action, action))
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(1);
  return row;
};

describe('Impersonation starten', () => {
  it('nur Superadmins; unbekannter Nutzer → 404; ein anderer Superadmin → 409', async () => {
    expect((await request(ctx, PATH, { method: 'POST', json: { userId: ids.ina } })).status).toBe(
      401,
    );
    const ina = await signIn(ctx, 'ina@muuv.test');
    expect((await start(ids.kim, ina)).res.status).toBe(403);

    const unknown = await start('00000000-0000-4000-8000-000000000000');
    expect(unknown.res.status).toBe(404);
    expect(await errorCodeOf(unknown.res)).toBe('IMPERSONATION_USER_NOT_FOUND');
    for (const userId of [ids.root2, ctx.seeded.userId]) {
      const res = (await start(userId)).res;
      expect(res.status).toBe(409);
      expect(await errorCodeOf(res)).toBe('IMPERSONATION_SUPERADMIN');
    }
    expect((await request(ctx, PATH, { method: 'POST', cookie: root, json: {} })).status).toBe(400);
    expect(await lastAudit('platform.impersonation_start')).toBeUndefined();
    expect((await me(root)).impersonatedBy).toBeNull();
  });

  it('die Liste der Mitglieder einer Organisation nennt, wer sich ansehen lässt', async () => {
    const res = await request(
      ctx,
      `/api/platform/organizations/${ctx.seeded.organizationId}/members`,
      { cookie: root },
    );
    expect(res.status).toBe(200);
    const { members } = await readJson<PlatformMemberList>(res);
    expect(members.map((m) => [m.email, m.role, m.superadmin])).toEqual([
      [ctx.seeded.email, 'admin', true],
      ['ina@muuv.test', 'admin', false],
      ['root2@muuv.test', 'viewer', true],
    ]);
    expect(members[1]!.userId).toBe(ids.ina);
  });
});

describe('Während der Impersonation', () => {
  let asIna: string;

  beforeAll(async () => {
    const started = await start(ids.ina);
    expect(started.res.status).toBe(204);
    asIna = started.cookie;
  });

  it('/api/me zeigt den Nutzer und wer ihn ansieht; die Session läuft höchstens eine Stunde', async () => {
    const body = await me(asIna);
    expect(body.user).toMatchObject({ id: ids.ina, email: 'ina@muuv.test', role: 'user' });
    expect(body.impersonatedBy).toEqual({ id: ctx.seeded.userId, name: expect.any(String) });
    const [session] = await ctx.testDb.db
      .select({ expiresAt: sessions.expiresAt })
      .from(sessions)
      .where(and(eq(sessions.userId, ids.ina), eq(sessions.impersonatedBy, ctx.seeded.userId)));
    const remaining = session!.expiresAt.getTime() - Date.now();
    expect(remaining).toBeGreaterThan(50 * 60_000);
    expect(remaining).toBeLessThanOrEqual(60 * 60_000);
    expect(await lastAudit('platform.impersonation_start')).toEqual({
      organizationId: null,
      actorUserId: ctx.seeded.userId,
      target: { type: 'user', id: ids.ina, email: 'ina@muuv.test' },
    });
  });

  it('schreibende Routen nennen den Superadmin als Handelnden und den Nutzer im target', async () => {
    const settings = await request(ctx, '/api/settings', {
      method: 'PUT',
      cookie: asIna,
      json: { theme: 'dark', locale: 'de-DE', density: 'compact' },
    });
    expect(settings.status).toBe(200);
    expect(await lastAudit('settings.update')).toMatchObject({
      actorUserId: ctx.seeded.userId,
      target: { impersonatedUserId: ids.ina },
    });

    const client = await request(ctx, '/api/clients', {
      method: 'POST',
      cookie: asIna,
      json: { name: 'Südhang' },
    });
    expect(client.status).toBe(201);
    expect(await lastAudit('client.create')).toMatchObject({
      organizationId: ctx.seeded.organizationId,
      actorUserId: ctx.seeded.userId,
      target: { type: 'client', name: 'Südhang', impersonatedUserId: ids.ina },
    });
  });

  it('auch die better-auth-Hooks nennen den Superadmin', async () => {
    await ctx.auth.api.updateOrganization({
      headers: new Headers({ cookie: asIna }),
      body: { organizationId: ctx.seeded.organizationId, data: { name: 'Muuv' } },
    });
    expect(await lastAudit('organization.update')).toMatchObject({
      actorUserId: ctx.seeded.userId,
      target: { type: 'organization', impersonatedUserId: ids.ina },
    });
  });

  it('Mitgliederverwaltung, Kundenzugang und Plattform-Routen sind gesperrt', async () => {
    const blocked: [string, string, unknown?][] = [
      ['GET', '/api/members'],
      ['POST', '/api/members', { email: 'neu@muuv.test', name: 'Neu', role: 'admin' }],
      ['POST', `/api/members/${ids.ina}/password-link`],
      ['GET', `/api/clients/${ids.client}/access`],
      ['POST', `/api/clients/${ids.client}/access`, { email: 'neu@kunde.test', name: 'Neu' }],
      ['GET', '/api/platform/organizations'],
      ['POST', PATH, { userId: ids.kim }],
    ];
    for (const [method, path, json] of blocked) {
      const res = await request(ctx, path, { method, cookie: asIna, json });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await errorCodeOf(res), `${method} ${path}`).toBe('IMPERSONATION_FORBIDDEN');
    }
    // Ohne Impersonation darf dieselbe Org-Admin die Mitglieder verwalten.
    const ina = await signIn(ctx, 'ina@muuv.test');
    expect((await request(ctx, '/api/members', { cookie: ina })).status).toBe(200);
  });

  it('Beenden stellt die Session des Superadmins wieder her und schreibt das Ende ins Audit', async () => {
    const stopped = await stop(asIna);
    expect(stopped.res.status).toBe(204);
    const body = await me(stopped.cookie);
    expect(body.user.id).toBe(ctx.seeded.userId);
    expect(body.impersonatedBy).toBeNull();
    expect(await lastAudit('platform.impersonation_stop')).toEqual({
      organizationId: null,
      actorUserId: ctx.seeded.userId,
      target: { type: 'user', id: ids.ina, email: 'ina@muuv.test', impersonatedUserId: ids.ina },
    });
    // Die Session des Nutzers ist beendet; ohne Impersonation gibt es nichts zu beenden.
    expect((await request(ctx, '/api/me', { cookie: asIna })).status).toBe(401);
    const again = await stop(stopped.cookie);
    expect(again.res.status).toBe(409);
    expect(await errorCodeOf(again.res)).toBe('IMPERSONATION_NOT_ACTIVE');
  });
});

describe('Grenzen', () => {
  it('nach Ablauf gilt die Session nicht mehr', async () => {
    const { cookie } = await start(ids.ina);
    await ctx.testDb.db
      .update(sessions)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(sessions.impersonatedBy, ctx.seeded.userId));
    expect((await request(ctx, '/api/me', { cookie })).status).toBe(401);
  });

  it('Beenden ohne die gemerkte Session des Superadmins beendet trotzdem die des Nutzers', async () => {
    const { cookie } = await start(ids.ina);
    const withoutAdminSession = cookie
      .split('; ')
      .filter((pair) => !pair.includes('admin_session'))
      .join('; ');
    expect((await stop(withoutAdminSession)).res.status).toBe(204);
    expect((await request(ctx, '/api/me', { cookie })).status).toBe(401);
    expect(await lastAudit('platform.impersonation_stop')).toMatchObject({
      actorUserId: ctx.seeded.userId,
    });
  });

  it('als Kunden-Nutzer gelten dessen Grenzen; Beenden bleibt möglich', async () => {
    const { res, cookie } = await start(ids.kim);
    expect(res.status).toBe(204);
    expect((await me(cookie)).organizations).toMatchObject([{ type: 'client', role: 'viewer' }]);
    const clientsRes = await request(ctx, '/api/clients', { cookie });
    expect(clientsRes.status).toBe(403);
    expect(await errorCodeOf(clientsRes)).toBe('CUSTOMER_ORG_FORBIDDEN');
    expect((await stop(cookie)).res.status).toBe(204);
  });
});
