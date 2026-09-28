import type { AmazonAdsExportType } from './exports';
import { REPORT_DEFINITIONS, type AmazonAdsReportType } from './reports';

/**
 * Synthetische Werbedaten für den Mock-Anbieter (SP, SB, SD): Entities je Profil und Tageskennzahlen je Ebene.
 * Deterministisch (gleiche Eingabe, gleiche Datei), damit ein zweiter Sync nichts ändert.
 *
 * Abgedeckt: große IDs als JSON-Zahl (über `Number.MAX_SAFE_INTEGER`), Beträge mit vielen Nachkommastellen
 * (auch als JSON-Zahl), eine archivierte Kampagne, Negatives auf Kampagnen- und Ad-Group-Ebene, Vendoren ohne
 * SKU, Tage ohne Aktivität (fehlen im Report). Kampagnen-Kennzahlen sind die Summe ihrer Ad Groups; Targets,
 * Product Ads und Suchbegriffe sind unabhängige Aufteilungen (Summen stimmen dort nicht überein).
 *
 * SB (1.9) nur für das DE-Profil (die übrigen nutzen SB nicht): Keyword-, Themen- und Produkt-Targets, ein
 * Negative, ein Video-Ad mit einem und ein Kollektions-Ad mit drei ASINs. SB-Reports liefern Klick + View
 * (`sales` …) und den Klick-Anteil (`salesClicks` …); Report-Zeilen enthalten nur die angeforderten Spalten.
 *
 * SD (1.9) ebenfalls nur für das DE-Profil: eine vCPM-Kampagne mit Zielgruppe (Taktik `T00030`) und eine
 * CPC-Kampagne mit Produkt- und Kategorie-Target (`T00020`), ein Negative, ein Product-Ad nur mit SKU (wie
 * bei Sellern) und ein Bild-Ad mit zwei ASINs. SD-Reports wie SB, dazu Same-SKU nach Klick und sichtbare
 * Impressionen; `sdTargeting` nennt alle Targets per `targetingId`, `sdAdvertisedProduct` ASIN und SKU.
 */

const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const SD = 'SPONSORED_DISPLAY';
/** Profile mit SB-Kampagnen. */
const BRANDS_PROFILE_IDS: ReadonlySet<string> = new Set(['9007199254740993']);
/** Profile mit SD-Kampagnen. */
const DISPLAY_PROFILE_IDS: ReadonlySet<string> = new Set(['9007199254740993']);

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

export interface MockCampaign {
  id: string;
  adProduct: string;
  name: string;
  state: string;
  /** SP: `MANUAL` | `AUTO`; SD: Taktik (`T00020`, `T00030`); SB: ohne Bedeutung. */
  targeting: string;
  /** SB/SD: `CPC` | `VCPM`. */
  costType?: string;
  budget: string;
  portfolioId: string | null;
  /** SB ohne Multi-Ad-Group (v3-Preview-Lücke): Entities im Export, aber keine Report-Zeilen. */
  withoutReports?: boolean;
}

export interface MockAdGroup {
  id: string;
  campaignId: string;
  name: string;
  state: string;
  /** SB-Ad-Groups haben kein Standardgebot (Gebote an den Targets). */
  defaultBid: string | null;
}

export interface MockTarget {
  id: string;
  campaignId: string;
  adGroupId: string | null;
  state: string;
  negative: boolean;
  targetType: string;
  details: Record<string, unknown>;
  bid: string | null;
  /** Suchbegriffe im Report; ohne Angabe zwei feste Mock-Begriffe. */
  searchTerms?: readonly string[];
}

export interface MockAd {
  id: string;
  campaignId: string;
  adGroupId: string;
  state: string;
  adType: string;
  asins: string[];
  /** SKU bei Sellern; ohne Angabe aus der ersten ASIN abgeleitet. */
  sku?: string;
}

