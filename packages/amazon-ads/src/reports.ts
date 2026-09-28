import { z } from 'zod';
import type { ConnectionRef } from './access-token';
import type { AmazonAdsAsyncStatus } from './async-status';
import type { AdsEndpointDeps, RequestOptions } from './client';
import { AmazonAdsDuplicateReportError, AmazonAdsHttpError } from './errors';
import { amazonDecimalSchema } from './money';
import { createUnknownValueReporter } from './normalize';
import { amazonIdSchema } from './profiles';

/**
 * Reporting v3 (Kennzahlen, ADR 004). Geprüft am 2026-09-27 gegen Guide und OpenAPI-Spec
 * (`OfflineReport_prod_3p.json`):
 * - `POST /reporting/reports` mit `Content-Type: application/vnd.createasyncreportrequest.v3+json`, Antwort mit
 *   `reportId`. Identische Anfrage, solange die erste läuft: 425 mit `{ code, detail }`.
 * - `GET /reporting/reports/{reportId}`: Status laut Spec `PENDING`/`PROCESSING`/`COMPLETED`/`FAILED` (der Guide
 *   schreibt `FAILURE`, beides wird erkannt), bei `COMPLETED` eine signierte URL (Standard 1 h gültig).
 * - Höchstens 31 Tage je Anfrage, `timeUnit: DAILY` mit Spalte `date`, Format `GZIP_JSON`.
 * - `Amazon-Ads-AccountId`: laut Spec optional (DSP), laut Guide für alle Ad-Typen „erforderlich“. Wir senden ihn
 *   nicht; beim ersten echten Lauf klären (1.10).
 */

export const REPORT_CREATE_CONTENT_TYPE = 'application/vnd.createasyncreportrequest.v3+json';

/** Höchstens so viele Tage je Report (beide Grenzen eingeschlossen). */
export const MAX_REPORT_DAYS = 31;

/** Ebene der Kennzahlen, wie `replaceDailyMetrics` in `@profitbash/db` sie nimmt. */
export type AmazonAdsMetricsLevel = 'campaign' | 'adGroup' | 'target' | 'productAd' | 'searchTerm';

export interface ReportDefinition {
  adProduct: string;
  level: AmazonAdsMetricsLevel;
  /** Amazons Report-Typ (`reportTypeId`). */
  reportTypeId: string;
  groupBy: readonly string[];
  columns: readonly string[];
  /** So viele Tage hält Amazon die Daten vor (Historie beim ersten Sync, F4). */
  retentionDays: number;
}

/** Attribution nach F7: 7 und 14 Tage, gesamt und „same SKU“. 1 und 30 Tage bewusst nicht. */
const SP_METRIC_COLUMNS = [
  'impressions',
  'clicks',
  'cost',
  'sales7d',
  'sales14d',
  'attributedSalesSameSku7d',
  'attributedSalesSameSku14d',
  'purchases7d',
  'purchases14d',
  'purchasesSameSku7d',
  'purchasesSameSku14d',
  'unitsSoldClicks7d',
  'unitsSoldClicks14d',
  'unitsSoldSameSku7d',
  'unitsSoldSameSku14d',
] as const;

/**
 * SB (1.9): ein Fenster (14 Tage) ohne Suffix. `sales`, `purchases`, `unitsSold` zählen Klicks und Views (wie
 * die Konsole), `…Clicks` nur Klicks; `…Promoted` entspricht laut Doku `…SameSku14d`. Nur Spalten, die auf der
 * Seite des Report-Typs **und** in der Spalten-Referenz stehen (Stand 2026-09-28; eine falsche Spalte ließe
 * jeden Report mit 400 scheitern): `unitsSoldClicks` fehlt deshalb bei `sbTargeting` und `sbSearchTerm`,
 * `…Promoted` bei `sbSearchTerm`.
 */
const SB_METRIC_COLUMNS = [
  'impressions',
  'clicks',
  'cost',
  'sales',
  'salesClicks',
  'purchases',
  'purchasesClicks',
  'unitsSold',
] as const;
const SB_PROMOTED_COLUMNS = ['salesPromoted', 'purchasesPromoted'] as const;
const AD_GROUP_REPORT_COLUMNS = [
  'date',
  'campaignId',
  'campaignName',
  'adGroupId',
  'adGroupName',
] as const;

