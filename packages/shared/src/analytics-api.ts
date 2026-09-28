import { z } from 'zod';
import { adProductSchema, attributionSettingSchema } from './analytics';

/**
 * zod-Schemas der Auswertungs-Endpunkte (`/api/ads/*`, `docs/tasks/phase-2.md` 2.5). Alle Endpunkte sind POST, IDs
 * stehen im Body (URL-Länge). Beträge und Zähler sind Decimal-Strings (nie `number`), fehlende Werte `null`
 * (Anzeige „–“, nie 0).
 */

// ---------------------------------------------------------------------------
// Anfragen
// ---------------------------------------------------------------------------

/** Längster Zeitraum je Anfrage (Letztes Jahr, Letzte 12 Monate, frei gewählt). */
export const MAX_ANALYTICS_RANGE_DAYS = 400;
/**
 * Höchstzahl markierter Zeilen für die Tagesreihe. Unabhängig davon gilt die Body-Grenze der API (64 KB): Größere
 * Anfragen scheitern vorher mit `413` im Fehlerformat.
 */
export const MAX_TIME_SERIES_ENTITY_IDS = 200;
/** Höchstzahl ASINs/SKUs je Suche im ASIN-Quick-Tool. */
export const MAX_ASIN_SEARCH_TERMS = 100;

const DAY_MS = 86_400_000;

/**
 * Nullbar an der Verwendung, ohne die benannte Komponente zu ändern: `.nullable()` auf einem Schema mit
 * `.meta({ id })` machte die Komponente selbst in OpenAPI nullbar (und damit jede Verwendung im Client).
 */
const orNull = <T extends z.ZodType>(schema: T) => z.union([schema, z.null()]);

export const dateRangeSchema = z
  .object({ from: z.iso.date(), to: z.iso.date() })
  .refine((range) => range.from <= range.to, { message: '`from` liegt nach `to`' })
  .refine(
    (range) => (Date.parse(range.to) - Date.parse(range.from)) / DAY_MS < MAX_ANALYTICS_RANGE_DAYS,
    { message: `höchstens ${MAX_ANALYTICS_RANGE_DAYS} Tage` },
  )
  .meta({ id: 'DateRange' });
export type DateRangeInput = z.infer<typeof dateRangeSchema>;

/** `auto` (eine Währung in der Auswahl → diese, sonst EUR) oder ein ISO-Währungscode. */
export const displayCurrencySchema = z.union([z.literal('auto'), z.string().regex(/^[A-Z]{3}$/)]);

const ids = (max: number) => z.array(z.uuid()).max(max);

/** Auswahl der Filterleiste (F2); alle Angaben schränken zusätzlich ein. */
export const analyticsSelectionSchema = z.object({
  clientIds: ids(500).optional(),
  /** Mit `clientIds`: zusätzlich Profile ohne Client; allein: nur Profile ohne Client. */
  withoutClient: z.boolean().optional(),
  profileIds: ids(1000).optional(),
  adProducts: z.array(adProductSchema).min(1).max(3).optional(),
});

export const analyticsQuerySchema = analyticsSelectionSchema
  .extend({
    period: dateRangeSchema,
    comparison: orNull(dateRangeSchema).optional(),
    /** Standard `auto` (der Server setzt ihn, damit der generierte Client das Feld weglassen darf). */
    currency: displayCurrencySchema.optional(),
    /** Standard `console`. */
    attribution: attributionSettingSchema.optional(),
  })
  .meta({ id: 'AnalyticsQuery' });

export const ANALYTICS_LEVELS = [
  'portfolio',
  'campaign',
  'adGroup',
  'target',
  'productAd',
  'searchTerm',
] as const;
export const analyticsLevelSchema = z.enum(ANALYTICS_LEVELS);
export const EXPLORER_LEVELS = [...ANALYTICS_LEVELS, 'negative'] as const;
export type ExplorerLevel = (typeof EXPLORER_LEVELS)[number];

export const explorerFilterSchema = z.object({
  portfolioIds: ids(1000).optional(),
  campaignIds: ids(1000).optional(),
  adGroupIds: ids(1000).optional(),
  /** Entfernte Entities mitzählen (Standard nein). */
  includeRemoved: z.boolean().optional(),
});

export const explorerRowsRequestSchema = analyticsQuerySchema
  .extend({ level: z.enum(EXPLORER_LEVELS), filter: explorerFilterSchema.optional() })
  .meta({ id: 'ExplorerRowsRequest' });

