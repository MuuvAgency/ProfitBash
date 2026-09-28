import { convertAmount, formatDecimal, parseDecimal, sumDecimals } from '@profitbash/engine';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  listSelectableCurrencies,
  queryDashboard,
  queryDataStatus,
  queryExplorerRows,
  queryNegatives,
  queryTimeSeries,
  type AnalyticsQuery,
} from './ads-analytics';
import { markMetricsImportedThrough } from './amazon-ads-metrics';
import { fxRatesOnOrBefore } from './fx-rates';
import {
  amazonAdsAdGroupDailyMetrics,
  amazonAdsAdGroups,
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsPortfolios,
  amazonAdsProductAdDailyMetrics,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsSearchTermDailyMetrics,
  amazonAdsTargetDailyMetrics,
  amazonAdsTargets,
  clients,
  fxRates,
  members,
  users,
} from './schema';
import { createTestConnection, createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/**
 * Abfrage-Schicht (2.4) gegen eine kleine, von Hand geprüfte Datenlage: drei sichtbare Profile in EUR, GBP und
 * SEK (Seller, Vendor, Agency), ein ausgeblendetes Profil und eine fremde Organisation mit Daten.
 */

const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const SD = 'SPONSORED_DISPLAY';
const PERIOD = { from: '2026-09-01', to: '2026-09-02' };
const COMPARISON = { from: '2026-08-30', to: '2026-08-31' };

let testDb: TestDatabase;
const ids = {
  org: '',
  otherOrg: '',
  admin: '',
  viewer: '',
  outsider: '',
  clientA: '',
  clientB: '',
  de: '',
  uk: '',
  se: '',
  hidden: '',
  foreign: '',
  portfolio: '',
  spDe: '',
  sbDe: '',
  sdDe: '',
  spUk: '',
  spSe: '',
  spHidden: '',
  spForeign: '',
  agDe: '',
  agSd: '',
  agSb: '',
  agUk: '',
  agSe: '',
  tKeyword: '',
  tPlaceholder: '',
  tRemoved: '',
  tSbCampaign: '',
  tUk: '',
  adMulti: '',
  adSku: '',
};

interface MetricInput {
  profileId: string;
  currencyCode: string;
  adProduct: string;
  date: string;
  impressions: number;
  clicks: number;
  cost: string;
  sales7d?: string | null;
  sales14d?: string | null;
  purchases7d?: number | null;
  purchases14d?: number | null;
  salesClicks14d?: string | null;
  purchasesClicks14d?: number | null;
  viewableImpressions?: number | null;
}

/** Alle Kennzahl-Zeilen der Kampagnen-Ebene, für die unabhängige Prüfung der Summen. */
const campaignRows: Array<MetricInput & { campaignId: string }> = [];

function values(input: MetricInput) {
  return {
    organizationId: input.profileId === ids.foreign ? ids.otherOrg : ids.org,
    profileId: input.profileId,
    date: input.date,
    adProduct: input.adProduct,
    currencyCode: input.currencyCode,
    impressions: input.impressions,
    clicks: input.clicks,
    cost: input.cost,
    sales7d: input.sales7d ?? null,
    sales14d: input.sales14d ?? null,
    purchases7d: input.purchases7d ?? null,
    purchases14d: input.purchases14d ?? null,
    salesClicks14d: input.salesClicks14d ?? null,
    purchasesClicks14d: input.purchasesClicks14d ?? null,
    viewableImpressions: input.viewableImpressions ?? null,
    importedAt: new Date(),
  };
}

async function campaignMetric(campaignId: string, input: MetricInput) {
  campaignRows.push({ ...input, campaignId });
  await testDb.db.insert(amazonAdsCampaignDailyMetrics).values({ ...values(input), campaignId });
}

const base = (): Pick<
  AnalyticsQuery,
  'userId' | 'orgId' | 'period' | 'currency' | 'attribution'
> => ({
  userId: ids.viewer,
  orgId: ids.org,
  period: PERIOD,
  currency: 'auto',
  attribution: 'console',
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const [admin, viewer, outsider] = await db
    .insert(users)
    .values([
      { name: 'Ada', email: 'ada@muuv.test' },
      { name: 'Vera', email: 'vera@muuv.test' },
      { name: 'Otto', email: 'otto@andere.test' },
    ])
    .returning({ id: users.id });
  ids.admin = admin!.id;
  ids.viewer = viewer!.id;
  ids.outsider = outsider!.id;
  await db.insert(members).values([
    { organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() },
    { organizationId: ids.org, userId: ids.viewer, role: 'viewer', createdAt: new Date() },
    { organizationId: ids.otherOrg, userId: ids.outsider, role: 'admin', createdAt: new Date() },
  ]);
  const [clientA, clientB] = await db
    .insert(clients)
    .values([
      { organizationId: ids.org, name: 'Alpha', slug: 'alpha' },
      { organizationId: ids.org, name: 'Beta', slug: 'beta' },
    ])
    .returning({ id: clients.id });
  ids.clientA = clientA!.id;
  ids.clientB = clientB!.id;

  const connection = await createTestConnection(db, ids.org, 'amzn1.account.MUUV');
  const otherConnection = await createTestConnection(db, ids.otherOrg, 'amzn1.account.OTHER');
  const profile = (
    amazonProfileId: string,
    currencyCode: string,
    accountType: string,
    extra: Partial<typeof amazonAdsProfiles.$inferInsert> = {},
  ): typeof amazonAdsProfiles.$inferInsert => ({
    organizationId: ids.org,
    connectionId: connection,
    amazonProfileId,
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode,
    timezone: 'Europe/Berlin',
    accountType,
    ...extra,
  });
  const [de, uk, se, hidden, foreign] = await db
    .insert(amazonAdsProfiles)
    .values([
      profile('1', 'EUR', 'seller', { clientId: ids.clientA }),
      profile('2', 'GBP', 'vendor', { clientId: ids.clientB, countryCode: 'UK' }),
      profile('3', 'SEK', 'agency', { countryCode: 'SE' }),
      profile('4', 'EUR', 'seller', { isHidden: true, clientId: ids.clientA }),
      profile('5', 'EUR', 'seller', {
        organizationId: ids.otherOrg,
        connectionId: otherConnection,
      }),
    ])
    .returning({ id: amazonAdsProfiles.id });
  ids.de = de!.id;
  ids.uk = uk!.id;
  ids.se = se!.id;
  ids.hidden = hidden!.id;
  ids.foreign = foreign!.id;

  const orgOf = (profileId: string) => (profileId === ids.foreign ? ids.otherOrg : ids.org);
  const [portfolio] = await db
    .insert(amazonAdsPortfolios)
    .values({
      organizationId: ids.org,
      profileId: ids.de,
      amazonPortfolioId: 'pf1',
      name: 'Marke A',
      syncedAt: new Date(),
    })
    .returning({ id: amazonAdsPortfolios.id });
  ids.portfolio = portfolio!.id;

  const campaign = (
    profileId: string,
    amazonCampaignId: string,
    adProduct: string,
    name: string,
    extra: Partial<typeof amazonAdsCampaigns.$inferInsert> = {},
  ) => ({
    organizationId: orgOf(profileId),
    profileId,
    amazonCampaignId,
    adProduct,
    name,
    state: 'ENABLED',
    syncedAt: new Date(),
    ...extra,
  });
  const [spDe, sbDe, sdDe, spUk, spSe, spHidden, spForeign] = await db
    .insert(amazonAdsCampaigns)
    .values([
      campaign(ids.de, 'c1', SP, 'SP DE', { portfolioId: ids.portfolio }),
      campaign(ids.de, 'c2', SB, 'SB DE ohne Kennzahlen'),
      campaign(ids.de, 'c3', SD, 'SD DE vCPM', { extra: { costType: 'VCPM' } }),
      campaign(ids.uk, 'c4', SP, 'SP UK'),
      campaign(ids.se, 'c5', SP, 'SP SE'),
      campaign(ids.hidden, 'c6', SP, 'SP versteckt'),
      campaign(ids.foreign, 'c7', SP, 'SP fremd'),
    ])
    .returning({ id: amazonAdsCampaigns.id });
  Object.assign(ids, {
    spDe: spDe!.id,
    sbDe: sbDe!.id,
    sdDe: sdDe!.id,
    spUk: spUk!.id,
    spSe: spSe!.id,
    spHidden: spHidden!.id,
    spForeign: spForeign!.id,
  });

  const adGroup = (
    profileId: string,
    campaignId: string,
    amazonAdGroupId: string,
    name: string,
    adProduct = SP,
  ) => ({
    adProduct,
    organizationId: orgOf(profileId),
    profileId,
    campaignId,
    amazonAdGroupId,
    name,
    state: 'ENABLED',
    syncedAt: new Date(),
  });
  const [agDe, agSd, agSb, agUk, agSe] = await db
    .insert(amazonAdsAdGroups)
    .values([
      adGroup(ids.de, ids.spDe, 'g1', 'AG DE'),
      adGroup(ids.de, ids.sdDe, 'g2', 'AG SD', SD),
      adGroup(ids.de, ids.sbDe, 'g3', 'AG SB', SB),
      adGroup(ids.uk, ids.spUk, 'g4', 'AG UK'),
      adGroup(ids.se, ids.spSe, 'g5', 'AG SE'),
    ])
    .returning({ id: amazonAdsAdGroups.id });
  Object.assign(ids, {
    agDe: agDe!.id,
    agSd: agSd!.id,
    agSb: agSb!.id,
    agUk: agUk!.id,
    agSe: agSe!.id,
  });

  const target = (
    profileId: string,
    campaignId: string,
    adGroupId: string | null,
    amazonTargetId: string,
    extra: Partial<typeof amazonAdsTargets.$inferInsert> = {},
  ) => ({
    organizationId: orgOf(profileId),
    profileId,
    campaignId,
    adGroupId,
    amazonTargetId,
    adProduct: SP,
    targetType: 'keyword',
    keywordText: `kw ${amazonTargetId}`,
    matchType: 'EXACT',
    state: 'ENABLED',
    syncedAt: new Date(),
    ...extra,
  });
  const [tKeyword, tPlaceholder, tRemoved, tSbCampaign, tUk] = await db
    .insert(amazonAdsTargets)
    .values([
      target(ids.de, ids.spDe, ids.agDe, 't1'),
      target(ids.de, ids.spDe, ids.agDe, 't2', {
        keywordText: null,
        targetType: null,
        matchType: null,
        state: null,
        syncedAt: null,
      }),
      target(ids.de, ids.spDe, ids.agDe, 't3', { removedAt: new Date() }),
      target(ids.de, ids.sbDe, null, 't4', { adProduct: SB }),
      target(ids.uk, ids.spUk, ids.agUk, 't5'),
    ])
    .returning({ id: amazonAdsTargets.id });
  Object.assign(ids, {
    tKeyword: tKeyword!.id,
    tPlaceholder: tPlaceholder!.id,
    tRemoved: tRemoved!.id,
    tSbCampaign: tSbCampaign!.id,
    tUk: tUk!.id,
  });

  const [adMulti, adSku] = await db
    .insert(amazonAdsProductAds)
    .values([
      {
        organizationId: ids.org,
        profileId: ids.de,
        campaignId: ids.sbDe,
        adGroupId: ids.agSb,
        amazonAdId: 'a1',
        adProduct: SB,
        asin: null,
        state: 'ENABLED',
        extra: { asins: ['B0AAA', 'B0BBB'], adType: 'PRODUCT_COLLECTION' },
        syncedAt: new Date(),
      },
      {
        organizationId: ids.org,
        profileId: ids.de,
        campaignId: ids.sdDe,
        adGroupId: ids.agSd,
        amazonAdId: 'a2',
        adProduct: SD,
        asin: null,
        sku: 'Sku-Nur',
        state: 'ENABLED',
        syncedAt: new Date(),
      },
    ])
    .returning({ id: amazonAdsProductAds.id });
  ids.adMulti = adMulti!.id;
  ids.adSku = adSku!.id;

  // Kurse: GBP an beiden Freitagen, SEK erst ab dem 01.09. (Vergleichszeitraum ohne SEK-Kurs).
  await db.insert(fxRates).values([
    { date: '2026-08-28', quote: 'GBP', rate: '0.85' },
    { date: '2026-09-01', quote: 'GBP', rate: '0.86' },
    { date: '2026-09-02', quote: 'GBP', rate: '0.8625' },
    { date: '2026-09-01', quote: 'SEK', rate: '11.3' },
    { date: '2026-09-02', quote: 'SEK', rate: '11.25' },
    { date: '2026-09-01', quote: 'USD', rate: '1.17' },
    { date: '2026-09-02', quote: 'USD', rate: '1.18' },
  ]);

  // Kampagnen-Kennzahlen.
  const de1 = { profileId: ids.de, currencyCode: 'EUR' };
  await campaignMetric(ids.spDe, {
    ...de1,
    adProduct: SP,
    date: '2026-09-01',
    impressions: 1000,
    clicks: 10,
    cost: '5.005',
    sales7d: '100.10',
    sales14d: '120.10',
    purchases7d: 2,
    purchases14d: 3,
  });
  await campaignMetric(ids.spDe, {
    ...de1,
    adProduct: SP,
    date: '2026-09-02',
    impressions: 500,
    clicks: 5,
    cost: '2.50',
    sales7d: '0',
    sales14d: '10',
    purchases7d: 0,
    purchases14d: 1,
  });
  await campaignMetric(ids.spDe, {
    ...de1,
    adProduct: SP,
    date: '2026-08-31',
    impressions: 800,
    clicks: 8,
    cost: '4',
    sales7d: '50',
    sales14d: '60',
    purchases7d: 1,
    purchases14d: 1,
  });
  await campaignMetric(ids.sdDe, {
    ...de1,
    adProduct: SD,
    date: '2026-09-01',
    impressions: 4000,
    clicks: 3,
    cost: '8.25',
    sales14d: '40',
    purchases14d: 2,
    salesClicks14d: '30',
    purchasesClicks14d: 1,
    viewableImpressions: 2500,
  });
  await campaignMetric(ids.spUk, {
    profileId: ids.uk,
    currencyCode: 'GBP',
    adProduct: SP,
    date: '2026-09-01',
    impressions: 300,
    clicks: 4,
    cost: '3.40',
    sales7d: '20',
    sales14d: '25.5',
    purchases7d: 1,
    purchases14d: 2,
  });
  await campaignMetric(ids.spUk, {
    profileId: ids.uk,
    currencyCode: 'GBP',
    adProduct: SP,
    date: '2026-08-30',
    impressions: 200,
    clicks: 2,
    cost: '1.70',
    sales7d: '0',
    sales14d: '0',
    purchases7d: 0,
    purchases14d: 0,
  });
  await campaignMetric(ids.spSe, {
    profileId: ids.se,
    currencyCode: 'SEK',
    adProduct: SP,
    date: '2026-09-02',
    impressions: 700,
    clicks: 9,
    cost: '45',
    sales7d: '225',
    sales14d: '300',
    purchases7d: 1,
    purchases14d: 2,
  });
  await campaignMetric(ids.spSe, {
    profileId: ids.se,
    currencyCode: 'SEK',
    adProduct: SP,
    date: '2026-08-31',
    impressions: 100,
    clicks: 1,
    cost: '11',
    sales7d: '0',
    sales14d: '0',
    purchases7d: 0,
    purchases14d: 0,
  });
  // Ausgeblendet und fremd: dürfen nie erscheinen.
  await testDb.db.insert(amazonAdsCampaignDailyMetrics).values([
    {
      ...values({
        profileId: ids.hidden,
        currencyCode: 'EUR',
        adProduct: SP,
        date: '2026-09-01',
        impressions: 9,
        clicks: 9,
        cost: '999',
      }),
      campaignId: ids.spHidden,
    },
    {
      ...values({
        profileId: ids.foreign,
        currencyCode: 'EUR',
        adProduct: SP,
        date: '2026-09-01',
        impressions: 9,
        clicks: 9,
        cost: '777',
      }),
      campaignId: ids.spForeign,
    },
  ]);

  // Target-Kennzahlen (auch Platzhalter, entferntes Target und SB-Target ohne Ad Group).
  const target1 = (targetId: string, cost: string, extra: Partial<MetricInput> = {}) => ({
    ...values({
      ...de1,
      adProduct: SP,
      date: '2026-09-01',
      impressions: 100,
      clicks: 2,
      cost,
      sales7d: '10',
      sales14d: '12',
      purchases7d: 1,
      purchases14d: 1,
      ...extra,
    }),
    targetId,
  });
  await db.insert(amazonAdsTargetDailyMetrics).values([
    target1(ids.tKeyword, '1.50'),
    target1(ids.tPlaceholder, '0.75'),
    target1(ids.tRemoved, '9'),
    {
      ...target1(ids.tSbCampaign, '2.20', {
        adProduct: SB,
        sales7d: null,
        sales14d: '30',
        purchases7d: null,
        purchases14d: 2,
        salesClicks14d: '20',
        purchasesClicks14d: 1,
      }),
    },
    {
      ...values({
        profileId: ids.uk,
        currencyCode: 'GBP',
        adProduct: SP,
        date: '2026-09-02',
        impressions: 50,
        clicks: 1,
        cost: '0.40',
        sales7d: '0',
        sales14d: '5',
        purchases7d: 0,
        purchases14d: 1,
      }),
      targetId: ids.tUk,
    },
  ]);
  await db.insert(amazonAdsAdGroupDailyMetrics).values([
    {
      ...values({
        ...de1,
        adProduct: SP,
        date: '2026-09-01',
        impressions: 1000,
        clicks: 10,
        cost: '5.005',
        sales7d: '100.10',
        purchases7d: 2,
      }),
      adGroupId: ids.agDe,
    },
  ]);
  await db.insert(amazonAdsSearchTermDailyMetrics).values([
    {
      ...values({
        ...de1,
        adProduct: SP,
        date: '2026-09-01',
        impressions: 60,
        clicks: 1,
        cost: '0.50',
        sales7d: '5',
        purchases7d: 1,
      }),
      targetId: ids.tKeyword,
      searchTerm: 'laufschuhe',
    },
    {
      ...values({
        ...de1,
        adProduct: SP,
        date: '2026-09-02',
        impressions: 40,
        clicks: 1,
        cost: '0.25',
        sales7d: '0',
        purchases7d: 0,
      }),
      targetId: ids.tKeyword,
      searchTerm: 'laufschuhe',
    },
    {
      ...values({
        ...de1,
        adProduct: SP,
        date: '2026-09-01',
        impressions: 30,
        clicks: 0,
        cost: '0',
        sales7d: '0',
        purchases7d: 0,
      }),
      targetId: ids.tKeyword,
      searchTerm: 'sportschuhe',
    },
  ]);
  await db.insert(amazonAdsProductAdDailyMetrics).values([
    {
      ...values({
        ...de1,
        adProduct: SB,
        date: '2026-09-01',
        impressions: 500,
        clicks: 5,
        cost: '3',
        sales14d: '50',
        purchases14d: 1,
        salesClicks14d: '50',
        purchasesClicks14d: 1,
      }),
      productAdId: ids.adMulti,
    },
  ]);
}, 60_000);

afterAll(() => testDb?.close());

/** Unabhängige Prüfung: Summe der Kampagnen-Kosten in `target`, je Zeile mit `convertAmount` umgerechnet. */
async function expectedCost(
  profileIds: string[],
  range: { from: string; to: string },
  target: string,
) {
  const converted: string[] = [];
  const missing = new Set<string>();
  for (const row of campaignRows) {
    if (!profileIds.includes(row.profileId) || row.date < range.from || row.date > range.to)
      continue;
    const rates = await fxRatesOnOrBefore(testDb.db, row.date, [row.currencyCode, target]);
    const value = convertAmount(
      row.cost,
      row.currencyCode,
      target,
      new Map([...rates].map(([currency, { rate }]) => [currency, rate])),
    );
    if (value === null) missing.add(row.currencyCode);
    else converted.push(value);
  }
  return { cost: sumDecimals(converted), missing: [...missing].sort() };
}

const round = (value: string | null, places = 9) =>
  value === null ? null : formatDecimal(parseDecimal(value).toDecimalPlaces(places));

describe('queryExplorerRows: Sichtbarkeit', () => {
  it('liefert für Nicht-Mitglieder nichts', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      userId: ids.outsider,
      level: 'campaign',
    });
    expect(result.rows).toEqual([]);
    expect(result.totals.current.cost).toBe('0');
  });

  it('zeigt weder ausgeblendete noch fremde Profile, auch nicht bei ausdrücklicher Auswahl', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'campaign',
      profileIds: [ids.de, ids.hidden, ids.foreign],
    });
    expect(new Set(result.rows.map((row) => row.profileId))).toEqual(new Set([ids.de]));
    expect(result.rows.map((row) => row.name)).not.toContain('SP versteckt');
    const all = await queryExplorerRows(testDb.db, {
      ...base(),
      userId: ids.admin,
      level: 'campaign',
    });
    expect(all.rows.map((row) => row.id)).not.toContain(ids.spHidden);
    expect(all.rows.map((row) => row.id)).not.toContain(ids.spForeign);
  });
});

