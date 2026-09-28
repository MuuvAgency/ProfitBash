import {
  formatDecimal,
  parseDecimal,
  selectAttribution,
  summarizeAttribution,
  type AttributionSelection,
  type AttributionSummary,
  type MetricColumn,
  type MetricsLevel,
} from '@profitbash/engine';
import { AD_PRODUCTS, type AdProduct, type AttributionSetting } from '@profitbash/shared/analytics';
import { sql, type SQL } from 'drizzle-orm';
import { visibleProfilesScope, type ProfileVisibilityInput } from './access';
import { metricsImportedThroughSql, type ReportAdProductSelection } from './amazon-ads-metrics';
import type { Db } from './client';

/**
 * Lesezugriffe für Dashboard und Explorer (`docs/tasks/phase-2.md` 2.4, F2–F7, F10). Jede Abfrage beginnt mit den
 * sichtbaren Profilen aus `visibleProfilesScope()` (ADR 002) und filtert nie selbst nach Organisation.
 *
 * - **Beträge** bleiben Decimal-Strings (Summen in SQL über `numeric`/`bigint`, als Text zurück).
 * - **Zeilen** einer Ebene tragen Beträge in der Originalwährung ihres Profils; **Summen**, Tagesreihe und
 *   Dashboard in der Anzeigewährung (`currency`: `auto` = eine Währung in der Auswahl → diese, sonst EUR).
 *   Umgerechnet wird je Tag über EUR mit dem letzten EZB-Kurs an oder vor dem Tag (wie `convertAmount`):
 *   Betrag × Kurs(Ziel) ÷ Kurs(Quelle). Fehlt ein Kurs, zählt der Betrag nicht und die Währung steht in
 *   `missingFxCurrencies`.
 * - **Attribution** je Zeile als `CASE` über Ad-Typ und Kontotyp (`selectAttribution`), zusammengefasst mit
 *   `summarizeAttribution` über die Kombinationen, die in den Kennzahl-Zeilen vorkommen.
 * - **Obergrenze** `MAX_ANALYTICS_ROWS` (F7): die Zeilen mit dem höchsten Spend (umgerechnet); die Summen gelten
 *   für alle Zeilen der Auswahl.
 */

export const MAX_ANALYTICS_ROWS = 10_000;

export const ANALYTICS_LEVELS = [
  'portfolio',
  'campaign',
  'adGroup',
  'target',
  'productAd',
  'searchTerm',
] as const;
export type AnalyticsLevel = (typeof ANALYTICS_LEVELS)[number];

export interface DateRange {
  /** `YYYY-MM-DD`, Tage in der Zeitzone des jeweiligen Profils (so liegen sie in der DB). */
  from: string;
  to: string;
}

/** Auswahl der Filterleiste (F2); alle Angaben schränken zusätzlich ein (UND). */
export interface AnalyticsSelection extends ProfileVisibilityInput {
  /** Nur Profile dieser Clients (mit `withoutClient` zusätzlich Profile ohne Client). */
  clientIds?: readonly string[] | undefined;
  withoutClient?: boolean | undefined;
  /** Nur diese Profile (interne IDs). */
  profileIds?: readonly string[] | undefined;
  adProducts?: readonly AdProduct[] | undefined;
}

export interface AnalyticsQuery extends AnalyticsSelection {
  period: DateRange;
  comparison?: DateRange | null | undefined;
  /** `auto` oder ein Währungscode (EUR, USD, eine Profilwährung). */
  currency: string;
  attribution: AttributionSetting;
}

/** Drill-Down und Filter des Explorers (F6, F10). */
export interface ExplorerFilter {
  portfolioIds?: readonly string[] | undefined;
  campaignIds?: readonly string[] | undefined;
  adGroupIds?: readonly string[] | undefined;
  /** Entfernte Entities (`removed_at`) mitzählen; Standard nein (`phase-1.md` F10). */
  includeRemoved?: boolean | undefined;
  /** Product Ads: ASINs oder SKUs (auch in `extra.asins`), Groß-/Kleinschreibung egal. */
  productSearch?: readonly string[] | undefined;
}

type Amount = string | null;

export interface MetricSums {
  impressions: Amount;
  clicks: Amount;
  cost: Amount;
  sales: Amount;
  purchases: Amount;
  units: Amount;
  salesSameSku: Amount;
  purchasesSameSku: Amount;
  unitsSameSku: Amount;
  viewableImpressions: Amount;
  /** Kosten nur der Zeilen mit sichtbaren Impressionen (SD, Basis für vCPM). */
  viewableCost: Amount;
}

export interface AnalyticsTotals {
  current: MetricSums;
  comparison: MetricSums | null;
  attribution: AttributionSummary;
  comparisonAttribution: AttributionSummary | null;
  /** Währungen, für die an mindestens einem Tag kein Kurs vorlag (Beträge nicht gezählt). */
  missingFxCurrencies: string[];
}

export interface CurrencyInfo {
  /** Anzeigewährung der Summen. */
  currency: string;
  /** Mindestens ein Betrag lag in einer anderen Währung vor (Anzeige „≈“). */
  converted: boolean;
}

export interface ExplorerRow {
  /** Interne ID; bei Suchbegriffen `targetId:searchTerm`. */
  id: string;
  profileId: string;
  accountName: string;
  countryCode: string;
  /** Originalwährung der Beträge dieser Zeile. */
  currencyCode: string;
  accountType: string;
  /** `null` bei Portfolios (gelten für alle Ad-Typen). */
  adProduct: string | null;
  name: string | null;
  state: string | null;
  removed: boolean;
  /** Aus einem Report angelegt, vom Entity-Sync noch nicht bestätigt (`synced_at` leer). */
  placeholder: boolean;
  /** Ebenenabhängige Felder (Kampagne, Ad Group, Gebot, ASIN …). */
  attributes: Record<string, unknown>;
  /** Es gab Kennzahl-Zeilen im Zeitraum (SB-Kampagnen ohne Kennzahlen: Preview-Lücke). */
  hasMetrics: boolean;
  current: MetricSums;
  comparison: MetricSums | null;
  attribution: AttributionSummary;
}

export interface ExplorerResult extends CurrencyInfo {
  rows: ExplorerRow[];
  totalRows: number;
  truncated: boolean;
  totals: AnalyticsTotals;
}