export const timeSeriesRequestSchema = analyticsQuerySchema
  .extend({
    level: analyticsLevelSchema.default('campaign'),
    filter: explorerFilterSchema.optional(),
    /** Markierte Zeilen (IDs wie in den Explorer-Zeilen). */
    entityIds: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(MAX_TIME_SERIES_ENTITY_IDS)
      .optional(),
  })
  .meta({ id: 'TimeSeriesRequest' });

export const asinSearchRequestSchema = analyticsQuerySchema
  .extend({
    /** ASINs oder SKUs; die API sucht in beiden Feldern und in `extra.asins`. */
    terms: z.array(z.string().trim().min(1).max(60)).min(1).max(MAX_ASIN_SEARCH_TERMS),
  })
  .meta({ id: 'AsinSearchRequest' });

export const filterOptionsRequestSchema = z.object({}).meta({ id: 'FilterOptionsRequest' });

// ---------------------------------------------------------------------------
// Antworten
// ---------------------------------------------------------------------------

const amount = z.string().nullable();

export const metricSumsSchema = z
  .object({
    impressions: amount,
    clicks: amount,
    cost: amount,
    sales: amount,
    purchases: amount,
    units: amount,
    salesSameSku: amount,
    purchasesSameSku: amount,
    unitsSameSku: amount,
    viewableImpressions: amount,
    viewableCost: amount,
  })
  .meta({ id: 'MetricSums' });

/** Abgeleitete Kennzahlen, Anteile als Bruch (0.25 = 25 %), `null` bei fehlendem Wert oder Division durch 0. */
export const derivedMetricsSchema = z
  .object({
    ctr: amount,
    cpc: amount,
    cvr: amount,
    acos: amount,
    roas: amount,
    cpm: amount,
    vcpm: amount,
  })
  .meta({ id: 'DerivedMetrics' });

const coverageSchema = z.enum(['full', 'partial', 'none']);

export const attributionSummarySchema = z
  .object({
    /** Umsatz, Käufe, Einheiten beruhen auf verschiedenen Fenstern bzw. mit/ohne Views (Hinweis an der Summe). */
    mixed: z.boolean(),
    sameSkuMixed: z.boolean(),
    coverage: z.object({
      sales: coverageSchema,
      purchases: coverageSchema,
      units: coverageSchema,
      salesSameSku: coverageSchema,
      purchasesSameSku: coverageSchema,
      unitsSameSku: coverageSchema,
    }),
  })
  .meta({ id: 'AttributionSummary' });

export const metricChangeSchema = z
  .object({ absolute: amount, relative: amount })
  .meta({ id: 'MetricChange' });

/** Werte eines Zeitraums: Summen und abgeleitete Kennzahlen. */
export const periodMetricsSchema = z
  .object({ sums: metricSumsSchema, derived: derivedMetricsSchema })
  .meta({ id: 'PeriodMetrics' });

export const CHANGE_KEYS = [
  'impressions',
  'clicks',
  'cost',
  'sales',
  'purchases',
  'units',
  'ctr',
  'cpc',
  'cvr',
  'acos',
  'roas',
  'cpm',
  'vcpm',
] as const;
export type ChangeKey = (typeof CHANGE_KEYS)[number];

const changesSchema = z
  .object(
    Object.fromEntries(CHANGE_KEYS.map((key) => [key, metricChangeSchema])) as Record<
      ChangeKey,
      typeof metricChangeSchema
    >,
  )
  .meta({ id: 'MetricChanges' });

/** Summe mit Vergleich, Veränderung und Attribution (Summenzeile, Dashboard). */
export const metricsTotalSchema = z
  .object({
    current: periodMetricsSchema,
    comparison: orNull(periodMetricsSchema),
    /** `null` ohne Vergleichszeitraum. */
    change: orNull(changesSchema),
    attribution: attributionSummarySchema,
  })
  .meta({ id: 'MetricsTotal' });

/** Datenstand und Währung, in jeder Antwort mit Kennzahlen. */
export const analyticsMetaSchema = z
  .object({
    /** Anzeigewährung der Summen. */
    currency: z.string(),
    /** Mindestens ein Betrag wurde umgerechnet (Anzeige „≈“). */
    converted: z.boolean(),
    /** Währungen ohne Kurs an mindestens einem Tag: Beträge nicht gezählt (Hinweis). */
    missingFxCurrencies: z.array(z.string()),
    dataThrough: z.iso.date().nullable(),
    /** Ab diesem Tag sind die Werte vorläufig (Amazon korrigiert noch). */
    provisionalFrom: z.iso.date().nullable(),
    /** Erster Tag mit Kennzahlen in der Auswahl. */
    earliestDate: z.iso.date().nullable(),
    profilesWithoutData: z.number().int(),
  })
  .meta({ id: 'AnalyticsMeta' });

