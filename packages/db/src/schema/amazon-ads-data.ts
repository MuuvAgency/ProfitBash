import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  date,
  foreignKey,
  index,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type PgColumn,
} from 'drizzle-orm/pg-core';
import { amazonAdsProfiles } from './app';
import { createdAt, id, organizationId, updatedAt } from './columns';
import { fileImports } from './file-imports';

/**
 * Werbe-Entities und Tageskennzahlen je Amazon-Ads-Profil (Phase 1, 1.5). Zugriffe nur über
 * `amazon-ads-entities.ts` und `amazon-ads-metrics.ts` (Systemzugriff der Jobs).
 *
 * Regeln (DB-Konvention aus 1.1):
 * - Amazon-IDs als Text, Beträge als `numeric` ohne feste Skala (String), Zähler `bigint`, Tage `date`
 *   als String. Jeder Betrag hat eine eigene Währungsspalte.
 * - `profile_id` hängt über (`profile_id`, `organization_id`) am Profil derselben Organisation, Eltern
 *   und Kennzahlen über (`…_id`, `profile_id`) an der Entity desselben Profils.
 * - Verweise auf Profile und Eltern mit `ON DELETE NO ACTION`: Historie ist nicht wiederbeschaffbar,
 *   ein Profil oder eine Kampagne mit Daten lässt sich nicht löschen. Die Organisation schon (ihre
 *   Kaskade entfernt alles; `NO ACTION` prüft erst am Ende der Anweisung, anders als `RESTRICT`).
 * - Platzhalter (Entity aus einem Report, die der Entity-Sync noch nicht kennt): `synced_at` leer,
 *   Name, Status, Gebot, Budget und Währung leer, bis der Entity-Sync sie füllt.
 * - `removed_at`: Amazon liefert die Entity nicht mehr (umkehrbar, nie löschen).
 */

// ---------------------------------------------------------------------------
// Gemeinsame Spalten und Schlüssel
// ---------------------------------------------------------------------------

const profileId = () => uuid('profile_id').notNull();
/** `SPONSORED_PRODUCTS` | `SPONSORED_BRANDS` | `SPONSORED_DISPLAY` (Text: neue Amazon-Werte brechen nichts). */
const adProduct = () => text('ad_product').notNull();
/** Produktspezifische Felder ohne eigene Spalte. Nie Beträge, mit denen gerechnet wird. */
const extra = () =>
  jsonb('extra')
    .$type<Record<string, unknown>>()
    .notNull()
    .default(sql`'{}'::jsonb`);
const money = (name: string) => numeric(name, { mode: 'string' });

const entityTimestamps = () => ({
  /** Letzte Änderung laut Amazon, falls geliefert. */
  amazonUpdatedAt: timestamp('amazon_updated_at', { withTimezone: true, mode: 'date' }),
  /** Letzter Entity-Sync, der die Entity geliefert hat; leer bei Platzhaltern. */
  syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
  removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

const profileFk = (table: string, profile: PgColumn, organization: PgColumn) =>
  foreignKey({
    name: `${table}_profile_org_fk`,
    columns: [profile, organization],
    foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
  });

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

/** Portfolios gelten für alle Ad-Typen eines Profils (kein `ad_product`). */
export const amazonAdsPortfolios = pgTable(
  'amazon_ads_portfolios',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: profileId(),
    amazonPortfolioId: text('amazon_portfolio_id').notNull(),
    name: text('name'),
    state: text('state'),
    budgetAmount: money('budget_amount'),
    budgetCurrencyCode: text('budget_currency_code'),
    /** z. B. `DATE_RANGE`, `MONTHLY_RECURRING`, `NO_CAP`. */
    budgetPolicy: text('budget_policy'),
    budgetStartDate: date('budget_start_date', { mode: 'string' }),
    budgetEndDate: date('budget_end_date', { mode: 'string' }),
    inBudget: boolean('in_budget'),
    extra: extra(),
    ...entityTimestamps(),
  },
  (t) => [
    profileFk('amazon_ads_portfolios', t.profileId, t.organizationId),
    unique('amazon_ads_portfolios_profile_amazon_uq').on(t.profileId, t.amazonPortfolioId),
    unique('amazon_ads_portfolios_id_profile_uq').on(t.id, t.profileId),
  ],
);

export const amazonAdsCampaigns = pgTable(
  'amazon_ads_campaigns',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: profileId(),
    portfolioId: uuid('portfolio_id'),
    amazonCampaignId: text('amazon_campaign_id').notNull(),
    adProduct: adProduct(),
    name: text('name'),
    state: text('state'),
    /** `MANUAL` | `AUTO` (SP). */
    targetingType: text('targeting_type'),
    budgetAmount: money('budget_amount'),
    budgetCurrencyCode: text('budget_currency_code'),
    /** z. B. `DAILY`. */
    budgetType: text('budget_type'),
    biddingStrategy: text('bidding_strategy'),
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    /** u. a. Platzierungs-Anpassungen. */
    extra: extra(),
    ...entityTimestamps(),
  },
  (t) => [
    profileFk('amazon_ads_campaigns', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_campaigns_portfolio_fk',
      columns: [t.portfolioId, t.profileId],
      foreignColumns: [amazonAdsPortfolios.id, amazonAdsPortfolios.profileId],
    }),
    unique('amazon_ads_campaigns_profile_amazon_uq').on(t.profileId, t.amazonCampaignId),
    unique('amazon_ads_campaigns_id_profile_uq').on(t.id, t.profileId),
    index('amazon_ads_campaigns_portfolio_idx').on(t.portfolioId),
  ],
);

