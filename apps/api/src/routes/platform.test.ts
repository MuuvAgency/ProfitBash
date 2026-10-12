import { schema } from '@profitbash/db';
import type {
  AuditEventList,
  ErrorResponse,
  MeResponse,
  PlatformOrganization,
  PlatformOrganizationList,
  PlatformStaffList,
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

const { auditEvents, clients, organizations } = schema;

/** Plattform-Admin (6.4, F5): nur Superadmins; Audit `platform.*`. */

let ctx: TestContext;
let root: string;
let orgAdmin: string;
let orgAdminId: string;
const ids = { customerOrg: '' };
const UNKNOWN = '00000000-0000-4000-8000-000000000000';

const ROUTES: [method: string, path: string, json?: unknown][] = [
  ['GET', '/api/platform/organizations'],
  ['POST', '/api/platform/organizations', { name: 'Neu' }],
  ['PATCH', `/api/platform/organizations/${UNKNOWN}`, { name: 'Neu' }],
  ['PUT', `/api/platform/organizations/${UNKNOWN}/entitlements`, { features: [] }],
  ['GET', '/api/platform/staff'],
  ['POST', '/api/platform/staff', { email: 'admin2@muuv.test' }],
  ['DELETE', `/api/platform/staff/${UNKNOWN}`],
  ['GET', '/api/platform/audit-events'],
];

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const agency = ctx.seeded.organizationId;
  orgAdminId = (
    await createUser(ctx, { email: 'admin2@muuv.test', org: { id: agency, role: 'admin' } })
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
  await db.insert(clients).values({
    organizationId: agency,
    name: 'Nordwind',
    slug: 'nordwind',
    clientOrganizationId: ids.customerOrg,
  });
  root = await signIn(ctx, ctx.seeded.email);
  orgAdmin = await signIn(ctx, 'admin2@muuv.test');
});

afterAll(async () => {
  await ctx?.close();
});

const call = (method: string, path: string, json?: unknown, cookie = root) =>
  request(ctx, path, { method, cookie, json });

const errorCodeOf = async (res: Response) => (await readJson<ErrorResponse>(res)).error.code;

const actions = async (organizationId: string) =>
  (
    await ctx.testDb.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, organizationId))
  ).map((row) => row.action);