describe('queryExplorerRows: Währung', () => {
  it('rechnet gemischte Währungen je Tag in EUR um, Zeilen bleiben in Originalwährung', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'campaign',
      comparison: COMPARISON,
    });
    expect(result.currency).toBe('EUR');
    expect(result.converted).toBe(true);
    const uk = result.rows.find((row) => row.id === ids.spUk)!;
    expect(uk.currencyCode).toBe('GBP');
    expect(uk.current.cost).toBe('3.40');

    const visible = [ids.de, ids.uk, ids.se];
    const expected = await expectedCost(visible, PERIOD, 'EUR');
    expect(round(result.totals.current.cost)).toBe(round(expected.cost));
    // Vergleichszeitraum: für SEK gibt es vor dem 01.09. keinen Kurs; der Betrag zählt nicht.
    const expectedComparison = await expectedCost(visible, COMPARISON, 'EUR');
    expect(expectedComparison.missing).toEqual(['SEK']);
    expect(round(result.totals.comparison!.cost)).toBe(round(expectedComparison.cost));
    expect(result.totals.missingFxCurrencies).toEqual(['SEK']);
  });

  it('rechnet zwischen zwei Nicht-EUR-Währungen über EUR mit den Kursen desselben Tages um', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'campaign',
      currency: 'USD',
    });
    const expected = await expectedCost([ids.de, ids.uk, ids.se], PERIOD, 'USD');
    expect(round(result.totals.current.cost)).toBe(round(expected.cost));
    expect(result.currency).toBe('USD');
  });

  it('bleibt bei einer Währung in der Auswahl in dieser Währung ohne Umrechnung', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'campaign',
      clientIds: [ids.clientB],
    });
    expect(result.currency).toBe('GBP');
    expect(result.converted).toBe(false);
    expect(result.totals.current.cost).toBe('3.40');
  });
});