export const amazonAdsAdGroups = pgTable(
  'amazon_ads_ad_groups',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: profileId(),
    campaignId: uuid('campaign_id').notNull(),
    amazonAdGroupId: text('amazon_ad_group_id').notNull(),
    adProduct: adProduct(),
    name: text('name'),
    state: text('state'),
    defaultBid: money('default_bid'),
    defaultBidCurrencyCode: text('default_bid_currency_code'),
    extra: extra(),
    ...entityTimestamps(),
  },
  (t) => [
    profileFk('amazon_ads_ad_groups', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_ad_groups_campaign_fk',
      columns: [t.campaignId, t.profileId],
      foreignColumns: [amazonAdsCampaigns.id, amazonAdsCampaigns.profileId],
    }),
    unique('amazon_ads_ad_groups_profile_amazon_uq').on(t.profileId, t.amazonAdGroupId),
    unique('amazon_ads_ad_groups_id_profile_uq').on(t.id, t.profileId),
    index('amazon_ads_ad_groups_campaign_idx').on(t.campaignId),
  ],
);

/** Positive Targets (mit Gebot und Kennzahlen). Negatives liegen in `amazon_ads_negative_targets`. */
export const amazonAdsTargets = pgTable(
  'amazon_ads_targets',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: profileId(),
    campaignId: uuid('campaign_id').notNull(),
    /** Leer bei Targets auf Kampagnenebene (SB). */
    adGroupId: uuid('ad_group_id'),
    amazonTargetId: text('amazon_target_id').notNull(),
    adProduct: adProduct(),
    /** `keyword` | `product` | `category` | `auto` | `audience`; leer bei Platzhaltern. */
    targetType: text('target_type'),
    keywordText: text('keyword_text'),
    matchType: text('match_type'),
    /** Target-Ausdruck (Produkt-, Kategorie-, Auto-, Audience-Targets). */
    expression: jsonb('expression').$type<unknown>(),
    state: text('state'),
    bid: money('bid'),
    bidCurrencyCode: text('bid_currency_code'),
    extra: extra(),
    ...entityTimestamps(),
  },
  (t) => [
    profileFk('amazon_ads_targets', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_targets_campaign_fk',
      columns: [t.campaignId, t.profileId],
      foreignColumns: [amazonAdsCampaigns.id, amazonAdsCampaigns.profileId],
    }),
    foreignKey({
      name: 'amazon_ads_targets_ad_group_fk',
      columns: [t.adGroupId, t.profileId],
      foreignColumns: [amazonAdsAdGroups.id, amazonAdsAdGroups.profileId],
    }),
    unique('amazon_ads_targets_profile_amazon_uq').on(t.profileId, t.amazonTargetId),
    unique('amazon_ads_targets_id_profile_uq').on(t.id, t.profileId),
    index('amazon_ads_targets_campaign_idx').on(t.campaignId),
    index('amazon_ads_targets_ad_group_idx').on(t.adGroupId),
  ],
);

