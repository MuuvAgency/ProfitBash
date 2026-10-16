import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsProfiles,
  amazonSpAccounts,
  amazonSpDailySales,
  amazonSpOrderItems,
  clients,
  fxRates,
  memberClientGrants,
  members,
  users,
} from './schema';
import { querySales, type SalesQuery } from './sp-sales';
import { createTestConnection, createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
const ids = {
  org: '',
  admin: '',
  restricted: '',
  nord: '',
  sued: '',
  de: '',
  fr: '',
  us: '',
  suedDe: '',
  profileDe: '',
  profileFr: '',
};

const DE = 'A1PA6795UKMFR9';
const FR = 'A13V1IB3VIYZZH';
const US = 'ATVPDKIKX0DER';

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  const [admin, restricted] = await db
    .insert(users)
    .values([
      { name: 'ada', email: 'ada@muuv.test' },
      { name: 'edi', email: 'edi@muuv.test' },
    ])
    .returning({ id: users.id });
  ids.admin = admin!.id;
  ids.restricted = restricted!.id;
  const [, editorMember] = await db
    .insert(members)
    .values([
      { organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() },
      { organizationId: ids.org, userId: ids.restricted, role: 'editor', createdAt: new Date() },
    ])
    .returning({ id: members.id });
  const [nord, sued] = await db
    .insert(clients)
    .values([
      { organizationId: ids.org, name: 'Nordwind', slug: 'nordwind' },
      { organizationId: ids.org, name: 'Südhang', slug: 'suedhang' },
    ])
    .returning({ id: clients.id });
  ids.nord = nord!.id;
  ids.sued = sued!.id;
  // Edi sieht nur Südhang.
  await db
    .insert(memberClientGrants)
    .values({ organizationId: ids.org, memberId: editorMember!.id, clientId: ids.sued });

  const spConnection = await createTestConnection(db, ids.org, 'A1SELLER', 'amazon_sp');
  const account = (
    marketplaceId: string,
    countryCode: string,
    currencyCode: string,
    clientId: string,
    sellerId = 'A1SELLER',
  ) => ({
    organizationId: ids.org,
    connectionId: spConnection,
    clientId,
    amazonSellerId: sellerId,
    marketplaceId,
    storeName: 'Store',
    countryCode,
    currencyCode,
    timezone: 'Europe/Berlin',
  });
  const accounts = await db
    .insert(amazonSpAccounts)
    .values([
      account(DE, 'DE', 'EUR', ids.nord),
      account(FR, 'FR', 'EUR', ids.nord),
      account(US, 'US', 'USD', ids.nord),
      account(DE, 'DE', 'EUR', ids.sued, 'A2SUED'),
    ])
    .returning({ id: amazonSpAccounts.id });
  [ids.de, ids.fr, ids.us, ids.suedDe] = accounts.map((a) => a.id) as [
    string,
    string,
    string,
    string,
  ];

  // Ads: Nordwind hat ein Profil auf DE (gehört zum DE-Konto) und eins auf FR; Südhang keins.
  const adsConnection = await createTestConnection(db, ids.org, 'ads-1');
  const profile = (amazonProfileId: string, marketplaceId: string, countryCode: string) => ({
    organizationId: ids.org,
    connectionId: adsConnection,
    clientId: ids.nord,
    amazonProfileId,
    accountName: `Nordwind ${countryCode}`,
    countryCode,
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
    marketplaceId,
  });
  const profiles = await db
    .insert(amazonAdsProfiles)
    .values([profile('1', DE, 'DE'), profile('2', FR, 'FR')])
    .returning({ id: amazonAdsProfiles.id });
  [ids.profileDe, ids.profileFr] = profiles.map((p) => p.id) as [string, string];
  const campaigns = await db
    .insert(amazonAdsCampaigns)
    .values(
      profiles.map((p, i) => ({
        organizationId: ids.org,
        profileId: p.id,
        amazonCampaignId: `c${i}`,
        adProduct: 'SPONSORED_PRODUCTS',
        name: `SP ${i}`,
        state: 'ENABLED',
      })),
    )
    .returning({ id: amazonAdsCampaigns.id });
  const metric = (i: number, date: string, cost: string, sales7d: string) => ({
    organizationId: ids.org,
    profileId: profiles[i]!.id,
    campaignId: campaigns[i]!.id,
    date,
    adProduct: 'SPONSORED_PRODUCTS',
    currencyCode: 'EUR',
    impressions: 1000,
    clicks: 10,
    cost,
    sales7d,
    importedAt: new Date(),
  });
  await db
    .insert(amazonAdsCampaignDailyMetrics)
    .values([
      metric(0, '2026-10-01', '10', '50'),
      metric(0, '2026-10-02', '20', '100'),
      metric(1, '2026-10-01', '5', '30'),
      metric(0, '2026-09-01', '7', '20'),
    ]);

  const day = (
    sellerAccountId: string,
    date: string,
    sku: string,
    values: {
      units: number;
      orders: number;
      itemPrice: string;
      itemTax: string;
      discount?: string;
    },
  ) => ({
    organizationId: ids.org,
    sellerAccountId,
    date,
    sku,
    asin: `B0${sku}`,
    currency: sellerAccountId === ids.us ? 'USD' : 'EUR',
    units: values.units,
    orders: values.orders,
    unpricedUnits: 0,
    itemPrice: values.itemPrice,
    itemTax: values.itemTax,
    shippingPrice: '0',
    shippingTax: '0',
    giftWrapPrice: '0',
    giftWrapTax: '0',
    itemPromotionDiscount: values.discount ?? '0',
    shipPromotionDiscount: '0',
  });
  await db.insert(amazonSpDailySales).values([
    // DE: Preis inkl. 19 % USt.
    day(ids.de, '2026-10-01', 'TEE', { units: 2, orders: 2, itemPrice: '119', itemTax: '19' }),
    day(ids.de, '2026-10-02', 'TEE', { units: 1, orders: 1, itemPrice: '59.50', itemTax: '9.50' }),
    day(ids.de, '2026-10-02', 'CAP', {
      units: 1,
      orders: 1,
      itemPrice: '23.80',
      itemTax: '3.80',
      discount: '-3.80',
    }),
    day(ids.fr, '2026-10-01', 'TEE', { units: 1, orders: 1, itemPrice: '60', itemTax: '10' }),
    // US: Preis ohne Steuer, Steuer kommt dazu.
    day(ids.us, '2026-10-01', 'TEE', { units: 1, orders: 1, itemPrice: '117', itemTax: '10' }),
    day(ids.suedDe, '2026-10-01', 'MUG', {
      units: 4,
      orders: 3,
      itemPrice: '47.60',
      itemTax: '7.60',
    }),
    // Vergleichszeitraum
    day(ids.de, '2026-09-01', 'TEE', { units: 1, orders: 1, itemPrice: '59.50', itemTax: '9.50' }),
  ]);
  // Distinkte Bestellungen kommen aus den Positionen (eine Bestellung mit zwei SKUs zählt einmal).
  const item = (sellerAccountId: string, amazonOrderId: string, sku: string, date: string) => ({
    organizationId: ids.org,
    sellerAccountId,
    amazonOrderId,
    sku,
    purchasedAt: new Date(`${date}T10:00:00Z`),
    purchaseDate: date,
    lastUpdatedAt: new Date(`${date}T10:00:00Z`),
    orderStatus: 'Shipped',
    quantity: 1,
    isBusinessOrder: false,
  });
  await db
    .insert(amazonSpOrderItems)
    .values([
      item(ids.de, 'o1', 'TEE', '2026-10-01'),
      item(ids.de, 'o2', 'TEE', '2026-10-01'),
      item(ids.de, 'o3', 'TEE', '2026-10-02'),
      item(ids.de, 'o3', 'CAP', '2026-10-02'),
      { ...item(ids.de, 'o4', 'TEE', '2026-10-02'), orderStatus: 'Cancelled' },
    ]);
  await db.insert(fxRates).values([{ date: '2026-09-30', quote: 'USD', rate: '1.17' }]);
});

