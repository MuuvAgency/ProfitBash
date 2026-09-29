import { schema } from '@profitbash/db';
import {
  savedViewListSchema,
  savedViewSchema,
  type ErrorResponse,
  type SavedView,
  type SavedViewState,
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

const { amazonAdsProfiles, auditEvents, connections, orgEntitlements, savedViews } = schema;

/** Gespeicherte Ansichten über die API (2.9): Rechte je Rolle und Feature, Access-Layer, Fehlerformat. */

let ctx: TestContext;
let orgId = '';
let admin = '';
let editor = '';
let viewer = '';
let outsider = '';
const ids = { visible: '', hidden: '' };

const filters = (patch: Partial<SavedViewState['filters']> = {}): SavedViewState['filters'] => ({
  clientIds: [],
  withoutClient: false,
  profileIds: null,
  period: { preset: 'last30' },
  comparison: 'previous',
  currency: 'auto',
  attribution: 'console',
  ...patch,
});
const explorerState = (): SavedViewState => ({
  filters: filters(),
  explorer: {
    level: 'campaign',
    drill: { portfolioId: null, campaignId: null, adGroupId: null },
    includeRemoved: false,
    adProducts: [],
    chartMetrics: ['cost', 'sales'],
    columns: ['name', 'cost'],
    sort: { column: 'cost', direction: 'desc' },
  },
});

async function call<T>(method: string, path: string, cookie: string, json?: unknown) {
  const res = await request(ctx, `/api${path}`, { method, cookie, json });
  const body = res.status === 204 ? (undefined as T) : await readJson<T>(res);
  return { status: res.status, body };
}

const create = (cookie: string, body: Record<string, unknown>) =>
  call<SavedView & ErrorResponse>('POST', '/saved-views', cookie, {
    name: 'Ansicht',
    area: 'dashboard',
    state: { filters: filters() },
    ...body,
  });

beforeAll(async () => {
  ctx = await createTestContext();
  orgId = ctx.seeded.organizationId;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: orgId, role: 'editor' } });
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  await createUser(ctx, { email: 'ohne@muuv.test' });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  outsider = await signIn(ctx, 'ohne@muuv.test');
  const { db } = ctx.testDb;
  const [connection] = await db
    .insert(connections)
    .values({
      organizationId: orgId,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId: 'amzn1.account.MUUV',
      refreshTokenEncrypted: 'v1:k1:nicht-benutzt',
    })
    .returning({ id: connections.id });
  const profile = (amazonProfileId: string, isHidden: boolean) => ({
    organizationId: orgId,
    connectionId: connection!.id,
    amazonProfileId,
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
    isHidden,
  });
  const [visible, hidden] = await db
    .insert(amazonAdsProfiles)
    .values([profile('1', false), profile('2', true)])
    .returning({ id: amazonAdsProfiles.id });
  ids.visible = visible!.id;
  ids.hidden = hidden!.id;
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(savedViews);
});

