import { z } from 'zod';
import {
  BLOCK_AUDIENCES,
  BLOCK_BIDDING_STRATEGIES,
  BLOCK_MATCH_TYPES,
  BLOCK_PRODUCT_MATCHES,
  BLOCK_SD_OPTIMIZATIONS,
  BLOCK_TARGETINGS,
  CATALOG_AD_PRODUCTS,
  MAX_PLACEMENT_PERCENT,
} from './structure-catalog';

/**
 * Kampagnen-Setup (`docs/tasks/phase-4.md` 4.4/4.5): der **Plan** einer Anlage, wie ihn die Plan-Engine
 * (`buildCampaignPlan`, 4.3) liefert und ein **Entwurf** ihn speichert. Beträge sind Decimal-Strings in der Währung
 * des Profils, ASINs zehn Zeichen. Die Engine leitet ihre Typen von hier ab (`PlannedCampaign`), damit gespeicherte
 * Entwürfe und Engine nicht auseinanderlaufen.
 */

/** Höchstens so viele Kampagnen je Entwurf (ein Preset hat höchstens 30 Bausteine, Einzel-Kampagnen je Ziel). */
export const MAX_SETUP_CAMPAIGNS = 300;
/** Targets bzw. Negatives je Kampagne (eine Ad Group); Amazon nimmt bis 1000 je Aufruf. */
export const MAX_SETUP_TARGETS_PER_CAMPAIGN = 1000;
export const MAX_SETUP_NEGATIVES_PER_CAMPAIGN = 1000;
export const MAX_SETUP_ADS_PER_CAMPAIGN = 100;
/** Eingaben des Assistenten je Liste. */
export const MAX_SETUP_INPUTS = 1000;
export const MAX_SETUP_DRAFT_NAME_LENGTH = 120;

export const CAMPAIGN_SETUP_DRAFT_STATUSES = ['draft', 'submitted', 'discarded'] as const;
export type CampaignSetupDraftStatus = (typeof CAMPAIGN_SETUP_DRAFT_STATUSES)[number];
/** Neue Kampagnen sind aktiv vorbelegt und je Entwurf auf pausiert umstellbar (F6). */
export const CAMPAIGN_SETUP_STATES = ['ENABLED', 'PAUSED'] as const;
export type CampaignSetupState = (typeof CAMPAIGN_SETUP_STATES)[number];

/** Entities einer Übermittlung (`campaign_setup_items.entity_type`), in der Reihenfolge der Anlage. */
export const CAMPAIGN_SETUP_ITEM_ENTITIES = [
  'campaign',
  'placement',
  'ad_group',
  'product_ad',
  'keyword',
  'product_target',
  'negative_keyword',
  'negative_product_target',
] as const;
export type CampaignSetupItemEntity = (typeof CAMPAIGN_SETUP_ITEM_ENTITIES)[number];

const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
const money = z.string().regex(MONEY);
const asin = z.string().regex(/^[A-Z0-9]{10}$/);
const percent = z.number().int().min(0).max(MAX_PLACEMENT_PERCENT);
const name = z.string().min(1).max(255);
/** Keywords: wie die Engine sie bereinigt (Wortgrenzen, Länge prüft die Engine gegen Amazons Grenzen). */
const keywordText = z.string().min(1).max(255);

export const plannedTargetSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('keyword'),
    text: keywordText,
    matchType: z.enum(BLOCK_MATCH_TYPES),
    bid: money,
  }),
  z.strictObject({
    type: z.literal('product'),
    asin,
    match: z.enum(BLOCK_PRODUCT_MATCHES),
    bid: money,
  }),
  z.strictObject({
    type: z.literal('category'),
    categoryId: z.string().regex(/^\d{1,20}$/),
    name: z.string().max(255),
    bid: money,
  }),
  z.strictObject({
    type: z.literal('audience'),
    audience: z.enum(BLOCK_AUDIENCES),
    lookbackDays: z.number().int().min(1).max(365),
    bid: money,
  }),
]);
export type PlannedTarget = z.output<typeof plannedTargetSchema>;