afterAll(async () => {
  await testDb.close();
});

const query = (overrides: Partial<SalesQuery> = {}): SalesQuery => ({
  userId: ids.admin,
  orgId: ids.org,
  period: { from: '2026-10-01', to: '2026-10-02' },
  comparison: null,
  currency: 'EUR',
  attribution: 'console',
  ...overrides,
});

describe('querySales', () => {
  it('summiert netto und brutto je Marktplatz-Regel und zählt Bestellungen ohne Doppel', async () => {
    const result = await querySales(
      testDb.db,
      query({ clientIds: [ids.nord], profileIds: [ids.profileDe] }),
    );

    expect(result.accounts).toBe(1);
    // DE: 119 + 59.50 + 23.80 − 3.80 Rabatt = 198.50 brutto; Steuer 19 + 9.50 + 3.80 = 32.30.
    expect(result.totals.current).toMatchObject({
      revenueGross: '198.5',
      revenueNet: '166.2',
      units: 4,
      orders: 3,
      unpricedUnits: 0,
    });
    expect(result.days).toEqual([
      { date: '2026-10-01', revenueNet: '100', revenueGross: '119', units: 2 },
      { date: '2026-10-02', revenueNet: '66.2', revenueGross: '79.5', units: 2 },
    ]);
    expect(result.products.map((p) => [p.sku, p.current.revenueNet])).toEqual([
      ['TEE', '150'],
      ['CAP', '16.2'],
    ]);
  });

  it('nimmt Werbekosten und Anzeigen-Umsatz der Profile desselben Clients und Marktplatzes', async () => {
    const de = await querySales(testDb.db, query({ profileIds: [ids.profileDe] }));
    expect(de.ads).toEqual({
      profiles: 1,
      current: { cost: '30', sales: '150' },
      comparison: null,
    });

    // Ohne Profilauswahl: alle Konten von Nordwind; FR hat ein Profil, US keins.
    const all = await querySales(testDb.db, query({ clientIds: [ids.nord] }));
    expect(all.accounts).toBe(3);
    expect(all.ads).toMatchObject({ profiles: 2, current: { cost: '35', sales: '180' } });
  });

  it('rechnet in die Anzeigewährung um (US: Preis ohne Steuer) und markiert die Umrechnung', async () => {
    const result = await querySales(
      testDb.db,
      query({ clientIds: [ids.nord], period: { from: '2026-10-01', to: '2026-10-01' } }),
    );

    expect(result.converted).toBe(true);
    // DE 119/100, FR 60/50, US netto 117 USD = 100 EUR, brutto 127 USD.
    // Faktoren mit 30 Nachkommastellen: gerundet wird erst bei der Anzeige.
    expect(Number(result.totals.current.revenueNet)).toBeCloseTo(250, 9);
    expect(Number(result.totals.current.revenueGross)).toBeCloseTo(179 + 127 / 1.17, 6);
    expect(result.missingFxCurrencies).toEqual([]);
  });

  it('liefert den Vergleichszeitraum', async () => {
    const result = await querySales(
      testDb.db,
      query({
        profileIds: [ids.profileDe],
        comparison: { from: '2026-09-01', to: '2026-09-02' },
      }),
    );
    expect(result.totals.comparison).toMatchObject({ revenueNet: '50', units: 1, orders: 0 });
    expect(result.comparisonDays).toEqual([
      { date: '2026-09-01', revenueNet: '50', revenueGross: '59.5', units: 1 },
    ]);
    expect(result.ads?.comparison).toEqual({ cost: '7', sales: '20' });
  });

  it('zeigt nur Konten freigegebener Clients (Access-Layer)', async () => {
    const result = await querySales(testDb.db, query({ userId: ids.restricted }));

    expect(result.accounts).toBe(1);
    expect(result.products.map((p) => p.sku)).toEqual(['MUG']);
    expect(result.ads).toBe(null);
  });

  it('ist leer für fremde Nutzer', async () => {
    const result = await querySales(
      testDb.db,
      query({ orgId: '00000000-0000-0000-0000-000000000000' }),
    );
    expect(result.accounts).toBe(0);
    expect(result.totals.current.revenueNet).toBe('0');
    expect(result.products).toEqual([]);
  });
});
