import { z } from 'zod';
import type { ConnectionRef } from './access-token';
import type { AmazonAdsAsyncStatus } from './async-status';
import type { AdsEndpointDeps, RequestOptions } from './client';
import { AmazonAdsHttpError } from './errors';
import type { Logger } from './logger';
import { amazonDecimalSchema, currencyCodeSchema } from './money';
import {
  amazonDateSchema,
  compact,
  createUnknownValueReporter,
  extraFieldSchema,
  KNOWN_AD_PRODUCTS,
  KNOWN_ENTITY_STATES,
  parseAmazonTimestamp,
  type UnknownValueReporter,
} from './normalize';
import { amazonIdSchema } from './profiles';

/**
 * Exports-API (Entities lesen, ADR 004). Geprüft am 2026-09-27 gegen Guide und OpenAPI-Spec
 * (`AmazonAdsAPIExports_prod_3p.json`):
 * - `POST /{campaigns|adGroups|targets|ads}/export` mit je eigenem Content-Type (auch als Accept), Antwort 202
 *   mit `exportId`. `stateFilter` ohne Angabe liefert nur `ENABLED`/`PAUSED`; wir fordern `ARCHIVED` mit an (F10).
 * - `GET /exports/{exportId}` mit dem Accept-Header des Export-Typs (sonst 406). Status laut Spec
 *   `PROCESSING`/`COMPLETED`/`FAILED`, der Guide schreibt `IN_PROGRESS`; beides gilt als „läuft“.
 *   Jede Abfrage erzeugt eine neue Download-URL (1 h gültig), bis 24 h nach Fertigstellung.
 * - Datei: gzip-JSON, ein Array im gemeinsamen Modell (Campaign/AdGroup/Target/Ad common model).
 *   Ads und SB/SD-Targets tragen keine `campaignId`; 1.7 ergänzt sie über die Ad Groups desselben Batches.
 * - Amazon begrenzt laufende Exports auf 5 je Endpunkt und Entwickler (FAQ, Stand 2026-09-27).
 */

export const EXPORT_TYPES = ['campaigns', 'adGroups', 'targets', 'ads'] as const;
export type AmazonAdsExportType = (typeof EXPORT_TYPES)[number];

export const EXPORT_CONTENT_TYPES: Readonly<Record<AmazonAdsExportType, string>> = {
  campaigns: 'application/vnd.campaignsexport.v1+json',
  adGroups: 'application/vnd.adgroupsexport.v1+json',
  targets: 'application/vnd.targetsexport.v1+json',
  ads: 'application/vnd.adsexport.v1+json',
};

/** Alle Zustände, auch archivierte (F10: Kennzahlen der Vergangenheit verweisen auf sie). */
const ALL_STATES = ['ENABLED', 'PAUSED', 'ARCHIVED'] as const;

// ---------------------------------------------------------------------------
// Eigenes Modell (Felder wie die `…Record`-Typen in `@profitbash/db`, 1.7 bildet 1:1 ab)
// ---------------------------------------------------------------------------

interface EntityBase {
  adProduct: string;
  state: string;
  amazonUpdatedAt: Date | null;
  /** Felder ohne eigene Spalte (Lieferstatus, Tags, Platzierungs-Anpassungen …). */
  extra: Record<string, unknown>;
}

export interface AmazonAdsCampaign extends EntityBase {
  amazonCampaignId: string;
  amazonPortfolioId: string | null;
  name: string;
  /** SP: `MANUAL` | `AUTO`; SD: Taktik (z. B. `T00030`). */
  targetingType: string | null;
  budgetAmount: string | null;
  budgetCurrencyCode: string | null;
  /** Wiederholung des Budgets, z. B. `DAILY`. */
  budgetType: string | null;
  biddingStrategy: string | null;
  startDate: string | null;
  endDate: string | null;
}