/** Negative Keywords und Targets (ohne Gebot und Kennzahlen, deshalb ohne Platzhalter). */
export const amazonAdsNegativeTargets = pgTable(
  'amazon_ads_negative_targets',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: profileId(),
    /** `campaign` | `ad_group`. */
    level: text('level').notNull(),
    campaignId: uuid('campaign_id').notNull(),
    adGroupId: uuid('ad_group_id'),
    amazonTargetId: text('amazon_target_id').notNull(),
    adProduct: adProduct(),
    targetType: text('target_type').notNull(),
    keywordText: text('keyword_text'),
    matchType: text('match_type'),
    expression: jsonb('expression').$type<unknown>(),
    state: text('state').notNull(),
    extra: extra(),
    ...entityTimestamps(),
  },
  (t) => [
    profileFk('amazon_ads_negative_targets', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_negative_targets_campaign_fk',
      columns: [t.campaignId, t.profileId],
      foreignColumns: [amazonAdsCampaigns.id, amazonAdsCampaigns.profileId],
    }),
    foreignKey({
      name: 'amazon_ads_negative_targets_ad_group_fk',
      columns: [t.adGroupId, t.profileId],
      foreignColumns: [amazonAdsAdGroups.id, amazonAdsAdGroups.profileId],
    }),
    unique('amazon_ads_negative_targets_profile_amazon_uq').on(t.profileId, t.amazonTargetId),
    unique('amazon_ads_negative_targets_id_profile_uq').on(t.id, t.profileId),
    index('amazon_ads_negative_targets_campaign_idx').on(t.campaignId),
    index('amazon_ads_negative_targets_ad_group_idx').on(t.adGroupId),
    check(
      'amazon_ads_negative_targets_level_ck',
      sql`(level = 'campaign' and ad_group_id is null) or (level = 'ad_group' and ad_group_id is not null)`,
    ),
  ],
);

export const amazonAdsProductAds = pgTable(
  'amazon_ads_product_ads',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: profileId(),
    campaignId: uuid('campaign_id').notNull(),
    adGroupId: uuid('ad_group_id').notNull(),
    amazonAdId: text('amazon_ad_id').notNull(),
    adProduct: adProduct(),
    /** Leer nur bei Platzhaltern ohne ASIN in der Report-Zeile. */
    asin: text('asin'),
    /** Leer bei Vendoren. */
    sku: text('sku'),
    state: text('state'),
    extra: extra(),
    ...entityTimestamps(),
  },
  (t) => [
    profileFk('amazon_ads_product_ads', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_product_ads_campaign_fk',
      columns: [t.campaignId, t.profileId],
      foreignColumns: [amazonAdsCampaigns.id, amazonAdsCampaigns.profileId],
    }),
    foreignKey({
      name: 'amazon_ads_product_ads_ad_group_fk',
      columns: [t.adGroupId, t.profileId],
      foreignColumns: [amazonAdsAdGroups.id, amazonAdsAdGroups.profileId],
    }),
    unique('amazon_ads_product_ads_profile_amazon_uq').on(t.profileId, t.amazonAdId),
    unique('amazon_ads_product_ads_id_profile_uq').on(t.id, t.profileId),
    index('amazon_ads_product_ads_campaign_idx').on(t.campaignId),
    index('amazon_ads_product_ads_ad_group_idx').on(t.adGroupId),
  ],
);

// ---------------------------------------------------------------------------
// Tageskennzahlen (Reporting v3, ein Tag je Zeile in der Zeitzone des Profils)
// ---------------------------------------------------------------------------

/** Zähler: Tageswerte liegen weit unter 2^53; `mode: 'bigint'` wäre nicht JSON-serialisierbar. */
const count = (name: string) => bigint(name, { mode: 'number' });

const metricKeyColumns = () => ({
  id: id(),
  organizationId: organizationId(),
  profileId: profileId(),
  date: date('date', { mode: 'string' }).notNull(),
  adProduct: adProduct(),
});

/**
 * Attribution nach F7: 7 und 14 Tage, gesamt und „same SKU“. SB/SD liefern nur ein Fenster (14 Tage)
 * ohne Suffix → `*_14d`, die `*_7d`-Spalten bleiben dort leer (nicht 0). Bei SB/SD zählen `*_14d` Klicks
 * und Views (wie die Konsole), `*_clicks_14d` nur Klicks (1.9); SP ist nur klick-basiert, dort bleiben
 * sie leer. SD: Same-SKU nur nach Klick, `viewable_impressions` (MRC, Basis für vCPM) nur dort gefüllt.
 */
