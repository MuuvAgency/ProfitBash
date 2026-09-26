import { schema } from '@profitbash/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorResponse, MeResponse } from '@profitbash/shared';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

let ctx: TestContext;
let otherOrgId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const [other] = await ctx.testDb.db
    .insert(schema.organizations)
    .values({ name: 'Kunde Soapi', slug: 'soapi', type: 'client', createdAt: new Date() })
    .returning({ id: schema.organizations.id });
  otherOrgId = other!.id;
  await ctx.testDb.db
    .insert(schema.orgEntitlements)
    .values({ organizationId: otherOrgId, feature: 'dashboard', enabled: true });
});

afterAll(async () => {
  await ctx?.close();
});

async function me(cookie: string) {
  const res = await request(ctx, '/api/me', { cookie });
  expect(res.status).toBe(200);
  return readJson<MeResponse>(res);
}

describe('GET /api/me', () => {
  it('verlangt eine Session', async () => {
    const res = await request(ctx, '/api/me');
    expect(res.status).toBe(401);
    expect((await readJson<ErrorResponse>(res)).error.code).toBe('UNAUTHORIZED');
  });

  it('liefert Nutzer, Organisationen, aktive Org, Feature-Rechte und Default-Einstellungen', async () => {
    const body = await me(await signIn(ctx, ctx.seeded.email));

    expect(body.user).toEqual({
      id: ctx.seeded.userId,
      email: ctx.seeded.email,
      name: 'Admin',
      role: 'superadmin',
    });
    expect(body.organizations).toEqual([
      {
        id: ctx.seeded.organizationId,
        name: 'Muuv',
        slug: 'muuv',
        type: 'internal',
        role: 'admin',
      },
    ]);
    expect(body.activeOrganizationId).toBe(ctx.seeded.organizationId);
    // Der Seed bucht alle Features, der Admin darf überall schreiben.
    expect(body.features.dashboard).toEqual({ view: true, write: true, entitled: true });
    expect(body.features.profit).toEqual({ view: true, write: true, entitled: true });
    expect(body.preferences).toEqual({ theme: 'system', locale: 'de-DE', density: 'comfortable' });
  });

  it('viewer sehen gebuchte Features nur lesend, abgeschaltete gar nicht', async () => {
    await createUser(ctx, {
      email: 'viewer@muuv.test',
      org: { id: ctx.seeded.organizationId, role: 'viewer' },
    });
    const goals = and(
      eq(schema.orgEntitlements.organizationId, ctx.seeded.organizationId),
      eq(schema.orgEntitlements.feature, 'goals'),
    );
    await ctx.testDb.db.update(schema.orgEntitlements).set({ enabled: false }).where(goals);
    try {
      const body = await me(await signIn(ctx, 'viewer@muuv.test'));
      expect(body.user.role).toBe('user');
      expect(body.organizations[0]?.role).toBe('viewer');
      expect(body.features.dashboard).toEqual({ view: true, write: false, entitled: true });
      expect(body.features.goals).toEqual({ view: false, write: false, entitled: false });
    } finally {
      await ctx.testDb.db.update(schema.orgEntitlements).set({ enabled: true }).where(goals);
    }
  });

  it('ohne Organisation: keine aktive Org und keine Feature-Rechte', async () => {
    await createUser(ctx, { email: 'loner@muuv.test' });
    const body = await me(await signIn(ctx, 'loner@muuv.test'));
    expect(body.organizations).toEqual([]);
    expect(body.activeOrganizationId).toBeNull();
    expect(Object.values(body.features).every((f) => !f.view)).toBe(true);
  });

  it('folgt der in der Session gewählten Organisation und nutzt deren Rolle und Entitlements', async () => {
    await createUser(ctx, {
      email: 'multi@muuv.test',
      org: { id: ctx.seeded.organizationId, role: 'admin' },
    });
    const [multi] = await ctx.testDb.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, 'multi@muuv.test'));
    await ctx.testDb.db.insert(schema.members).values({
      organizationId: otherOrgId,
      userId: multi!.id,
      role: 'viewer',
      // Ausdrücklich später: Bei gleicher Millisekunde entschiede die (zufällige) Org-ID.
      createdAt: new Date(Date.now() + 60_000),
    });
    const cookie = await signIn(ctx, 'multi@muuv.test');
    // Beim Login ist die älteste Mitgliedschaft (Muuv) aktiv.
    expect((await me(cookie)).activeOrganizationId).toBe(ctx.seeded.organizationId);

    const setActive = await request(ctx, '/api/auth/organization/set-active', {
      method: 'POST',
      cookie,
      json: { organizationId: otherOrgId },
    });
    expect(setActive.status).toBe(200);

    const body = await me(cookie);
    expect(body.activeOrganizationId).toBe(otherOrgId);
    expect(body.features.dashboard).toEqual({ view: true, write: false, entitled: true });
    expect(body.features.profit).toEqual({ view: false, write: false, entitled: false });

    // Wird die Mitgliedschaft der aktiven Org entzogen, fällt /me auf die älteste Mitgliedschaft zurück.
    await ctx.testDb.db
      .delete(schema.members)
      .where(
        and(eq(schema.members.userId, multi!.id), eq(schema.members.organizationId, otherOrgId)),
      );
    const after = await me(cookie);
    expect(after.activeOrganizationId).toBe(ctx.seeded.organizationId);
    expect(after.features.profit).toEqual({ view: true, write: true, entitled: true });

    // Der Fallback wird in die Session zurückgeschrieben, damit better-auth dieselbe Org nutzt.
    const [session] = await ctx.testDb.db
      .select({ activeOrganizationId: schema.sessions.activeOrganizationId })
      .from(schema.sessions)
      .where(eq(schema.sessions.userId, multi!.id));
    expect(session?.activeOrganizationId).toBe(ctx.seeded.organizationId);
  });

  it('reicht eine von better-auth verlängerte Session als Cookie an den Browser weiter', async () => {
    const cookie = await signIn(ctx, ctx.seeded.email);
    const token = decodeURIComponent(cookie.split('=')[1]!).split('.')[0]!;
    // Session läuft bald ab → better-auth verlängert sie beim nächsten Zugriff.
    await ctx.testDb.db
      .update(schema.sessions)
      .set({ expiresAt: new Date(Date.now() + 60 * 60 * 1000) })
      .where(eq(schema.sessions.token, token));

    const res = await request(ctx, '/api/me', { cookie });
    expect(res.status).toBe(200);
    expect(res.headers.get('set-cookie')).toContain('better-auth.session_token=');

    const [session] = await ctx.testDb.db
      .select({ expiresAt: schema.sessions.expiresAt })
      .from(schema.sessions)
      .where(eq(schema.sessions.token, token));
    expect(session!.expiresAt.getTime()).toBeGreaterThan(Date.now() + 24 * 60 * 60 * 1000);
  });

  it('liefert gespeicherte Einstellungen', async () => {
    await ctx.testDb.db.insert(schema.userPreferences).values({
      userId: ctx.seeded.userId,
      theme: 'dark',
      locale: 'en-US',
      density: 'compact',
    });
    const body = await me(await signIn(ctx, ctx.seeded.email));
    expect(body.preferences).toEqual({ theme: 'dark', locale: 'en-US', density: 'compact' });
  });
});