export interface MockAccount {
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
      adProduct: SP,
      name: 'Mock SP Manuell',
      state: 'ENABLED',
      targeting: 'MANUAL',
      budget: '25.50',
      portfolioId: id(1),
    },
    {
      id: id(102),
      adProduct: SP,
      name: 'Mock SP Auto',
      state: 'PAUSED',
      targeting: 'AUTO',
      budget: '10.005',
      portfolioId: null,
    },
    {
      id: id(103),
      adProduct: SP,
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
  const productAd = (n: number, campaign: number, adGroup: number, state: string): MockAd => ({
    id: id(n),
    campaignId: id(campaign),
    adGroupId: id(adGroup),
    state,
    adType: 'PRODUCT_AD',
    asins: [`B0MOCK000${n - 400}`],
  });
  const ads: MockAd[] = [
    productAd(401, 101, 201, 'ENABLED'),
    productAd(402, 101, 202, 'ENABLED'),
    productAd(403, 102, 203, 'ENABLED'),
    productAd(404, 103, 204, 'ARCHIVED'),
  ];
  if (BRANDS_PROFILE_IDS.has(profile.amazonProfileId)) {
    campaigns.push(
      {
        id: id(501),
        adProduct: SB,
        name: 'Mock SB Video',
        state: 'ENABLED',
        targeting: 'MANUAL',
        budget: '15.75',
        portfolioId: id(1),
      },
      {
        id: id(502),
        adProduct: SB,
        name: 'Mock SB Kollektion',
        state: 'PAUSED',
        targeting: 'MANUAL',
        budget: '8.125',
        portfolioId: null,
      },
    );
    adGroups.push(
      {
        id: id(601),
        campaignId: id(501),
        name: 'Mock SB AG Video',
        state: 'ENABLED',
        defaultBid: null,
      },
      {
        id: id(602),
        campaignId: id(502),
        name: 'Mock SB AG Kollektion',
        state: 'ENABLED',
        defaultBid: null,
      },
    );
    targets.push(
      {
        id: id(701),
        campaignId: id(501),
        adGroupId: id(601),
        state: 'ENABLED',
        negative: false,
        targetType: 'KEYWORD',
        details: { matchType: 'BROAD', keyword: 'mock marke schuhe' },
        bid: '1.05',
      },
      {
        id: id(702),
        campaignId: id(501),
        adGroupId: id(601),
        state: 'ENABLED',
        negative: false,
        targetType: 'THEME',
        details: { matchType: 'KEYWORDS_RELATED_TO_YOUR_BRAND' },
        bid: '0.9',
      },
      {
        id: id(703),
        campaignId: id(502),
        adGroupId: id(602),
        state: 'ENABLED',
        negative: false,
        targetType: 'PRODUCT',
        details: { matchType: 'PRODUCT_EXACT', asin: 'B0MOCKFREMD' },
        bid: '0.65',
      },
      {
        id: id(751),
        campaignId: id(501),
        adGroupId: id(601),
        state: 'ENABLED',
        negative: true,
        targetType: 'KEYWORD',
        details: { matchType: 'EXACT', keyword: 'mock billig' },
        bid: null,
      },
    );
    ads.push(
      {
        id: id(801),
        campaignId: id(501),
        adGroupId: id(601),
        state: 'ENABLED',
        adType: 'VIDEO',
        asins: ['B0MOCK0001'],
      },
      {
        id: id(802),
        campaignId: id(502),
        adGroupId: id(602),
        state: 'ENABLED',
        adType: 'PRODUCT_COLLECTION',
        asins: ['B0MOCK0001', 'B0MOCK0002', 'B0MOCK0003'],
      },
    );
  }
  if (DISPLAY_PROFILE_IDS.has(profile.amazonProfileId)) {
    campaigns.push(
      {
        id: id(901),
        adProduct: SD,
        name: 'Mock SD Zielgruppen',
        state: 'ENABLED',
        targeting: 'T00030',
        costType: 'VCPM',
        budget: '20.005',
        portfolioId: null,
      },
      {
        id: id(902),
        adProduct: SD,
        name: 'Mock SD Produkte',
        state: 'ENABLED',
        targeting: 'T00020',
        costType: 'CPC',
        budget: '7.5',
        portfolioId: id(2),
      },
    );
    adGroups.push(
      {
        id: id(911),
        campaignId: id(901),
        name: 'Mock SD AG Zielgruppe',
        state: 'ENABLED',
        defaultBid: '4.25',
      },
      {
        id: id(912),
        campaignId: id(902),
        name: 'Mock SD AG Produkte',
        state: 'ENABLED',
        defaultBid: '0.55',
      },
    );
    targets.push(
      {
        id: id(951),
        campaignId: id(901),
        adGroupId: id(911),
        state: 'ENABLED',
        negative: false,
        targetType: 'AUDIENCE',
        details: { event: 'VIEWS', lookback: 30 },
        bid: null,
      },
      {
        id: id(952),
        campaignId: id(902),
        adGroupId: id(912),
        state: 'ENABLED',
        negative: false,
        targetType: 'PRODUCT',
        details: { matchType: 'PRODUCT_EXACT', asin: 'B0MOCKFREMD' },
        bid: '0.6',
      },
      {
        id: id(953),
        campaignId: id(902),
        adGroupId: id(912),
        state: 'PAUSED',
        negative: false,
        targetType: 'PRODUCT_CATEGORY',
        details: { productCategoryId: '12345678901', productCategoryResolved: 'Mock Schuhe' },
        bid: '0.45',
      },
      {
        id: id(961),
        campaignId: id(902),
        adGroupId: id(912),
        state: 'ENABLED',
        negative: true,
        targetType: 'PRODUCT',
        details: { matchType: 'PRODUCT_EXACT', asin: 'B0MOCK0003' },
        bid: null,
      },
    );
    ads.push(
      {
        id: id(971),
        campaignId: id(901),
        adGroupId: id(911),
        state: 'ENABLED',
        adType: 'PRODUCT_AD',
        asins: ['B0MOCK0001'],
      },
      {
        id: id(972),
        campaignId: id(902),
        adGroupId: id(912),
        state: 'ENABLED',
        adType: 'IMAGE',
        asins: ['B0MOCK0002', 'B0MOCK0003'],
      },
    );
  }
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

/** Ad-Typ je Kampagne (Ad Groups, Targets und Ads gehören über ihre Kampagne dazu). */
function adProductOf(account: MockAccount): (campaignId: string) => string {
  const byCampaign = new Map(account.campaigns.map((c) => [c.id, c.adProduct]));
  return (campaignId) => byCampaign.get(campaignId) ?? SP;
}

/** Zeilen eines Exports wie im gemeinsamen Modell von Amazon (gefiltert nach Ad-Typ und Zustand). */
export function mockExportRows(
  account: MockAccount,
  exportType: AmazonAdsExportType,
  filter: { adProducts: readonly string[]; states: readonly string[] },
): unknown[] {
  const currencyCode = account.profile.currencyCode;
  const adProductOfCampaign = adProductOf(account);
  const common = (campaignId: string, state: string) => ({
    adProduct: adProductOfCampaign(campaignId),
    state,
    deliveryStatus: state === 'ENABLED' ? 'DELIVERING' : 'NOT_DELIVERING',
    creationDateTime: TIMESTAMP,
    lastUpdatedDateTime: TIMESTAMP,
  });
  const rows: Array<{ adProduct: string; state: string } & Record<string, unknown>> = [];
  switch (exportType) {
    case 'campaigns':
      for (const c of account.campaigns) {
        rows.push({
          campaignId: raw(c.id),
          ...(c.portfolioId && { portfolioId: c.portfolioId }),
          name: c.name,
          startDate: '2026-01-15',
          ...(c.adProduct === SP && {
            targetingSettings: c.targeting,
            optimization: {
              bidStrategy: 'SALES_DOWN_ONLY',
              placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: 25 }],
            },
          }),
          ...(c.adProduct === SB && { costType: 'CPC', brandEntityId: 'ENTITYMOCKBRAND01' }),
          // SD: Taktik in `targetingSettings` (gemeinsames Modell), Kostenart CPC oder vCPM.
          ...(c.adProduct === SD && { targetingSettings: c.targeting, costType: c.costType }),
          budgetCaps: {
            recurrenceTimePeriod: 'DAILY',
            budgetType: 'MONETARY',
            budgetValue: { monetaryBudget: { currencyCode, amount: raw(c.budget) } },
          },
          ...common(c.id, c.state),
        });
      }
      break;
    case 'adGroups':
      for (const g of account.adGroups) {
        rows.push({
          adGroupId: raw(g.id),
          campaignId: raw(g.campaignId),
          name: g.name,
          ...(g.defaultBid !== null && { bid: { defaultBid: raw(g.defaultBid), currencyCode } }),
          ...common(g.campaignId, g.state),
        });
      }
      break;
    case 'targets':
      for (const t of account.targets) {
        const adProduct = adProductOfCampaign(t.campaignId);
        rows.push({
          targetId: raw(t.id),
          // SP-Targets tragen die Kampagne, SB- und SD-Targets nicht (gemeinsames Modell).
          ...(adProduct === SP && { campaignId: raw(t.campaignId) }),
          ...(t.adGroupId && { adGroupId: raw(t.adGroupId) }),
          negative: t.negative,
          targetType: t.targetType,
          targetDetails: t.details,
          ...(t.bid && { bid: { bid: raw(t.bid), currencyCode } }),
          ...common(t.campaignId, t.state),
        });
      }
      break;
    case 'ads':
      for (const ad of account.ads) {
        const seller = account.profile.accountType !== 'vendor';
        // SD-Product-Ads nennen bei Sellern nur die SKU (ASIN oder SKU laut gemeinsamem Modell).
        const skuOnly =
          seller && ad.adType === 'PRODUCT_AD' && adProductOfCampaign(ad.campaignId) === SD;
        const products: Array<{ productIdType: string; productId: string }> = skuOnly
          ? []
          : ad.asins.map((asin) => ({ productIdType: 'ASIN', productId: asin }));
        if (ad.adType === 'PRODUCT_AD' && seller) {
          products.push({ productIdType: 'SKU', productId: mockSku(ad) });
        }
        rows.push({
          adId: raw(ad.id),
          adGroupId: raw(ad.adGroupId),
          adType: ad.adType,
          ...(ad.adType !== 'PRODUCT_AD' && { name: `Mock ${ad.adType}` }),
          creative: { products },
          ...common(ad.campaignId, ad.state),
        });
      }
      break;
  }
  return rows.filter(
    (row) => filter.adProducts.includes(row.adProduct) && filter.states.includes(row.state),
  );
}

