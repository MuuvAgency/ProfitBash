import { schema } from '@profitbash/db';
import {
  dashboardResponseSchema,
  explorerRowsResponseSchema,
  filterOptionsResponseSchema,
  timeSeriesResponseSchema,
  type DashboardResponse,
  type ErrorResponse,
  type ExplorerRowsResponse,
  type FilterOptionsResponse,
  type TimeSeriesResponse,
} from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { gunzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const {
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsAdGroups,
  amazonAdsNegativeTargets,
  amazonAdsProductAdDailyMetrics,
  amazonAdsProductAds,
  amazonAdsProfileMetricsImportedThrough,
  amazonAdsProfiles,
  clients,
  connections,
  fxRates,
  orgEntitlements,
} = schema;

const SP = 'SPONSORED_PRODUCTS';
const PERIOD = { from: '2026-09-01', to: '2026-09-02' };
const COMPARISON = { from: '2026-08-30', to: '2026-08-31' };

let ctx: TestContext;
let admin = '';
let viewer = '';
let orgId = '';
const ids = { client: '', de: '', uk: '', hidden: '', spDe: '', spUk: '', spHidden: '', ad: '' };

/** Antwort-Schema je Pfad: Jede erfolgreiche Antwort muss dem veröffentlichten Vertrag entsprechen. */
const RESPONSE_SCHEMAS: Record<
  string,
  { safeParse(value: unknown): { success: boolean; error?: unknown } }
> = {
  '/api/ads/filter-options': filterOptionsResponseSchema,
  '/api/ads/explorer/rows': explorerRowsResponseSchema,
  '/api/ads/asin-search': explorerRowsResponseSchema,
  '/api/ads/timeseries': timeSeriesResponseSchema,
  '/api/ads/dashboard': dashboardResponseSchema,
};

async function post<T>(path: string, body: unknown, cookie = viewer) {
  const res = await request(ctx, path, { method: 'POST', cookie, json: body });
  const json = await readJson<T>(res);
  if (res.status === 200) {
    const parsed = RESPONSE_SCHEMAS[path]!.safeParse(json);
    expect(parsed.error, `${path} entspricht nicht dem Antwort-Schema`).toBeUndefined();
  }
  return { status: res.status, body: json, headers: res.headers };
}

const query = (extra: Record<string, unknown> = {}) => ({ period: PERIOD, ...extra });

beforeAll(async () => {
  ctx = await createTestContext();
  orgId = ctx.seeded.organizationId;
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: orgId, role: 'viewer' } });
  admin = await signIn(ctx, ctx.seeded.email);
  viewer = await signIn(ctx, 'viewer@muuv.test');
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
  const [client] = await db
    .insert(clients)
    .values({ organizationId: orgId, name: 'Nordwind', slug: 'nordwind' })
    .returning({ id: clients.id });
  ids.client = client!.id;
  const profile = (amazonProfileId: string, currencyCode: string, extra = {}) => ({
    organizationId: orgId,
    connectionId: connection!.id,
    amazonProfileId,
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode,
    timezone: 'Europe/Berlin',
    accountType: 'seller',
    ...extra,
  });
  const [de, uk, hidden] = await db
    .insert(amazonAdsProfiles)
    .values([
      profile('1', 'EUR', { clientId: ids.client }),
      profile('2', 'GBP', { accountType: 'vendor', countryCode: 'UK' }),
      profile('3', 'EUR', { isHidden: true }),
    ])
    .returning({ id: amazonAdsProfiles.id });
  Object.assign(ids, { de: de!.id, uk: uk!.id, hidden: hidden!.id });

  const campaign = (profileId: string, amazonCampaignId: string, name: string) => ({
    organizationId: orgId,
    profileId,
    amazonCampaignId,
    adProduct: SP,
    name,
    state: 'ENABLED',
    syncedAt: new Date(),
  });
  const [spDe, spUk, spHidden] = await db
    .insert(amazonAdsCampaigns)
    .values([
      campaign(ids.de, 'c1', 'SP DE'),
      campaign(ids.uk, 'c2', 'SP UK'),
      campaign(ids.hidden, 'c3', 'SP versteckt'),
    ])
    .returning({ id: amazonAdsCampaigns.id });
  Object.assign(ids, { spDe: spDe!.id, spUk: spUk!.id, spHidden: spHidden!.id });
  const [adGroup] = await db
    .insert(amazonAdsAdGroups)
    .values({
      organizationId: orgId,
      profileId: ids.de,
      campaignId: ids.spDe,
      amazonAdGroupId: 'g1',
      adProduct: SP,
      name: 'AG DE',
      syncedAt: new Date(),
    })
    .returning({ id: amazonAdsAdGroups.id });
  const [ad] = await db
    .insert(amazonAdsProductAds)
    .values({
      organizationId: orgId,
      profileId: ids.de,
      campaignId: ids.spDe,
      adGroupId: adGroup!.id,
      amazonAdId: 'a1',
      adProduct: SP,
      asin: 'B0TEST0001',
      sku: 'SKU-1',
      state: 'ENABLED',
      syncedAt: new Date(),
    })
    .returning({ id: amazonAdsProductAds.id });
  ids.ad = ad!.id;
  await db.insert(amazonAdsNegativeTargets).values({
    organizationId: orgId,
    profileId: ids.de,
    adProduct: SP,
    level: 'campaign',
    campaignId: ids.spDe,
    amazonTargetId: 'n1',
    targetType: 'keyword',
    keywordText: 'gratis',
    matchType: 'NEGATIVE_EXACT',
    state: 'ENABLED',
  });

  const metric = (
    profileId: string,
    currencyCode: string,
    date: string,
    cost: string,
    sales: string,
  ) => ({
    organizationId: orgId,
    profileId,
    date,
    adProduct: SP,
    currencyCode,
    impressions: 1000,
    clicks: 10,
    cost,
    sales7d: sales,
    sales14d: sales,
    purchases7d: 2,
    purchases14d: 2,
    importedAt: new Date(),
  });
  await db.insert(amazonAdsCampaignDailyMetrics).values([
    { ...metric(ids.de, 'EUR', '2026-09-01', '10', '40'), campaignId: ids.spDe },
    { ...metric(ids.de, 'EUR', '2026-09-02', '5', '0'), campaignId: ids.spDe },
    { ...metric(ids.de, 'EUR', '2026-08-31', '8', '20'), campaignId: ids.spDe },
    { ...metric(ids.uk, 'GBP', '2026-09-01', '8.6', '17.2'), campaignId: ids.spUk },
    { ...metric(ids.hidden, 'EUR', '2026-09-01', '999', '999'), campaignId: ids.spHidden },
  ]);
  await db.insert(amazonAdsProductAdDailyMetrics).values({
    ...metric(ids.de, 'EUR', '2026-09-01', '3', '12'),
    productAdId: ids.ad,
  });
  await db.insert(fxRates).values([
    { date: '2026-08-28', quote: 'GBP', rate: '0.85' },
    { date: '2026-09-01', quote: 'GBP', rate: '0.86' },
    { date: '2026-09-02', quote: 'GBP', rate: '0.86' },
  ]);
  await db.insert(amazonAdsProfileMetricsImportedThrough).values([
    { organizationId: orgId, profileId: ids.de, adProduct: SP, importedThrough: '2026-09-02' },
    { organizationId: orgId, profileId: ids.uk, adProduct: SP, importedThrough: '2026-09-02' },
  ]);
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