// ---------------------------------------------------------------------------
// Bausteine
// ---------------------------------------------------------------------------

const COLUMN_SQL: Record<MetricColumn, string> = {
  sales7d: 'sales_7d',
  sales14d: 'sales_14d',
  salesSameSku7d: 'sales_same_sku_7d',
  salesSameSku14d: 'sales_same_sku_14d',
  purchases7d: 'purchases_7d',
  purchases14d: 'purchases_14d',
  purchasesSameSku7d: 'purchases_same_sku_7d',
  purchasesSameSku14d: 'purchases_same_sku_14d',
  units7d: 'units_7d',
  units14d: 'units_14d',
  unitsSameSku7d: 'units_same_sku_7d',
  unitsSameSku14d: 'units_same_sku_14d',
  salesClicks14d: 'sales_clicks_14d',
  purchasesClicks14d: 'purchases_clicks_14d',
  unitsClicks14d: 'units_clicks_14d',
  viewableImpressions: 'viewable_impressions',
};

const MONEY_FIELDS = ['sales', 'salesSameSku'] as const;
const COUNT_FIELDS = ['purchases', 'units', 'purchasesSameSku', 'unitsSameSku'] as const;
type AttributedSumField = (typeof MONEY_FIELDS)[number] | (typeof COUNT_FIELDS)[number];

const SUM_KEYS = [
  'impressions',
  'clicks',
  'cost',
  'sales',
  'purchases',
  'units',
  'salesSameSku',
  'purchasesSameSku',
  'unitsSameSku',
  'viewableImpressions',
  'viewableCost',
] as const satisfies ReadonlyArray<keyof MetricSums>;
const MONEY_KEYS: ReadonlySet<keyof MetricSums> = new Set([
  'cost',
  'sales',
  'salesSameSku',
  'viewableCost',
]);

/** Kontotyp für die Attribution: nur Vendoren weichen ab (F4). */
const vendorKey = (accountType: string) => (accountType === 'vendor' ? 'vendor' : 'other');

/** Spalte je Feld als `CASE` über Ad-Typ und Kontotyp der Kennzahl-Zeile `m` bzw. des Profils `p`. */
function attributedColumn(
  level: MetricsLevel,
  setting: AttributionSetting,
  field: AttributedSumField,
): SQL {
  const branches: SQL[] = [];
  for (const adProduct of AD_PRODUCTS) {
    for (const accountType of ['vendor', 'seller'] as const) {
      const column = selectAttribution({ adProduct, level, accountType, setting })[field];
      const vendor =
        accountType === 'vendor'
          ? sql.raw(`p.account_type = 'vendor'`)
          : sql.raw(`p.account_type <> 'vendor'`);
      branches.push(
        sql`when m.ad_product = ${adProduct} and ${vendor} then ${column ? sql.raw(`m.${COLUMN_SQL[column]}`) : sql.raw('null')}`,
      );
    }
  }
  return sql`(case ${sql.join(branches, sql` `)} else null end)`;
}

const uuidArray = (values: readonly string[]) => sql`${sql.param([...values])}::uuid[]`;
const textArray = (values: readonly string[]) => sql`${sql.param([...values])}::text[]`;

/** Sichtbare Profile der Auswahl als Unterabfrage (`id`, `currency_code`, `account_type`, …). */
async function selectionSql(db: Db, selection: AnalyticsSelection): Promise<SQL | null> {
  const scope = await visibleProfilesScope(db, selection);
  if (scope === null) return null;
  const conditions: SQL[] = [sql`p.id in (${scope.ids})`];
  if (selection.profileIds) conditions.push(sql`p.id = any(${uuidArray(selection.profileIds)})`);
  if (selection.clientIds) {
    conditions.push(
      selection.withoutClient
        ? sql`(p.client_id = any(${uuidArray(selection.clientIds)}) or p.client_id is null)`
        : sql`p.client_id = any(${uuidArray(selection.clientIds)})`,
    );
  } else if (selection.withoutClient) {
    conditions.push(sql`p.client_id is null`);
  }
  return sql`select p.id, p.client_id, p.currency_code, p.account_type, p.account_name, p.country_code
    from amazon_ads_profiles p where ${sql.join(conditions, sql` and `)}`;
}

/** Anzeigewährung und ob umgerechnet wird, aus den Währungen der ausgewählten Profile. */
async function resolveCurrency(
  db: Db,
  selectionQuery: SQL,
  requested: string,
): Promise<CurrencyInfo> {
  const rows = await db.execute<{ currency_code: string }>(
    sql`select distinct s.currency_code from (${selectionQuery}) s order by 1`,
  );
  const currencies = rows.map((row) => row.currency_code);
  const currency =
    requested === 'auto' ? (currencies.length === 1 ? currencies[0]! : 'EUR') : requested;
  return { currency, converted: currencies.some((code) => code !== currency) };
}

interface Periods {
  period: DateRange;
  comparison: DateRange | null;
}

function periodsOf(query: AnalyticsQuery): Periods {
  return { period: query.period, comparison: query.comparison ?? null };
}

const inRange = (range: DateRange) => sql`m.date between ${range.from}::date and ${range.to}::date`;

/** Tage beider Zeiträume (für die Einschränkung der Kennzahl-Tabelle). */
function anyRange({ period, comparison }: Periods): SQL {
  return comparison ? sql`(${inRange(period)} or ${inRange(comparison)})` : inRange(period);
}

/**
 * Umrechnungsfaktor je Tag und Währung in die Anzeigewährung: Kurs(Ziel) ÷ Kurs(Quelle) mit dem letzten Kurs
 * an oder vor dem Tag, `null`, wenn einer fehlt. 30 Nachkommastellen, damit Summen erst bei der Anzeige runden.
 */
function fxSql(selectionQuery: SQL, target: string, { period, comparison }: Periods): SQL {
  const from = comparison
    ? sql`least(${period.from}::date, ${comparison.from}::date)`
    : sql`${period.from}::date`;
  const to = comparison
    ? sql`greatest(${period.to}::date, ${comparison.to}::date)`
    : sql`${period.to}::date`;
  const rate = (currency: SQL) => sql`(case when ${currency} = 'EUR' then 1::numeric else (
      select r.rate from fx_rates r where r.quote = ${currency} and r.date <= d.day
      order by r.date desc limit 1) end)`;
  return sql`select d.day, c.currency,
      case when c.currency = ${target} then 1::numeric
        else round(${rate(sql`${target}::text`)}::numeric(48, 30) / nullif(${rate(sql`c.currency`)}, 0), 30)
      end as factor
    from generate_series(${from}, ${to}, interval '1 day') as d0(ts)
    cross join lateral (select d0.ts::date as day) d
    cross join (select distinct s.currency_code as currency from (${selectionQuery}) s) c`;
}

