import { schema } from '@profitbash/db';
import type { ErrorResponse, SalesResponse } from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
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
 * Verkaufsanalyse (`phase-7.md` 7.4): Agentur sieht alle Konten, Kunden-Logins (F7) nur die ihres Clients, nie die
 * eines zweiten Clients; ohne gebuchtes `profit` gibt es nichts.
 */

const {
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsProfiles,
  amazonSpAccounts,
  amazonSpDailySales,
  clients,
  connections,
  organizations,
  orgEntitlements,
} = schema;

const DE = 'A1PA6795UKMFR9';
const PATH = '/api/profit/sales';
const query = (extra: Record<string, unknown> = {}) => ({
  period: { from: '2026-10-01', to: '2026-10-02' },
  ...extra,
});

let ctx: TestContext;
let adminCookie = '';
let nordCookie = '';
const ids = { nord: '', sued: '', nordOrg: '', agency: '' };

async function post<T>(body: unknown, cookie = adminCookie) {
  const res = await request(ctx, PATH, { method: 'POST', cookie, json: body });
  return { status: res.status, body: await readJson<T>(res) };
}

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const agency = ctx.seeded.organizationId;
  ids.agency = agency;

  const customerOrg = async (name: string, slug: string, email: string) => {
    const [org] = await db
      .insert(organizations)
      .values({ name, slug, type: 'client', createdAt: new Date() })
      .returning({ id: organizations.id });
    await db
      .insert(orgEntitlements)
      .values({ organizationId: org!.id, feature: 'profit', enabled: true });
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
  ids.nord = nord!.id;
  ids.sued = sued!.id;

  const [sp, ads] = await db
    .insert(connections)
    .values([
      {
        organizationId: agency,
        provider: 'amazon_sp' as const,
        region: 'eu' as const,
        externalAccountId: 'A1SELLER',
        refreshTokenEncrypted: 'v1:k1:nicht-benutzt',
      },
      {
        organizationId: agency,
        provider: 'amazon_ads' as const,
        region: 'eu' as const,
        externalAccountId: 'amzn1.account.MUUV',
        refreshTokenEncrypted: 'v1:k1:nicht-benutzt',
      },
    ])
    .returning({ id: connections.id });
  const accounts = await db
    .insert(amazonSpAccounts)
    .values(
      [
        [ids.nord, 'A1SELLER'],
        [ids.sued, 'A2SUED'],
      ].map(([clientId, sellerId]) => ({
        organizationId: agency,
        connectionId: sp!.id,
        clientId: clientId!,
        amazonSellerId: sellerId!,
        marketplaceId: DE,
        storeName: 'Store',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
      })),
    )
    .returning({ id: amazonSpAccounts.id });
  const sales = (sellerAccountId: string, sku: string, itemPrice: string, itemTax: string) => ({
    organizationId: agency,
    sellerAccountId,
    date: '2026-10-01',
    sku,
    asin: null,
    currency: 'EUR',
    units: 1,
    orders: 1,
    unpricedUnits: 0,
    itemPrice,
    itemTax,
    shippingPrice: '0',
    shippingTax: '0',
    giftWrapPrice: '0',
    giftWrapTax: '0',
    itemPromotionDiscount: '0',
    shipPromotionDiscount: '0',
  });
  await db
    .insert(amazonSpDailySales)
    .values([
      sales(accounts[0]!.id, 'NORD-1', '119', '19'),
      sales(accounts[1]!.id, 'SUED-1', '1190', '190'),
    ]);

  const [profile] = await db
    .insert(amazonAdsProfiles)
    .values({
      organizationId: agency,
      connectionId: ads!.id,
      clientId: ids.nord,
      amazonProfileId: '1',
      accountName: 'Nordwind DE',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
      marketplaceId: DE,
    })
    .returning({ id: amazonAdsProfiles.id });
  const [campaign] = await db
    .insert(amazonAdsCampaigns)
    .values({
      organizationId: agency,
      profileId: profile!.id,
      amazonCampaignId: 'c1',
      adProduct: 'SPONSORED_PRODUCTS',
      name: 'SP Nord',
      state: 'ENABLED',
    })
    .returning({ id: amazonAdsCampaigns.id });
  await db.insert(amazonAdsCampaignDailyMetrics).values({
    organizationId: agency,
    profileId: profile!.id,
    campaignId: campaign!.id,
    date: '2026-10-01',
    adProduct: 'SPONSORED_PRODUCTS',
    currencyCode: 'EUR',
    impressions: 100,
    clicks: 5,
    cost: '10',
    sales7d: '40',
    importedAt: new Date(),
  });

  adminCookie = await signIn(ctx, ctx.seeded.email);
  nordCookie = await signIn(ctx, 'kim@nordwind.test');
}, 60_000);