const metricValueColumns = () => ({
  /** Währung des Profils (v3-Reports liefern je Zeile keine). */
  currencyCode: text('currency_code').notNull(),
  impressions: count('impressions').notNull(),
  clicks: count('clicks').notNull(),
  cost: money('cost').notNull(),
  sales7d: money('sales_7d'),
  sales14d: money('sales_14d'),
  salesSameSku7d: money('sales_same_sku_7d'),
  salesSameSku14d: money('sales_same_sku_14d'),
  purchases7d: count('purchases_7d'),
  purchases14d: count('purchases_14d'),
  purchasesSameSku7d: count('purchases_same_sku_7d'),
  purchasesSameSku14d: count('purchases_same_sku_14d'),
  units7d: count('units_7d'),
  units14d: count('units_14d'),
  unitsSameSku7d: count('units_same_sku_7d'),
  unitsSameSku14d: count('units_same_sku_14d'),
  salesClicks14d: money('sales_clicks_14d'),
  purchasesClicks14d: count('purchases_clicks_14d'),
  unitsClicks14d: count('units_clicks_14d'),
  viewableImpressions: count('viewable_impressions'),
  /** Weitere Report-Spalten ohne eigene Spalte. */
  extra: extra(),
  importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' }).notNull(),
});

export const amazonAdsCampaignDailyMetrics = pgTable(
  'amazon_ads_campaign_daily_metrics',
  { ...metricKeyColumns(), campaignId: uuid('campaign_id').notNull(), ...metricValueColumns() },
  (t) => [
    profileFk('amazon_ads_campaign_daily_metrics', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_campaign_daily_metrics_campaign_fk',
      columns: [t.campaignId, t.profileId],
      foreignColumns: [amazonAdsCampaigns.id, amazonAdsCampaigns.profileId],
    }),
    // Upsert-Schlüssel; dient auch der FK-Prüfung beim Löschen einer Kampagne.
    unique('amazon_ads_campaign_daily_metrics_key_uq').on(t.profileId, t.campaignId, t.date),
    index('amazon_ads_campaign_daily_metrics_profile_date_idx').on(t.profileId, t.date),
  ],
);

export const amazonAdsAdGroupDailyMetrics = pgTable(
  'amazon_ads_ad_group_daily_metrics',
  { ...metricKeyColumns(), adGroupId: uuid('ad_group_id').notNull(), ...metricValueColumns() },
  (t) => [
    profileFk('amazon_ads_ad_group_daily_metrics', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_ad_group_daily_metrics_ad_group_fk',
      columns: [t.adGroupId, t.profileId],
      foreignColumns: [amazonAdsAdGroups.id, amazonAdsAdGroups.profileId],
    }),
    unique('amazon_ads_ad_group_daily_metrics_key_uq').on(t.profileId, t.adGroupId, t.date),
    index('amazon_ads_ad_group_daily_metrics_profile_date_idx').on(t.profileId, t.date),
  ],
);

export const amazonAdsTargetDailyMetrics = pgTable(
  'amazon_ads_target_daily_metrics',
  { ...metricKeyColumns(), targetId: uuid('target_id').notNull(), ...metricValueColumns() },
  (t) => [
    profileFk('amazon_ads_target_daily_metrics', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_target_daily_metrics_target_fk',
      columns: [t.targetId, t.profileId],
      foreignColumns: [amazonAdsTargets.id, amazonAdsTargets.profileId],
    }),
    unique('amazon_ads_target_daily_metrics_key_uq').on(t.profileId, t.targetId, t.date),
    index('amazon_ads_target_daily_metrics_profile_date_idx').on(t.profileId, t.date),
  ],
);

export const amazonAdsProductAdDailyMetrics = pgTable(
  'amazon_ads_product_ad_daily_metrics',
  { ...metricKeyColumns(), productAdId: uuid('product_ad_id').notNull(), ...metricValueColumns() },
  (t) => [
    profileFk('amazon_ads_product_ad_daily_metrics', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_product_ad_daily_metrics_product_ad_fk',
      columns: [t.productAdId, t.profileId],
      foreignColumns: [amazonAdsProductAds.id, amazonAdsProductAds.profileId],
    }),
    unique('amazon_ads_product_ad_daily_metrics_key_uq').on(t.profileId, t.productAdId, t.date),
    index('amazon_ads_product_ad_daily_metrics_profile_date_idx').on(t.profileId, t.date),
  ],
);