/**
 * Summen-Ausdrücke eines Zeitraums über die Kennzahl-Zeilen `m` (Profil `p`, Faktor `fx.factor`). `converted`:
 * Beträge in der Anzeigewährung (sonst Originalwährung).
 */
function sumColumns(
  level: MetricsLevel,
  setting: AttributionSetting,
  range: DateRange,
  prefix: string,
  converted: boolean,
): SQL[] {
  const when = inRange(range);
  const money = (expr: SQL) => (converted ? sql`(${expr}) * fx.factor` : expr);
  const col = (name: string, expr: SQL) =>
    sql`sum(${expr}) filter (where ${when}) as ${sql.raw(`${prefix}_${name}`)}`;
  return [
    col('impressions', sql`m.impressions`),
    col('clicks', sql`m.clicks`),
    col('cost', money(sql`m.cost`)),
    col('sales', money(attributedColumn(level, setting, 'sales'))),
    col('purchases', attributedColumn(level, setting, 'purchases')),
    col('units', attributedColumn(level, setting, 'units')),
    col('sales_same_sku', money(attributedColumn(level, setting, 'salesSameSku'))),
    col('purchases_same_sku', attributedColumn(level, setting, 'purchasesSameSku')),
    col('units_same_sku', attributedColumn(level, setting, 'unitsSameSku')),
    col('viewable_impressions', sql`m.viewable_impressions`),
    col('viewable_cost', money(sql`case when m.viewable_impressions is not null then m.cost end`)),
    sql`count(*) filter (where ${when}) as ${sql.raw(`${prefix}_rows`)}`,
    sql`array_agg(distinct m.ad_product || ':' || (case when p.account_type = 'vendor' then 'vendor' else 'other' end))
      filter (where ${when}) as ${sql.raw(`${prefix}_combos`)}`,
  ];
}

const SUM_SQL_NAMES: Record<(typeof SUM_KEYS)[number], string> = {
  impressions: 'impressions',
  clicks: 'clicks',
  cost: 'cost',
  sales: 'sales',
  purchases: 'purchases',
  units: 'units',
  salesSameSku: 'sales_same_sku',
  purchasesSameSku: 'purchases_same_sku',
  unitsSameSku: 'units_same_sku',
  viewableImpressions: 'viewable_impressions',
  viewableCost: 'viewable_cost',
};

/** Summen aus einer Ergebniszeile (Spalten `<prefix>_<name>`, als Text). */
function readSums(row: Record<string, unknown>, prefix: string, roundMoney: boolean): MetricSums {
  const sums = {} as MetricSums;
  for (const key of SUM_KEYS) {
    const value = row[`${prefix}_${SUM_SQL_NAMES[key]}`];
    const text = value === null || value === undefined ? null : String(value);
    sums[key] = text !== null && roundMoney && MONEY_KEYS.has(key) ? roundAmount(text) : text;
  }
  return sums;
}

/** Umgerechnete Beträge auf 12 Nachkommastellen (gerundet wird erst bei der Anzeige, hier nur der Rechenrest). */
function roundAmount(value: string): string {
  return formatDecimal(parseDecimal(value).toDecimalPlaces(12));
}

function selectionsOf(
  level: MetricsLevel,
  setting: AttributionSetting,
  combos: unknown,
): AttributionSelection[] {
  if (!Array.isArray(combos)) return [];
  return combos.flatMap((combo) => {
    const [adProduct, account] = String(combo).split(':');
    if (!AD_PRODUCTS.includes(adProduct as AdProduct)) return [];
    return [
      selectAttribution({
        adProduct: adProduct as AdProduct,
        level,
        accountType: account === 'vendor' ? 'vendor' : 'seller',
        setting,
      }),
    ];
  });
}

/**
 * Zeile ohne Kennzahlen im Zeitraum: Impressionen, Klicks und Kosten sind 0 (Amazon liefert Tage ohne Aktivität
 * nicht); Umsatz usw. 0, wenn Amazon den Wert für Ad-Typ und Ebene liefert, sonst `null` („–“).
 */
function fillEmpty(sums: MetricSums, selection: AttributionSelection | null): MetricSums {
  const filled = { ...sums };
  for (const key of ['impressions', 'clicks', 'cost'] as const) filled[key] ??= '0';
  for (const field of [...MONEY_FIELDS, ...COUNT_FIELDS]) {
    if (filled[field] === null && (selection === null || selection[field] !== null))
      filled[field] = '0';
  }
  return filled;
}

// ---------------------------------------------------------------------------
// Ebenen
// ---------------------------------------------------------------------------

interface LevelSpec {
  metricsLevel: MetricsLevel;
  /** Kennzahl-Tabelle und Gruppierung. */
  metricsTable: string;
  groupKey: SQL;
  /** Spalte der Kennzahl-Zeile (bzw. der Kampagne `c` bei Portfolios), die auf `e.id` zeigt. */
  entityKey: SQL;
  /** Entity-Abfrage mit `e` (Entity) und `p` (Profil der Auswahl), liefert `row_id`, `row_ad_product` und Attribute. */
  entitySql: (filter: ExplorerFilter) => { from: SQL; where: SQL[]; columns: SQL; join: SQL };
}

const removedFilter = (filter: ExplorerFilter, alias = 'e') =>
  filter.includeRemoved ? [] : [sql.raw(`${alias}.removed_at is null`)];

const parentFilters = (
  filter: ExplorerFilter,
  has: { portfolio?: boolean; campaign?: boolean; adGroup?: boolean },
) => {
  const where: SQL[] = [];
  if (has.portfolio && filter.portfolioIds)
    where.push(sql`e.portfolio_id = any(${uuidArray(filter.portfolioIds)})`);
  if (has.campaign && filter.campaignIds)
    where.push(sql`e.campaign_id = any(${uuidArray(filter.campaignIds)})`);
  if (has.adGroup && filter.adGroupIds)
    where.push(sql`e.ad_group_id = any(${uuidArray(filter.adGroupIds)})`);
  return where;
};