describe('Plattform-Admin', () => {
  it('verlangt eine Session und die Plattform-Rolle superadmin, auch von Org-Admins', async () => {
    for (const [method, path, json] of ROUTES) {
      expect((await request(ctx, path, { method, json })).status, path).toBe(401);
      const res = await call(method, path, json, orgAdmin);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(await errorCodeOf(res)).toBe('FORBIDDEN');
    }
    expect(await actions(ctx.seeded.organizationId)).not.toContain('platform.organization_create');
  });

  it('listet die Organisationen mit Typ, Mitgliederzahl, Client und Features', async () => {
    const res = await call('GET', '/api/platform/organizations');
    expect(res.status).toBe(200);
    const { organizations: list } = await readJson<PlatformOrganizationList>(res);
    expect(list.map((org) => org.name)).toEqual(['Muuv', 'Nordwind GmbH']);
    expect(list[0]).toMatchObject({ type: 'internal', customerOrg: false, memberCount: 2 });
    expect(list[0]!.features.length).toBeGreaterThan(0);
    expect(list[1]).toMatchObject({
      type: 'client',
      customerOrg: true,
      memberCount: 0,
      client: { name: 'Nordwind', ownerOrganizationId: ctx.seeded.organizationId },
      createdAt: expect.stringMatching(/Z$/),
    });
  });

  it('legt eine Organisation an, benennt sie um und bucht Features; /api/me zeigt beides', async () => {
    const created = await call('POST', '/api/platform/organizations', { name: ' Zweite Agentur ' });
    expect(created.status).toBe(201);
    const org = await readJson<PlatformOrganization>(created);
    expect(org).toMatchObject({ name: 'Zweite Agentur', slug: 'zweite-agentur', memberCount: 1 });

    const duplicate = await call('POST', '/api/platform/organizations', { name: 'Zweite Agentur' });
    expect(duplicate.status).toBe(409);
    expect(await errorCodeOf(duplicate)).toBe('PLATFORM_SLUG_TAKEN');
    const invalid = await call('POST', '/api/platform/organizations', { name: '???' });
    expect(invalid.status).toBe(400);
    expect(await errorCodeOf(invalid)).toBe('PLATFORM_INVALID_NAME');

    const renamed = await call('PATCH', `/api/platform/organizations/${org.id}`, { name: 'Zwei' });
    expect(renamed.status).toBe(200);
    expect(await readJson<PlatformOrganization>(renamed)).toMatchObject({
      name: 'Zwei',
      slug: 'zweite-agentur',
    });

    const booked = await call('PUT', `/api/platform/organizations/${org.id}/entitlements`, {
      features: ['tags', 'dashboard'],
    });
    expect(booked.status).toBe(200);
    expect((await readJson<PlatformOrganization>(booked)).features).toEqual(['dashboard', 'tags']);

    // Der Anlegende ist Admin der neuen Organisation und kann in sie wechseln.
    const switched = await call('POST', '/api/auth/organization/set-active', {
      organizationId: org.id,
    });
    expect(switched.status).toBe(200);
    const me = await readJson<MeResponse>(await call('GET', '/api/me'));
    expect(me.activeOrganizationId).toBe(org.id);
    expect(me.organizations.find((o) => o.id === org.id)).toMatchObject({
      name: 'Zwei',
      type: 'internal',
      role: 'admin',
    });
    expect(me.features.tags).toEqual({ view: true, write: true, entitled: true });
    expect(me.features.goals.entitled).toBe(false);
    await call('POST', '/api/auth/organization/set-active', {
      organizationId: ctx.seeded.organizationId,
    });

    expect(await actions(org.id)).toEqual([
      'platform.organization_create',
      'platform.organization_rename',
      'platform.entitlements_update',
    ]);
  });

  it('unbekannte Organisation → 404, ungültige Eingaben → 400, Kunden-Org nur mit Kunden-Features', async () => {
    const missing = await call('PATCH', `/api/platform/organizations/${UNKNOWN}`, { name: 'X' });
    expect(missing.status).toBe(404);
    expect(await errorCodeOf(missing)).toBe('PLATFORM_NOT_FOUND');
    const entitlements = `/api/platform/organizations/${ids.customerOrg}/entitlements`;
    expect((await call('PUT', entitlements, { features: ['gibt-es-nicht'] })).status).toBe(400);
    expect((await call('POST', '/api/platform/organizations', { name: ' ' })).status).toBe(400);
    const notForCustomers = await call('PUT', entitlements, { features: ['dashboard', 'tags'] });
    expect(notForCustomers.status).toBe(409);
    expect(await errorCodeOf(notForCustomers)).toBe('PLATFORM_FEATURE_NOT_FOR_CUSTOMERS');
    expect((await call('PUT', entitlements, { features: ['dashboard'] })).status).toBe(200);
  });

  it('Staff: Rolle vergeben wirkt sofort, entziehen auch; der letzte Superadmin bleibt', async () => {
    const list = async () =>
      (await readJson<PlatformStaffList>(await call('GET', '/api/platform/staff'))).staff;
    expect(await list()).toEqual([
      { id: ctx.seeded.userId, name: expect.any(String), email: ctx.seeded.email, isSelf: true },
    ]);

    const lastOne = await call('DELETE', `/api/platform/staff/${ctx.seeded.userId}`);
    expect(lastOne.status).toBe(409);
    expect(await errorCodeOf(lastOne)).toBe('PLATFORM_LAST_SUPERADMIN');
    const unknown = await call('POST', '/api/platform/staff', { email: 'niemand@muuv.test' });
    expect(unknown.status).toBe(404);

    expect((await call('POST', '/api/platform/staff', { email: 'Admin2@muuv.test' })).status).toBe(
      204,
    );
    expect((await list()).map((s) => s.email).sort()).toEqual([
      'admin2@muuv.test',
      ctx.seeded.email,
    ]);
    expect((await call('GET', '/api/platform/staff', undefined, orgAdmin)).status).toBe(200);

    expect((await call('DELETE', `/api/platform/staff/${orgAdminId}`)).status).toBe(204);
    expect((await call('GET', '/api/platform/staff', undefined, orgAdmin)).status).toBe(403);

    // Plattformweite Ereignisse (ohne Organisation) zeigt nur der Plattform-Admin.
    const res = await call('GET', '/api/platform/audit-events');
    expect(res.status).toBe(200);
    const { events } = await readJson<AuditEventList>(res);
    expect(events.map((event) => event.action)).toEqual([
      'platform.staff_revoke',
      'platform.staff_grant',
    ]);
    expect(events[0]).toMatchObject({
      actor: { email: ctx.seeded.email },
      target: { type: 'user', id: orgAdminId, email: 'admin2@muuv.test' },
    });

    // Blättern: Der Cursor liefert die Ereignisse davor.
    const older = await call('GET', `/api/platform/audit-events?cursor=${events[0]!.id}`);
    expect((await readJson<AuditEventList>(older)).events.map((event) => event.action)).toEqual([
      'platform.staff_grant',
    ]);
    expect((await call('GET', '/api/platform/audit-events?cursor=x')).status).toBe(400);
  });
});