afterAll(async () => {
  await ctx?.close();
});

describe('POST /api/profit/sales', () => {
  it('liefert der Agentur Umsatz, TACoS und organischen Umsatz aller sichtbaren Konten', async () => {
    const res = await post<SalesResponse>(query({ clientIds: [ids.nord] }));

    expect(res.status).toBe(200);
    expect(res.body.meta).toMatchObject({ currency: 'EUR', accounts: 1, adProfiles: 1 });
    expect(res.body.current).toMatchObject({
      revenueNet: '100',
      revenueGross: '119',
      adCost: '10',
      adSales: '40',
      tacos: '0.1',
      organicNet: '60',
      organicGross: '79',
    });
    expect(res.body.products.map((p) => p.sku)).toEqual(['NORD-1']);

    const all = await post<SalesResponse>(query());
    expect(all.body.meta.accounts).toBe(2);
  });

  it('rechnet die Veränderung zum Vergleichszeitraum', async () => {
    const res = await post<SalesResponse>(
      query({ clientIds: [ids.nord], comparison: { from: '2026-09-01', to: '2026-09-02' } }),
    );
    expect(res.body.comparison).toMatchObject({ revenueNet: '0', tacos: null });
    expect(res.body.change?.revenueNet).toEqual({ absolute: '100', relative: null });
  });

  it('zeigt einem Kunden-Login nur seinen Client, auch wenn er einen fremden anfragt', async () => {
    const own = await post<SalesResponse>(query(), nordCookie);
    expect(own.status).toBe(200);
    expect(own.body.meta.accounts).toBe(1);
    expect(own.body.products.map((p) => p.sku)).toEqual(['NORD-1']);

    const foreign = await post<SalesResponse>(query({ clientIds: [ids.sued] }), nordCookie);
    expect(foreign.body.meta.accounts).toBe(0);
    expect(foreign.body.products).toEqual([]);
  });

  it('öffnet die Filterleiste auch mit `profit` allein', async () => {
    const res = await request(ctx, '/api/ads/filter-options', {
      method: 'POST',
      cookie: nordCookie,
      json: {},
    });
    expect(res.status).toBe(200);
  });

  it('antwortet 403 ohne gebuchtes `profit`', async () => {
    const { db } = ctx.testDb;
    await db
      .update(orgEntitlements)
      .set({ enabled: false })
      .where(
        and(eq(orgEntitlements.organizationId, ids.nordOrg), eq(orgEntitlements.feature, 'profit')),
      );

    const res = await post<ErrorResponse>(query(), nordCookie);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FEATURE_FORBIDDEN');
  });

  it('lehnt einen ungültigen Zeitraum und eine nicht wählbare Währung ab', async () => {
    const swapped = await post<ErrorResponse>({ period: { from: '2026-10-02', to: '2026-10-01' } });
    expect(swapped.status).toBe(400);
    const currency = await post<ErrorResponse>(query({ currency: 'JPY' }));
    expect(currency.status).toBe(400);
    expect(currency.body.error.code).toBe('CURRENCY_NOT_SELECTABLE');
  });
});