describe('queryExplorerRows: Kennzahlen und Attribution', () => {
  it('summiert je Zeile für Zeitraum und Vergleich (Original, exakt)', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'campaign',
      comparison: COMPARISON,
      clientIds: [ids.clientA],
    });
    const sp = result.rows.find((row) => row.id === ids.spDe)!;
    expect(sp.current).toMatchObject({
      impressions: '1500',
      clicks: '15',
      cost: '7.505',
      sales: '100.10',
      purchases: '2',
    });
    expect(sp.comparison).toMatchObject({ cost: '4', sales: '50', purchases: '1' });
    expect(sp.current.viewableImpressions).toBeNull();
  });

  it('wählt die Attribution je Ad-Typ und Kontotyp und meldet gemischte Summen', async () => {
    const console = await queryExplorerRows(testDb.db, { ...base(), level: 'campaign' });
    // Vendor (UK): 14 Tage, Seller (DE) und Agency (SE): 7 Tage.
    expect(console.rows.find((row) => row.id === ids.spUk)!.current.sales).toBe('25.5');
    expect(console.rows.find((row) => row.id === ids.spSe)!.current.sales).toBe('225');
    // SD „wie Konsole“: 14 Tage inkl. Views.
    expect(console.rows.find((row) => row.id === ids.sdDe)!.current.sales).toBe('40');
    expect(console.totals.attribution.mixed).toBe(true);

    const clicks = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'campaign',
      attribution: 'clicks14d',
    });
    expect(clicks.rows.find((row) => row.id === ids.spDe)!.current.sales).toBe('130.10');
    expect(clicks.rows.find((row) => row.id === ids.sdDe)!.current.sales).toBe('30');
    expect(clicks.totals.attribution.mixed).toBe(false);
  });

  it('zeigt SD-vCPM-Grundlagen nur bei SD und SB-Kampagnen ohne Kennzahlen mit 0 und Kennzeichen', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'campaign',
      clientIds: [ids.clientA],
    });
    const sd = result.rows.find((row) => row.id === ids.sdDe)!;
    expect(sd.current).toMatchObject({ viewableImpressions: '2500', viewableCost: '8.25' });
    expect(sd.attributes).toMatchObject({ costType: 'VCPM' });
    const sb = result.rows.find((row) => row.id === ids.sbDe)!;
    expect(sb.hasMetrics).toBe(false);
    expect(sb.current).toMatchObject({ cost: '0', clicks: '0', sales: '0', unitsSameSku: null });
    expect(result.totals.current.viewableCost).toBe('8.25');
  });
});