/**
 * SD (1.9): ein Fenster (14 Tage) ohne Suffix wie SB. `sales`, `purchases`, `unitsSold` zählen Klicks und
 * Views, `…Clicks` nur Klicks, `…PromotedClicks` ist Same-SKU **nur nach Klick** (anders als SB).
 * `impressionsViews` sind die sichtbaren Impressionen (MRC, Basis für vCPM). Alle Spalten stehen auf den
 * Seiten der Report-Typen und in der Spalten-Referenz (Stand 2026-09-28, dort `sdAdGroups` geschrieben).
 */
const SD_METRIC_COLUMNS = [
  'impressions',
  'clicks',
  'cost',
  'sales',
  'salesClicks',
  'salesPromotedClicks',
  'purchases',
  'purchasesClicks',
  'purchasesPromotedClicks',
  'unitsSold',
  'unitsSoldClicks',
  'impressionsViews',
] as const;

/**
 * Report-Typen im eigenen Katalog. Der Schlüssel steht in `amazon_ads_report_requests.report_type` und ist
 * meist Amazons `reportTypeId`; nur `spAdGroups` ist eigener Name für `spCampaigns` mit `groupBy` Ad Group
 * (sonst kollidierten beide Aufträge im Schlüssel des offenen Auftrags).
 */