describe('Rechte', () => {
  it('verlangt eine Session', async () => {
    const res = await request(ctx, '/api/ads/explorer/rows', {
      method: 'POST',
      json: { ...query(), level: 'campaign' },
    });
    expect(res.status).toBe(401);
  });

  it('antwortet 403 im Fehlerformat, wenn das Feature nicht gebucht ist', async () => {
    const set = (feature: string, enabled: boolean) =>
      ctx.testDb.db
        .update(orgEntitlements)
        .set({ enabled })
        .where(
          and(eq(orgEntitlements.organizationId, orgId), eq(orgEntitlements.feature, feature)),
        );
    await set('sp-explorer', false);
    await set('dashboard', false);
    try {
      const rows = await post<ErrorResponse>('/api/ads/explorer/rows', {
        ...query(),
        level: 'campaign',
      });
      expect(rows.status).toBe(403);
      expect(rows.body.error.code).toBe('FEATURE_FORBIDDEN');
      expect((await post<ErrorResponse>('/api/ads/dashboard', query())).status).toBe(403);
      expect((await post<ErrorResponse>('/api/ads/filter-options', {})).status).toBe(403);
    } finally {
      await set('sp-explorer', true);
      await set('dashboard', true);
    }
  });

  it('lässt mit nur einem der Features Filterleiste und Tagesreihe zu, den Explorer nicht', async () => {
    await ctx.testDb.db
      .update(orgEntitlements)
      .set({ enabled: false })
      .where(
        and(eq(orgEntitlements.organizationId, orgId), eq(orgEntitlements.feature, 'sp-explorer')),
      );
    try {
      expect((await post('/api/ads/filter-options', {})).status).toBe(200);
      expect((await post('/api/ads/timeseries', query())).status).toBe(200);
      expect((await post('/api/ads/dashboard', query())).status).toBe(200);
      expect((await post('/api/ads/explorer/rows', { ...query(), level: 'campaign' })).status).toBe(
        403,
      );
      expect((await post('/api/ads/asin-search', query({ terms: ['B0X'] }))).status).toBe(403);
    } finally {
      await ctx.testDb.db
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

  it('prüft Eingaben mit zod (Zeitraum, Ebene, Währung)', async () => {
    const reversed = await post<ErrorResponse>('/api/ads/explorer/rows', {
      period: { from: '2026-09-02', to: '2026-09-01' },
      level: 'campaign',
    });
    expect(reversed.status).toBe(400);
    expect(reversed.body.error.code).toBe('VALIDATION_ERROR');
    expect((await post('/api/ads/explorer/rows', { ...query(), level: 'keyword' })).status).toBe(
      400,
    );
    const currency = await post<ErrorResponse>('/api/ads/explorer/rows', {
      ...query({ currency: 'JPY' }),
      level: 'campaign',
    });
    expect(currency.status).toBe(400);
    expect(currency.body.error.code).toBe('CURRENCY_NOT_SELECTABLE');
  });
});

describe('POST /api/ads/filter-options', () => {
  it('liefert sichtbare Clients, Profile und wählbare Währungen, dazu den Stand der Kurse', async () => {
    const res = await post<FilterOptionsResponse>('/api/ads/filter-options', {});
    expect(res.status).toBe(200);
    expect(res.body.clients.map((c) => c.name)).toEqual(['Nordwind']);
    expect(res.body.profiles.map((p) => p.id).sort()).toEqual([ids.de, ids.uk].sort());
    expect(res.body.currencies).toEqual(['EUR', 'GBP', 'USD']);
    expect(res.body.fxRatesThrough).toBe('2026-09-02');
    expect(res.body.fxRatesStale).toBe(true);
  });
});

describe('POST /api/ads/explorer/rows', () => {
  it('liefert Zeilen in Originalwährung, Summe umgerechnet mit Kennzahlen, Veränderung und Datenstand', async () => {
    const res = await post<ExplorerRowsResponse>('/api/ads/explorer/rows', {
      ...query({ comparison: COMPARISON }),
      level: 'campaign',
    });
    expect(res.status).toBe(200);
    expect(res.body.meta).toEqual({
      currency: 'EUR',
      converted: true,
      missingFxCurrencies: [],
      dataThrough: '2026-09-02',
      provisionalFrom: '2026-08-20',
      earliestDate: '2026-08-31',
      profilesWithoutData: 0,
    });
    expect(res.body.rows.map((row) => row.id)).not.toContain(ids.spHidden);
    const de = res.body.rows.find((row) => row.id === ids.spDe)!;
    expect(de.current!.sums).toMatchObject({ cost: '15', sales: '40' });
    expect(de.current!.derived).toMatchObject({ acos: '0.375', cpc: '0.75' });
    expect(de.comparison!.sums.cost).toBe('8');
    expect(de.change).toMatchObject({ cost: '0.875' });
    const uk = res.body.rows.find((row) => row.id === ids.spUk)!;
    expect(uk.currencyCode).toBe('GBP');
    // Summe: 15 EUR + 8.6 GBP ÷ 0.86 = 25 EUR.
    expect(res.body.total!.current.sums.cost).toBe('25');
    expect(res.body.total!.change!.cost).toEqual({ absolute: '17', relative: '2.125' });
    expect(res.body.total!.attribution.mixed).toBe(true);
    expect(res.body).toMatchObject({ truncated: false, totalRows: 2, maxRows: 10000 });
  });

  it('bleibt bei einer Währung in der Auswahl ohne Umrechnung; Vergleich null wie weggelassen', async () => {
    const res = await post<ExplorerRowsResponse>('/api/ads/explorer/rows', {
      ...query({ comparison: null, clientIds: [ids.client] }),
      level: 'campaign',
    });
    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ currency: 'EUR', converted: false });
    expect(res.body.total!.comparison).toBeNull();
    expect(res.body.total!.change).toBeNull();
    const gbp = await post<ExplorerRowsResponse>('/api/ads/explorer/rows', {
      ...query({ profileIds: [ids.uk, ids.hidden] }),
      level: 'campaign',
    });
    expect(gbp.body.meta).toMatchObject({ currency: 'GBP', converted: false });
    expect(gbp.body.rows.map((row) => row.id)).toEqual([ids.spUk]);
  });

  it('liefert Negatives ohne Kennzahlen', async () => {
    const res = await post<ExplorerRowsResponse>('/api/ads/explorer/rows', {
      ...query(),
      level: 'negative',
    });
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      expect.objectContaining({ name: 'gratis', current: null, attribution: null }),
    ]);
    expect(res.body.total).toBeNull();
    const single = await post<ExplorerRowsResponse>('/api/ads/explorer/rows', {
      ...query({ profileIds: [ids.uk] }),
      level: 'negative',
    });
    expect(single.body.meta.currency).toBe('GBP');
  });

  it('komprimiert die Antwort, wenn der Browser es anbietet', async () => {
    const res = await request(ctx, '/api/ads/explorer/rows', {
      method: 'POST',
      cookie: viewer,
      json: { ...query(), level: 'campaign' },
      headers: { 'accept-encoding': 'gzip' },
    });
    expect(res.headers.get('content-encoding')).toBe('gzip');
    const body = JSON.parse(
      gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'),
    ) as ExplorerRowsResponse;
    expect(body.rows).toHaveLength(2);
  });
});

