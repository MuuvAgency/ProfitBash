import type { AmazonAdsExportType } from './exports';
import { REPORT_DEFINITIONS, type AmazonAdsReportType } from './reports';

/**
 * Synthetische Werbedaten für den Mock-Anbieter (SP): Entities je Profil und Tageskennzahlen je Ebene.
 * Deterministisch (gleiche Eingabe, gleiche Datei), damit ein zweiter Sync nichts ändert.
 *
 * Abgedeckt: große IDs als JSON-Zahl (über `Number.MAX_SAFE_INTEGER`), Beträge mit vielen Nachkommastellen
 * (auch als JSON-Zahl), eine archivierte Kampagne, Negatives auf Kampagnen- und Ad-Group-Ebene, Vendoren ohne
 * SKU, Tage ohne Aktivität (fehlen im Report). Kampagnen-Kennzahlen sind die Summe ihrer Ad Groups; Targets,
 * Product Ads und Suchbegriffe sind unabhängige Aufteilungen (Summen stimmen dort nicht überein).
 */

export interface MockProfile {
  amazonProfileId: string;
  currencyCode: string;
  accountType: string;
}

/**
 * Zahl im JSON-Text ohne Anführungszeichen. So kommen große IDs und Beträge wie bei Amazon als Zahl an
 * und prüfen das verlustfreie Parsing.
 */
class RawNumber {
  constructor(readonly source: string) {}
  toJSON(): string {
    return `\u0000${this.source}\u0000`;
  }
}

const raw = (source: string) => new RawNumber(source);

/** JSON-Text mit `RawNumber` als unveränderter Zahl. */
export function toAmazonJson(value: unknown): string {
  return JSON.stringify(value).replace(/"\\u0000([-0-9.eE+]+)\\u0000"/g, '$1');
}

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

interface MockCampaign {
  id: string;
  name: string;
  state: string;
  targeting: 'MANUAL' | 'AUTO';
  budget: string;
  portfolioId: string | null;
}

interface MockAdGroup {
  id: string;
  campaignId: string;
  name: string;
  state: string;
  defaultBid: string;
}

interface MockTarget {
  id: string;
  campaignId: string;
  adGroupId: string | null;
  state: string;
  negative: boolean;
  targetType: string;
  details: Record<string, unknown>;
  bid: string | null;
}

interface MockAd {
  id: string;
  campaignId: string;
  adGroupId: string;
  state: string;
  asin: string;
}

interface MockAccount {
  profile: MockProfile;
  portfolios: Array<{ id: string; name: string; budget: string | null; policy: string }>;
  campaigns: MockCampaign[];
  adGroups: MockAdGroup[];
  targets: MockTarget[];
  ads: MockAd[];
}

/**
 * Konto eines Profils. IDs sind die Profil-ID mit angehängter Nummer; beim DE-Profil (9007199254740993)
 * liegen sie damit über `MAX_SAFE_INTEGER`.
 */
