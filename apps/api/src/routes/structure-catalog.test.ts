import { schema } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import {
  DEFAULT_STRUCTURE_CATALOG,
  type ErrorResponse,
  type ProductGroup,
  type StructureCatalogResponse,
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

const { auditEvents, clientPresets, clients, orgEntitlements, productGroups, structureCatalogs } =
  schema;

/**
 * Struktur-Katalog über die API (`phase-4.md` 4.2, F11): lesen mit `view`, ändern nur Admins, Presets je Client und
 * Produktgruppe mit `write`. Fremde Organisation und Entitlement `tools`.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
let client = '';
let foreignClient = '';
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
const get = (cookie: string | undefined) =>
  call<StructureCatalogResponse>('GET', '/ads/tools/catalog', cookie);
const changed = () => {
  const catalog = structuredClone(DEFAULT_STRUCTURE_CATALOG);
  catalog.naming.pattern = '{adType}-{block}-{group}';
  return catalog;
};
const save = (cookie: string | undefined, catalog: unknown, version = 0) =>
  call<StructureCatalogResponse>('PUT', '/ads/tools/catalog', cookie, { catalog, version });

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
  other = await seedAdChangeFixture(db, 'fremd-katalog');
  await db.insert(orgEntitlements).values({ organizationId: other.org, feature: 'tools' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  const [mine, theirs] = await db
    .insert(clients)
    .values([
      { organizationId: orgId, name: 'Waldkauz', slug: 'waldkauz' },
      { organizationId: other.org, name: 'Fremd', slug: 'fremd' },
    ])
    .returning({ id: clients.id });
  client = mine!.id;
  foreignClient = theirs!.id;
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(structureCatalogs);
  await ctx.testDb.db.delete(clientPresets);
  await ctx.testDb.db.delete(productGroups);
  await ctx.testDb.db.delete(auditEvents);
});

describe('Struktur-Katalog (/api/ads/tools/catalog)', () => {
  it('liefert allen Mitgliedern die Startwerte mit Clients', async () => {
    const res = await get(viewer);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ version: 0, updatedAt: null, clientPresets: [] });
    expect(res.body.catalog).toEqual(DEFAULT_STRUCTURE_CATALOG);
    expect(res.body.clients.map((entry) => entry.name)).toContain('Waldkauz');
    expect(res.body.clients.map((entry) => entry.name)).not.toContain('Fremd');
  });

  it('lässt nur Admins speichern; Editoren und Viewer bekommen 403', async () => {
    expect((await save(editor, changed())).status).toBe(403);
    expect((await save(viewer, changed())).status).toBe(403);
    const saved = await save(admin, changed());
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(1);
    expect((await get(editor)).body.catalog.naming.pattern).toBe('{adType}-{block}-{group}');
    // Der Katalog der anderen Organisation bleibt bei den Startwerten.
    expect((await get(foreign)).body.version).toBe(0);
  });

  it('meldet eine veraltete Version als Konflikt und prüft den Katalog', async () => {
    await save(admin, changed());
    const stale = await save(admin, changed(), 0);
    expect(stale.status).toBe(409);
    expect(stale.body.error.code).toBe('STRUCTURE_CATALOG_VERSION_CONFLICT');

    const broken = changed();
    broken.edges.push({ ...broken.edges[0]!, from: 'SP-BRAND-DEF', to: 'SP-KW-EXACT' });
    const invalid = await save(admin, broken, 1);
    expect(invalid.status).toBe(400);
  });

  it('verlangt das Feature „tools“ und eine Anmeldung', async () => {
    expect((await get(undefined)).status).toBe(401);
    const orgId = ctx.seeded.organizationId;
    const where = and(
      eq(orgEntitlements.organizationId, orgId),
      eq(orgEntitlements.feature, 'tools'),
    );
    await ctx.testDb.db.update(orgEntitlements).set({ enabled: false }).where(where);
    try {
      expect((await get(admin)).status).toBe(403);
    } finally {
      await ctx.testDb.db.update(orgEntitlements).set({ enabled: true }).where(where);
    }
  });
});

describe('Preset je Client (/api/ads/tools/client-presets/{clientId})', () => {
  const put = (cookie: string, clientId: string, presetKey: string | null) =>
    call('PUT', `/ads/tools/client-presets/${clientId}`, cookie, { presetKey });

  it('Editoren setzen und lösen das Preset, Viewer nicht', async () => {
    expect((await put(viewer, client, 'launch')).status).toBe(403);
    expect((await put(editor, client, 'launch')).status).toBe(204);
    expect((await get(viewer)).body.clientPresets).toEqual([
      { clientId: client, presetKey: 'launch' },
    ]);
    expect((await put(editor, client, null)).status).toBe(204);
    expect((await get(viewer)).body.clientPresets).toEqual([]);
  });

  it('kennt nur Presets des Katalogs und eigene Clients', async () => {
    const unknown = await put(admin, client, 'gibt-es-nicht');
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('STRUCTURE_CATALOG_UNKNOWN_PRESET');
    expect((await put(admin, foreignClient, 'launch')).status).toBe(404);
  });
});

describe('Preset je Produktgruppe', () => {
  it('nimmt das Preset beim Anlegen und Ändern an und lehnt unbekannte ab', async () => {
    const created = await call<ProductGroup>('POST', '/ads/tools/product-groups', editor, {
      profileId: f.profile,
      name: 'Flaschen',
      items: [{ asin: 'B0TEST0001', sku: 'SKU-1' }],
      presetKey: 'control',
    });
    expect(created.status).toBe(201);
    expect(created.body.presetKey).toBe('control');
    const cleared = await call<ProductGroup>(
      'PATCH',
      `/ads/tools/product-groups/${created.body.id}`,
      editor,
      { presetKey: null },
    );
    expect(cleared.body.presetKey).toBeNull();
    const unknown = await call('PATCH', `/ads/tools/product-groups/${created.body.id}`, editor, {
      presetKey: 'gibt-es-nicht',
    });
    expect(unknown.status).toBe(400);
    expect(unknown.body.error.code).toBe('PRODUCT_GROUP_UNKNOWN_PRESET');
  });
});

describe('Baustein je Kampagne (/api/ads/tools/campaign-blocks)', () => {
  type List = { campaigns: { campaignId: string; blockKey: string | null }[]; truncated: boolean };
  const list = (cookie: string | undefined, profileId = f.profile) =>
    call<List>('GET', `/ads/tools/campaign-blocks?profileId=${profileId}`, cookie);
  const set = (cookie: string | undefined, blockKey: string | null, profileId = f.profile) =>
    call<{ changed: number }>('PUT', '/ads/tools/campaign-blocks', cookie, {
      profileId,
      assignments: [{ campaignId: f.campaign, blockKey }],
    });

  beforeEach(async () => {
    await ctx.testDb.db.delete(schema.campaignBlocks);
  });

  it('listet für alle Mitglieder, bestätigt nur mit „write“ und schreibt Audit', async () => {
    expect((await list(undefined)).status).toBe(401);
    const before = await list(viewer);
    expect(before.status).toBe(200);
    expect(before.body.campaigns).toMatchObject([{ campaignId: f.campaign, blockKey: null }]);
    expect((await set(viewer, 'SP-AUTO')).status).toBe(403);
    const saved = await set(editor, 'SP-AUTO');
    expect(saved.status).toBe(200);
    expect(saved.body).toEqual({ changed: 1 });
    expect((await list(viewer)).body.campaigns[0]).toMatchObject({
      blockKey: 'SP-AUTO',
      source: 'manual',
    });
    const audits = await ctx.testDb.db.select().from(auditEvents);
    expect(audits.map((event) => event.action)).toEqual(['campaign_blocks.update']);
  });

  it('meldet unbekannte Bausteine und Kampagnen mit 400', async () => {
    const block = await set(admin, 'SD-PAT');
    expect(block.status).toBe(400);
    expect(block.body.error.code).toBe('CAMPAIGN_BLOCK_UNKNOWN_BLOCK');
    const campaign = await call('PUT', '/ads/tools/campaign-blocks', admin, {
      profileId: f.profile,
      assignments: [{ campaignId: other.campaign, blockKey: 'SP-AUTO' }],
    });
    expect(campaign.status).toBe(400);
    expect(campaign.body.error.code).toBe('CAMPAIGN_BLOCK_UNKNOWN_CAMPAIGN');
  });

  it('kennt weder Profile fremder Organisationen noch ausgeblendete', async () => {
    expect((await list(foreign)).status).toBe(404);
    expect((await set(foreign, 'SP-AUTO')).status).toBe(404);
    await ctx.testDb.db
      .update(schema.amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(schema.amazonAdsProfiles.id, f.fileProfile));
    expect((await list(editor, f.fileProfile)).status).toBe(404);
    expect((await set(editor, 'SP-AUTO', f.fileProfile)).status).toBe(404);
  });
});