describe('/api/saved-views', () => {
  it('Viewer legt persönliche Ansichten an, sieht sie in der Liste, darf aber nicht freigeben', async () => {
    const created = await create(viewer, {});
    expect(created.status).toBe(201);
    expect(savedViewSchema.safeParse(created.body).error).toBeUndefined();
    expect(created.body).toMatchObject({
      shared: false,
      own: true,
      canEdit: true,
      canShare: false,
    });

    const list = await call<{ views: SavedView[] }>('GET', '/saved-views?area=dashboard', viewer);
    expect(list.status).toBe(200);
    expect(savedViewListSchema.safeParse(list.body).error).toBeUndefined();
    expect(list.body.views.map((v) => v.id)).toEqual([created.body.id]);

    const shared = await create(viewer, { name: 'Team', shared: true });
    expect(shared.status).toBe(403);
    expect(shared.body.error.code).toBe('SAVED_VIEW_SHARE_FORBIDDEN');
    const patched = await call<ErrorResponse>('PATCH', `/saved-views/${created.body.id}`, viewer, {
      shared: true,
    });
    expect(patched.status).toBe(403);
  });

  it('Editor gibt frei; andere sehen die Ansicht, ändern sie aber nicht', async () => {
    const created = await create(editor, {
      shared: true,
      area: 'explorer',
      state: explorerState(),
    });
    expect(created.status).toBe(201);
    expect(created.body.canShare).toBe(true);

    const forViewer = await call<SavedView>('GET', `/saved-views/${created.body.id}`, viewer);
    expect(forViewer.status).toBe(200);
    expect(forViewer.body).toMatchObject({ own: false, canEdit: false, canShare: false });
    expect(forViewer.body.state.explorer?.sort).toEqual({ column: 'cost', direction: 'desc' });

    const rename = await call<ErrorResponse>('PATCH', `/saved-views/${created.body.id}`, viewer, {
      name: 'X',
    });
    expect(rename.status).toBe(403);
    expect(rename.body.error.code).toBe('SAVED_VIEW_FORBIDDEN');

    const byAdmin = await call<SavedView>('PATCH', `/saved-views/${created.body.id}`, admin, {
      name: 'Von Ada',
    });
    expect(byAdmin.status).toBe(200);
    expect(byAdmin.body.name).toBe('Von Ada');
    const [event] = await ctx.testDb.db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'saved_view.update'), eq(auditEvents.organizationId, orgId)),
      );
    expect(event?.actorUserId).not.toBeNull();
    expect(event?.target).toMatchObject({ id: created.body.id, after: { name: 'Von Ada' } });

    const removed = await call('DELETE', `/saved-views/${created.body.id}`, admin);
    expect(removed.status).toBe(204);
    expect((await call('GET', `/saved-views/${created.body.id}`, viewer)).status).toBe(404);
  });

  it('liefert ausgeblendete Profile nie aus', async () => {
    const created = await create(admin, {
      state: { filters: filters({ profileIds: [ids.visible, ids.hidden] }) },
    });
    expect(created.body.state.filters.profileIds).toEqual([ids.visible]);
    expect(created.body.hiddenItems).toBe(1);
    const list = await call<{ views: SavedView[] }>('GET', '/saved-views?area=dashboard', admin);
    expect(JSON.stringify(list.body)).not.toContain(ids.hidden);
  });

  it('filtert ausgeblendete Profile auch beim Ändern und nach dem Ausblenden beim Laden (DoD)', async () => {
    const created = await create(editor, { name: 'Später ausgeblendet', shared: true });
    const patched = await call<SavedView>('PATCH', `/saved-views/${created.body.id}`, editor, {
      state: { filters: filters({ profileIds: [ids.visible, ids.hidden] }) },
    });
    expect(patched.status).toBe(200);
    expect(patched.body.state.filters.profileIds).toEqual([ids.visible]);
    expect(patched.body.hiddenItems).toBe(1);

    // Das sichtbare Profil wird nachträglich ausgeblendet: Laden über die ID nennt es nicht mehr.
    await ctx.testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, ids.visible));
    try {
      const loaded = await call<SavedView>('GET', `/saved-views/${created.body.id}`, viewer);
      expect(loaded.status).toBe(200);
      expect(JSON.stringify(loaded.body)).not.toContain(ids.visible);
      expect(loaded.body.selectionHidden).toBe(true);
    } finally {
      await ctx.testDb.db
        .update(amazonAdsProfiles)
        .set({ isHidden: false })
        .where(eq(amazonAdsProfiles.id, ids.visible));
    }
  });

  it('andere Mitglieder (nicht Admin) löschen fremde Ansichten nicht', async () => {
    const shared = await create(editor, { name: 'Team-Ansicht zum Löschen', shared: true });
    const denied = await call<ErrorResponse>('DELETE', `/saved-views/${shared.body.id}`, viewer);
    expect(denied.status).toBe(403);
    expect(denied.body.error.code).toBe('SAVED_VIEW_FORBIDDEN');
    expect((await call('GET', `/saved-views/${shared.body.id}`, viewer)).status).toBe(200);
  });

  it('prüft Eingaben, Namen und Bereich', async () => {
    expect((await create(viewer, { area: 'explorer' })).status).toBe(400);
    expect((await create(viewer, { name: '' })).status).toBe(400);
    expect((await call('GET', '/saved-views?area=profit', viewer)).status).toBe(400);
    expect((await create(viewer, { name: 'Doppelt' })).status).toBe(201);
    const twice = await create(viewer, { name: 'doppelt' });
    expect(twice.status).toBe(409);
    expect(twice.body.error.code).toBe('SAVED_VIEW_NAME_TAKEN');
    expect((await call('PATCH', '/saved-views/not-a-uuid', viewer, { name: 'x' })).status).toBe(
      400,
    );
  });

  it('fremde Organisation: weder lesen noch ändern noch löschen; Zustand muss zum Bereich passen', async () => {
    const view = await create(editor, { shared: true });
    const other = await ctx.testDb.db
      .insert(schema.organizations)
      .values({ name: 'Andere', slug: 'andere', type: 'internal', createdAt: new Date() })
      .returning({ id: schema.organizations.id });
    await createUser(ctx, { email: 'fremd@andere.test', org: { id: other[0]!.id, role: 'admin' } });
    const foreign = await signIn(ctx, 'fremd@andere.test');
    await ctx.testDb.db
      .insert(orgEntitlements)
      .values(
        ['dashboard', 'sp-explorer'].map((feature) => ({ organizationId: other[0]!.id, feature })),
      );
    expect((await call('GET', `/saved-views/${view.body.id}`, foreign)).status).toBe(404);
    expect(
      (await call('PATCH', `/saved-views/${view.body.id}`, foreign, { name: 'übernommen' })).status,
    ).toBe(404);
    expect((await call('DELETE', `/saved-views/${view.body.id}`, foreign)).status).toBe(404);
    expect(
      (await call<{ views: unknown[] }>('GET', '/saved-views?area=dashboard', foreign)).body.views,
    ).toEqual([]);

    const wrongArea = await call<ErrorResponse>('PATCH', `/saved-views/${view.body.id}`, editor, {
      state: explorerState(),
    });
    expect(wrongArea.status).toBe(400);
  });

  it('verlangt Session, Organisation und das Feature des Bereichs', async () => {
    expect((await call('GET', '/saved-views?area=dashboard', '')).status).toBe(401);
    expect((await call('GET', '/saved-views?area=dashboard', outsider)).status).toBe(403);

    const view = await create(viewer, { area: 'explorer', state: explorerState() });
    const { db } = ctx.testDb;
    await db
      .update(orgEntitlements)
      .set({ enabled: false })
      .where(
        and(eq(orgEntitlements.organizationId, orgId), eq(orgEntitlements.feature, 'sp-explorer')),
      );
    try {
      const list = await call<ErrorResponse>('GET', '/saved-views?area=explorer', viewer);
      expect(list.status).toBe(403);
      expect(list.body.error.code).toBe('FEATURE_FORBIDDEN');
      expect((await call('GET', `/saved-views/${view.body.id}`, viewer)).status).toBe(403);
      expect((await call('DELETE', `/saved-views/${view.body.id}`, viewer)).status).toBe(403);
      expect(
        (await call('PATCH', `/saved-views/${view.body.id}`, viewer, { name: 'neu' })).status,
      ).toBe(403);
      expect((await create(viewer, { area: 'explorer', state: explorerState() })).status).toBe(403);
      expect((await call('GET', '/saved-views?area=dashboard', viewer)).status).toBe(200);
    } finally {
      await db
        .update(orgEntitlements)
        .set({ enabled: true })
        .where(
          and(
            eq(orgEntitlements.organizationId, orgId),
            eq(orgEntitlements.feature, 'sp-explorer'),
          ),
        );
    }
  });
});