export const REPORT_DEFINITIONS = {
  spCampaigns: {
    adProduct: 'SPONSORED_PRODUCTS',
    level: 'campaign',
    reportTypeId: 'spCampaigns',
    groupBy: ['campaign'],
    columns: ['date', 'campaignId', 'campaignName', ...SP_METRIC_COLUMNS],
    retentionDays: 95,
  },
  spAdGroups: {
    adProduct: 'SPONSORED_PRODUCTS',
    level: 'adGroup',
    reportTypeId: 'spCampaigns',
    groupBy: ['campaign', 'adGroup'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'adGroupId',
      'adGroupName',
      ...SP_METRIC_COLUMNS,
    ],
    retentionDays: 95,
  },
  spTargeting: {
    adProduct: 'SPONSORED_PRODUCTS',
    level: 'target',
    reportTypeId: 'spTargeting',
    groupBy: ['targeting'],
    // `keywordId` ist in spTargeting die ID von Keywords und Targets (1.10: gegen `targetId` im Export prüfen).
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'adGroupId',
      'adGroupName',
      'keywordId',
      ...SP_METRIC_COLUMNS,
    ],
    retentionDays: 95,
  },
  spAdvertisedProduct: {
    adProduct: 'SPONSORED_PRODUCTS',
    level: 'productAd',
    reportTypeId: 'spAdvertisedProduct',
    groupBy: ['advertiser'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'adGroupId',
      'adGroupName',
      'adId',
      'advertisedAsin',
      'advertisedSku',
      ...SP_METRIC_COLUMNS,
    ],
    retentionDays: 95,
  },
  spSearchTerm: {
    adProduct: 'SPONSORED_PRODUCTS',
    level: 'searchTerm',
    reportTypeId: 'spSearchTerm',
    groupBy: ['searchTerm'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      'adGroupId',
      'adGroupName',
      'keywordId',
      'searchTerm',
      ...SP_METRIC_COLUMNS,
    ],
    // Laut Doku (Stand 2026-09-27) nur 65 Tage, nicht 95 wie die übrigen SP-Reports.
    retentionDays: 65,
  },
  sbCampaigns: {
    adProduct: 'SPONSORED_BRANDS',
    level: 'campaign',
    reportTypeId: 'sbCampaigns',
    groupBy: ['campaign'],
    columns: [
      'date',
      'campaignId',
      'campaignName',
      ...SB_METRIC_COLUMNS,
      'unitsSoldClicks',
      ...SB_PROMOTED_COLUMNS,
    ],
    retentionDays: 60,
  },
  sbAdGroup: {
    adProduct: 'SPONSORED_BRANDS',
    level: 'adGroup',
    reportTypeId: 'sbAdGroup',
    groupBy: ['adGroup'],
    columns: [
      ...AD_GROUP_REPORT_COLUMNS,
      ...SB_METRIC_COLUMNS,
      'unitsSoldClicks',
      ...SB_PROMOTED_COLUMNS,
    ],
    retentionDays: 60,
  },
  sbTargeting: {
    adProduct: 'SPONSORED_BRANDS',
    level: 'target',
    reportTypeId: 'sbTargeting',
    groupBy: ['targeting'],
    // Keywords tragen `keywordId`, Produkt- und Themen-Targets ggf. nur `targetingId` (1.10: gegen den Export prüfen).
    columns: [
      ...AD_GROUP_REPORT_COLUMNS,
      'keywordId',
      'targetingId',
      ...SB_METRIC_COLUMNS,
      ...SB_PROMOTED_COLUMNS,
    ],
    retentionDays: 60,
  },
  sbAds: {
    adProduct: 'SPONSORED_BRANDS',
    level: 'productAd',
    reportTypeId: 'sbAds',
    groupBy: ['ads'],
    columns: [
      ...AD_GROUP_REPORT_COLUMNS,
      'adId',
      ...SB_METRIC_COLUMNS,
      'unitsSoldClicks',
      ...SB_PROMOTED_COLUMNS,
    ],
    retentionDays: 60,
  },
  sbSearchTerm: {
    adProduct: 'SPONSORED_BRANDS',
    level: 'searchTerm',
    reportTypeId: 'sbSearchTerm',
    groupBy: ['searchTerm'],
    columns: [...AD_GROUP_REPORT_COLUMNS, 'keywordId', 'searchTerm', ...SB_METRIC_COLUMNS],
    retentionDays: 60,
  },
  sdCampaigns: {
    adProduct: 'SPONSORED_DISPLAY',
    level: 'campaign',
    reportTypeId: 'sdCampaigns',
    groupBy: ['campaign'],
    columns: ['date', 'campaignId', 'campaignName', ...SD_METRIC_COLUMNS],
    retentionDays: 65,
  },
  sdAdGroup: {
    adProduct: 'SPONSORED_DISPLAY',
    level: 'adGroup',
    reportTypeId: 'sdAdGroup',
    groupBy: ['adGroup'],
    columns: [...AD_GROUP_REPORT_COLUMNS, ...SD_METRIC_COLUMNS],
    retentionDays: 65,
  },
  sdTargeting: {
    adProduct: 'SPONSORED_DISPLAY',
    level: 'target',
    reportTypeId: 'sdTargeting',
    groupBy: ['targeting'],
    // Nur `targetingId` (kein `keywordId`); entspricht der `targetId` im Export (1.10: prüfen).
    columns: [...AD_GROUP_REPORT_COLUMNS, 'targetingId', ...SD_METRIC_COLUMNS],
    retentionDays: 65,
  },
  sdAdvertisedProduct: {
    adProduct: 'SPONSORED_DISPLAY',
    level: 'productAd',
    reportTypeId: 'sdAdvertisedProduct',
    groupBy: ['advertiser'],
    // `promotedAsin`/`promotedSku` statt `advertisedAsin`/`advertisedSku` wie bei SP.
    columns: [
      ...AD_GROUP_REPORT_COLUMNS,
      'adId',
      'promotedAsin',
      'promotedSku',
      ...SD_METRIC_COLUMNS,
    ],
    retentionDays: 65,
  },
} as const satisfies Record<string, ReportDefinition>;

export type AmazonAdsReportType = keyof typeof REPORT_DEFINITIONS;

/** Report-Typen je Ad-Typ in Hierarchie-Reihenfolge. */
export const REPORT_TYPES_BY_AD_PRODUCT = {
  SPONSORED_PRODUCTS: [
    'spCampaigns',
    'spAdGroups',
    'spTargeting',
    'spAdvertisedProduct',
    'spSearchTerm',
  ],
  SPONSORED_BRANDS: ['sbCampaigns', 'sbAdGroup', 'sbTargeting', 'sbAds', 'sbSearchTerm'],
  SPONSORED_DISPLAY: ['sdCampaigns', 'sdAdGroup', 'sdTargeting', 'sdAdvertisedProduct'],
} as const satisfies Record<string, readonly AmazonAdsReportType[]>;

/** Ad-Typen mit Reports im Katalog (Reihenfolge von `REPORT_TYPES_BY_AD_PRODUCT`). */
export const REPORT_AD_PRODUCTS = Object.keys(REPORT_TYPES_BY_AD_PRODUCT) as ReadonlyArray<
  keyof typeof REPORT_TYPES_BY_AD_PRODUCT