/** Negatives gelten für die Ad Group (4.3). */
export const plannedNegativeSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('keyword'),
    text: keywordText,
    matchType: z.enum(['negativeExact', 'negativePhrase']),
  }),
  z.strictObject({ type: z.literal('product'), asin, matchType: z.literal('negativeExact') }),
]);
export type PlannedNegative = z.output<typeof plannedNegativeSchema>;

export const plannedCampaignSchema = z.strictObject({
  /** Schlüssel des Bausteins. */
  block: z.string().max(32),
  adProduct: z.enum(CATALOG_AD_PRODUCTS),
  /** Targeting-Art aus dem Baustein (Bulk: SP `Targeting Type` auto/manuell, SD-Taktik). */
  targeting: z.enum(BLOCK_TARGETINGS),
  name,
  /** Wie die Engine plant; der Entwurf setzt den Zustand aller neuen Kampagnen (`campaignState`, F6). */
  state: z.literal('ENABLED'),
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  dailyBudget: money,
  biddingStrategy: z.enum(BLOCK_BIDDING_STRATEGIES).nullable(),
  sdOptimization: z.enum(BLOCK_SD_OPTIMIZATIONS).nullable(),
  costType: z.enum(['cpc', 'vcpm']),
  offAmazon: z.boolean(),
  placements: z
    .strictObject({ topOfSearch: percent, productPages: percent, restOfSearch: percent })
    .nullable(),
  adGroup: z.strictObject({ name, defaultBid: money }),
  ads: z
    .array(z.strictObject({ asin, sku: z.string().min(1).max(40).nullable() }))
    .max(MAX_SETUP_ADS_PER_CAMPAIGN),
  targets: z.array(plannedTargetSchema).max(MAX_SETUP_TARGETS_PER_CAMPAIGN),
  negatives: z.array(plannedNegativeSchema).max(MAX_SETUP_NEGATIVES_PER_CAMPAIGN),
});
export type PlannedCampaign = z.output<typeof plannedCampaignSchema>;

/**
 * Eingaben des Assistenten (4.5), damit ein Entwurf neu geplant werden kann: Keywords, Marken-Begriffe, fremde
 * Produkte, Kategorien und Freischaltungen je Baustein (F13). Gebote in der Währung des Profils.
 */
export const setupInputsSchema = z.strictObject({
  keywords: z
    .array(
      z.strictObject({
        text: keywordText,
        single: z.boolean().optional(),
        bid: money.optional(),
      }),
    )
    .max(MAX_SETUP_INPUTS)
    .default([]),
  brandTerms: z.array(keywordText).max(MAX_SETUP_INPUTS).default([]),
  productTargets: z
    .array(z.strictObject({ asin, single: z.boolean().optional(), bid: money.optional() }))
    .max(MAX_SETUP_INPUTS)
    .default([]),
  categories: z
    .array(
      z.strictObject({
        id: z.string().regex(/^\d{1,20}$/),
        name: z.string().max(255),
        bid: money.optional(),
      }),
    )
    .max(MAX_SETUP_INPUTS)
    .default([]),
  unlocks: z
    .record(
      z.string().max(32),
      z.strictObject({ vcpm: z.boolean().optional(), offAmazon: z.boolean().optional() }),
    )
    .default({}),
});
export type SetupInputs = z.output<typeof setupInputsSchema>;

const draftName = z
  .string()
  .transform((value) => value.normalize('NFC').split(/\s+/u).filter(Boolean).join(' '))
  .pipe(z.string().min(1).max(MAX_SETUP_DRAFT_NAME_LENGTH));

/** Entwurf speichern (anlegen bzw. mit `version` ändern). */
export const saveCampaignSetupDraftSchema = z.strictObject({
  profileId: z.uuid(),
  productGroupId: z.uuid().nullable(),
  presetKey: z.string().min(1).max(64),
  name: draftName,
  campaignState: z.enum(CAMPAIGN_SETUP_STATES),
  inputs: setupInputsSchema,
  campaigns: z.array(plannedCampaignSchema).min(1).max(MAX_SETUP_CAMPAIGNS),
});
export type SaveCampaignSetupDraft = z.output<typeof saveCampaignSetupDraftSchema>;