export interface AmazonAdsAdGroup extends EntityBase {
  amazonAdGroupId: string;
  amazonCampaignId: string;
  name: string;
  defaultBid: string | null;
  defaultBidCurrencyCode: string | null;
}

interface TargetBase extends EntityBase {
  amazonTargetId: string;
  /** Fehlt bei SB/SD-Targets; 1.7 ergänzt sie über die Ad Group. */
  amazonCampaignId: string | null;
  amazonAdGroupId: string | null;
  /** `keyword` | `product` | `category` | `auto` | `audience` | … (siehe `TARGET_TYPES`) */
  targetType: string;
  keywordText: string | null;
  matchType: string | null;
  /** `targetDetails` aus dem Export, unverändert (Dezimalzahlen als Quelltext). */
  expression: Record<string, unknown>;
}

export interface AmazonAdsTarget extends TargetBase {
  bid: string | null;
  bidCurrencyCode: string | null;
}

export interface AmazonAdsNegativeTarget extends TargetBase {
  /** `campaign`: ohne Ad Group (nur SP). */
  level: 'campaign' | 'ad_group';
}

/** Eine Zeile des Targets-Exports: positives Target oder Negative (eigene Tabellen, 1.5). */
export type AmazonAdsExportedTarget =
  | { kind: 'target'; target: AmazonAdsTarget }
  | { kind: 'negative'; target: AmazonAdsNegativeTarget };

export interface AmazonAdsProductAd extends EntityBase {
  amazonAdId: string;
  amazonAdGroupId: string;
  /** Das gemeinsame Ad-Modell hat keine Kampagne; 1.7 ergänzt sie über die Ad Group. */
  amazonCampaignId: string | null;
  asin: string | null;
  /** Vendoren haben keine SKU. */
  sku: string | null;
}

export interface AmazonAdsExportRows {
  campaigns: AmazonAdsCampaign;
  adGroups: AmazonAdsAdGroup;
  targets: AmazonAdsExportedTarget;
  ads: AmazonAdsProductAd;
}

/** Amazons Target-Typen → eigene Namen (1.5: `keyword` | `product` | `category` | `auto` | `audience`). */
const TARGET_TYPES: Readonly<Record<string, string>> = {
  KEYWORD: 'keyword',
  PRODUCT: 'product',
  PRODUCT_CATEGORY: 'category',
  AUTO: 'auto',
  AUDIENCE: 'audience',
  PRODUCT_AUDIENCE: 'product_audience',
  PRODUCT_CATEGORY_AUDIENCE: 'category_audience',
  THEME: 'theme',
  CONTENT_CATEGORY: 'content_category',
};
const KNOWN_TARGET_TYPES: ReadonlySet<string> = new Set(Object.keys(TARGET_TYPES));

// ---------------------------------------------------------------------------
// Anfordern und Status
// ---------------------------------------------------------------------------

export interface RequestExportInput {
  amazonProfileId: string;
  exportType: AmazonAdsExportType;
  /** Ein Ad-Typ je Export (1.4: ein Ad-Typ je Auftrag). */
  adProduct: string;
}

const requestResponseSchema = z.object({ exportId: z.string().min(1) });

export async function requestExport(
  deps: AdsEndpointDeps,
  connection: ConnectionRef,
  input: RequestExportInput,
  options: RequestOptions = {},
): Promise<{ exportId: string }> {
  const contentType = EXPORT_CONTENT_TYPES[input.exportType];
  const response = await deps.request(connection, {
    operation: 'exports.request',
    method: 'POST',
    path: `/${input.exportType}/export`,
    amazonProfileId: input.amazonProfileId,
    headers: { 'Content-Type': contentType, Accept: contentType },
    body: JSON.stringify({ adProductFilter: [input.adProduct], stateFilter: ALL_STATES }),
    schema: requestResponseSchema,
    ...(options.meter && { meter: options.meter }),
  });
  return { exportId: response.exportId };
}