>;

/**
 * Für welche Ad-Typen der Sync je Profil Reports anfordert (1.9, für `selectReportAdProducts` und
 * `metricsImportedThroughSql` in `@profitbash/db`): SP immer (F2), SB und SD nur für Profile mit
 * mindestens einer Kampagne dieses Ad-Typs. Auch „Daten bis“ rechnet über genau diese Auswahl.
 */
export const REPORT_AD_PRODUCT_SELECTION = {
  always: ['SPONSORED_PRODUCTS'],
  withCampaigns: ['SPONSORED_BRANDS', 'SPONSORED_DISPLAY'],
} as const satisfies {
  always: readonly (typeof REPORT_AD_PRODUCTS)[number][];
  withCampaigns: readonly (typeof REPORT_AD_PRODUCTS)[number][];
};

/** Report-Typen eines Ad-Typs; leer für Ad-Typen ohne Reports im Katalog. */
export function reportTypesFor(adProduct: string): readonly AmazonAdsReportType[] {
  return Object.hasOwn(REPORT_TYPES_BY_AD_PRODUCT, adProduct)
    ? REPORT_TYPES_BY_AD_PRODUCT[adProduct as keyof typeof REPORT_TYPES_BY_AD_PRODUCT]
    : [];
}

export function isReportType(value: string): value is AmazonAdsReportType {
  return Object.hasOwn(REPORT_DEFINITIONS, value);
}

// ---------------------------------------------------------------------------
// Eigenes Modell der Kennzahlen (Felder wie die Zeilen von `replaceDailyMetrics` in `@profitbash/db`)
// ---------------------------------------------------------------------------

export interface AmazonAdsDailyMetricValues {
  impressions: number;
  clicks: number;
  /** Decimal-String in der Währung des Profils (v3 liefert je Zeile keine Währung). */
  cost: string;
  sales7d: string | null;
  sales14d: string | null;
  salesSameSku7d: string | null;
  salesSameSku14d: string | null;
  purchases7d: number | null;
  purchases14d: number | null;
  purchasesSameSku7d: number | null;
  purchasesSameSku14d: number | null;
  units7d: number | null;
  units14d: number | null;
  unitsSameSku7d: number | null;
  unitsSameSku14d: number | null;
  /** Nur Klicks (SB/SD, 14 Tage); `*14d` zählt dort Klicks und Views. SP: `null` (nur klick-basiert). */
  salesClicks14d: string | null;
  purchasesClicks14d: number | null;
  unitsClicks14d: number | null;
  /** Sichtbare Impressionen nach MRC (nur SD, Basis für vCPM). SP/SB: `null`. */
  viewableImpressions: number | null;
  extra: Record<string, unknown>;
}

interface MetricRowBase extends AmazonAdsDailyMetricValues {
  /** Tag in der Zeitzone des Profils (`YYYY-MM-DD`). */
  date: string;
  amazonCampaignId: string;
  campaignName?: string | null;
}

export type AmazonAdsCampaignDailyMetric = MetricRowBase;

export interface AmazonAdsAdGroupDailyMetric extends MetricRowBase {
  amazonAdGroupId: string;
  adGroupName?: string | null;
}

export interface AmazonAdsTargetDailyMetric extends MetricRowBase {
  amazonAdGroupId: string | null;
  adGroupName?: string | null;
  amazonTargetId: string;
}

export interface AmazonAdsProductAdDailyMetric extends MetricRowBase {
  amazonAdGroupId: string;
  adGroupName?: string | null;
  amazonAdId: string;
  asin?: string | null;
  sku?: string | null;
}

export interface AmazonAdsSearchTermDailyMetric extends AmazonAdsTargetDailyMetric {
  searchTerm: string;
}

export interface AmazonAdsReportRows {
  spCampaigns: AmazonAdsCampaignDailyMetric;
  spAdGroups: AmazonAdsAdGroupDailyMetric;
  spTargeting: AmazonAdsTargetDailyMetric;
  spAdvertisedProduct: AmazonAdsProductAdDailyMetric;
  spSearchTerm: AmazonAdsSearchTermDailyMetric;
  sbCampaigns: AmazonAdsCampaignDailyMetric;
  sbAdGroup: AmazonAdsAdGroupDailyMetric;
  sbTargeting: AmazonAdsTargetDailyMetric;
  sbAds: AmazonAdsProductAdDailyMetric;
  sbSearchTerm: AmazonAdsSearchTermDailyMetric;
  sdCampaigns: AmazonAdsCampaignDailyMetric;
  sdAdGroup: AmazonAdsAdGroupDailyMetric;
  sdTargeting: AmazonAdsTargetDailyMetric;
  sdAdvertisedProduct: AmazonAdsProductAdDailyMetric;
}

