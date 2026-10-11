import { schema } from '@profitbash/db';
import type {
  DashboardResponse,
  ErrorResponse,
  ExplorerRowsResponse,
  FilterOptionsResponse,
  TimeSeriesResponse,
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

/**
 * Dashboard und Explorer für Kunden-Logins (`phase-6.md` 6.3b, F1): Ein Kunde sieht nur die Kennzahlen der Profile
 * seines Clients, nie die eines zweiten Clients, einer anderen Kunden-Org oder ausgeblendeter Profile.
 */

const {
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsProfileMetricsImportedThrough,
  amazonAdsProfiles,
  clients,
  connections,
  jobRuns,
  organizations,
  orgEntitlements,
  tagAssignments,
  tags,
} = schema;

const SP = 'SPONSORED_PRODUCTS';
const query = (extra: Record<string, unknown> = {}) => ({
  period: { from: '2026-09-01', to: '2026-09-02' },
  ...extra,
});

let ctx: TestContext;
let nordCookie = '';
let suedCookie = '';
const ids = {
  nord: '',
  sued: '',
  nordOrg: '',
  nordProfile: '',
  nordHidden: '',
  suedProfile: '',
  nordCampaign: '',
  tag: '',
};

async function post<T>(path: string, body: unknown, cookie = nordCookie) {
  const res = await request(ctx, path, { method: 'POST', cookie, json: body });
  return { status: res.status, body: await readJson<T>(res) };
}

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const agency = ctx.seeded.organizationId;

  const customerOrg = async (name: string, slug: string, email: string) => {
    const [org] = await db
      .insert(organizations)
      .values({ name, slug, type: 'client', createdAt: new Date() })
      .returning({ id: organizations.id });
    await db.insert(orgEntitlements).values(
      ['dashboard', 'sp-explorer'].map((feature) => ({
        organizationId: org!.id,
        feature,
        enabled: true,
      })),
    );
    await createUser(ctx, { email, org: { id: org!.id, role: 'viewer' } });
    return org!.id;
  };
  ids.nordOrg = await customerOrg('Nordwind GmbH', 'nordwind-kunde', 'kim@nordwind.test');
  const suedOrg = await customerOrg('Südhang AG', 'suedhang-kunde', 'sam@suedhang.test');

  const [nord, sued] = await db
    .insert(clients)
    .values([
      {
        organizationId: agency,
        name: 'Nordwind',
        slug: 'nordwind',
        clientOrganizationId: ids.nordOrg,
      },
      { organizationId: agency, name: 'Südhang', slug: 'suedhang', clientOrganizationId: suedOrg },
    ])
    .returning({ id: clients.id });
  Object.assign(ids, { nord: nord!.id, sued: sued!.id });

  const [connection] = await db
    .insert(connections)
    .values({
      organizationId: agency,
      provider: 'amazon_ads',
      region: 'eu',
      externalAccountId: 'amzn1.account.MUUV',
      refreshTokenEncrypted: 'v1:k1:nicht-benutzt',
    })
    .returning({ id: connections.id });
  const profile = (amazonProfileId: string, clientId: string, isHidden = false) => ({
    organizationId: agency,
    connectionId: connection!.id,
    amazonProfileId,
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
    clientId,
    isHidden,
  });
  const [nordProfile, nordHidden, suedProfile] = await db
    .insert(amazonAdsProfiles)
    .values([profile('1', ids.nord), profile('2', ids.nord, true), profile('3', ids.sued)])
    .returning({ id: amazonAdsProfiles.id });
  Object.assign(ids, {
    nordProfile: nordProfile!.id,
    nordHidden: nordHidden!.id,
    suedProfile: suedProfile!.id,
  });

  const campaign = (profileId: string, amazonCampaignId: string, name: string) => ({
    organizationId: agency,
    profileId,
    amazonCampaignId,
    adProduct: SP,
    name,
    state: 'ENABLED',
    syncedAt: new Date(),
  });
  const [nordCampaign, hiddenCampaign, suedCampaign] = await db
    .insert(amazonAdsCampaigns)
    .values([
      campaign(ids.nordProfile, 'c1', 'SP Nord'),
      campaign(ids.nordHidden, 'c2', 'SP Nord versteckt'),
      campaign(ids.suedProfile, 'c3', 'SP Süd'),
    ])
    .returning({ id: amazonAdsCampaigns.id });
  ids.nordCampaign = nordCampaign!.id;
  const metric = (profileId: string, campaignId: string, cost: string) => ({
    organizationId: agency,
    profileId,
    campaignId,
    date: '2026-09-01',
    adProduct: SP,
    currencyCode: 'EUR',
    impressions: 1000,
    clicks: 10,
    cost,
    sales7d: '40',
    sales14d: '40',
    purchases7d: 2,
    purchases14d: 2,
    importedAt: new Date(),
  });
  await db
    .insert(amazonAdsCampaignDailyMetrics)
    .values([
      metric(ids.nordProfile, nordCampaign!.id, '10'),
      metric(ids.nordHidden, hiddenCampaign!.id, '500'),
      metric(ids.suedProfile, suedCampaign!.id, '7000'),
    ]);
  await db.insert(amazonAdsProfileMetricsImportedThrough).values(
    [ids.nordProfile, ids.suedProfile].map((profileId) => ({
      organizationId: agency,
      profileId,
      adProduct: SP,
      importedThrough: '2026-09-02',
    })),
  );
  await db.insert(jobRuns).values({
    organizationId: agency,
    job: 'reports-sync',
    scope: connection!.id,
    status: 'success',
    finishedAt: new Date('2026-09-03T04:00:00Z'),
  });
  // Ein Tag der Agentur an der Kampagne des Kunden: Kunden sehen Tags nie.
  const [tag] = await db
    .insert(tags)
    .values({ organizationId: agency, name: 'Intern: Problemkunde', color: 'red' })
    .returning({ id: tags.id });
  ids.tag = tag!.id;
  await db.insert(tagAssignments).values({
    tagId: ids.tag,
    organizationId: agency,
    profileId: ids.nordProfile,
    entityType: 'campaign',
    entityId: ids.nordCampaign,
  });

  nordCookie = await signIn(ctx, 'kim@nordwind.test');
  suedCookie = await signIn(ctx, 'sam@suedhang.test');
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

describe('Kunden-Login: Filterauswahl', () => {
  it('nennt nur den eigenen Client und dessen sichtbare Profile', async () => {
    const res = await post<FilterOptionsResponse>('/api/ads/filter-options', {});
    expect(res.status).toBe(200);
    expect(res.body.clients).toEqual([{ id: ids.nord, name: 'Nordwind', slug: 'nordwind' }]);
    expect(res.body.profiles.map((p) => p.id)).toEqual([ids.nordProfile]);
    expect(res.body.currencies).toContain('EUR');
  });
});

describe('Kunden-Login: Dashboard', () => {
  it('summiert nur die Profile des eigenen Clients und zeigt den Datenstand', async () => {
    const res = await post<DashboardResponse>('/api/ads/dashboard', query());
    expect(res.status).toBe(200);
    expect(res.body.total.current.sums.cost).toBe('10');
    expect(res.body.byClient.map((g) => g.label)).toEqual(['Nordwind']);
    expect(res.body.byProfile.map((g) => g.key)).toEqual([ids.nordProfile]);
    // Der Lauf gehört der Eigentümer-Org; der Kunde sieht trotzdem, wann zuletzt synchronisiert wurde.
    expect(res.body.status.lastSyncAt).toBe('2026-09-03T04:00:00.000Z');
  });

  it('liefert nichts für fremde Clients, fremde und ausgeblendete Profile', async () => {
    for (const selection of [
      { clientIds: [ids.sued] },
      { profileIds: [ids.suedProfile] },
      { profileIds: [ids.nordHidden] },
    ]) {
      const res = await post<DashboardResponse>('/api/ads/dashboard', query(selection));
      expect(res.status).toBe(200);
      expect(Number(res.body.total.current.sums.cost)).toBe(0);
      expect(res.body.byProfile).toEqual([]);
    }
  });

  it('eine andere Kunden-Org sieht nur ihren Client', async () => {
    const res = await post<DashboardResponse>('/api/ads/dashboard', query(), suedCookie);
    expect(res.body.total.current.sums.cost).toBe('7000');
    expect(res.body.byClient.map((g) => g.label)).toEqual(['Südhang']);
  });
});

describe('Kunden-Login: Explorer', () => {
  it('zeigt nur eigene Kampagnen, ohne Tags der Agentur', async () => {
    const res = await post<ExplorerRowsResponse>(
      '/api/ads/explorer/rows',
      query({ level: 'campaign' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.rows.map((row) => row.name)).toEqual(['SP Nord']);
    expect(res.body.rows[0]!.attributes).toMatchObject({ tagIds: [] });
    expect(JSON.stringify(res.body)).not.toContain(ids.tag);
  });

  it('der Tag-Filter trifft für Kunden nichts', async () => {
    const res = await post<ExplorerRowsResponse>(
      '/api/ads/explorer/rows',
      query({ level: 'campaign', tagIds: [ids.tag] }),
    );
    expect(res.body.rows).toEqual([]);
    const dashboard = await post<DashboardResponse>(
      '/api/ads/dashboard',
      query({ tagIds: [ids.tag] }),
    );
    expect(Number(dashboard.body.total.current.sums.cost)).toBe(0);
  });

  it('die Agentur sieht ihre Tags weiter und kann danach filtern', async () => {
    const admin = await signIn(ctx, ctx.seeded.email);
    const res = await post<ExplorerRowsResponse>(
      '/api/ads/explorer/rows',
      query({ level: 'campaign', tagIds: [ids.tag] }),
      admin,
    );
    expect(res.body.rows.map((row) => row.name)).toEqual(['SP Nord']);
    expect(res.body.rows[0]!.attributes).toMatchObject({ tagIds: [ids.tag] });
  });

  it('die Tagesreihe enthält nur die eigenen Kennzahlen', async () => {
    const res = await post<TimeSeriesResponse>('/api/ads/timeseries', query({ level: 'campaign' }));
    expect(res.status).toBe(200);
    const total = res.body.days.reduce((sum, day) => sum + Number(day.sums.cost), 0);
    expect(total).toBe(10);
  });

  it('die ASIN-Suche (Quick-Tool) bleibt für Kunden gesperrt', async () => {
    const res = await post<ErrorResponse>('/api/ads/asin-search', query({ terms: ['B0TEST0001'] }));
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('CUSTOMER_ORG_FORBIDDEN');
  });
});

describe('Kunden-Login: entzogener Zugang', () => {
  it('ohne Verknüpfung zum Client sieht der Kunde nichts mehr', async () => {
    await ctx.testDb.db
      .update(clients)
      .set({ clientOrganizationId: null })
      .where(eq(clients.id, ids.nord));
    const options = await post<FilterOptionsResponse>('/api/ads/filter-options', {});
    expect(options.body.clients).toEqual([]);
    expect(options.body.profiles).toEqual([]);
    const dashboard = await post<DashboardResponse>('/api/ads/dashboard', query());
    expect(Number(dashboard.body.total.current.sums.cost)).toBe(0);
    const rows = await post<ExplorerRowsResponse>(
      '/api/ads/explorer/rows',
      query({ level: 'campaign' }),
    );
    expect(rows.body.rows).toEqual([]);
  });
});