export function mockAccount(profile: MockProfile): MockAccount {
  const id = (n: number) => `${profile.amazonProfileId}${String(n).padStart(3, '0')}`;
  const campaigns: MockCampaign[] = [
    {
      id: id(101),
      name: 'Mock SP Manuell',
      state: 'ENABLED',
      targeting: 'MANUAL',
      budget: '25.50',
      portfolioId: id(1),
    },
    {
      id: id(102),
      name: 'Mock SP Auto',
      state: 'PAUSED',
      targeting: 'AUTO',
      budget: '10.005',
      portfolioId: null,
    },
    {
      id: id(103),
      name: 'Mock SP Archiv',
      state: 'ARCHIVED',
      targeting: 'MANUAL',
      budget: '5',
      portfolioId: id(2),
    },
  ];
  const adGroups: MockAdGroup[] = [
    {
      id: id(201),
      campaignId: id(101),
      name: 'Mock AG Keywords',
      state: 'ENABLED',
      defaultBid: '0.75',
    },
    {
      id: id(202),
      campaignId: id(101),
      name: 'Mock AG Produkte',
      state: 'ENABLED',
      defaultBid: '0.3333333333',
    },
    {
      id: id(203),
      campaignId: id(102),
      name: 'Mock AG Auto',
      state: 'ENABLED',
      defaultBid: '0.30',
    },
    {
      id: id(204),
      campaignId: id(103),
      name: 'Mock AG Archiv',
      state: 'ARCHIVED',
      defaultBid: '1',
    },
  ];
  const targets: MockTarget[] = [
    {
      id: id(301),
      campaignId: id(101),
      adGroupId: id(201),
      state: 'ENABLED',
      negative: false,
      targetType: 'KEYWORD',
      details: { matchType: 'EXACT', keyword: 'mock laufschuhe' },
      bid: '1.23456',
    },
    {
      id: id(302),
      campaignId: id(101),
      adGroupId: id(201),
      state: 'PAUSED',
      negative: false,
      targetType: 'KEYWORD',
      details: { matchType: 'PHRASE', keyword: 'mock sportschuhe' },
      bid: '0.85',
    },
    {
      id: id(303),
      campaignId: id(101),
      adGroupId: id(202),
      state: 'ENABLED',
      negative: false,
      targetType: 'PRODUCT',
      details: { matchType: 'PRODUCT_EXACT', asin: 'B0MOCK0001' },
      bid: '0.5',
    },
    {
      id: id(304),
      campaignId: id(102),
      adGroupId: id(203),
      state: 'ENABLED',
      negative: false,
      targetType: 'AUTO',
      details: { matchType: 'SEARCH_LOOSE_MATCH' },
      bid: '0.3',
    },
    {
      id: id(305),
      campaignId: id(103),
      adGroupId: id(204),
      state: 'ARCHIVED',
      negative: false,
      targetType: 'KEYWORD',
      details: { matchType: 'BROAD', keyword: 'mock alt' },
      bid: '0.4',
    },
    {
      id: id(351),
      campaignId: id(101),
      adGroupId: id(201),
      state: 'ENABLED',
      negative: true,
      targetType: 'KEYWORD',
      details: { matchType: 'EXACT', keyword: 'mock gratis' },
      bid: null,
    },
    {
      id: id(352),
      campaignId: id(101),
      adGroupId: null,
      state: 'ENABLED',
      negative: true,
      targetType: 'PRODUCT',
      details: { matchType: 'PRODUCT_EXACT', asin: 'B0MOCKFREMD' },
      bid: null,
    },
  ];
  const ads: MockAd[] = [
    { id: id(401), campaignId: id(101), adGroupId: id(201), state: 'ENABLED', asin: 'B0MOCK0001' },
    { id: id(402), campaignId: id(101), adGroupId: id(202), state: 'ENABLED', asin: 'B0MOCK0002' },
    { id: id(403), campaignId: id(102), adGroupId: id(203), state: 'ENABLED', asin: 'B0MOCK0003' },
    { id: id(404), campaignId: id(103), adGroupId: id(204), state: 'ARCHIVED', asin: 'B0MOCK0004' },
  ];
  return {
    profile,
    portfolios: [
      {
        id: id(1),
        name: 'Mock Portfolio Marke A',
        budget: '1234.56789012345678',
        policy: 'DATE_RANGE',
      },
      { id: id(2), name: 'Mock Portfolio Marke B', budget: '500', policy: 'MONTHLY_RECURRING' },
      { id: id(3), name: 'Mock Portfolio ohne Budget', budget: null, policy: 'NO_CAP' },
    ],
    campaigns,
    adGroups,
    targets,
    ads,
  };
}

const TIMESTAMP = '2026-09-01T08:00:00.000Z';

export function mockPortfolios(account: MockAccount): unknown[] {
  return account.portfolios.map((portfolio) => ({
    portfolioId: raw(portfolio.id),
    name: portfolio.name,
    state: 'ENABLED',
    inBudget: true,
    budget: {
      amount: portfolio.budget === null ? null : raw(portfolio.budget),
      currencyCode: account.profile.currencyCode,
      policy: portfolio.policy,
      ...(portfolio.policy === 'DATE_RANGE' && { startDate: '2026-09-01', endDate: '2026-12-31' }),
    },
    extendedData: {
      servingStatus: 'PORTFOLIO_STATUS_ENABLED',
      lastUpdateDateTime: TIMESTAMP,
      creationDateTime: TIMESTAMP,
    },
  }));
}