const LEVELS: Record<AnalyticsLevel, LevelSpec> = {
  portfolio: {
    metricsLevel: 'campaign',
    metricsTable: 'amazon_ads_campaign_daily_metrics',
    groupKey: sql`c.portfolio_id`,
    entityKey: sql`c.portfolio_id`,
    entitySql: (filter) => ({
      from: sql`amazon_ads_portfolios e`,
      join: sql`a.group_key = e.id`,
      where: [
        ...removedFilter(filter),
        ...(filter.portfolioIds ? [sql`e.id = any(${uuidArray(filter.portfolioIds)})`] : []),
      ],
      columns: sql`e.id::text as row_id, null::text as row_ad_product, e.name, e.state, e.amazon_portfolio_id as amazon_id,
        e.removed_at is not null as removed, e.synced_at is null as placeholder,
        json_build_object('budgetAmount', e.budget_amount::text, 'budgetCurrencyCode', e.budget_currency_code,
          'budgetPolicy', e.budget_policy, 'budgetStartDate', e.budget_start_date, 'budgetEndDate', e.budget_end_date,
          'inBudget', e.in_budget) as attributes`,
    }),
  },
  campaign: {
    metricsLevel: 'campaign',
    metricsTable: 'amazon_ads_campaign_daily_metrics',
    groupKey: sql`m.campaign_id`,
    entityKey: sql`m.campaign_id`,
    entitySql: (filter) => ({
      from: sql`amazon_ads_campaigns e left join amazon_ads_portfolios pf on pf.id = e.portfolio_id`,
      join: sql`a.group_key = e.id`,
      where: [
        ...removedFilter(filter),
        ...parentFilters(filter, { portfolio: true }),
        ...(filter.campaignIds ? [sql`e.id = any(${uuidArray(filter.campaignIds)})`] : []),
      ],
      columns: sql`e.id::text as row_id, e.ad_product as row_ad_product, e.name, e.state, e.amazon_campaign_id as amazon_id,
        e.removed_at is not null as removed, e.synced_at is null as placeholder,
        json_build_object('portfolioId', e.portfolio_id, 'portfolioName', pf.name, 'targetingType', e.targeting_type,
          'budgetAmount', e.budget_amount::text, 'budgetCurrencyCode', e.budget_currency_code, 'budgetType', e.budget_type,
          'biddingStrategy', e.bidding_strategy, 'costType', e.extra->>'costType', 'startDate', e.start_date,
          'endDate', e.end_date) as attributes`,
    }),
  },
  adGroup: {
    metricsLevel: 'adGroup',
    metricsTable: 'amazon_ads_ad_group_daily_metrics',
    groupKey: sql`m.ad_group_id`,
    entityKey: sql`m.ad_group_id`,
    entitySql: (filter) => ({
      from: sql`amazon_ads_ad_groups e join amazon_ads_campaigns c on c.id = e.campaign_id`,
      join: sql`a.group_key = e.id`,
      where: [
        ...removedFilter(filter),
        ...parentFilters(filter, { campaign: true }),
        ...(filter.portfolioIds
          ? [sql`c.portfolio_id = any(${uuidArray(filter.portfolioIds)})`]
          : []),
        ...(filter.adGroupIds ? [sql`e.id = any(${uuidArray(filter.adGroupIds)})`] : []),
      ],
      columns: sql`e.id::text as row_id, e.ad_product as row_ad_product, e.name, e.state, e.amazon_ad_group_id as amazon_id,
        e.removed_at is not null as removed, e.synced_at is null as placeholder,
        json_build_object('campaignId', e.campaign_id, 'campaignName', c.name, 'defaultBid', e.default_bid::text,
          'defaultBidCurrencyCode', e.default_bid_currency_code, 'costType', c.extra->>'costType') as attributes`,
    }),
  },
  target: {
    metricsLevel: 'target',
    metricsTable: 'amazon_ads_target_daily_metrics',
    groupKey: sql`m.target_id`,
    entityKey: sql`m.target_id`,
    entitySql: (filter) => ({
      from: sql`amazon_ads_targets e join amazon_ads_campaigns c on c.id = e.campaign_id
        left join amazon_ads_ad_groups g on g.id = e.ad_group_id`,
      join: sql`a.group_key = e.id`,
      where: [
        ...removedFilter(filter),
        ...parentFilters(filter, { campaign: true, adGroup: true }),
        ...(filter.portfolioIds
          ? [sql`c.portfolio_id = any(${uuidArray(filter.portfolioIds)})`]
          : []),
      ],
      columns: sql`e.id::text as row_id, e.ad_product as row_ad_product,
        coalesce(e.keyword_text, e.expression::text) as name, e.state, e.amazon_target_id as amazon_id,
        e.removed_at is not null as removed, e.synced_at is null as placeholder,
        json_build_object('campaignId', e.campaign_id, 'campaignName', c.name, 'adGroupId', e.ad_group_id,
          'adGroupName', g.name, 'targetType', e.target_type, 'keywordText', e.keyword_text, 'matchType', e.match_type,
          'expression', e.expression, 'bid', e.bid::text, 'bidCurrencyCode', e.bid_currency_code,
          'costType', c.extra->>'costType') as attributes`,
    }),
  },
  productAd: {
    metricsLevel: 'productAd',
    metricsTable: 'amazon_ads_product_ad_daily_metrics',
    groupKey: sql`m.product_ad_id`,
    entityKey: sql`m.product_ad_id`,
    entitySql: (filter) => {
      const where: SQL[] = [
        ...removedFilter(filter),
        ...parentFilters(filter, { campaign: true, adGroup: true }),
        ...(filter.portfolioIds
          ? [sql`c.portfolio_id = any(${uuidArray(filter.portfolioIds)})`]
          : []),
      ];
      if (filter.productSearch) {
        const terms = textArray(filter.productSearch.map((term) => term.trim().toUpperCase()));
        where.push(sql`(upper(e.asin) = any(${terms}) or upper(e.sku) = any(${terms})
          or exists (select 1 from jsonb_array_elements_text(case when jsonb_typeof(e.extra->'asins') = 'array'
            then e.extra->'asins' else '[]'::jsonb end) x(asin) where upper(x.asin) = any(${terms})))`);
      }
      return {
        from: sql`amazon_ads_product_ads e join amazon_ads_campaigns c on c.id = e.campaign_id
          join amazon_ads_ad_groups g on g.id = e.ad_group_id`,
        join: sql`a.group_key = e.id`,
        where,
        columns: sql`e.id::text as row_id, e.ad_product as row_ad_product, coalesce(e.asin, e.sku, e.extra->>'name') as name,
          e.state, e.amazon_ad_id as amazon_id, e.removed_at is not null as removed, e.synced_at is null as placeholder,
          json_build_object('campaignId', e.campaign_id, 'campaignName', c.name, 'adGroupId', e.ad_group_id,
            'adGroupName', g.name, 'asin', e.asin, 'sku', e.sku, 'adType', e.extra->>'adType',
            'asins', case when jsonb_typeof(e.extra->'asins') = 'array' then e.extra->'asins' end) as attributes`,
      };
    },
  },
  searchTerm: {
    metricsLevel: 'searchTerm',
    metricsTable: 'amazon_ads_search_term_daily_metrics',
    groupKey: sql`m.target_id || ':' || m.search_term`,
    entityKey: sql`m.target_id`,
    entitySql: (filter) => ({
      from: sql`amazon_ads_targets e join amazon_ads_campaigns c on c.id = e.campaign_id
        left join amazon_ads_ad_groups g on g.id = e.ad_group_id`,
      join: sql`a.target_id = e.id`,
      where: [
        ...removedFilter(filter),
        ...parentFilters(filter, { campaign: true, adGroup: true }),
        ...(filter.portfolioIds
          ? [sql`c.portfolio_id = any(${uuidArray(filter.portfolioIds)})`]
          : []),
      ],
      columns: sql`a.group_key as row_id, e.ad_product as row_ad_product, a.search_term as name, e.state,
        e.amazon_target_id as amazon_id, e.removed_at is not null as removed, e.synced_at is null as placeholder,
        json_build_object('searchTerm', a.search_term, 'targetId', e.id, 'campaignId', e.campaign_id,
          'campaignName', c.name, 'adGroupId', e.ad_group_id, 'adGroupName', g.name, 'targetType', e.target_type,
          'keywordText', e.keyword_text, 'matchType', e.match_type, 'expression', e.expression) as attributes`,
    }),
  },
};