describe('POST /api/ads/timeseries', () => {
  it('liefert die Tagesreihe in der Anzeigewährung, auch für markierte Zeilen', async () => {
    const all = await post<TimeSeriesResponse>('/api/ads/timeseries', query({ currency: 'GBP' }));
    expect(all.status).toBe(200);
    expect(all.body.meta.currency).toBe('GBP');
    expect(all.body.days.map((day) => [day.date, day.sums.cost])).toEqual([
      ['2026-09-01', '17.2'],
      ['2026-09-02', '4.3'],
    ]);
    const marked = await post<TimeSeriesResponse>('/api/ads/timeseries', {
      ...query(),
      level: 'campaign',
      entityIds: [ids.spUk],
    });
    expect(marked.body.days.map((day) => day.sums.cost)).toEqual(['10']);
  });
});

describe('POST /api/ads/dashboard', () => {
  it('liefert Summen je Client, Profil und Ad-Typ, dazu den Stand der Kurse', async () => {
    const res = await post<DashboardResponse>(
      '/api/ads/dashboard',
      query({ comparison: COMPARISON }),
      admin,
    );
    expect(res.status).toBe(200);
    expect(res.body.total.current.sums.cost).toBe('25');
    expect(res.body.byClient.map((group) => group.label)).toEqual(['Nordwind', null]);
    expect(res.body.byAdProduct.map((group) => group.key)).toEqual([SP]);
    expect(res.body.fxRatesThrough).toBe('2026-09-02');
    expect(res.body.fxRatesStale).toBe(true);
  });
});

describe('POST /api/ads/asin-search', () => {
  it('findet Product Ads per ASIN oder SKU mit Kennzahlen', async () => {
    const res = await post<ExplorerRowsResponse>(
      '/api/ads/asin-search',
      query({ terms: ['b0test0001'] }),
    );
    expect(res.status).toBe(200);
    expect(res.body.rows).toEqual([
      expect.objectContaining({
        id: ids.ad,
        attributes: expect.objectContaining({ asin: 'B0TEST0001' }),
      }),
    ]);
    expect(res.body.rows[0]!.current!.sums.cost).toBe('3');
    expect((await post('/api/ads/asin-search', query({ terms: [] }))).status).toBe(400);
  });
});
