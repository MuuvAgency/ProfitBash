import { schema } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import type {
  AdvertisedProductsResponse,
  ErrorResponse,
  ProductGroup,
  ProductGroupListResponse,
} from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const { amazonAdsProfiles, auditEvents, orgEntitlements, productGroups } = schema;

/**
 * Produktgruppen über die API (`phase-4.md` 4.1). Je Endpunkt: Recht `write`, fremde Organisation, ausgeblendetes
 * Profil, Entitlement `tools`.
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
const items = [{ asin: 'B0TEST0001', sku: 'SKU-1', isHero: true }];
const create = (cookie: string | undefined, name: string, profileId = f.profile) =>
  call<ProductGroup>('POST', '/ads/tools/product-groups', cookie, { profileId, name, items });
const list = (cookie: string | undefined) =>
  call<ProductGroupListResponse>('GET', '/ads/tools/product-groups', cookie);
const advertised = (cookie: string | undefined, profileId = f.profile) =>
  call<AdvertisedProductsResponse>(
    'GET',
    `/ads/tools/advertised-products?profileId=${profileId}`,
    cookie,
  );
const hide = (hidden: boolean) =>
  ctx.testDb.db
    .update(amazonAdsProfiles)
    .set({ isHidden: hidden })
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
  other = await seedAdChangeFixture(db, 'fremd-gruppen');
  await db.insert(orgEntitlements).values({ organizationId: other.org, feature: 'tools' });
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
  await ctx.testDb.db.delete(productGroups);
  await ctx.testDb.db.delete(auditEvents);
  await hide(false);
});

describe('Produktgruppen (/api/ads/tools/product-groups)', () => {
  it('Editoren legen an, ändern und löschen; Viewer lesen nur', async () => {
    const created = await create(editor, '  Flaschen  ');
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ name: 'Flaschen', profileId: f.profile, items });

    const listed = await list(viewer);
    expect(listed.status).toBe(200);
    expect(listed.body.groups.map((group) => group.name)).toEqual(['Flaschen']);
    expect(listed.body.profiles.map((profile) => profile.accountName)).toContain('Nordwind DE');
    expect(listed.body.maxItems).toBeGreaterThan(0);

    const id = created.body.id;
    expect((await create(viewer, 'Nein')).status).toBe(403);
    expect(
      (await call('PATCH', `/ads/tools/product-groups/${id}`, viewer, { name: 'X' })).status,
    ).toBe(403);
    expect((await call('DELETE', `/ads/tools/product-groups/${id}`, viewer)).status).toBe(403);

    const renamed = await call<ProductGroup>('PATCH', `/ads/tools/product-groups/${id}`, editor, {
      name: 'Trinkflaschen',
      items: [
        { asin: 'B0TEST0002', sku: 'SKU-2', isHero: true },
        { asin: 'B0TEST0001', sku: 'SKU-1' },
      ],
    });
    expect(renamed.status).toBe(200);
    expect(renamed.body.items.map((item) => item.asin)).toEqual(['B0TEST0002', 'B0TEST0001']);

    expect((await call('DELETE', `/ads/tools/product-groups/${id}`, editor)).status).toBe(204);
    const events = await ctx.testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action).sort()).toEqual([
      'product_group.create',
      'product_group.delete',
      'product_group.update',
    ]);
  });

  it('meldet vergebene Namen und die SKU-Regel als Konflikt bzw. ungültige Eingabe', async () => {
    await create(admin, 'Flaschen');
    const taken = await create(admin, 'FLASCHEN');
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('PRODUCT_GROUP_NAME_TAKEN');

    const noSku = await call('POST', '/ads/tools/product-groups', admin, {
      profileId: f.profile,
      name: 'Ohne SKU',
      items: [{ asin: 'B0TEST0001' }],
    });
    expect(noSku.status).toBe(400);
    expect(noSku.body.error.code).toBe('PRODUCT_GROUP_SKU_REQUIRED');
  });

  it('prüft die Eingabe', async () => {
    const base = { profileId: f.profile, name: 'X', items };
    const post = (body: unknown) => call('POST', '/ads/tools/product-groups', admin, body);
    expect((await post({ ...base, items: [] })).status).toBe(400);
    expect((await post({ ...base, items: [{ asin: 'kurz' }] })).status).toBe(400);
    expect((await post({ ...base, profileId: 'kein-uuid' })).status).toBe(400);
    expect((await post({ ...base, extra: true })).status).toBe(400);
  });

  it('kennt fremde Organisationen und ausgeblendete Profile nicht', async () => {
    const theirs = await create(foreign, 'Fremd', other.profile);
    expect(theirs.status).toBe(201);
    expect((await create(admin, 'Fremd', other.profile)).status).toBe(404);
    expect(
      (await call('PATCH', `/ads/tools/product-groups/${theirs.body.id}`, admin, { name: 'X' }))
        .status,
    ).toBe(404);
    expect(
      (await call('DELETE', `/ads/tools/product-groups/${theirs.body.id}`, admin)).status,
    ).toBe(404);
    expect((await list(admin)).body.groups).toEqual([]);

    const mine = await create(admin, 'Meine');
    await hide(true);
    const hidden = await list(admin);
    expect(hidden.body.groups).toEqual([]);
    expect(hidden.body.profiles.map((profile) => profile.id)).not.toContain(f.profile);
    expect(
      (await call('PATCH', `/ads/tools/product-groups/${mine.body.id}`, admin, { name: 'X' }))
        .status,
    ).toBe(404);
    expect((await create(admin, 'Versteckt')).status).toBe(404);
  });

  it('verlangt das Feature „tools“ und eine Anmeldung', async () => {
    expect((await list(undefined)).status).toBe(401);
    const orgId = ctx.seeded.organizationId;
    const where = and(
      eq(orgEntitlements.organizationId, orgId),
      eq(orgEntitlements.feature, 'tools'),
    );
    await ctx.testDb.db.update(orgEntitlements).set({ enabled: false }).where(where);
    try {
      expect((await list(admin)).status).toBe(403);
      expect((await advertised(admin)).status).toBe(403);
    } finally {
      await ctx.testDb.db.update(orgEntitlements).set({ enabled: true }).where(where);
    }
  });
});

describe('Beworbene Produkte (/api/ads/tools/advertised-products)', () => {
  it('liefert die beworbenen Produkte eines sichtbaren Profils, auch für Viewer', async () => {
    const res = await advertised(viewer);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      truncated: false,
      products: [
        {
          asin: 'B0TEST0001',
          sku: 'SKU-1',
          adProducts: ['SPONSORED_PRODUCTS'],
          enabled: true,
          groupIds: [],
        },
      ],
    });
  });

  it('kennt fremde und ausgeblendete Profile nicht und prüft die Profil-ID', async () => {
    expect((await advertised(admin, other.profile)).status).toBe(404);
    await hide(true);
    expect((await advertised(admin)).status).toBe(404);
    expect((await advertised(admin, 'kein-uuid')).status).toBe(400);
  });
});
