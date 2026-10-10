import { schema } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import type { ErrorResponse, Goal, GoalsOverview, TargetAcosResponse } from '@profitbash/shared';
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

const { amazonAdsProfiles, auditEvents, clients, goals, orgEntitlements } = schema;

/**
 * Ziele über die API (`phase-5.md` 5.3). Je Endpunkt: Recht `write`, fremde Organisation, ausgeblendetes Profil,
 * Entitlement.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
let client = '';
let admin = '';
let editor = '';
let viewer = '';
let foreign = '';

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api${path}`, { method, cookie, json });
  const body =
    res.status === 204 ? ({} as T & ErrorResponse) : await readJson<T & ErrorResponse>(res);
  return { status: res.status, body };
}
const put = (cookie: string | undefined, type: string, id: string, value = '25', metric = 'acos') =>
  call<Goal>('PUT', '/ads/goals', cookie, { scope: { type, id }, metric, value });
const overview = (cookie: string | undefined) => call<GoalsOverview>('GET', '/ads/goals', cookie);
const calculate = (cookie: string | undefined, body: Record<string, unknown>) =>
  call<TargetAcosResponse>('POST', '/ads/goals/calculate', cookie, body);
const hide = (isHidden: boolean) =>
  ctx.testDb.db
    .update(amazonAdsProfiles)
    .set({ isHidden })
    .where(eq(amazonAdsProfiles.id, f.profile));

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const orgId = ctx.seeded.organizationId;
  const editorUser = await createUser(ctx, {
    email: 'editor@muuv.test',
    org: { id: orgId, role: 'editor' },
  });
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  f = await seedAdChangeFixture(db, 'muuv-api', {
    org: orgId,
    ada: ctx.seeded.userId,
    emil: editorUser.id,
  });
  other = await seedAdChangeFixture(db, 'fremd-ziele');
  await db.insert(orgEntitlements).values({ organizationId: other.org, feature: 'goals' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  const [kunde] = await db
    .insert(clients)
    .values({ organizationId: orgId, name: 'Kunde', slug: 'kunde-ziele' })
    .returning({ id: clients.id });
  client = kunde!.id;
  await db
    .update(amazonAdsProfiles)
    .set({ clientId: client })
    .where(eq(amazonAdsProfiles.id, f.profile));
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(goals);
  await hide(false);
});

describe('Ziele (/api/ads/goals)', () => {
  it('Editoren setzen, ersetzen und löschen Ziele; Viewer lesen nur', async () => {
    const created = await put(editor, 'client', client, ' 12,5 ');
    expect(created.status).toBe(200);
    expect(created.body).toMatchObject({ metric: 'acos', value: '12.5', acos: '12.5', roas: '8' });
    const replaced = await put(admin, 'client', client, '4', 'roas');
    expect(replaced.body).toMatchObject({ id: created.body.id, metric: 'roas', acos: '25' });

    const listed = await overview(viewer);
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toMatchObject([
      { id: client, goal: { roas: '4' }, profiles: [{ id: f.profile, goal: null }] },
    ]);
    expect(listed.body.unassignedProfiles.map((p) => p.id)).toContain(f.fileProfile);

    expect((await put(viewer, 'client', client)).status).toBe(403);
    expect((await call('DELETE', `/ads/goals/${created.body.id}`, viewer)).status).toBe(403);
    expect((await call('DELETE', `/ads/goals/${created.body.id}`, editor)).status).toBe(204);
    expect((await overview(admin)).body.clients[0]!.goal).toBeNull();
    const events = await ctx.testDb.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, ctx.seeded.organizationId));
    expect(events.map((e) => e.action).filter((a) => a.startsWith('goal.'))).toEqual(
      expect.arrayContaining(['goal.set', 'goal.delete']),
    );
  });

  it('prüft den Wert: Format und Grenzen je Kennzahl', async () => {
    for (const [value, metric] of [
      ['0', 'acos'],
      ['100.01', 'acos'],
      ['0.5', 'roas'],
      ['12.345', 'acos'],
      ['abc', 'acos'],
    ] as const) {
      const res = await put(admin, 'client', client, value, metric);
      expect([value, res.status]).toEqual([value, 400]);
    }
    expect((await put(admin, 'client', 'keine-uuid')).status).toBe(400);
    expect((await put(admin, 'campaign', client)).status).toBe(400);
  });

  it('zeigt und ändert nichts über Org-Grenzen', async () => {
    const { body } = await put(admin, 'profile', f.profile);

    expect((await put(foreign, 'profile', f.profile)).status).toBe(404);
    expect((await put(foreign, 'client', client)).status).toBe(404);
    expect((await put(admin, 'profile', other.profile)).status).toBe(404);
    const del = await call('DELETE', `/ads/goals/${body.id}`, foreign);
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('GOAL_NOT_FOUND');
    const theirs = await overview(foreign);
    expect(theirs.body.clients).toEqual([]);
    expect(theirs.body.unassignedProfiles.map((p) => p.id)).not.toContain(f.profile);
  });

  it('lässt ausgeblendete Profile aus', async () => {
    const { body } = await put(admin, 'profile', f.profile);
    await hide(true);

    expect((await put(editor, 'profile', f.profile, '30')).status).toBe(404);
    expect((await put(editor, 'client', client)).status).toBe(404);
    expect((await call('DELETE', `/ads/goals/${body.id}`, editor)).status).toBe(404);
    expect((await overview(editor)).body.clients).toEqual([]);
  });

  it('verlangt Anmeldung und das Feature', async () => {
    expect((await overview(undefined)).status).toBe(401);
    expect((await put(undefined, 'client', client)).status).toBe(401);
    expect((await calculate(undefined, {})).status).toBe(401);
    await ctx.testDb.db
      .delete(orgEntitlements)
      .where(eq(orgEntitlements.organizationId, other.org));
    try {
      expect((await overview(foreign)).status).toBe(403);
      expect((await put(foreign, 'profile', other.profile)).status).toBe(403);
      expect((await calculate(foreign, {})).status).toBe(403);
    } finally {
      await ctx.testDb.db
        .insert(orgEntitlements)
        .values({ organizationId: other.org, feature: 'goals' });
    }
  });
});

describe('Rechner (/api/ads/goals/calculate)', () => {
  it('rechnet Break-even- und Ziel-ACoS, auch für Viewer', async () => {
    const res = await calculate(viewer, {
      price: '20',
      unitCost: '6',
      fees: '6,00',
      margin: '15',
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ breakEvenAcos: '40', targetAcos: '25', targetRoas: '4' });
  });

  it('meldet „kein Ziel“, wenn nichts bleibt, und lehnt ungültige Eingaben ab', async () => {
    const none = await calculate(admin, { price: '20', unitCost: '12', fees: '6', margin: '15' });
    expect(none.body).toEqual({ breakEvenAcos: '10', targetAcos: null, targetRoas: null });
    for (const body of [
      { price: '0', unitCost: '1', fees: '1', margin: '5' },
      { price: '20', unitCost: '-1', fees: '1', margin: '5' },
      { price: '20', unitCost: '1', fees: '1', margin: '101' },
      { price: '20', unitCost: '1', fees: '1' },
    ]) {
      expect((await calculate(admin, body)).status).toBe(400);
    }
  });
});