describe('queryExplorerRows: Ebenen und Filter', () => {
  it('zeigt Platzhalter und SB-Targets ohne Ad Group, entfernte Targets nur auf Wunsch', async () => {
    const targets = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'target',
      clientIds: [ids.clientA],
    });
    const byId = new Map(targets.rows.map((row) => [row.id, row]));
    expect(byId.get(ids.tPlaceholder)).toMatchObject({ placeholder: true, name: null });
    expect(byId.has(ids.tRemoved)).toBe(false);
    expect(targets.totals.current.cost).toBe('4.45');

    const drill = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'target',
      filter: { campaignIds: [ids.sbDe] },
    });
    expect(drill.rows.map((row) => row.id)).toEqual([ids.tSbCampaign]);
    expect(drill.rows[0]!.attributes).toMatchObject({
      adGroupId: null,
      campaignName: 'SB DE ohne Kennzahlen',
    });

    const withRemoved = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'target',
      clientIds: [ids.clientA],
      filter: { includeRemoved: true },
    });
    expect(withRemoved.rows.find((row) => row.id === ids.tRemoved)).toMatchObject({
      removed: true,
    });
    expect(withRemoved.totals.current.cost).toBe('13.45');
  });

  it('kürzt auf die Zeilen mit dem höchsten Spend, die Summenzeile bleibt vollständig', async () => {
    const all = await queryExplorerRows(testDb.db, { ...base(), level: 'target' });
    const cut = await queryExplorerRows(testDb.db, { ...base(), level: 'target', limit: 2 });
    expect(cut.rows).toHaveLength(2);
    expect(cut.truncated).toBe(true);
    expect(cut.totalRows).toBe(all.totalRows);
    expect(all.truncated).toBe(false);
    expect(cut.totals).toEqual(all.totals);
    expect(cut.rows.map((row) => row.id)).toEqual([ids.tSbCampaign, ids.tKeyword]);
  });

  it('gruppiert Suchbegriffe je Target und Begriff', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'searchTerm',
      clientIds: [ids.clientA],
    });
    expect(result.rows.map((row) => [row.name, row.current.cost])).toEqual([
      ['laufschuhe', '0.75'],
      ['sportschuhe', '0'],
    ]);
    expect(result.rows[0]!.attributes).toMatchObject({
      targetId: ids.tKeyword,
      keywordText: 'kw t1',
    });
  });

  it('findet Product Ads per ASIN in extra.asins und per SKU (Groß-/Kleinschreibung egal)', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'productAd',
      filter: { productSearch: ['b0bbb', 'SKU-NUR'] },
    });
    expect(new Set(result.rows.map((row) => row.id))).toEqual(new Set([ids.adMulti, ids.adSku]));
    const multi = result.rows.find((row) => row.id === ids.adMulti)!;
    expect(multi.attributes).toMatchObject({ asins: ['B0AAA', 'B0BBB'] });
    expect(multi.current.cost).toBe('3');
  });

  it('summiert Portfolios aus ihren Kampagnen', async () => {
    const result = await queryExplorerRows(testDb.db, { ...base(), level: 'portfolio' });
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ id: ids.portfolio, name: 'Marke A', adProduct: null });
    expect(result.rows[0]!.current.cost).toBe('7.505');
  });

  it('filtert nach Ad-Typ', async () => {
    const result = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'campaign',
      adProducts: [SD],
      clientIds: [ids.clientA],
    });
    expect(result.rows.map((row) => row.id)).toEqual([ids.sdDe]);
    expect(result.totals.current.cost).toBe('8.25');
  });
});