/** Suchbegriffe (F6), bezogen auf das Target (Keyword bzw. Produkt-/Auto-Target), das sie ausgelöst hat. */
export const amazonAdsSearchTermDailyMetrics = pgTable(
  'amazon_ads_search_term_daily_metrics',
  {
    ...metricKeyColumns(),
    targetId: uuid('target_id').notNull(),
    searchTerm: text('search_term').notNull(),
    ...metricValueColumns(),
  },
  (t) => [
    profileFk('amazon_ads_search_term_daily_metrics', t.profileId, t.organizationId),
    foreignKey({
      name: 'amazon_ads_search_term_daily_metrics_target_fk',
      columns: [t.targetId, t.profileId],
      foreignColumns: [amazonAdsTargets.id, amazonAdsTargets.profileId],
    }),
    unique('amazon_ads_search_term_daily_metrics_key_uq').on(
      t.profileId,
      t.targetId,
      t.date,
      t.searchTerm,
    ),
    index('amazon_ads_search_term_daily_metrics_profile_date_idx').on(t.profileId, t.date),
  ],
);

/**
 * Suchbegriffe aus den Suchbegriff-Blättern der Bulk-Datei (`phase-2b.md` 2b.1, F1): **Summen über den
 * Download-Zeitraum** der Datei, keine Tageswerte. Deshalb eine eigene Tabelle neben
 * `amazon_ads_search_term_daily_metrics` (API-Weg): Zeiträume verschiedener Dateien überlappen sich und lassen sich
 * nicht addieren, Auswertungen rechnen je Zeitraum. Ein Upload ersetzt im selben Zeitraum die Zeilen der Kampagnen,
 * die er enthält (eine laut Upload vollständige Datei den ganzen Zeitraum).
 *
 * Kampagne, Ad Group und Target als Amazon-IDs ohne Fremdschlüssel: Die Datei kann eine Teilmenge sein
 * (z. B. ohne pausierte Targets), Suchbegriffe fehlender Entities sollen weder verloren gehen noch Platzhalter
 * erzwingen. Gelesen wird über die Unique-Schlüssel (Profil, Amazon-ID) der Entity-Tabellen.
 */
export const amazonAdsSearchTermPeriodMetrics = pgTable(
  'amazon_ads_search_term_period_metrics',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: profileId(),
    adProduct: adProduct(),
    /** Erster und letzter Tag des Download-Zeitraums (aus dem Dateinamen der Werbekonsole). */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    amazonCampaignId: text('amazon_campaign_id').notNull(),
    amazonAdGroupId: text('amazon_ad_group_id').notNull(),
    /** Keyword-ID bzw. Produkt-Targeting-ID des auslösenden Targets. */
    amazonTargetId: text('amazon_target_id').notNull(),
    searchTerm: text('search_term').notNull(),
    /** Währung des Profils (die Blätter tragen keine). */
    currencyCode: text('currency_code').notNull(),
    impressions: count('impressions').notNull(),
    clicks: count('clicks').notNull(),
    cost: money('cost').notNull(),
    sales: money('sales').notNull(),
    purchases: count('purchases').notNull(),
    units: count('units').notNull(),
    importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Datei, aus der die Zeile stammt (Anzeige „aus welchem Upload“); leer, sobald der Verlauf gelöscht ist. */
    fileImportId: uuid('file_import_id').references(() => fileImports.id, { onDelete: 'set null' }),
  },
  (t) => [
    profileFk('amazon_ads_search_term_period_metrics', t.profileId, t.organizationId),
    check(
      'amazon_ads_search_term_period_metrics_period_ck',
      sql`${t.periodStart} <= ${t.periodEnd}`,
    ),
    unique('amazon_ads_search_term_period_metrics_key_uq').on(
      t.profileId,
      t.adProduct,
      t.periodStart,
      t.periodEnd,
      t.amazonTargetId,
      t.searchTerm,
    ),
  ],
);

/**
 * „Daten bis“ je Profil und Ad-Typ (1.8, je Ad-Typ seit 1.9): Ende des zuletzt importierten
 * Kampagnen-Reports, rückt nur vor. Bewusst nicht `max(date)` der Kennzahlen (ein pausiertes Profil
 * hätte sonst ein altes Datum). Angezeigt wird das Minimum über die Ad-Typen des Syncs
 * (`metricsImportedThroughSql`): Ein hängender Ad-Typ bremst die Anzeige.
 */
export const amazonAdsProfileMetricsImportedThrough = pgTable(
  'amazon_ads_profile_metrics_imported_through',
  {
    organizationId: organizationId(),
    profileId: profileId(),
    adProduct: adProduct(),
    /** Tag in der Zeitzone des Profils. */
    importedThrough: date('imported_through', { mode: 'string' }).notNull(),
  },
  (t) => [
    primaryKey({
      name: 'amazon_ads_profile_metrics_imported_through_pk',
      columns: [t.profileId, t.adProduct],
    }),
    profileFk('amazon_ads_profile_metrics_imported_through', t.profileId, t.organizationId),
  ],
);
