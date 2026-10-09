import {
  replaceSearchTermPeriodMetrics,
  schema,
  type SearchTermPeriodMetric,
} from '@profitbash/db';
import type {
  ErrorResponse,
  HarvestListResponse,
  HarvestMarkResponse,
  SearchTermAnalysisResponse,
} from '@profitbash/shared';
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

const { amazonAdsProfiles, auditEvents, connections, orgEntitlements, searchTermHarvestMarks } =
  schema;

/**
 * Harvest-Merkliste über die API (`phase-3.md` 3.8): vormerken, ansehen, entfernen. Je Endpunkt: fremde
 * Organisation, ausgeblendetes Profil, Recht `write`, Entitlement.
 */

let ctx: TestContext;
let orgId = '';
let admin = '';
let editor = '';
let viewer = '';
let foreign = '';
const ids = { visible: '', hidden: '' };

const A = { periodStart: '2026-09-01', periodEnd: '2026-09-30' };

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api${path}`, { method, cookie, json });
  return { status: res.status, body: await readJson<T & ErrorResponse>(res) };
}
const mark = (cookie: string | undefined, searchTerms: string[], body: object = {}) =>
  call<HarvestMarkResponse>('POST', '/ads/search-terms/harvest', cookie, {
    profileId: ids.visible,
    ...A,
    searchTerms,
    ...body,
  });
const list = (cookie: string | undefined, body: object = {}) =>
  call<HarvestListResponse>('POST', '/ads/search-terms/harvest/list', cookie, body);
const remove = (cookie: string | undefined, markIds: string[]) =>
  call<{ removed: number }>('POST', '/ads/search-terms/harvest/remove', cookie, { ids: markIds });

const term = (
  searchTerm: string,
  patch: Partial<SearchTermPeriodMetric> = {},
): SearchTermPeriodMetric => ({
  amazonCampaignId: 'C1',
  amazonAdGroupId: 'AG1',
  amazonTargetId: 'T1',
  searchTerm,
  impressions: 1000,
  clicks: 3,
  cost: '1',
  sales: '0',
  purchases: 0,
  units: 0,
  ...patch,
});

async function write(profileId: string, rows: SearchTermPeriodMetric[]) {
  await replaceSearchTermPeriodMetrics(ctx.testDb.db, {
    organizationId: orgId,
    profileId,
    adProduct: 'SPONSORED_PRODUCTS',
    period: { startDate: A.periodStart, endDate: A.periodEnd },
    currencyCode: 'EUR',
    rows,
    replace: 'period',
    now: new Date('2026-10-01T08:00:00Z'),
  });
}

beforeAll(async () => {
  ctx = await createTestContext();
  orgId = ctx.seeded.organizationId;
  const { db } = ctx.testDb;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: orgId, role: 'editor' } });
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  const [other] = await db
    .insert(schema.organizations)
    .values({ name: 'Fremd', slug: 'fremd-harvest', type: 'internal', createdAt: new Date() })
    .returning({ id: schema.organizations.id });
  await db.insert(orgEntitlements).values({ organizationId: other!.id, feature: 'sp-explorer' });
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other!.id, role: 'admin' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  viewer = await signIn(ctx, 'viewer@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');

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
  const profile = (amazonProfileId: string, patch: Record<string, unknown> = {}) => ({
    organizationId: orgId,
    connectionId: connection!.id,
    amazonProfileId,
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
    ...patch,
  });
  const [visible, hidden] = await db
    .insert(amazonAdsProfiles)
    .values([profile('1'), profile('2', { isHidden: true })])
    .returning({ id: amazonAdsProfiles.id });
  ids.visible = visible!.id;
  ids.hidden = hidden!.id;

  await write(ids.visible, [
    term('led lampe', { clicks: 40, cost: '20', sales: '100', purchases: 4, units: 5 }),
    term('LED Lampe', {
      amazonTargetId: 'T2',
      clicks: 10,
      cost: '5',
      sales: '25',
      purchases: 1,
      units: 1,
    }),
    term('lampe rot'),
  ]);
  await write(ids.hidden, [term('versteckt')]);
});

afterAll(async () => {
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(searchTermHarvestMarks);
});

describe('POST /api/ads/search-terms/harvest', () => {
  it('Editoren merken Suchbegriffe vor; die Liste zeigt Quelle und Kennzahlen vom Zeitpunkt des Vormerkens', async () => {
    const res = await mark(editor, ['led lampe', 'gibt es nicht']);

    expect(res.status).toBe(200);
    expect(res.body.counts).toEqual({ added: 1, alreadyMarked: 0, notFound: 1 });
    expect(res.body.results.map((r) => r.outcome)).toEqual(['added', 'notFound']);

    const listed = await list(viewer, { profileId: ids.visible });
    expect(listed.status).toBe(200);
    expect(listed.body.truncated).toBe(false);
    expect(listed.body.marks).toHaveLength(1);
    expect(listed.body.marks[0]).toMatchObject({
      id: res.body.results[0]!.id,
      profileId: ids.visible,
      accountName: 'Konto 1',
      searchTerm: 'led lampe',
      amazonCampaignId: 'C1',
      amazonTargetId: 'T1',
      campaignName: null,
      ...A,
      sourceRows: 2,
      currencyCode: 'EUR',
      clicks: '50',
      cost: '25',
      sales: '125',
      purchases: '5',
      acos: '0.2',
      cvr: '0.1',
    });
    expect(listed.body.marks[0]!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it('schreibt ein Audit-Event', async () => {
    await ctx.testDb.db.delete(auditEvents);
    await mark(admin, ['lampe rot']);

    const events = await ctx.testDb.db.select().from(auditEvents);
    expect(events.map((event) => event.action)).toEqual(['search_term_harvest.add']);
  });

  it('Viewer dürfen nicht vormerken', async () => {
    const res = await mark(viewer, ['led lampe']);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FEATURE_FORBIDDEN');
  });

  it('verweigert ausgeblendete Profile (auch Admins) und fremde Organisationen mit 404', async () => {
    for (const res of [
      await mark(admin, ['versteckt'], { profileId: ids.hidden }),
      await mark(foreign, ['led lampe']),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('PROFILE_NOT_FOUND');
    }
    expect(await ctx.testDb.db.select().from(searchTermHarvestMarks)).toHaveLength(0);
  });

  it('prüft die Eingabe', async () => {
    expect((await mark(admin, [])).status).toBe(400);
    expect(
      (
        await mark(
          admin,
          Array.from({ length: 201 }, (_, i) => `b ${i}`),
        )
      ).status,
    ).toBe(400);
    expect((await mark(admin, ['x'], { periodStart: '2026-10-01' })).status).toBe(400);
    expect((await mark(admin, ['x'], { clicks: '999' })).status).toBe(400);
  });
});

describe('Kennzeichnung in der Analyse', () => {
  it('nennt je Zeile, ob der Begriff auf der Merkliste steht (alle Schreibweisen)', async () => {
    await mark(admin, ['led lampe']);

    const res = await call<SearchTermAnalysisResponse>(
      'POST',
      '/ads/search-terms/analysis',
      viewer,
      { profileId: ids.visible, ...A },
    );

    expect(
      Object.fromEntries(res.body.rows.map((row) => [row.searchTerm, row.harvestMarked])),
    ).toEqual({ 'led lampe': true, 'LED Lampe': true, 'lampe rot': false });
  });
});

describe('POST /api/ads/search-terms/harvest/list', () => {
  it('zeigt einer fremden Organisation nichts und nie Einträge ausgeblendeter Profile', async () => {
    await mark(admin, ['led lampe']);
    await ctx.testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, ids.visible));
    try {
      expect((await list(admin)).body.marks).toEqual([]);
    } finally {
      await ctx.testDb.db
        .update(amazonAdsProfiles)
        .set({ isHidden: false })
        .where(eq(amazonAdsProfiles.id, ids.visible));
    }
    expect((await list(admin)).body.marks).toHaveLength(1);
    expect((await list(foreign)).body.marks).toEqual([]);
    expect((await list(foreign, { profileId: ids.visible })).body.marks).toEqual([]);
  });
});

describe('POST /api/ads/search-terms/harvest/remove', () => {
  it('Editoren entfernen Einträge; Viewer und fremde Organisationen nicht', async () => {
    const added = await mark(admin, ['led lampe', 'lampe rot']);
    const [first, second] = added.body.results.map((r) => r.id!);

    expect((await remove(viewer, [first!])).status).toBe(403);
    expect((await remove(foreign, [first!])).body.removed).toBe(0);
    const res = await remove(editor, [first!]);

    expect(res.status).toBe(200);
    expect(res.body.removed).toBe(1);
    expect((await list(admin)).body.marks.map((entry) => entry.id)).toEqual([second]);
  });

  it('prüft die Eingabe', async () => {
    expect((await remove(admin, [])).status).toBe(400);
    expect((await remove(admin, ['keine-uuid'])).status).toBe(400);
  });
});

describe('Rechte je Endpunkt', () => {
  const endpoints = (): [string, unknown][] => [
    ['/ads/search-terms/harvest', { profileId: ids.visible, ...A, searchTerms: ['led lampe'] }],
    ['/ads/search-terms/harvest/list', {}],
    ['/ads/search-terms/harvest/remove', { ids: ['7f1f7a52-0d0b-4b0e-9a55-0a4b7b6a0001'] }],
  ];

  it('verlangt eine Session', async () => {
    for (const [path, body] of endpoints()) {
      expect((await call('POST', path, undefined, body)).status, path).toBe(401);
    }
  });

  it('verlangt das Feature „sp-explorer“', async () => {
    const set = (enabled: boolean) =>
      ctx.testDb.db
        .update(orgEntitlements)
        .set({ enabled })
        .where(eq(orgEntitlements.organizationId, orgId));
    await set(false);
    try {
      for (const [path, body] of endpoints()) {
        const res = await call('POST', path, admin, body);
        expect(res.status, path).toBe(403);
        expect(res.body.error.code, path).toBe('FEATURE_FORBIDDEN');
      }
    } finally {
      await set(true);
    }
    expect(await ctx.testDb.db.select().from(searchTermHarvestMarks)).toHaveLength(0);
  });
});