describe('queryTimeSeries', () => {
  it('liefert je Tag die umgerechneten Summen der Auswahl, getrennt nach Zeitraum und Vergleich', async () => {
    const result = await queryTimeSeries(testDb.db, {
      ...base(),
      level: 'campaign',
      comparison: COMPARISON,
    });
    expect(result.currency).toBe('EUR');
    expect(result.days.map((day) => day.date)).toEqual(['2026-09-01', '2026-09-02']);
    const first = await expectedCost(
      [ids.de, ids.uk, ids.se],
      { from: '2026-09-01', to: '2026-09-01' },
      'EUR',
    );
    expect(round(result.days[0]!.current.cost)).toBe(round(first.cost));
    expect(result.comparisonDays.map((day) => day.date)).toEqual(['2026-08-30', '2026-08-31']);
    expect(result.missingFxCurrencies).toEqual(['SEK']);
  });

  it('beschränkt auf markierte Zeilen und Drill-Down', async () => {
    const result = await queryTimeSeries(testDb.db, {
      ...base(),
      level: 'target',
      entityIds: [ids.tKeyword, ids.tUk],
      currency: 'GBP',
    });
    expect(result.days.map((day) => [day.date, day.current.clicks])).toEqual([
      ['2026-09-01', '2'],
      ['2026-09-02', '1'],
    ]);
    const drill = await queryTimeSeries(testDb.db, {
      ...base(),
      level: 'searchTerm',
      entityIds: [`${ids.tKeyword}:sportschuhe`],
    });
    expect(drill.days.map((day) => day.current.impressions)).toEqual(['30']);
  });
});