function sumsJson(prefix: string): SQL {
  const pairs = [
    ...SUM_KEYS.map((key) => `'${key}', ${prefix}_${SUM_SQL_NAMES[key]}::text`),
    `'rows', ${prefix}_rows`,
    `'combos', ${prefix}_combos`,
  ];
  return sql.raw(`json_build_object(${pairs.join(', ')})`);
}

/** Summen über die gefilterten Zeilen (`f`), Spalten `<prefix>_…` summiert, Kombinationen vereinigt. */
function totalsOver(prefix: string): SQL {
  const sums = SUM_KEYS.map((key) => {
    const name = `${prefix}_${SUM_SQL_NAMES[key]}`;
    return `sum(f.${name}) as ${name}`;
  });
  return sql.raw(`${sums.join(', ')}, coalesce(sum(f.${prefix}_rows), 0) as ${prefix}_rows,
    (select array_agg(distinct c) from filtered f2, unnest(f2.${prefix}_combos) c) as ${prefix}_combos`);
}

/** Portfolios: Kennzahlen der Kampagnen (entfernte Kampagnen wie im Kampagnen-Reiter nur mit `includeRemoved`). */
function portfolioJoinSql(level: AnalyticsLevel, filter: ExplorerFilter): SQL {
  if (level !== 'portfolio') return sql``;
  return sql`join amazon_ads_campaigns c on c.id = m.campaign_id and c.portfolio_id is not null
    ${filter.includeRemoved ? sql`` : sql`and c.removed_at is null`}`;
}

/**
 * Filter für Kennzahlen (`m`: Tage, Ad-Typ) und Entities (`e`); der Ad-Typ gilt für beide (Portfolios gelten für
 * alle Ad-Typen, dort nur für die Kennzahlen).
 */