// ---------------------------------------------------------------------------
// Anfordern und Status
// ---------------------------------------------------------------------------

export interface RequestReportInput {
  amazonProfileId: string;
  reportType: AmazonAdsReportType;
  /** `YYYY-MM-DD`, beide Grenzen eingeschlossen, höchstens 31 Tage. */
  startDate: string;
  endDate: string;
}

const requestResponseSchema = z.object({ reportId: z.string().min(1) });

/**
 * Fordert einen Report an. Der Name ist aus Typ und Zeitraum abgeleitet: Eine erneute Anforderung nach einem
 * Absturz ist damit identisch und trifft bei Amazon auf 425 mit der ID des laufenden Reports.
 */
export async function requestReport(
  deps: AdsEndpointDeps,
  connection: ConnectionRef,
  input: RequestReportInput,
  options: RequestOptions = {},
): Promise<{ reportId: string }> {
  const operation = 'reports.request';
  assertReportRange(input.startDate, input.endDate);
  const definition: ReportDefinition = REPORT_DEFINITIONS[input.reportType];
  try {
    const response = await deps.request(connection, {
      operation,
      method: 'POST',
      path: '/reporting/reports',
      amazonProfileId: input.amazonProfileId,
      headers: { 'Content-Type': REPORT_CREATE_CONTENT_TYPE },
      body: JSON.stringify({
        name: `profitbash ${input.reportType} ${input.startDate}..${input.endDate}`,
        startDate: input.startDate,
        endDate: input.endDate,
        configuration: {
          adProduct: definition.adProduct,
          reportTypeId: definition.reportTypeId,
          groupBy: definition.groupBy,
          columns: definition.columns,
          timeUnit: 'DAILY',
          format: 'GZIP_JSON',
        },
      }),
      schema: requestResponseSchema,
      ...(options.meter && { meter: options.meter }),
    });
    return { reportId: response.reportId };
  } catch (error) {
    if (error instanceof AmazonAdsHttpError && error.status === 425) {
      throw new AmazonAdsDuplicateReportError(
        operation,
        duplicateReportId(error.details),
        error.amazonRequestId,
        error.details,
      );
    }
    throw error;
  }
}

/**
 * Report-ID aus dem 425-Text. Beobachtetes Format „The Request is a duplicate of : <reportId>“; sonst die
 * erste UUID im Text. Die Doku nennt nur `{ code, detail }` (Stand 2026-09-27), 1.10 prüft das echte Format.
 */
export function duplicateReportId(detail: string | null): string | null {
  if (!detail) return null;
  // Kein Zeichen der ID und kein Kürzungszeichen („…“ aus `http.ts`) danach: sonst wäre die ID abgeschnitten.
  const explicit = /duplicate of\s*:?\s*([A-Za-z0-9][A-Za-z0-9_-]{7,})(?![A-Za-z0-9_…-])/i.exec(
    detail,
  );
  if (explicit) return explicit[1]!;
  const uuid = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.exec(detail);
  return uuid ? uuid[0] : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

function assertReportRange(startDate: string, endDate: string): void {
  const start = ISO_DATE.test(startDate) ? Date.parse(`${startDate}T00:00:00Z`) : NaN;
  const end = ISO_DATE.test(endDate) ? Date.parse(`${endDate}T00:00:00Z`) : NaN;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
    throw new RangeError('requestReport: Zeitraum ist ungültig (YYYY-MM-DD, Beginn vor Ende).');
  }
  if ((end - start) / DAY_MS + 1 > MAX_REPORT_DAYS) {
    throw new RangeError(`requestReport: Ein Report umfasst höchstens ${MAX_REPORT_DAYS} Tage.`);
  }
}

export interface GetReportInput {
  amazonProfileId: string;
  reportId: string;
}

const statusResponseSchema = z.object({
  status: z.string().min(1),
  url: z.string().nullish(),
  failureReason: z.string().nullish(),
});