describe('queryDashboard', () => {
  it('summiert je Client, Profil und Ad-Typ in der Anzeigewährung, Summe wie die Kampagnen', async () => {
    const result = await queryDashboard(testDb.db, { ...base(), comparison: COMPARISON });
    const explorer = await queryExplorerRows(testDb.db, {
      ...base(),
      level: 'campaign',
      comparison: COMPARISON,
    });
    expect(result.totals.current).toEqual(explorer.totals.current);
    expect(result.byClient.map((group) => [group.key, group.label])).toEqual([
      [ids.clientA, 'Alpha'],
      [ids.clientB, 'Beta'],
      [null, null],
    ]);
    expect(result.byAdProduct.map((group) => group.key)).toEqual([SD, SP]);
    const sd = result.byAdProduct.find((group) => group.key === SD)!;
    expect(sd.current.cost).toBe('8.25');
    expect(sd.attribution.mixed).toBe(false);
    const uk = result.byProfile.find((group) => group.key === ids.uk)!;
    expect(uk).toMatchObject({ label: 'Konto 2', currencyCode: 'GBP' });
    expect(round(uk.current.cost)).toBe(round(formatDecimal(parseDecimal('3.40').div('0.86'))));
    expect(result.totals.attribution.mixed).toBe(true);
  });
});