function filtersOf(
  input: AnalyticsQuery & { level: AnalyticsLevel },
  entity: { where: SQL[] },
  periods: Periods,
): { entityWhere: SQL[]; metricsWhere: SQL[] } {
  const metricsWhere: SQL[] = [anyRange(periods)];
  if (!input.adProducts) return { entityWhere: entity.where, metricsWhere };
  const adProducts = textArray(input.adProducts);
  metricsWhere.push(sql`m.ad_product = any(${adProducts})`);
  return {
    entityWhere:
      input.level === 'portfolio'
        ? entity.where
        : [...entity.where, sql`e.ad_product = any(${adProducts})`],
    metricsWhere,
  };
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

const EMPTY_SUMMARY: AttributionSummary = summarizeAttribution([]);

function emptyResult(currency: string): ExplorerResult {
  const zero = fillEmpty(readSums({}, 'x', false), null);
  return {
    currency: currency === 'auto' ? 'EUR' : currency,
    converted: false,
    rows: [],
    totalRows: 0,
    truncated: false,
    totals: {
      current: zero,
      comparison: null,
      attribution: EMPTY_SUMMARY,
      comparisonAttribution: null,
      missingFxCurrencies: [],
    },
  };
}

/**
 * Zeilen einer Ebene mit Summen für Zeitraum und Vergleichszeitraum (F6), Summenzeile über alle Zeilen der
 * Auswahl, gekürzt auf `limit` Zeilen mit dem höchsten Spend (F7). Entities ohne Kennzahlen erscheinen mit 0;
 * Suchbegriffe nur mit Kennzahlen.
 */
export async function queryExplorerRows(
  db: Db,
  input: AnalyticsQuery & { level: AnalyticsLevel; filter?: ExplorerFilter; limit?: number },
): Promise<ExplorerResult> {
  const selectionQuery = await selectionSql(db, input);
  if (selectionQuery === null) return emptyResult(input.currency);
  const { currency, converted } = await resolveCurrency(db, selectionQuery, input.currency);
  const periods = periodsOf(input);
  const spec = LEVELS[input.level];
  const filter = input.filter ?? {};
  const limit = Math.min(input.limit ?? MAX_ANALYTICS_ROWS, MAX_ANALYTICS_ROWS);
  const entity = spec.entitySql(filter);
  const { entityWhere, metricsWhere } = filtersOf(input, entity, periods);

  // Portfolios: Kennzahlen der Kampagnen (entfernte Kampagnen wie im Kampagnen-Reiter nur mit includeRemoved).
  const portfolioJoin = portfolioJoinSql(input.level, filter);
  const searchTermColumns =
    input.level === 'searchTerm'
      ? sql`, min(m.target_id::text)::uuid as target_id, min(m.search_term) as search_term`
      : sql``;

  const sumSets = (convertedMoney: boolean, suffix: string) => [
    ...sumColumns(
      spec.metricsLevel,
      input.attribution,
      periods.period,
      `cur${suffix}`,
      convertedMoney,
    ),
    ...(periods.comparison
      ? sumColumns(
          spec.metricsLevel,
          input.attribution,
          periods.comparison,
          `cmp${suffix}`,
          convertedMoney,
        )
      : []),
  ];

  const query = sql`
    with sel as (${selectionQuery}),
    fx as (${fxSql(sql`select * from sel`, currency, periods)}),
    agg as (
      select ${spec.groupKey} as group_key ${searchTermColumns},
        ${sql.join([...sumSets(false, ''), ...sumSets(true, 'x')], sql`, `)},
        array_agg(distinct m.currency_code) filter (where fx.factor is null) as missing_fx
      from ${sql.raw(spec.metricsTable)} m
      join sel p on p.id = m.profile_id
      ${portfolioJoin}
      left join fx on fx.day = m.date and fx.currency = m.currency_code
      where ${sql.join(metricsWhere, sql` and `)}
      group by 1
    ),
    filtered as (
      select ${entity.columns}, p.id as profile_id, p.account_name, p.country_code, p.currency_code, p.account_type,
        a.*
      from ${entity.from}
      join sel p on p.id = e.profile_id
      ${input.level === 'searchTerm' ? sql`join` : sql`left join`} agg a on ${entity.join}
      ${entityWhere.length > 0 ? sql`where ${sql.join(entityWhere, sql` and `)}` : sql``}
    ),
    tot as (
      select ${totalsOver('curx')}${periods.comparison ? sql`, ${totalsOver('cmpx')}` : sql``},
        (select array_agg(distinct c) from filtered f3, unnest(f3.missing_fx) c) as missing_fx
      from filtered f
    )
    select
      (select count(*) from filtered)::int as total_rows,
      (select json_build_object('cur', ${sumsJson('curx')}${periods.comparison ? sql`, 'cmp', ${sumsJson('cmpx')}` : sql``},
        'missing_fx', missing_fx) from tot) as totals,
      (select coalesce(json_agg(r), '[]'::json) from (
        select f.row_id, f.row_ad_product, f.name, f.state, f.amazon_id, f.removed, f.placeholder, f.attributes,
          f.profile_id, f.account_name, f.country_code, f.currency_code, f.account_type,
          ${sumsJson('cur')} as cur${periods.comparison ? sql`, ${sumsJson('cmp')} as cmp` : sql``}
        from filtered f
        order by f.curx_cost desc nulls last, f.name asc nulls last, f.row_id asc
        limit ${limit}
      ) r) as rows`;

  const [result] = await db.execute<{
    total_rows: number;
    totals: {
      cur: Record<string, unknown>;
      cmp?: Record<string, unknown>;
      missing_fx: string[] | null;
    };
    rows: Array<
      Record<string, unknown> & { cur: Record<string, unknown>; cmp?: Record<string, unknown> }
    >;
  }>(query);
  if (!result) return emptyResult(input.currency);

  const level = spec.metricsLevel;
  const rows = result.rows.map((row): ExplorerRow => {
    const adProduct = (row.row_ad_product as string | null) ?? null;
    const own =
      adProduct && AD_PRODUCTS.includes(adProduct as AdProduct)
        ? selectAttribution({
            adProduct: adProduct as AdProduct,
            level,
            accountType: vendorKey(String(row.account_type)) === 'vendor' ? 'vendor' : 'seller',
            setting: input.attribution,
          })
        : null;
    const sums = (json: Record<string, unknown> | undefined) => {
      if (!json) return null;
      const read = readSums(renamePrefix(json), 'x', false);
      return Number(json.rows ?? 0) > 0 ? read : fillEmpty(read, own);
    };
    const hasMetrics = Number(row.cur.rows ?? 0) > 0;
    return {
      id: String(row.row_id),
      profileId: String(row.profile_id),
      accountName: String(row.account_name),
      countryCode: String(row.country_code),
      currencyCode: String(row.currency_code),
      accountType: String(row.account_type),
      adProduct,
      name: (row.name as string | null) ?? null,
      state: (row.state as string | null) ?? null,
      removed: Boolean(row.removed),
      placeholder: Boolean(row.placeholder),
      attributes: { amazonId: row.amazon_id, ...(row.attributes as Record<string, unknown>) },
      hasMetrics,
      current: sums(row.cur)!,
      comparison: sums(row.cmp),
      attribution: summarizeAttribution(
        hasMetrics ? selectionsOf(level, input.attribution, row.cur.combos) : own ? [own] : [],
      ),
    };
  });

  const totals = result.totals;
  const totalSums = (json: Record<string, unknown> | undefined) => {
    if (!json) return null;
    const read = readSums(renamePrefix(json), 'x', converted);
    return Number(json.rows ?? 0) > 0 ? read : fillEmpty(read, null);
  };
  return {
    currency,
    converted,
    rows,
    totalRows: result.total_rows,
    truncated: result.total_rows > rows.length,
    totals: {
      current: totalSums(totals.cur)!,
      comparison: totalSums(totals.cmp),
      attribution: summarizeAttribution(selectionsOf(level, input.attribution, totals.cur.combos)),
      comparisonAttribution: totals.cmp
        ? summarizeAttribution(selectionsOf(level, input.attribution, totals.cmp.combos))
        : null,
      missingFxCurrencies: [...(totals.missing_fx ?? [])].sort(),
    },
  };
}

/** `sumsJson` nutzt die Schlüssel aus `SUM_KEYS`; `readSums` erwartet `<prefix>_<sql-name>`. */
function renamePrefix(json: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of SUM_KEYS) out[`x_${SUM_SQL_NAMES[key]}`] = json[key];
  return out;
}