const RUNNING_REPORT_STATES: ReadonlySet<string> = new Set(['PENDING', 'PROCESSING']);

export async function getReport(
  deps: AdsEndpointDeps,
  connection: ConnectionRef,
  input: GetReportInput,
  options: RequestOptions = {},
): Promise<AmazonAdsAsyncStatus> {
  const operation = 'reports.get';
  let response: z.output<typeof statusResponseSchema>;
  try {
    response = await deps.request(connection, {
      operation,
      method: 'GET',
      path: `/reporting/reports/${encodeURIComponent(input.reportId)}`,
      amazonProfileId: input.amazonProfileId,
      schema: statusResponseSchema,
      ...(options.meter && { meter: options.meter }),
    });
  } catch (error) {
    if (error instanceof AmazonAdsHttpError && error.status === 404) return { status: 'NOT_FOUND' };
    throw error;
  }
  switch (response.status) {
    case 'COMPLETED':
      return { status: 'COMPLETED', url: response.url ?? null };
    case 'FAILED':
    case 'FAILURE':
      return { status: 'FAILURE', failureReason: response.failureReason ?? null };
    case 'PENDING':
      return { status: 'PENDING' };
    default:
      if (!RUNNING_REPORT_STATES.has(response.status)) {
        createUnknownValueReporter(deps.logger, { operation }).check(
          'status',
          response.status,
          RUNNING_REPORT_STATES,
        );
      }
      return { status: 'PROCESSING' };
  }
}

// ---------------------------------------------------------------------------
// Zeilen-Schemas
// ---------------------------------------------------------------------------

// Ohne Untergrenze: Eine negative Korrektur darf nicht die ganze Zeile samt Kosten verwerfen (DB: `bigint`).
const counter = z.number().int();
const optionalCounter = counter.nullish().transform((value) => value ?? null);
const optionalAmount = amazonDecimalSchema.nullish().transform((value) => value ?? null);
const optionalText = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

const metricColumns = {
  date: z.string().regex(ISO_DATE),
  campaignId: amazonIdSchema,
  campaignName: optionalText,
  impressions: counter,
  clicks: counter,
  cost: amazonDecimalSchema,
  sales7d: optionalAmount,
  sales14d: optionalAmount,
  attributedSalesSameSku7d: optionalAmount,
  attributedSalesSameSku14d: optionalAmount,
  purchases7d: optionalCounter,
  purchases14d: optionalCounter,
  purchasesSameSku7d: optionalCounter,
  purchasesSameSku14d: optionalCounter,
  unitsSoldClicks7d: optionalCounter,
  unitsSoldClicks14d: optionalCounter,
  unitsSoldSameSku7d: optionalCounter,
  unitsSoldSameSku14d: optionalCounter,
};

type MetricColumns = z.output<z.ZodObject<typeof metricColumns>>;

function metricBase(row: MetricColumns): MetricRowBase {
  return {
    date: row.date,
    amazonCampaignId: row.campaignId,
    campaignName: row.campaignName,
    impressions: row.impressions,
    clicks: row.clicks,
    cost: row.cost,
    sales7d: row.sales7d,
    sales14d: row.sales14d,
    salesSameSku7d: row.attributedSalesSameSku7d,
    salesSameSku14d: row.attributedSalesSameSku14d,
    purchases7d: row.purchases7d,
    purchases14d: row.purchases14d,
    purchasesSameSku7d: row.purchasesSameSku7d,
    purchasesSameSku14d: row.purchasesSameSku14d,
    units7d: row.unitsSoldClicks7d,
    units14d: row.unitsSoldClicks14d,
    unitsSameSku7d: row.unitsSoldSameSku7d,
    unitsSameSku14d: row.unitsSoldSameSku14d,
    salesClicks14d: null,
    purchasesClicks14d: null,
    unitsClicks14d: null,
    viewableImpressions: null,
    extra: {},
  };
}

const adGroupColumns = { adGroupId: amazonIdSchema, adGroupName: optionalText };