/** Zeilen eines Exports wie im gemeinsamen Modell von Amazon (nur SP, gefiltert nach Zustand). */
export function mockExportRows(
  account: MockAccount,
  exportType: AmazonAdsExportType,
  filter: { adProducts: readonly string[]; states: readonly string[] },
): unknown[] {
  if (!filter.adProducts.includes('SPONSORED_PRODUCTS')) return [];
  const currencyCode = account.profile.currencyCode;
  const common = (state: string) => ({
    adProduct: 'SPONSORED_PRODUCTS',
    state,
    deliveryStatus: state === 'ENABLED' ? 'DELIVERING' : 'NOT_DELIVERING',
    creationDateTime: TIMESTAMP,
    lastUpdatedDateTime: TIMESTAMP,
  });
  const rows: Array<{ state: string } & Record<string, unknown>> = [];
  switch (exportType) {
    case 'campaigns':
      for (const c of account.campaigns) {
        rows.push({
          campaignId: raw(c.id),
          ...(c.portfolioId && { portfolioId: c.portfolioId }),
          name: c.name,
          startDate: '2026-01-15',
          targetingSettings: c.targeting,
          optimization: {
            bidStrategy: 'SALES_DOWN_ONLY',
            placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: 25 }],
          },
          budgetCaps: {
            recurrenceTimePeriod: 'DAILY',
            budgetType: 'MONETARY',
            budgetValue: { monetaryBudget: { currencyCode, amount: raw(c.budget) } },
          },
          ...common(c.state),
        });
      }
      break;
    case 'adGroups':
      for (const g of account.adGroups) {
        rows.push({
          adGroupId: raw(g.id),
          campaignId: raw(g.campaignId),
          name: g.name,
          bid: { defaultBid: raw(g.defaultBid), currencyCode },
          ...common(g.state),
        });
      }
      break;
    case 'targets':
      for (const t of account.targets) {
        rows.push({
          targetId: raw(t.id),
          campaignId: raw(t.campaignId),
          ...(t.adGroupId && { adGroupId: raw(t.adGroupId) }),
          negative: t.negative,
          targetType: t.targetType,
          targetDetails: t.details,
          ...(t.bid && { bid: { bid: raw(t.bid), currencyCode } }),
          ...common(t.state),
        });
      }
      break;
    case 'ads':
      for (const ad of account.ads) {
        const products: Array<{ productIdType: string; productId: string }> = [
          { productIdType: 'ASIN', productId: ad.asin },
        ];
        if (account.profile.accountType !== 'vendor') {
          products.push({ productIdType: 'SKU', productId: `MOCK-SKU-${ad.asin.slice(-4)}` });
        }
        rows.push({
          adId: raw(ad.id),
          adGroupId: raw(ad.adGroupId),
          adType: 'PRODUCT_AD',
          creative: { products },
          ...common(ad.state),
        });
      }
      break;
  }
  return rows.filter((row) => filter.states.includes(row.state));
}

// ---------------------------------------------------------------------------
// Kennzahlen
// ---------------------------------------------------------------------------

/** Kennzahlen eines Tages in ganzen Einheiten (Beträge in Tausendsteln), damit Summen exakt bleiben. */
interface MockMetrics {
  impressions: number;
  clicks: number;
  costMilli: number;
  sales7dMilli: number;
  sales14dMilli: number;
  purchases7d: number;
  purchases14d: number;
  units7d: number;
  units14d: number;
}

/** FNV-1a: stabile Pseudo-Zufallszahl aus Text. */
function hash(text: string): number {
  let value = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    value ^= text.charCodeAt(i);
    value = Math.imul(value, 0x01000193) >>> 0;
  }
  return value;
}

/** Kennzahlen einer Entity an einem Tag; `null` = keine Aktivität (Amazon liefert dann keine Zeile). */
function metricsFor(key: string, date: string): MockMetrics | null {
  const seed = hash(`${key}|${date}`);
  if (seed % 7 === 0) return null;
  const clicks = seed % 23;
  const purchases7d = clicks > 4 ? seed % 3 : 0;
  return {
    impressions: 150 + (seed % 2400),
    clicks,
    costMilli: clicks * (180 + (seed % 900)) + (seed % 11),
    sales7dMilli: purchases7d * 24_990,
    sales14dMilli: (purchases7d + (seed % 2)) * 24_990,
    purchases7d,
    purchases14d: purchases7d + (seed % 2),
    units7d: purchases7d,
    units14d: purchases7d + (seed % 2),
  };
}

function addMetrics(a: MockMetrics, b: MockMetrics): MockMetrics {
  return {
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    costMilli: a.costMilli + b.costMilli,
    sales7dMilli: a.sales7dMilli + b.sales7dMilli,
    sales14dMilli: a.sales14dMilli + b.sales14dMilli,
    purchases7d: a.purchases7d + b.purchases7d,
    purchases14d: a.purchases14d + b.purchases14d,
    units7d: a.units7d + b.units7d,
    units14d: a.units14d + b.units14d,
  };
}

/** Tausendstel als Dezimalzahl ohne Umweg über `number` (z. B. 5 → `0.005`). */
function milli(value: number): RawNumber {
  const whole = Math.floor(value / 1000);
  const fraction = String(value % 1000).padStart(3, '0');
  return raw(`${whole}.${fraction}`);
}

