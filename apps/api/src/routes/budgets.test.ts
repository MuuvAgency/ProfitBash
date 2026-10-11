import { schema } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import type { BudgetsOverview, ErrorResponse } from '@profitbash/shared';
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

const { amazonAdsProfiles, auditEvents, budgetCaps, orgEntitlements } = schema;

/**
 * Budget-Caps über die API (`phase-5.md` 5.9a). Je Endpunkt: Recht `write`, fremde Organisation, ausgeblendetes
 * Profil, Entitlement.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
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
const capBody = (input: Record<string, unknown> = {}) => ({
  profileId: f.profile,
  scope: { type: 'profile', ids: [] },
  amount: '1000',
  ...input,
});
const create = (cookie: string | undefined, input: Record<string, unknown> = {}) =>
  call<{ id: string }>('POST', '/ads/budgets/caps', cookie, capBody(input));
const update = (cookie: string | undefined, id: string, input: Record<string, unknown> = {}) =>
  call<{ id: string }>('PUT', `/ads/budgets/caps/${id}`, cookie, capBody(input));
const remove = (cookie: string | undefined, id: string) =>
  call('DELETE', `/ads/budgets/caps/${id}`, cookie);
const overview = (cookie: string | undefined) =>
  call<BudgetsOverview>('GET', '/ads/budgets', cookie);
const capsOf = async (cookie: string, profileId = f.profile) =>
  (await overview(cookie)).body.profiles.find((p) => p.id === profileId)?.caps;
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
  other = await seedAdChangeFixture(db, 'fremd-budgets');
  await db.insert(orgEntitlements).values({ organizationId: other.org, feature: 'budgets' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(budgetCaps);
  await hide(false);
});

describe('Budget-Caps (/api/ads/budgets)', () => {
  it('Editoren legen an, ändern und löschen; Viewer lesen nur', async () => {
    const created = await create(editor, { amount: ' 1500,50 ' });
    expect(created.status).toBe(200);
    const changed = await update(admin, created.body.id, {
      amount: '2000',
      monthAmounts: { '2026-11': '5000' },
      warnPercents: [90],
    });
    expect(changed.body).toEqual({ id: created.body.id });

    const listed = await overview(viewer);
    expect(listed.status).toBe(200);
    const profile = listed.body.profiles.find((p) => p.id === f.profile)!;
    expect(profile).toMatchObject({
      currencyCode: 'EUR',
      month: expect.stringMatching(/^\d{4}-\d\d$/),
    });
    expect(profile.caps).toMatchObject([
      {
        id: created.body.id,
        amount: '2000.00',
        monthAmounts: { '2026-11': '5000' },
        warnPercents: [90],
        campaignCount: 1,
        pacing: { actual: { value: '0' }, exact: false },
      },
    ]);

    expect((await create(viewer)).status).toBe(403);
    expect((await update(viewer, created.body.id)).status).toBe(403);
    expect((await remove(viewer, created.body.id)).status).toBe(403);
    expect((await remove(editor, created.body.id)).status).toBe(204);
    expect(await capsOf(admin)).toEqual([]);
    const events = await ctx.testDb.db
      .select({ action: auditEvents.action })
      .from(auditEvents)
      .where(eq(auditEvents.organizationId, ctx.seeded.organizationId));
    expect(events.map((e) => e.action).filter((a) => a.startsWith('budget_cap.'))).toEqual([
      'budget_cap.create',
      'budget_cap.update',
      'budget_cap.delete',
    ]);
  });

  it('prüft die Eingabe und den Umfang', async () => {
    for (const input of [
      { amount: '0' },
      { amount: '10.123' },
      { scope: { type: 'portfolios', ids: [] } },
      { scope: { type: 'campaign', ids: [] } },
      { warnPercents: [120] },
      { monthAmounts: { oktober: '5' } },
      { profileId: 'keine-uuid' },
    ]) {
      expect([input, (await create(admin, input)).status]).toEqual([input, 400]);
    }
    const unknown = await create(admin, { scope: { type: 'tags', ids: [f.profile] } });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('BUDGET_CAP_INVALID_SCOPE');
  });

  it('zeigt und ändert nichts über Org-Grenzen', async () => {
    const { body } = await create(admin);

    expect((await create(foreign)).status).toBe(404);
    expect((await create(admin, { profileId: other.profile })).status).toBe(404);
    expect((await update(foreign, body.id, { profileId: other.profile })).status).toBe(404);
    const del = await remove(foreign, body.id);
    expect(del.status).toBe(404);
    expect(del.body.error.code).toBe('BUDGET_CAP_NOT_FOUND');
    expect(await capsOf(foreign)).toBeUndefined();
    expect(await capsOf(admin)).toHaveLength(1);
  });

  it('lässt ausgeblendete Profile aus', async () => {
    const { body } = await create(admin);
    await hide(true);

    expect((await create(editor)).status).toBe(404);
    expect((await update(editor, body.id, { amount: '5' })).status).toBe(404);
    expect((await remove(editor, body.id)).status).toBe(404);
    expect(await capsOf(editor)).toBeUndefined();
  });

  it('verlangt Anmeldung und das Feature', async () => {
    expect((await overview(undefined)).status).toBe(401);
    expect((await create(undefined)).status).toBe(401);
    await ctx.testDb.db
      .delete(orgEntitlements)
      .where(eq(orgEntitlements.organizationId, other.org));
    try {
      expect((await overview(foreign)).status).toBe(403);
      expect((await create(foreign, { profileId: other.profile })).status).toBe(403);
    } finally {
      await ctx.testDb.db
        .insert(orgEntitlements)
        .values({ organizationId: other.org, feature: 'budgets' });
    }
  });
});