const sbMetricColumns = {
  date: z.string().regex(ISO_DATE),
  campaignId: amazonIdSchema,
  campaignName: optionalText,
  impressions: counter,
  clicks: counter,
  cost: amazonDecimalSchema,
  sales: optionalAmount,
  salesClicks: optionalAmount,
  salesPromoted: optionalAmount,
  purchases: optionalCounter,
  purchasesClicks: optionalCounter,
  purchasesPromoted: optionalCounter,
  unitsSold: optionalCounter,
  unitsSoldClicks: optionalCounter,
};

type SbMetricColumns = z.output<z.ZodObject<typeof sbMetricColumns>>;

/** SB: ein Fenster (14 Tage), `*_7d` bleibt leer; Einheiten ohne Same-SKU. */
function sbMetricBase(row: SbMetricColumns): MetricRowBase {
  return {
    date: row.date,
    amazonCampaignId: row.campaignId,
    campaignName: row.campaignName,
    impressions: row.impressions,
    clicks: row.clicks,
    cost: row.cost,
    sales7d: null,
    sales14d: row.sales,
    salesSameSku7d: null,
    salesSameSku14d: row.salesPromoted,
    purchases7d: null,
    purchases14d: row.purchases,
    purchasesSameSku7d: null,
    purchasesSameSku14d: row.purchasesPromoted,
    units7d: null,
    units14d: row.unitsSold,
    unitsSameSku7d: null,
    unitsSameSku14d: null,
    salesClicks14d: row.salesClicks,
    purchasesClicks14d: row.purchasesClicks,
    unitsClicks14d: row.unitsSoldClicks,
    viewableImpressions: null,
    extra: {},
  };
}

const sdMetricColumns = {
  date: z.string().regex(ISO_DATE),
  campaignId: amazonIdSchema,
  campaignName: optionalText,
  impressions: counter,
  clicks: counter,
  cost: amazonDecimalSchema,
  sales: optionalAmount,
  salesClicks: optionalAmount,
  salesPromotedClicks: optionalAmount,
  purchases: optionalCounter,
  purchasesClicks: optionalCounter,
  purchasesPromotedClicks: optionalCounter,
  unitsSold: optionalCounter,
  unitsSoldClicks: optionalCounter,
  impressionsViews: optionalCounter,
};

type SdMetricColumns = z.output<z.ZodObject<typeof sdMetricColumns>>;

/** SD: ein Fenster (14 Tage) wie SB; Same-SKU nur nach Klick, dazu die sichtbaren Impressionen. */
function sdMetricBase(row: SdMetricColumns): MetricRowBase {
  return {
    date: row.date,
    amazonCampaignId: row.campaignId,
    campaignName: row.campaignName,
    impressions: row.impressions,
    clicks: row.clicks,
    cost: row.cost,
    sales7d: null,
    sales14d: row.sales,
    salesSameSku7d: null,
    salesSameSku14d: row.salesPromotedClicks,
    purchases7d: null,
    purchases14d: row.purchases,
    purchasesSameSku7d: null,
    purchasesSameSku14d: row.purchasesPromotedClicks,
    units7d: null,
    units14d: row.unitsSold,
    unitsSameSku7d: null,
    unitsSameSku14d: null,
    salesClicks14d: row.salesClicks,
    purchasesClicks14d: row.purchasesClicks,
    unitsClicks14d: row.unitsSoldClicks,
    viewableImpressions: row.impressionsViews,
    extra: {},
  };
}

const optionalId = amazonIdSchema.nullish().transform((value) => value ?? null);