describe('listSelectableCurrencies', () => {
  it('bietet EUR, USD und die Währungen sichtbarer Profile an, soweit die EZB sie führt', async () => {
    expect(
      await listSelectableCurrencies(testDb.db, { userId: ids.viewer, orgId: ids.org }),
    ).toEqual(['EUR', 'GBP', 'SEK', 'USD']);
    expect(
      await listSelectableCurrencies(testDb.db, { userId: ids.outsider, orgId: ids.org }),
    ).toEqual([]);
  });
});

describe('queryDataStatus', () => {
  it('nennt „Daten bis“ (Minimum der Profile), den Beginn der vorläufigen Tage und den ersten Tag mit Daten', async () => {
    const selection = { always: [SP], withCampaigns: [] as string[] };
    const empty = await queryDataStatus(
      testDb.db,
      { userId: ids.viewer, orgId: ids.org },
      selection,
    );
    expect(empty).toEqual({
      dataThrough: null,
      provisionalFrom: null,
      earliestDate: '2026-08-30',
      profilesWithoutData: 3,
    });

    await markMetricsImportedThrough(testDb.db, {
      organizationId: ids.org,
      profileId: ids.de,
      adProduct: SP,
      date: '2026-09-02',
    });
    await markMetricsImportedThrough(testDb.db, {
      organizationId: ids.org,
      profileId: ids.uk,
      adProduct: SP,
      date: '2026-09-01',
    });
    const status = await queryDataStatus(
      testDb.db,
      { userId: ids.viewer, orgId: ids.org },
      selection,
    );
    expect(status).toEqual({
      dataThrough: '2026-09-01',
      provisionalFrom: '2026-08-19',
      earliestDate: '2026-08-30',
      profilesWithoutData: 1,
    });
  });
});