// ---------------------------------------------------------------------------
// Tagesreihe
// ---------------------------------------------------------------------------

export interface DayTotals {
  date: string;
  current: MetricSums;
}

export interface TimeSeriesResult extends CurrencyInfo {
  /** Nur Tage mit Kennzahl-Zeilen; Lücken füllt die Anzeige (Historie beginnt mit dem ersten Sync, F5). */
  days: DayTotals[];
  comparisonDays: DayTotals[];
  attribution: AttributionSummary;
  missingFxCurrencies: string[];
}

/**
 * Tagesverlauf der Auswahl in der Anzeigewährung (Chart über dem Grid, Hero-Kachel des Dashboards), mit denselben
 * Filtern wie `queryExplorerRows`; `entityIds` beschränkt auf markierte Zeilen (IDs wie in `ExplorerRow.id`).
 */
export async function queryTimeSeries(
  db: Db,
  input: AnalyticsQuery & {
    level: AnalyticsLevel;
    filter?: ExplorerFilter;
    entityIds?: readonly string[];
  },
): Promise<TimeSeriesResult> {
  const selectionQuery = await selectionSql(db, input);
  const empty = (currency: string): TimeSeriesResult => ({
    currency: currency === 'auto' ? 'EUR' : currency,
    converted: false,
    days: [],
    comparisonDays: [],
    attribution: EMPTY_SUMMARY,
    missingFxCurrencies: [],
  });
  if (selectionQuery === null) return empty(input.currency);
  const { currency, converted } = await resolveCurrency(db, selectionQuery, input.currency);
  const periods = periodsOf(input);
  const spec = LEVELS[input.level];
  const filter = input.filter ?? {};
  const entity = spec.entitySql(filter);
  const { entityWhere, metricsWhere } = filtersOf(input, entity, periods);
  const where = [...metricsWhere, ...entityWhere];
  if (input.entityIds) {
    where.push(sql`(${spec.groupKey})::text = any(${textArray(input.entityIds)})`);
  }
  const range = periods.comparison
    ? { from: periods.comparison.from, to: periods.period.to }
    : periods.period;
  const rows = await db.execute<Record<string, unknown> & { date: string }>(sql`
    with sel as (${selectionQuery}),
    fx as (${fxSql(sql`select * from sel`, currency, periods)})
    select to_char(m.date, 'YYYY-MM-DD') as date,
      ${sql.join(sumColumns(spec.metricsLevel, input.attribution, range, 'd', true), sql`, `)},
      array_agg(distinct m.currency_code) filter (where fx.factor is null) as missing_fx
    from ${sql.raw(spec.metricsTable)} m
    join sel p on p.id = m.profile_id
    ${portfolioJoinSql(input.level, filter)}
    join (${entity.from}) on e.id = ${spec.entityKey}
    left join fx on fx.day = m.date and fx.currency = m.currency_code
    where ${sql.join(where, sql` and `)}
    group by m.date
    order by m.date`);

  const inPeriod = (date: string, r: DateRange) => date >= r.from && date <= r.to;
  const toDay = (row: Record<string, unknown> & { date: string }): DayTotals => ({
    date: row.date,
    current: readSums(row, 'd', converted),
  });
  const periodRows = rows.filter((row) => inPeriod(row.date, periods.period));
  const combos = [...new Set(periodRows.flatMap((row) => (row.d_combos as string[] | null) ?? []))];
  return {
    currency,
    converted,
    days: periodRows.map(toDay),
    comparisonDays: periods.comparison
      ? rows.filter((row) => inPeriod(row.date, periods.comparison!)).map(toDay)
      : [],
    attribution: summarizeAttribution(selectionsOf(spec.metricsLevel, input.attribution, combos)),
    missingFxCurrencies: [
      ...new Set(rows.flatMap((row) => (row.missing_fx as string[] | null) ?? [])),
    ].sort(),
  };
}

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

export interface DashboardGroup {
  /** Client-ID (`null` = ohne Client), Profil-ID oder Ad-Typ. */
  key: string | null;
  /** Name des Clients bzw. Profils; `null` bei „Ohne Client“ und Ad-Typen. */
  label: string | null;
  /** Nur Profile: Land und Originalwährung. */
  countryCode?: string;
  currencyCode?: string;
  current: MetricSums;
  comparison: MetricSums | null;
  attribution: AttributionSummary;
}

export interface DashboardResult extends CurrencyInfo {
  totals: AnalyticsTotals;
  byClient: DashboardGroup[];
  byProfile: DashboardGroup[];
  byAdProduct: DashboardGroup[];
}

/**
 * Summen fürs Dashboard (F11) aus den Kampagnen-Kennzahlen, in der Anzeigewährung: gesamt und je Client, Profil und
 * Ad-Typ (eine Abfrage mit `grouping sets`). Zählt alle Kampagnen (auch entfernte: ihr Spend war echt); der
 * Kampagnen-Reiter des Explorers blendet entfernte standardmäßig aus.
 */