export const explorerRowSchema = z
  .object({
    id: z.string(),
    profileId: z.string(),
    accountName: z.string(),
    countryCode: z.string(),
    /** Originalwährung der Beträge dieser Zeile. */
    currencyCode: z.string(),
    adProduct: z.string().nullable(),
    name: z.string().nullable(),
    state: z.string().nullable(),
    removed: z.boolean(),
    placeholder: z.boolean(),
    /** Kennzahl-Zeilen im Zeitraum vorhanden (SB ohne Kennzahlen: v3-Preview-Lücke). */
    hasMetrics: z.boolean(),
    /** Ebenenabhängige Felder (Kampagne, Ad Group, Gebot, ASIN, Kostenart …). */
    attributes: z.record(z.string(), z.unknown()),
    /** `null` bei Negatives (ohne Kennzahlen). */
    current: orNull(periodMetricsSchema),
    comparison: orNull(periodMetricsSchema),
    /** Relative Veränderung je Kennzahl (Bruch), `null` ohne Vergleich. */
    change: z.record(z.enum(CHANGE_KEYS), amount).nullable(),
    attribution: orNull(attributionSummarySchema),
  })
  .meta({ id: 'ExplorerRow' });
export type ExplorerRowResponse = z.infer<typeof explorerRowSchema>;

export const explorerRowsResponseSchema = z
  .object({
    meta: analyticsMetaSchema,
    rows: z.array(explorerRowSchema),
    totalRows: z.number().int(),
    /** Mehr als die Obergrenze: nur die Zeilen mit dem höchsten Spend (Summenzeile gilt für alle). */
    truncated: z.boolean(),
    maxRows: z.number().int(),
    /** `null` bei Negatives. */
    total: orNull(metricsTotalSchema),
  })
  .meta({ id: 'ExplorerRowsResponse' });
export type ExplorerRowsResponse = z.infer<typeof explorerRowsResponseSchema>;

const dayMetricsSchema = z.object({
  date: z.iso.date(),
  sums: metricSumsSchema,
  derived: derivedMetricsSchema,
});

export const timeSeriesResponseSchema = z
  .object({
    meta: analyticsMetaSchema,
    days: z.array(dayMetricsSchema),
    comparisonDays: z.array(dayMetricsSchema),
    attribution: attributionSummarySchema,
    /** `null` ohne Vergleichszeitraum. */
    comparisonAttribution: orNull(attributionSummarySchema),
  })
  .meta({ id: 'TimeSeriesResponse' });
export type TimeSeriesResponse = z.infer<typeof timeSeriesResponseSchema>;

const dashboardGroupSchema = metricsTotalSchema
  .extend({
    key: z.string().nullable(),
    label: z.string().nullable(),
    countryCode: z.string().optional(),
    currencyCode: z.string().optional(),
  })
  .meta({ id: 'DashboardGroup' });

export const dashboardResponseSchema = z
  .object({
    meta: analyticsMetaSchema,
    total: metricsTotalSchema,
    byClient: z.array(dashboardGroupSchema),
    byProfile: z.array(dashboardGroupSchema),
    byAdProduct: z.array(dashboardGroupSchema),
    /** Letzter EZB-Kurs („Kurse bis“) und ob er veraltet ist (mehr als 5 Kalendertage). */
    fxRatesThrough: z.iso.date().nullable(),
    fxRatesStale: z.boolean(),
  })
  .meta({ id: 'DashboardResponse' });
export type DashboardResponse = z.infer<typeof dashboardResponseSchema>;

export const filterOptionsResponseSchema = z
  .object({
    clients: z.array(z.object({ id: z.string(), name: z.string(), slug: z.string() })),
    profiles: z.array(
      z.object({
        id: z.string(),
        amazonProfileId: z.string(),
        accountName: z.string(),
        countryCode: z.string(),
        currencyCode: z.string(),
        timezone: z.string(),
        accountType: z.string(),
        clientId: z.string().nullable(),
      }),
    ),
    /** Wählbare Anzeigewährungen (EUR, USD, Profilwährungen mit EZB-Kurs). */
    currencies: z.array(z.string()),
    fxRatesThrough: z.iso.date().nullable(),
    fxRatesStale: z.boolean(),
  })
  .meta({ id: 'FilterOptionsResponse' });
export type FilterOptionsResponse = z.infer<typeof filterOptionsResponseSchema>;