describe('queryNegatives', () => {
  it('listet Negatives sichtbarer Profile auf beiden Ebenen, filterbar nach Kampagne', async () => {
    await testDb.db.insert(amazonAdsNegativeTargets).values([
      {
        organizationId: ids.org,
        profileId: ids.de,
        adProduct: SP,
        level: 'campaign',
        campaignId: ids.spDe,
        amazonTargetId: 'n1',
        targetType: 'keyword',
        keywordText: 'gratis',
        matchType: 'NEGATIVE_EXACT',
        state: 'ENABLED',
        syncedAt: new Date(),
      },
      {
        organizationId: ids.org,
        profileId: ids.de,
        adProduct: SP,
        level: 'ad_group',
        campaignId: ids.spDe,
        adGroupId: ids.agDe,
        amazonTargetId: 'n2',
        targetType: 'keyword',
        keywordText: 'billig',
        matchType: 'NEGATIVE_PHRASE',
        state: 'ENABLED',
        syncedAt: new Date(),
      },
      {
        organizationId: ids.org,
        profileId: ids.hidden,
        adProduct: SP,
        level: 'campaign',
        campaignId: ids.spHidden,
        amazonTargetId: 'n3',
        targetType: 'keyword',
        keywordText: 'versteckt',
        matchType: 'NEGATIVE_EXACT',
        state: 'ENABLED',
        syncedAt: new Date(),
      },
    ]);
    const all = await queryNegatives(testDb.db, { userId: ids.viewer, orgId: ids.org });
    expect(all.rows.map((row) => row.name).sort()).toEqual(['billig', 'gratis']);
    expect(all.rows.find((row) => row.name === 'billig')).toMatchObject({
      currencyCode: 'EUR',
      adProduct: SP,
      attributes: {
        level: 'ad_group',
        adGroupName: 'AG DE',
        campaignName: 'SP DE',
        matchType: 'NEGATIVE_PHRASE',
      },
    });
    expect(all.truncated).toBe(false);
    const byAdGroup = await queryNegatives(testDb.db, {
      userId: ids.viewer,
      orgId: ids.org,
      filter: { adGroupIds: [ids.agDe] },
    });
    expect(byAdGroup.rows.map((row) => row.name)).toEqual(['billig']);
    expect(await queryNegatives(testDb.db, { userId: ids.outsider, orgId: ids.org })).toMatchObject(
      { rows: [] },
    );
  });
});