export async function queryDashboard(db: Db, input: AnalyticsQuery): Promise<DashboardResult> {
  const selectionQuery = await selectionSql(db, input);
  if (selectionQuery === null) {
    const empty = emptyResult(input.currency);
    return {
      currency: empty.currency,
      converted: false,
      totals: empty.totals,
      byClient: [],
      byProfile: [],
      byAdProduct: [],
    };
  }
  const { currency, converted } = await resolveCurrency(db, selectionQuery, input.currency);
  const periods = periodsOf(input);
  const where: SQL[] = [anyRange(periods)];
  if (input.adProducts) where.push(sql`m.ad_product = any(${textArray(input.adProducts)})`);
  const level: MetricsLevel = 'campaign';
  const rows = await db.execute<Record<string, unknown>>(sql`
    with sel as (${selectionQuery}),
    fx as (${fxSql(sql`select * from sel`, currency, periods)}),
    g as (
      select grouping(p.client_id) as g_client, grouping(p.id) as g_profile, grouping(m.ad_product) as g_ad_product,
        p.client_id, p.id as profile_id, m.ad_product,
        ${sql.join(
          [
            ...sumColumns(level, input.attribution, periods.period, 'cur', true),
            ...(periods.comparison
              ? sumColumns(level, input.attribution, periods.comparison, 'cmp', true)
              : []),
          ],
          sql`, `,
        )},
        array_agg(distinct m.currency_code) filter (where fx.factor is null) as missing_fx
      from amazon_ads_campaign_daily_metrics m
      join sel p on p.id = m.profile_id
      left join fx on fx.day = m.date and fx.currency = m.currency_code
      where ${sql.join(where, sql` and `)}
      group by grouping sets ((p.client_id), (p.id), (m.ad_product), ())
    )
    select g.*, cl.name as client_name, pr.account_name, pr.country_code, pr.currency_code
    from g
    left join clients cl on cl.id = g.client_id
    left join sel pr on pr.id = g.profile_id
    order by cl.name asc nulls last, pr.account_name asc nulls last, g.ad_product asc nulls last`);

  const sumsOf = (row: Record<string, unknown>, prefix: 'cur' | 'cmp') => {
    const read = readSums(row, prefix, converted);
    return Number(row[`${prefix}_rows`] ?? 0) > 0 ? read : fillEmpty(read, null);
  };
  const group = (
    row: Record<string, unknown>,
    key: string | null,
    label: string | null,
  ): DashboardGroup => ({
    key,
    label,
    current: sumsOf(row, 'cur'),
    comparison: periods.comparison ? sumsOf(row, 'cmp') : null,
    attribution: summarizeAttribution(selectionsOf(level, input.attribution, row.cur_combos)),
  });
  const flag = (row: Record<string, unknown>, name: string) => Number(row[name]) === 1;
  const totalRow =
    rows.find(
      (row) => flag(row, 'g_client') && flag(row, 'g_profile') && flag(row, 'g_ad_product'),
    ) ?? {};
  return {
    currency,
    converted,
    totals: {
      current: sumsOf(totalRow, 'cur'),
      comparison: periods.comparison ? sumsOf(totalRow, 'cmp') : null,
      attribution: summarizeAttribution(
        selectionsOf(level, input.attribution, totalRow.cur_combos),
      ),
      comparisonAttribution: periods.comparison
        ? summarizeAttribution(selectionsOf(level, input.attribution, totalRow.cmp_combos))
        : null,
      missingFxCurrencies: [...((totalRow.missing_fx as string[] | null) ?? [])].sort(),
    },
    byClient: rows
      .filter((row) => !flag(row, 'g_client'))
      .map((row) =>
        group(
          row,
          (row.client_id as string | null) ?? null,
          (row.client_name as string | null) ?? null,
        ),
      ),
    byProfile: rows
      .filter((row) => !flag(row, 'g_profile'))
      .map((row) => ({
        ...group(row, String(row.profile_id), String(row.account_name)),
        countryCode: String(row.country_code),
        currencyCode: String(row.currency_code),
      })),
    byAdProduct: rows
      .filter((row) => !flag(row, 'g_ad_product'))
      .map((row) => group(row, String(row.ad_product), null)),
  };
}

// ---------------------------------------------------------------------------
// Filterleiste und Datenstand
// ---------------------------------------------------------------------------

/**
 * Wählbare Anzeigewährungen (F3): EUR, USD und die Währungen der sichtbaren Profile, soweit die EZB sie
 * veröffentlicht (Kurs in `fx_rates`). Kein Mitglied: leer.
 */
export async function listSelectableCurrencies(
  db: Db,
  input: ProfileVisibilityInput,
): Promise<string[]> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return [];
  const rows = await db.execute<{ currency: string }>(sql`
    select c.currency from (
      select 'EUR'::text as currency
      union select 'USD'
      union select p.currency_code from amazon_ads_profiles p where p.id in (${scope.ids})
    ) c
    where c.currency in ('EUR', 'USD') or exists (select 1 from fx_rates r where r.quote = c.currency)
    order by c.currency`);
  return rows.map((row) => row.currency);
}

export interface DataStatus {
  /** Ältester „Daten bis“ der ausgewählten Profile mit Daten (Minimum über deren synchronisierte Ad-Typen). */
  dataThrough: string | null;
  /** Ab hier sind die Tage vorläufig (die letzten 14 Tage bis „Daten bis“, Amazon korrigiert noch, F5). */
  provisionalFrom: string | null;
  /** Erster Tag mit Kennzahlen in der Auswahl (davor zeigt die App „keine Daten“ statt 0). */
  earliestDate: string | null;
  /** Ausgewählte Profile ohne „Daten bis“ (neu verbunden oder ein Ad-Typ hängt). */
  profilesWithoutData: number;
}

/** Tage, die vor „Daten bis“ als vorläufig gelten (inklusive „Daten bis“). */
export const PROVISIONAL_DAYS = 14;

export async function queryDataStatus(
  db: Db,
  selection: AnalyticsSelection,
  adProductSelection: ReportAdProductSelection,
): Promise<DataStatus> {
  const selectionQuery = await selectionSql(db, selection);
  if (selectionQuery === null) {
    return { dataThrough: null, provisionalFrom: null, earliestDate: null, profilesWithoutData: 0 };
  }
  const [row] = await db.execute<{
    data_through: string | null;
    without_data: number;
    earliest: string | null;
  }>(sql`
    select to_char(min(x.through::date), 'YYYY-MM-DD') as data_through,
      (count(*) filter (where x.through is null))::int as without_data,
      (select to_char(min(m.date), 'YYYY-MM-DD') from amazon_ads_campaign_daily_metrics m
        where m.profile_id in (select s.id from (${selectionQuery}) s)
          ${selection.adProducts ? sql`and m.ad_product = any(${textArray(selection.adProducts)})` : sql``}) as earliest
    from (
      select ${metricsImportedThroughSql(adProductSelection)} as through
      from amazon_ads_profiles
      where amazon_ads_profiles.id in (select s.id from (${selectionQuery}) s)
    ) x`);
  const dataThrough = row?.data_through ?? null;
  return {
    dataThrough,
    provisionalFrom: dataThrough ? addDays(dataThrough, -(PROVISIONAL_DAYS - 1)) : null,
    earliestDate: row?.earliest ?? null,
    profilesWithoutData: row?.without_data ?? 0,
  };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}