function metricColumns(m: MockMetrics): Record<string, unknown> {
  return {
    impressions: m.impressions,
    clicks: m.clicks,
    cost: milli(m.costMilli),
    sales7d: milli(m.sales7dMilli),
    sales14d: milli(m.sales14dMilli),
    attributedSalesSameSku7d: milli(m.sales7dMilli),
    attributedSalesSameSku14d: milli(m.sales14dMilli),
    purchases7d: m.purchases7d,
    purchases14d: m.purchases14d,
    purchasesSameSku7d: m.purchases7d,
    purchasesSameSku14d: m.purchases14d,
    unitsSoldClicks7d: m.units7d,
    unitsSoldClicks14d: m.units14d,
    unitsSoldSameSku7d: m.units7d,
    unitsSoldSameSku14d: m.units14d,
  };
}

function daysBetween(startDate: string, endDate: string): string[] {
  const days: string[] = [];
  for (
    let day = Date.parse(`${startDate}T00:00:00Z`);
    day <= Date.parse(`${endDate}T00:00:00Z`);
    day += 24 * 60 * 60 * 1000
  ) {
    days.push(new Date(day).toISOString().slice(0, 10));
  }
  return days;
}

/**
 * Ad-Group-Kennzahlen eines Tages. Am ersten Tag des Zeitraums hat die erste Ad Group feste Werte
 * (`0.005` Kosten, `1234567.89` Umsatz), damit exakte Beträge im Demo-Betrieb sichtbar geprüft werden.
 */
function adGroupMetrics(account: MockAccount, adGroupId: string, date: string, first: boolean) {
  if (first && adGroupId === account.adGroups[0]?.id) {
    return {
      ...(metricsFor(adGroupId, date) ?? metricsFor(adGroupId, `${date}+`)!),
      costMilli: 5,
      sales7dMilli: 1_234_567_890,
    };
  }
  return metricsFor(adGroupId, date);
}

/** Zeilen eines Reports wie von Amazon (nur Tage mit Aktivität). */
export function mockReportRows(
  account: MockAccount,
  reportType: AmazonAdsReportType,
  startDate: string,
  endDate: string,
): unknown[] {
  const rows: unknown[] = [];
  const days = daysBetween(startDate, endDate);
  const campaignName = new Map(account.campaigns.map((c) => [c.id, c.name]));
  const adGroupName = new Map(account.adGroups.map((g) => [g.id, g.name]));
  const level = REPORT_DEFINITIONS[reportType].level;

  for (const [index, date] of days.entries()) {
    const first = index === 0;
    switch (level) {
      case 'campaign':
        for (const campaign of account.campaigns) {
          const parts = account.adGroups
            .filter((g) => g.campaignId === campaign.id)
            .map((g) => adGroupMetrics(account, g.id, date, first))
            .filter((m): m is MockMetrics => m !== null);
          if (parts.length === 0) continue;
          rows.push({
            date,
            campaignId: raw(campaign.id),
            campaignName: campaign.name,
            ...metricColumns(parts.reduce(addMetrics)),
          });
        }
        break;
      case 'adGroup':
        for (const group of account.adGroups) {
          const metrics = adGroupMetrics(account, group.id, date, first);
          if (!metrics) continue;
          rows.push({
            date,
            campaignId: raw(group.campaignId),
            campaignName: campaignName.get(group.campaignId),
            adGroupId: raw(group.id),
            adGroupName: group.name,
            ...metricColumns(metrics),
          });
        }
        break;
      case 'target':
      case 'searchTerm':
        for (const target of account.targets) {
          if (target.negative || !target.adGroupId) continue;
          const base = {
            date,
            campaignId: raw(target.campaignId),
            campaignName: campaignName.get(target.campaignId),
            adGroupId: raw(target.adGroupId),
            adGroupName: adGroupName.get(target.adGroupId),
            keywordId: raw(target.id),
          };
          if (level === 'target') {
            const metrics = metricsFor(target.id, date);
            if (metrics) rows.push({ ...base, ...metricColumns(metrics) });
            continue;
          }
          for (const term of ['mock suchbegriff eins', 'mock suchbegriff zwei']) {
            const metrics = metricsFor(`${target.id}|${term}`, date);
            if (metrics) rows.push({ ...base, searchTerm: term, ...metricColumns(metrics) });
          }
        }
        break;
      case 'productAd':
        for (const ad of account.ads) {
          const metrics = metricsFor(ad.id, date);
          if (!metrics) continue;
          rows.push({
            date,
            campaignId: raw(ad.campaignId),
            campaignName: campaignName.get(ad.campaignId),
            adGroupId: raw(ad.adGroupId),
            adGroupName: adGroupName.get(ad.adGroupId),
            adId: raw(ad.id),
            advertisedAsin: ad.asin,
            ...(account.profile.accountType !== 'vendor' && {
              advertisedSku: `MOCK-SKU-${ad.asin.slice(-4)}`,
            }),
            ...metricColumns(metrics),
          });
        }
        break;
    }
  }
  return rows;
}