const REPORT_ROW_SCHEMAS: { [K in AmazonAdsReportType]: z.ZodType<AmazonAdsReportRows[K]> } = {
  spCampaigns: z.object(metricColumns).transform(metricBase),
  spAdGroups: z.object({ ...metricColumns, ...adGroupColumns }).transform((row) => ({
    ...metricBase(row),
    amazonAdGroupId: row.adGroupId,
    adGroupName: row.adGroupName,
  })),
  spTargeting: z
    .object({ ...metricColumns, ...adGroupColumns, keywordId: amazonIdSchema })
    .transform((row) => ({
      ...metricBase(row),
      amazonAdGroupId: row.adGroupId,
      adGroupName: row.adGroupName,
      amazonTargetId: row.keywordId,
    })),
  spAdvertisedProduct: z
    .object({
      ...metricColumns,
      ...adGroupColumns,
      adId: amazonIdSchema,
      advertisedAsin: optionalText,
      advertisedSku: optionalText,
    })
    .transform((row) => ({
      ...metricBase(row),
      amazonAdGroupId: row.adGroupId,
      adGroupName: row.adGroupName,
      amazonAdId: row.adId,
      asin: row.advertisedAsin,
      sku: row.advertisedSku,
    })),
  spSearchTerm: z
    .object({
      ...metricColumns,
      ...adGroupColumns,
      keywordId: amazonIdSchema,
      searchTerm: z.string(),
    })
    .transform((row) => ({
      ...metricBase(row),
      amazonAdGroupId: row.adGroupId,
      adGroupName: row.adGroupName,
      amazonTargetId: row.keywordId,
      searchTerm: row.searchTerm,
    })),
  sbCampaigns: z.object(sbMetricColumns).transform(sbMetricBase),
  sbAdGroup: z.object({ ...sbMetricColumns, ...adGroupColumns }).transform((row) => ({
    ...sbMetricBase(row),
    amazonAdGroupId: row.adGroupId,
    adGroupName: row.adGroupName,
  })),
  sbTargeting: z
    .object({
      ...sbMetricColumns,
      ...adGroupColumns,
      keywordId: optionalId,
      targetingId: optionalId,
    })
    .refine((row) => row.keywordId !== null || row.targetingId !== null, {
      message: 'Target ohne keywordId und targetingId',
    })
    .transform((row) => {
      const amazonTargetId = (row.keywordId ?? row.targetingId)!;
      const base = sbMetricBase(row);
      return {
        ...base,
        amazonAdGroupId: row.adGroupId,
        adGroupName: row.adGroupName,
        amazonTargetId,
        // Der Export kennt nur eine Target-ID; eine abweichende `targetingId` bleibt für den Abgleich (1.10).
        extra:
          row.targetingId !== null && row.targetingId !== amazonTargetId
            ? { ...base.extra, targetingId: row.targetingId }
            : base.extra,
      };
    }),
  sbAds: z
    .object({ ...sbMetricColumns, ...adGroupColumns, adId: amazonIdSchema })
    .transform((row) => ({
      ...sbMetricBase(row),
      amazonAdGroupId: row.adGroupId,
      adGroupName: row.adGroupName,
      amazonAdId: row.adId,
      asin: null,
      sku: null,
    })),
  sbSearchTerm: z
    .object({
      ...sbMetricColumns,
      ...adGroupColumns,
      keywordId: amazonIdSchema,
      searchTerm: z.string(),
    })
    .transform((row) => ({
      ...sbMetricBase(row),
      amazonAdGroupId: row.adGroupId,
      adGroupName: row.adGroupName,
      amazonTargetId: row.keywordId,
      searchTerm: row.searchTerm,
    })),
  sdCampaigns: z.object(sdMetricColumns).transform(sdMetricBase),
  sdAdGroup: z.object({ ...sdMetricColumns, ...adGroupColumns }).transform((row) => ({
    ...sdMetricBase(row),
    amazonAdGroupId: row.adGroupId,
    adGroupName: row.adGroupName,
  })),
  sdTargeting: z
    .object({ ...sdMetricColumns, ...adGroupColumns, targetingId: amazonIdSchema })
    .transform((row) => ({
      ...sdMetricBase(row),
      amazonAdGroupId: row.adGroupId,
      adGroupName: row.adGroupName,
      amazonTargetId: row.targetingId,
    })),
  sdAdvertisedProduct: z
    .object({
      ...sdMetricColumns,
      ...adGroupColumns,
      adId: amazonIdSchema,
      promotedAsin: optionalText,
      promotedSku: optionalText,
    })
    .transform((row) => ({
      ...sdMetricBase(row),
      amazonAdGroupId: row.adGroupId,
      adGroupName: row.adGroupName,
      amazonAdId: row.adId,
      asin: row.promotedAsin,
      sku: row.promotedSku,
    })),
};

/**
 * zod-Schema je Zeile einer Report-Datei (Eingabe aus `decodeGzipJson`), Ausgabe als Kennzahl im eigenen
 * Modell. Beträge über `amazonDecimalSchema`, Zähler als sichere Ganzzahlen, IDs als Strings.
 */
export function createReportRowSchema<T extends AmazonAdsReportType>(
  reportType: T,
): z.ZodType<AmazonAdsReportRows[T]> {
  return REPORT_ROW_SCHEMAS[reportType];
}