export interface GetExportInput {
  amazonProfileId: string;
  exportType: AmazonAdsExportType;
  exportId: string;
}

const statusResponseSchema = z.object({
  status: z.string().min(1),
  url: z.string().nullish(),
  error: z.object({ errorCode: z.string().nullish(), message: z.string().nullish() }).nullish(),
});

const RUNNING_EXPORT_STATES: ReadonlySet<string> = new Set(['PROCESSING', 'IN_PROGRESS']);

export async function getExport(
  deps: AdsEndpointDeps,
  connection: ConnectionRef,
  input: GetExportInput,
  options: RequestOptions = {},
): Promise<AmazonAdsAsyncStatus> {
  const operation = 'exports.get';
  let response: z.output<typeof statusResponseSchema>;
  try {
    response = await deps.request(connection, {
      operation,
      method: 'GET',
      path: `/exports/${encodeURIComponent(input.exportId)}`,
      amazonProfileId: input.amazonProfileId,
      headers: { Accept: EXPORT_CONTENT_TYPES[input.exportType] },
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
      return { status: 'FAILURE', failureReason: describeError(response.error) };
    default:
      if (!RUNNING_EXPORT_STATES.has(response.status)) {
        // Unbekannt: weiter warten. Die 4-h-Regel der Zustandsmaschine beendet den Auftrag sonst.
        createUnknownValueReporter(deps.logger, { operation }).check(
          'status',
          response.status,
          RUNNING_EXPORT_STATES,
        );
      }
      return { status: 'PROCESSING' };
  }
}

function describeError(
  error: { errorCode?: string | null; message?: string | null } | null | undefined,
): string | null {
  if (!error) return null;
  const parts = [error.errorCode, error.message].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(': ') : null;
}

// ---------------------------------------------------------------------------
// Zeilen-Schemas
// ---------------------------------------------------------------------------

export interface ExportRowSchemaOptions {
  /** Ad-Typ des Exports; gilt, wenn eine Zeile keinen nennt. */
  adProduct: string;
  /** Für unbekannte Enum-Werte und Währungen (je Wert einmal je Schema). */
  logger: Logger;
}

const optionalId = amazonIdSchema.nullish();
const optionalText = z.string().nullish();

const entityBase = {
  adProduct: optionalText,
  state: z.string().min(1),
  deliveryStatus: extraFieldSchema,
  deliveryReasons: extraFieldSchema,
  creationDateTime: extraFieldSchema,
  lastUpdatedDateTime: optionalText.catch(null),
};

const monetaryBudgetSchema = z.object({
  currencyCode: currencyCodeSchema.nullish(),
  amount: amazonDecimalSchema.nullish(),
  ruleAmount: amazonDecimalSchema.nullish(),
});

const optimizationSchema = z
  .object({
    bidStrategy: optionalText,
    placementBidAdjustments: extraFieldSchema,
    shopperSegmentBidAdjustment: extraFieldSchema,
    shopperCohortBidAdjustment: extraFieldSchema,
  })
  .loose();

const campaignRowSchema = z.object({
  ...entityBase,
  campaignId: amazonIdSchema,
  portfolioId: optionalId,
  name: z.string(),
  startDate: amazonDateSchema,
  endDate: amazonDateSchema,
  targetingSettings: optionalText,
  costType: extraFieldSchema,
  brandEntityId: extraFieldSchema,
  // Der Guide zeigt `optimization` teils als Array (generisches Beispiel), teils als Objekt. Andere Formen
  // kosten nur die Gebotsstrategie, nicht die Kampagne.
  optimization: z
    .union([optimizationSchema, z.array(optimizationSchema)])
    .nullish()
    .catch(null),
  budgetCaps: z
    .object({
      recurrenceTimePeriod: optionalText,
      budgetType: extraFieldSchema,
      budgetValue: z.object({ monetaryBudget: monetaryBudgetSchema.nullish() }).nullish(),
    })
    .nullish(),
  tags: extraFieldSchema,
});

const adGroupRowSchema = z.object({
  ...entityBase,
  adGroupId: amazonIdSchema,
  campaignId: amazonIdSchema,
  name: z.string(),
  creativeType: extraFieldSchema,
  bid: z
    .object({
      defaultBid: amazonDecimalSchema.nullish(),
      currencyCode: currencyCodeSchema.nullish(),
    })
    .nullish(),
  optimization: z.unknown().optional(),
});

const targetRowSchema = z.object({
  ...entityBase,
  targetId: amazonIdSchema,
  adGroupId: optionalId,
  campaignId: optionalId,
  negative: z.boolean(),
  targetType: z.string().min(1),
  bid: z
    .object({ bid: amazonDecimalSchema.nullish(), currencyCode: currencyCodeSchema.nullish() })
    .nullish(),
  targetDetails: z.record(z.string(), z.unknown()).nullish(),
});

const adRowSchema = z.object({
  ...entityBase,
  adId: amazonIdSchema,
  adGroupId: amazonIdSchema,
  campaignId: optionalId,
  name: extraFieldSchema,
  adType: extraFieldSchema,
  creative: z
    .object({
      products: z
        .array(z.object({ productIdType: optionalText, productId: optionalText }))
        .nullish()
        .catch(null),
      headline: extraFieldSchema,
    })
    .loose()
    .nullish()
    .catch(null),
});

type EntityBaseRow = {
  adProduct?: string | null | undefined;
  state: string;
  deliveryStatus?: unknown;
  deliveryReasons?: unknown;
  creationDateTime?: unknown;
  lastUpdatedDateTime?: string | null | undefined;
};

function baseFields(
  row: EntityBaseRow,
  options: ExportRowSchemaOptions,
  unknown: UnknownValueReporter,
): Omit<EntityBase, 'extra'> & { extraBase: Record<string, unknown> } {
  unknown.check('state', row.state, KNOWN_ENTITY_STATES);
  unknown.check('adProduct', row.adProduct, KNOWN_AD_PRODUCTS);
  return {
    adProduct: row.adProduct ?? options.adProduct,
    state: row.state,
    amazonUpdatedAt: parseAmazonTimestamp(row.lastUpdatedDateTime),
    extraBase: {
      deliveryStatus: row.deliveryStatus,
      deliveryReasons: row.deliveryReasons,
      creationDateTime: row.creationDateTime,
    },
  };
}

/**
 * zod-Schema je Zeile einer Export-Datei (Eingabe aus `decodeGzipJson`, also mit Dezimalzahlen als
 * Quelltext), Ausgabe im eigenen Modell. Ungültige Zeilen scheitern in zod und zählen in der
 * Zustandsmaschine als ungültig.
 */
export function createExportRowSchema<T extends AmazonAdsExportType>(
  exportType: T,
  options: ExportRowSchemaOptions,
): z.ZodType<AmazonAdsExportRows[T]> {
  const unknown = createUnknownValueReporter(options.logger, {
    operation: `exports.${exportType}`,
  });
  const schemas: { [K in AmazonAdsExportType]: z.ZodType<AmazonAdsExportRows[K]> } = {
    campaigns: campaignRowSchema.transform((row): AmazonAdsCampaign => {
      const { extraBase, ...base } = baseFields(row, options, unknown);
      const optimization = Array.isArray(row.optimization) ? row.optimization[0] : row.optimization;
      const money = row.budgetCaps?.budgetValue?.monetaryBudget;
      unknown.checkCurrency(
        'budgetCaps.budgetValue.monetaryBudget.currencyCode',
        money?.currencyCode,
      );
      return {
        amazonCampaignId: row.campaignId,
        amazonPortfolioId: row.portfolioId ?? null,
        name: row.name,
        targetingType: row.targetingSettings ?? null,
        budgetAmount: money?.amount ?? null,
        budgetCurrencyCode: money?.currencyCode ?? null,
        budgetType: row.budgetCaps?.recurrenceTimePeriod ?? null,
        biddingStrategy: optimization?.bidStrategy ?? null,
        startDate: row.startDate,
        endDate: row.endDate,
        ...base,
        extra: compact({
          placementBidAdjustments: optimization?.placementBidAdjustments,
          shopperSegmentBidAdjustment: optimization?.shopperSegmentBidAdjustment,
          shopperCohortBidAdjustment: optimization?.shopperCohortBidAdjustment,
          budgetCapType:
            row.budgetCaps?.budgetType === 'MONETARY' ? undefined : row.budgetCaps?.budgetType,
          budgetRuleAmount: money?.ruleAmount,
          costType: row.costType,
          brandEntityId: row.brandEntityId,
          tags: row.tags,
          ...extraBase,
        }),
      };
    }),
    adGroups: adGroupRowSchema.transform((row): AmazonAdsAdGroup => {
      const { extraBase, ...base } = baseFields(row, options, unknown);
      unknown.checkCurrency('bid.currencyCode', row.bid?.currencyCode);
      return {
        amazonAdGroupId: row.adGroupId,
        amazonCampaignId: row.campaignId,
        name: row.name,
        defaultBid: row.bid?.defaultBid ?? null,
        defaultBidCurrencyCode: row.bid?.currencyCode ?? null,
        ...base,
        extra: compact({
          creativeType: row.creativeType,
          optimization: row.optimization,
          ...extraBase,
        }),
      };
    }),
    targets: targetRowSchema
      .superRefine((row, ctx) => {
        // Ohne Ad Group gilt das Target für die Kampagne; dann muss sie genannt sein.
        if (!row.adGroupId && !row.campaignId) {
          ctx.addIssue({ code: 'custom', message: 'Target ohne Kampagne und Ad Group' });
        }
      })
      .transform((row): AmazonAdsExportedTarget => {
        const { extraBase, ...base } = baseFields(row, options, unknown);
        unknown.check('targetType', row.targetType, KNOWN_TARGET_TYPES);
        const details = row.targetDetails ?? {};
        const keywordText = typeof details.keyword === 'string' ? details.keyword : null;
        if (row.targetType === 'KEYWORD' && keywordText === null) {
          unknown.missing('targetDetails.keyword');
        }
        const common = {
          amazonTargetId: row.targetId,
          amazonCampaignId: row.campaignId ?? null,
          amazonAdGroupId: row.adGroupId ?? null,
          targetType: TARGET_TYPES[row.targetType] ?? row.targetType.toLowerCase(),
          keywordText,
          matchType: typeof details.matchType === 'string' ? details.matchType : null,
          expression: details,
          ...base,
          extra: compact(extraBase),
        };
        if (row.negative) {
          return {
            kind: 'negative',
            target: { ...common, level: row.adGroupId ? 'ad_group' : 'campaign' },
          };
        }
        unknown.checkCurrency('bid.currencyCode', row.bid?.currencyCode);
        return {
          kind: 'target',
          target: {
            ...common,
            bid: row.bid?.bid ?? null,
            bidCurrencyCode: row.bid?.currencyCode ?? null,
          },
        };
      }),
    ads: adRowSchema.transform((row): AmazonAdsProductAd => {
      const { extraBase, ...base } = baseFields(row, options, unknown);
      const products = row.creative?.products ?? [];
      const productId = (type: string) =>
        products.find((product) => product.productIdType === type)?.productId ?? null;
      return {
        amazonAdId: row.adId,
        amazonAdGroupId: row.adGroupId,
        amazonCampaignId: row.campaignId ?? null,
        asin: productId('ASIN'),
        sku: productId('SKU'),
        ...base,
        extra: compact({
          adType: row.adType,
          name: row.name,
          headline: row.creative?.headline,
          ...extraBase,
        }),
      };
    }),
  };
  return schemas[exportType];
}