const mockSku = (ad: MockAd) => ad.sku ?? `MOCK-SKU-${ad.asins[0]!.slice(-4)}`;

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
  /** Zusätzliche Käufe nach einem View (nur SB/SD: `purchases` = Klick + View). */
  viewPurchases: number;
  /** Sichtbare Impressionen (nur SD), höchstens `impressions`. */
  viewableImpressions: number;
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
  const impressions = 150 + (seed % 2400);
  return {
    impressions,
    clicks,
    costMilli: clicks * (180 + (seed % 900)) + (seed % 11),
    sales7dMilli: purchases7d * 24_990,
    sales14dMilli: (purchases7d + (seed % 2)) * 24_990,
    purchases7d,
    purchases14d: purchases7d + (seed % 2),
    units7d: purchases7d,
    units14d: purchases7d + (seed % 2),
    viewPurchases: (seed >>> 3) % 3 === 0 ? 1 : 0,
    viewableImpressions: Math.floor((impressions * (40 + ((seed >>> 5) % 50))) / 100),
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
    viewPurchases: a.viewPurchases + b.viewPurchases,
    viewableImpressions: a.viewableImpressions + b.viewableImpressions,
  };
}

/** Tausendstel als Dezimalzahl ohne Umweg über `number` (z. B. 5 → `0.005`). */
function milli(value: number): RawNumber {
  const whole = Math.floor(value / 1000);
  const fraction = String(value % 1000).padStart(3, '0');
  return raw(`${whole}.${fraction}`);
}

/** Spalten je Ad-Typ; `mockReportRows` behält davon nur die angeforderten. */
function metricColumns(adProduct: string, m: MockMetrics): Record<string, unknown> {
  if (adProduct === SD) {
    // Wie SB, Same-SKU aber nur nach Klick (Teilmenge des Klick-Anteils); dazu sichtbare Impressionen.
    const viewSalesMilli = m.viewPurchases * 24_990;
    return {
      impressions: m.impressions,
      clicks: m.clicks,
      cost: milli(m.costMilli),
      impressionsViews: m.viewableImpressions,
      sales: milli(m.sales14dMilli + viewSalesMilli),
      salesClicks: milli(m.sales14dMilli),
      salesPromotedClicks: milli(m.sales7dMilli),
      purchases: m.purchases14d + m.viewPurchases,
      purchasesClicks: m.purchases14d,
      purchasesPromotedClicks: m.purchases7d,
      unitsSold: m.units14d + m.viewPurchases,
      unitsSoldClicks: m.units14d,
    };
  }
  if (adProduct === SB) {
    // Ein Fenster (14 Tage): Klick + View ohne Suffix, der Klick-Anteil in `…Clicks`.
    const viewSalesMilli = m.viewPurchases * 24_990;
    return {
      impressions: m.impressions,
      clicks: m.clicks,
      cost: milli(m.costMilli),
      sales: milli(m.sales14dMilli + viewSalesMilli),
      salesClicks: milli(m.sales14dMilli),
      salesPromoted: milli(m.sales14dMilli + viewSalesMilli),
      purchases: m.purchases14d + m.viewPurchases,
      purchasesClicks: m.purchases14d,
      purchasesPromoted: m.purchases14d + m.viewPurchases,
      unitsSold: m.units14d + m.viewPurchases,
      unitsSoldClicks: m.units14d,
    };
  }
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

/** Zeilen eines Reports wie von Amazon: nur Tage mit Aktivität, nur die angeforderten Spalten. */
export function mockReportRows(
  account: MockAccount,
  reportType: AmazonAdsReportType,
  startDate: string,
  endDate: string,
): unknown[] {
  const rows: Array<Record<string, unknown>> = [];
  const days = daysBetween(startDate, endDate);
  const { adProduct, level, columns } = REPORT_DEFINITIONS[reportType];
  const adProductOfCampaign = adProductOf(account);
  const unreported = new Set(account.campaigns.filter((c) => c.withoutReports).map((c) => c.id));
  const ofAdProduct = <T extends { campaignId: string }>(entities: readonly T[]) =>
    entities.filter(
      (entity) =>
        adProductOfCampaign(entity.campaignId) === adProduct && !unreported.has(entity.campaignId),
    );
  const campaigns = account.campaigns.filter((c) => c.adProduct === adProduct && !c.withoutReports);
  const adGroups = ofAdProduct(account.adGroups);
  const campaignName = new Map(account.campaigns.map((c) => [c.id, c.name]));
  const adGroupName = new Map(account.adGroups.map((g) => [g.id, g.name]));
  const values = (m: MockMetrics) => metricColumns(adProduct, m);

  for (const [index, date] of days.entries()) {
    const first = index === 0;
    switch (level) {
      case 'campaign':
        for (const campaign of campaigns) {
          const parts = adGroups
            .filter((g) => g.campaignId === campaign.id)
            .map((g) => adGroupMetrics(account, g.id, date, first))
            .filter((m): m is MockMetrics => m !== null);
          if (parts.length === 0) continue;
          rows.push({
            date,
            campaignId: raw(campaign.id),
            campaignName: campaign.name,
            ...values(parts.reduce(addMetrics)),
          });
        }
        break;
      case 'adGroup':
        for (const group of adGroups) {
          const metrics = adGroupMetrics(account, group.id, date, first);
          if (!metrics) continue;
          rows.push({
            date,
            campaignId: raw(group.campaignId),
            campaignName: campaignName.get(group.campaignId),
            adGroupId: raw(group.id),
            adGroupName: group.name,
            ...values(metrics),
          });
        }
        break;
      case 'target':
      case 'searchTerm':
        for (const target of ofAdProduct(account.targets)) {
          if (target.negative || !target.adGroupId) continue;
          // SB-Targeting: Keywords über `keywordId`, Themen und Produkte über `targetingId`; SD kennt nur
          // `targetingId`.
          const idColumn =
            level === 'target' &&
            (adProduct === SD || (adProduct === SB && target.targetType !== 'KEYWORD'))
              ? 'targetingId'
              : 'keywordId';
          const base = {
            date,
            campaignId: raw(target.campaignId),
            campaignName: campaignName.get(target.campaignId),
            adGroupId: raw(target.adGroupId),
            adGroupName: adGroupName.get(target.adGroupId),
            [idColumn]: raw(target.id),
          };
          if (level === 'target') {
            const metrics = metricsFor(target.id, date);
            if (metrics) rows.push({ ...base, ...values(metrics) });
            continue;
          }
          for (const term of target.searchTerms ?? [
            'mock suchbegriff eins',
            'mock suchbegriff zwei',
          ]) {
            const metrics = metricsFor(`${target.id}|${term}`, date);
            if (metrics) rows.push({ ...base, searchTerm: term, ...values(metrics) });
          }
        }
        break;
      case 'productAd':
        for (const ad of ofAdProduct(account.ads)) {
          const metrics = metricsFor(ad.id, date);
          if (!metrics) continue;
          rows.push({
            date,
            campaignId: raw(ad.campaignId),
            campaignName: campaignName.get(ad.campaignId),
            adGroupId: raw(ad.adGroupId),
            adGroupName: adGroupName.get(ad.adGroupId),
            adId: raw(ad.id),
            // SD heißt `promoted…`, SP `advertised…`; je Ad eine Zeile mit dem ersten Produkt.
            [adProduct === SD ? 'promotedAsin' : 'advertisedAsin']: ad.asins[0],
            ...(account.profile.accountType !== 'vendor' && {
              [adProduct === SD ? 'promotedSku' : 'advertisedSku']: mockSku(ad),
            }),
            ...values(metrics),
          });
        }
        break;
    }
  }
  const requested = new Set<string>(columns);
  return rows.map((row) =>
    Object.fromEntries(Object.entries(row).filter(([key]) => requested.has(key))),
  );
}
