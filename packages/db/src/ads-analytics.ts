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
  // Gleiche Spalten zusammenfassen: meist bleiben ein bis zwei Zweige (z. B. SP-Seller 7 Tage, sonst 14 Tage).
  const byColumn = new Map<string, number[]>();
  COMBOS.forEach((combo, index) => {
    const column = selectAttribution({
      adProduct: combo.adProduct,
      level,
      accountType: combo.vendor ? 'vendor' : 'seller',
      setting,
    })[field];
    if (column)
      byColumn.set(COLUMN_SQL[column], [...(byColumn.get(COLUMN_SQL[column]) ?? []), index]);
  });
  if (byColumn.size === 0) return sql.raw('null');
  const branches = [...byColumn].map(
    ([column, indexes]) => `when y.k in (${indexes.join(', ')}) then y.${column}`,
  );
  return sql.raw(`(case ${branches.join(' ')} end)`);
}

/** Index der Kombination aus Ad-Typ und Kontotyp wie in `COMBOS` (unbekannter Ad-Typ: negativ). */
const COMBO_INDEX_SQL = sql.raw(
  `((case m.ad_product ${AD_PRODUCTS.map(
    (adProduct, index) => `when '${adProduct}' then ${index * 2}`,
  ).join(' ')} else -100 end) + (case when p.account_type = 'vendor' then 0 else 1 end))`,
);

/** Spalten der Kennzahl-Tabellen, die die Attribution liest. */
const ATTRIBUTION_SOURCE_COLUMNS = Object.values(COLUMN_SQL)
  .filter((column) => column !== 'viewable_impressions')
  .map((column) => `m.${column}`)
  .join(', ');

/**
 * Abfrage über viele Kennzahl-Zeilen mit mehr Arbeitsspeicher für Hash-Aggregation und Sortierung (`set local`
 * gilt nur in dieser Transaktion). Mit dem Standard (4 MB) lagert Postgres bei 10 000 Zeilen auf die Platte aus.
 */
async function executeLarge<T extends Record<string, unknown>>(db: Db, query: SQL): Promise<T[]> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local work_mem = '64MB'`);
    return [...(await tx.execute<T>(query))] as T[];
  });
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
/** Anzeigewährung und ob umgerechnet würde, für Antworten ohne Beträge (Negatives). */
export async function resolveDisplayCurrency(
  db: Db,
  input: AnalyticsSelection & { currency: string },
): Promise<CurrencyInfo> {
  const selectionQuery = await selectionSql(db, input);
  if (selectionQuery === null)
    return { currency: input.currency === 'auto' ? 'EUR' : input.currency, converted: false };
  const { currency, converted } = await resolveCurrency(db, selectionQuery, input.currency);
  return { currency, converted };
}

async function resolveCurrency(
  db: Db,
  selectionQuery: SQL,
  requested: string,
): Promise<CurrencyInfo & { currencies: string[]; profileIds: string[] }> {
  const rows = await db.execute<{ id: string; currency_code: string }>(
    sql`select s.id, s.currency_code from (${selectionQuery}) s order by s.currency_code, s.id`,
  );
  const currencies = [...new Set(rows.map((row) => row.currency_code))];
  const profileIds = rows.map((row) => row.id);
  const currency =
    requested === 'auto' ? (currencies.length === 1 ? currencies[0]! : 'EUR') : requested;
  return {
    currency,
    converted: currencies.some((code) => code !== currency),
    currencies,
    profileIds,
  };
}

interface Periods {
  period: DateRange;
  comparison: DateRange | null;
}

function periodsOf(query: AnalyticsQuery): Periods {
  return { period: query.period, comparison: query.comparison ?? null };
}

const inRange = (range: DateRange) => sql`m.date between ${range.from}::date and ${range.to}::date`;

/**
 * Tage beider Zeiträume. Die umschließende Spanne steht vorn, damit der Index (`profile_id`, `date`) einen
 * Bereich liest statt aller Tage des Profils.
 */
function anyRange({ period, comparison }: Periods): SQL {
  if (!comparison) return inRange(period);
  return sql`m.date between least(${period.from}::date, ${comparison.from}::date)
      and greatest(${period.to}::date, ${comparison.to}::date)
    and (${inRange(period)} or ${inRange(comparison)})`;
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
 * Kennzahl-Zeilen als abgeleitete Tabelle `x`: Attribution (`a_*`), Faktor und Zeitraum-Merker werden je Zeile
 * **einmal** berechnet (`offset 0` verhindert, dass Postgres die Ausdrücke in jedes Aggregat zurückkopiert).
 * `body` enthält die Joins ab `m` (Kennzahlen) und `p` (Auswahl), `select` weitere Spalten (Gruppierung).
 */
function metricRowsSql(input: {
  /** Ausgewählte, sichtbare Profile (aus `selectionSql`): als Liste, damit Postgres die Menge richtig schätzt. */
  profileIds: readonly string[];
  level: MetricsLevel;
  setting: AttributionSetting;
  periods: Periods;
  table: string;
  select: SQL;
  joins: SQL;
  where: SQL[];
}): SQL {
  const { level, setting, periods } = input;
  const attributed = (field: AttributedSumField) => attributedColumn(level, setting, field);
  const flag = (range: DateRange) => sql`y.date between ${range.from}::date and ${range.to}::date`;
  return sql`(select y.*,
      ${attributed('sales')} as a_sales, ${attributed('purchases')} as a_purchases, ${attributed('units')} as a_units,
      ${attributed('salesSameSku')} as a_sales_same_sku, ${attributed('purchasesSameSku')} as a_purchases_same_sku,
      ${attributed('unitsSameSku')} as a_units_same_sku,
      ${flag(periods.period)} as in_cur,
      ${periods.comparison ? flag(periods.comparison) : sql`false`} as in_cmp
    from (
      select ${input.select}, m.date, m.currency_code, m.ad_product, p.account_type = 'vendor' as vendor,
        ${COMBO_INDEX_SQL} as k, m.impressions, m.clicks, m.cost, m.viewable_impressions,
        ${sql.raw(ATTRIBUTION_SOURCE_COLUMNS)},
        fxa.factors[(m.date - fxa.first_day) + 1][array_position(fxa.currencies, m.currency_code)] as factor
      from ${sql.raw(input.table)} m
      join amazon_ads_profiles p on p.id = m.profile_id
      ${input.joins}
      cross join fxa
      where m.profile_id = any(${uuidArray(input.profileIds)}) and ${sql.join(input.where, sql` and `)}
      offset 0
    ) y
    offset 0) x`;
}

/**
 * Umrechnung als CTEs `fx` (Tag × Währung → Faktor) und `fxa` (dieselben Faktoren als Matrix mit `first_day` und
 * `currencies`): Die Kennzahl-Zeilen lesen ihren Faktor per Index statt über einen Join, den Postgres bei
 * Hunderttausenden Zeilen schlecht schätzt (Sortierung auf die Platte).
 */
function fxCtes(target: string, periods: Periods): SQL {
  return sql`fx as (${fxSql(sql`select * from sel`, target, periods)}),
    fxa as (
      select min(d.day) as first_day, array_agg(d.factors order by d.day) as factors,
        (select array_agg(c.currency order by c.currency) from (select distinct fx.currency from fx) c) as currencies
      from (select fx.day, array_agg(fx.factor order by fx.currency) as factors from fx group by fx.day) d
    )`;
}

/**
 * Summen eines Zeitraums (`flag`: `in_cur`/`in_cmp`) über `x`. `converted`: Beträge × Faktor (Anzeigewährung);
 * `combos`: Merker je Kombination aus Ad-Typ und Kontotyp (für `summarizeAttribution`).
 */
function sumColumns(
  prefix: string,
  flag: 'in_cur' | 'in_cmp' | 'all',
  options: { converted: boolean; combos: boolean },
): SQL[] {
  const money = (column: string) => (options.converted ? `x.${column} * x.factor` : `x.${column}`);
  // Umgerechnet zählen nur Zeilen mit Kurs, auch bei Klicks und Impressionen: Sonst stammten CPC, CPM usw. aus
  // ungleichen Mengen. Welche Währung fehlte, melden die Merker `missing…`.
  const conditions = [
    ...(flag === 'all' ? [] : [`x.${flag}`]),
    ...(options.converted ? ['x.factor is not null'] : []),
  ];
  const when = conditions.length > 0 ? ` filter (where ${conditions.join(' and ')})` : '';
  const col = (name: string, expr: string) => `sum(${expr})${when} as ${prefix}_${name}`;
  const viewableCost = options.converted
    ? '(case when x.viewable_impressions is not null then x.cost end) * x.factor'
    : 'case when x.viewable_impressions is not null then x.cost end';
  const moneyColumns = [
    col('cost', money('cost')),
    col('sales', money('a_sales')),
    col('sales_same_sku', money('a_sales_same_sku')),
    col('viewable_cost', viewableCost),
  ];
  const columns = [
    ...moneyColumns,
    col('impressions', 'x.impressions'),
    col('clicks', 'x.clicks'),
    col('purchases', 'x.a_purchases'),
    col('units', 'x.a_units'),
    col('purchases_same_sku', 'x.a_purchases_same_sku'),
    col('units_same_sku', 'x.a_units_same_sku'),
    col('viewable_impressions', 'x.viewable_impressions'),
    `count(*)${when} as ${prefix}_rows`,
    // Merker statt `array_agg(distinct …)`: hashbar, `distinct` erzwänge eine Sortierung.
    ...(options.combos
      ? COMBOS.map(
          (combo, index) =>
            `coalesce(bool_or(x.ad_product = '${combo.adProduct}' and ${combo.vendor ? '' : 'not '}x.vendor)${when},
              false) as ${prefix}_c${index}`,
        )
      : []),
  ];
  return columns.map((column) => sql.raw(column));
}

/** Merker je Währung, ob an einem Tag der Kurs fehlte (`missing_<i>`, Reihenfolge wie `currencies`). */
function missingFxColumns(currencies: readonly string[]): SQL[] {
  return currencies.map(
    (code, index) =>
      sql`coalesce(bool_or(x.factor is null and x.currency_code = ${code}), false) as ${sql.raw(`missing_${index}`)}`,
  );
}

function missingFxOf(
  rows: ReadonlyArray<Record<string, unknown>>,
  currencies: readonly string[],
): string[] {
  return currencies.filter((_, index) => rows.some((row) => row[`missing_${index}`] === true));
}

/** Kombinationen aus Ad-Typ und Kontotyp, die die Attribution unterscheidet (F4: nur Vendoren weichen ab). */
const COMBOS = AD_PRODUCTS.flatMap((adProduct) =>
  [true, false].map((vendor) => ({
    adProduct,
    vendor,
    key: `${adProduct}:${vendor ? 'vendor' : 'other'}`,
  })),
);

/** Vorkommende Kombinationen aus den Merkern `<prefix>c0` … einer Ergebniszeile. */
function combosOf(row: Record<string, unknown> | undefined, prefix: string): string[] {
  if (!row) return [];
  return COMBOS.flatMap((combo, index) => (row[`${prefix}c${index}`] === true ? [combo.key] : []));
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
  /** Spalten der Gruppierung in `x` (`group_key` bzw. `target_id` und `search_term`). */
  groupSelect: SQL;
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
    groupSelect: sql`c.portfolio_id as group_key`,
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
    groupSelect: sql`m.campaign_id as group_key`,
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
    groupSelect: sql`m.ad_group_id as group_key`,
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
    groupSelect: sql`m.target_id as group_key`,
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
    groupSelect: sql`m.product_ad_id as group_key`,
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
    groupSelect: sql`m.target_id, m.search_term`,
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
      columns: sql`a.target_id::text || ':' || a.search_term as row_id, e.ad_product as row_ad_product, a.search_term as name, e.state,
        e.amazon_target_id as amazon_id, e.removed_at is not null as removed, e.synced_at is null as placeholder,
        json_build_object('searchTerm', a.search_term, 'targetId', e.id, 'campaignId', e.campaign_id,
          'campaignName', c.name, 'adGroupId', e.ad_group_id, 'adGroupName', g.name, 'targetType', e.target_type,
          'keywordText', e.keyword_text, 'matchType', e.match_type, 'expression', e.expression) as attributes`,
    }),
  },
};

function sumsJson(prefix: string, combos: boolean): SQL {
  const pairs = [
    ...SUM_KEYS.map((key) => `'${key}', ${prefix}_${SUM_SQL_NAMES[key]}::text`),
    `'rows', ${prefix}_rows`,
    ...(combos ? COMBOS.map((_, index) => `'c${index}', ${prefix}_c${index}`) : []),
  ];
  return sql.raw(`json_build_object(${pairs.join(', ')})`);
}

/**
 * Summen über die gefilterten Zeilen (`f`, Spalten `<prefix>_…`). Kombinationen aus Ad-Typ und Kontotyp: bei
 * Portfolios aus den Merkern der Zeilen, sonst aus Ad-Typ und Kontotyp der Zeilen mit Kennzahlen (`rowsPrefix`).
 */
function totalsOver(prefix: string, rowsPrefix: string, level: AnalyticsLevel): SQL {
  const sums = SUM_KEYS.map((key) => {
    const name = SUM_SQL_NAMES[key];
    return `sum(f.${prefix}_${name}) as ${prefix}_${name}`;
  });
  const combos = COMBOS.map((combo, index) =>
    level === 'portfolio'
      ? `coalesce(bool_or(f.${rowsPrefix}_c${index}), false) as ${prefix}_c${index}`
      : `coalesce(bool_or(f.row_ad_product = '${combo.adProduct}'
          and f.account_type ${combo.vendor ? '=' : '<>'} 'vendor') filter (where f.${rowsPrefix}_rows > 0), false)
          as ${prefix}_c${index}`,
  );
  return sql.raw(
    `${[...sums, ...combos].join(', ')}, coalesce(sum(f.${prefix}_rows), 0) as ${prefix}_rows`,
  );
}

/** Portfolios: Kennzahlen der Kampagnen (entfernte Kampagnen wie im Kampagnen-Reiter nur mit `includeRemoved`). */
function portfolioJoinSql(level: AnalyticsLevel, filter: ExplorerFilter): SQL {
  if (level !== 'portfolio') return sql``;
  return sql`join amazon_ads_campaigns c on c.id = m.campaign_id and c.portfolio_id is not null
    ${filter.includeRemoved ? sql`` : sql`and c.removed_at is null`}`;
}

/** Join der Kennzahl-Zeilen auf ihre Entity `e` (mit Profil, damit der Schlüssel-Index greift). */
function entityJoinSql(spec: LevelSpec, entity: { from: SQL }): SQL {
  return sql`join (${entity.from}) on e.id = ${spec.entityKey} and e.profile_id = m.profile_id`;
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
  const { currency, converted, profileIds } = await resolveCurrency(
    db,
    selectionQuery,
    input.currency,
  );
  const periods = periodsOf(input);
  const spec = LEVELS[input.level];
  const filter = input.filter ?? {};
  const limit = Math.min(input.limit ?? MAX_ANALYTICS_ROWS, MAX_ANALYTICS_ROWS);
  const entity = spec.entitySql(filter);
  const { entityWhere, metricsWhere } = filtersOf(input, entity, periods);

  const portfolio = input.level === 'portfolio';
  const sumSets = (prefix: 'cur' | 'cmp') => [
    ...sumColumns(prefix, prefix === 'cur' ? 'in_cur' : 'in_cmp', {
      converted: false,
      combos: portfolio,
    }),
    // Umgerechnet für Summenzeile und Sortierung (nur Zeilen mit Kurs).
    ...sumColumns(`${prefix}x`, prefix === 'cur' ? 'in_cur' : 'in_cmp', {
      converted: true,
      combos: false,
    }),
  ];
  const searchTerms = input.level === 'searchTerm';
  const narrowed = Boolean(
    filter.portfolioIds || filter.campaignIds || filter.adGroupIds || filter.productSearch,
  );
  const metricRows = metricRowsSql({
    profileIds,
    level: spec.metricsLevel,
    setting: input.attribution,
    periods,
    table: spec.metricsTable,
    select: spec.groupSelect,
    // Drill-Down und Suche: Entities schon beim Lesen der Kennzahlen filtern (Index über Profil und Entity), statt
    // alle Kennzahlen der Ebene zu summieren und danach zu verwerfen.
    joins: narrowed
      ? sql`${portfolioJoinSql(input.level, filter)} ${entityJoinSql(spec, entity)}`
      : portfolioJoinSql(input.level, filter),
    where: narrowed ? [...metricsWhere, ...entityWhere] : metricsWhere,
  });

  const query = sql`
    with sel as (${selectionQuery}),
    ${fxCtes(currency, periods)},
    agg as (
      select ${searchTerms ? sql`x.target_id, x.search_term` : sql`x.group_key`},
        ${sql.join([...sumSets('cur'), ...(periods.comparison ? sumSets('cmp') : [])], sql`, `)},
        coalesce(bool_or(x.factor is null), false) as missing_fx
      from ${metricRows}
      group by ${searchTerms ? sql`x.target_id, x.search_term` : sql`x.group_key`}
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
      select ${totalsOver('curx', 'cur', input.level)}${
        periods.comparison ? sql`, ${totalsOver('cmpx', 'cmp', input.level)}` : sql``
      },
        (select array_agg(distinct f3.currency_code) from filtered f3 where f3.missing_fx) as missing_fx
      from filtered f
    )
    select
      (select count(*) from filtered)::int as total_rows,
      (select json_build_object('cur', ${sumsJson('curx', true)}${periods.comparison ? sql`, 'cmp', ${sumsJson('cmpx', true)}` : sql``},
        'missing_fx', missing_fx) from tot) as totals,
      (select coalesce(json_agg(r), '[]'::json) from (
        select f.row_id, f.row_ad_product, f.name, f.state, f.amazon_id, f.removed, f.placeholder, f.attributes,
          f.profile_id, f.account_name, f.country_code, f.currency_code, f.account_type,
          ${sumsJson('cur', portfolio)} as cur${periods.comparison ? sql`, ${sumsJson('cmp', portfolio)} as cmp` : sql``}
        from filtered f
        order by f.curx_cost desc nulls last, f.name asc nulls last, f.row_id asc
        limit ${limit}
      ) r) as rows`;

  const [result] = await executeLarge<{
    total_rows: number;
    totals: {
      cur: Record<string, unknown>;
      cmp?: Record<string, unknown>;
      missing_fx: string[] | null;
    };
    rows: Array<
      Record<string, unknown> & { cur: Record<string, unknown>; cmp?: Record<string, unknown> }
    >;
  }>(db, query);
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
      // Eine Zeile hat genau einen Ad-Typ und Kontotyp; nur Portfolios fassen mehrere zusammen.
      attribution: summarizeAttribution(
        portfolio && hasMetrics
          ? selectionsOf(level, input.attribution, combosOf(row.cur, ''))
          : own
            ? [own]
            : [],
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
      attribution: summarizeAttribution(
        selectionsOf(level, input.attribution, combosOf(totals.cur, '')),
      ),
      comparisonAttribution: totals.cmp
        ? summarizeAttribution(selectionsOf(level, input.attribution, combosOf(totals.cmp, '')))
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
  /** Attribution über die Tage des Vergleichszeitraums; `null` ohne Vergleich. */
  comparisonAttribution: AttributionSummary | null;
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
    comparisonAttribution: null,
    missingFxCurrencies: [],
  });
  if (selectionQuery === null) return empty(input.currency);
  const { currency, converted, currencies, profileIds } = await resolveCurrency(
    db,
    selectionQuery,
    input.currency,
  );
  const periods = periodsOf(input);
  const spec = LEVELS[input.level];
  const filter = input.filter ?? {};
  const entity = spec.entitySql(filter);
  const { entityWhere, metricsWhere } = filtersOf(input, entity, periods);
  const where = [...metricsWhere, ...entityWhere];
  if (input.entityIds) {
    where.push(sql`(${spec.groupKey})::text = any(${textArray(input.entityIds)})`);
  }
  const metricRows = metricRowsSql({
    profileIds,
    level: spec.metricsLevel,
    setting: input.attribution,
    periods,
    table: spec.metricsTable,
    select: sql`1 as one`,
    joins: sql`${portfolioJoinSql(input.level, filter)} ${entityJoinSql(spec, entity)}`,
    where,
  });
  const rows = await executeLarge<Record<string, unknown> & { date: string }>(
    db,
    sql`
    with sel as (${selectionQuery}),
    ${fxCtes(currency, periods)}
    select to_char(x.date, 'YYYY-MM-DD') as date,
      ${sql.join([...sumColumns('d', 'all', { converted: true, combos: true }), ...missingFxColumns(currencies)], sql`, `)}
    from ${metricRows}
    group by x.date
    order by x.date`,
  );

  const inPeriod = (date: string, r: DateRange) => date >= r.from && date <= r.to;
  const toDay = (row: Record<string, unknown> & { date: string }): DayTotals => ({
    date: row.date,
    current: readSums(row, 'd', converted),
  });
  const periodRows = rows.filter((row) => inPeriod(row.date, periods.period));
  const summaryOf = (days: typeof rows) =>
    summarizeAttribution(
      selectionsOf(spec.metricsLevel, input.attribution, [
        ...new Set(days.flatMap((row) => combosOf(row, 'd_'))),
      ]),
    );
  const comparisonRows = periods.comparison
    ? rows.filter((row) => inPeriod(row.date, periods.comparison!))
    : [];
  return {
    currency,
    converted,
    days: periodRows.map(toDay),
    comparisonDays: comparisonRows.map(toDay),
    attribution: summaryOf(periodRows),
    comparisonAttribution: periods.comparison ? summaryOf(comparisonRows) : null,
    missingFxCurrencies: missingFxOf(rows, currencies),
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
  /** Attribution des Vergleichszeitraums (andere Ad-Typen möglich); `null` ohne Vergleich. */
  comparisonAttribution: AttributionSummary | null;
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
  const { currency, converted, currencies, profileIds } = await resolveCurrency(
    db,
    selectionQuery,
    input.currency,
  );
  const periods = periodsOf(input);
  const where: SQL[] = [anyRange(periods)];
  if (input.adProducts) where.push(sql`m.ad_product = any(${textArray(input.adProducts)})`);
  const level: MetricsLevel = 'campaign';
  const metricRows = metricRowsSql({
    profileIds,
    level,
    setting: input.attribution,
    periods,
    table: 'amazon_ads_campaign_daily_metrics',
    select: sql`p.client_id, p.id as profile_id`,
    joins: sql``,
    where,
  });
  const rows = await executeLarge<Record<string, unknown>>(
    db,
    sql`
    with sel as (${selectionQuery}),
    ${fxCtes(currency, periods)},
    g as (
      select grouping(x.client_id) as g_client, grouping(x.profile_id) as g_profile,
        grouping(x.ad_product) as g_ad_product, x.client_id, x.profile_id, x.ad_product,
        ${sql.join(
          [
            ...sumColumns('cur', 'in_cur', { converted: true, combos: true }),
            ...(periods.comparison
              ? sumColumns('cmp', 'in_cmp', { converted: true, combos: true })
              : []),
            ...missingFxColumns(currencies),
          ],
          sql`, `,
        )}
      from ${metricRows}
      group by grouping sets ((x.client_id), (x.profile_id), (x.ad_product), ())
    )
    select g.*, cl.name as client_name, pr.account_name, pr.country_code, pr.currency_code
    from g
    left join clients cl on cl.id = g.client_id
    left join sel pr on pr.id = g.profile_id
    order by cl.name asc nulls last, pr.account_name asc nulls last, g.ad_product asc nulls last`,
  );

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
    attribution: summarizeAttribution(
      selectionsOf(level, input.attribution, combosOf(row, 'cur_')),
    ),
    comparisonAttribution: periods.comparison
      ? summarizeAttribution(selectionsOf(level, input.attribution, combosOf(row, 'cmp_')))
      : null,
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
        selectionsOf(level, input.attribution, combosOf(totalRow, 'cur_')),
      ),
      comparisonAttribution: periods.comparison
        ? summarizeAttribution(selectionsOf(level, input.attribution, combosOf(totalRow, 'cmp_')))
        : null,
      missingFxCurrencies: missingFxOf([totalRow], currencies),
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

export interface DashboardStatus {
  /** Letzter erfolgreicher `reports-sync` einer Connection der Auswahl (ISO-Zeitpunkt). */
  lastSyncAt: string | null;
  /**
   * „Daten bis“ je Ad-Typ, den die Auswahl nutzt (wie der Sync: `always` immer, sonst nur mit Kampagnen); `null`, solange
   * einem Profil dieser Tag fehlt. Ein Ad-Typ hinter den anderen = hängender Import.
   */
  adProducts: { adProduct: string; dataThrough: string | null; profilesWithoutData: number }[];
  /** SB-Kampagnen (nicht entfernt) ohne jede Kennzahl-Zeile: v3-Preview-Lücke (`plan.md` §5). */
  sbCampaignsWithoutMetrics: number;
}

/** Datenstand fürs Dashboard (F11), nur über die sichtbaren Profile der Auswahl (ADR 002). */
export async function queryDashboardStatus(
  db: Db,
  selection: AnalyticsSelection,
  adProductSelection: ReportAdProductSelection,
): Promise<DashboardStatus> {
  const selectionQuery = await selectionSql(db, selection);
  if (selectionQuery === null) {
    return { lastSyncAt: null, adProducts: [], sbCampaignsWithoutMetrics: 0 };
  }
  const always = [...new Set(adProductSelection.always)];
  const withCampaigns = [...new Set(adProductSelection.withCampaigns)];
  const [row] = await db.execute<{
    last_sync_at: string | null;
    ad_products: DashboardStatus['adProducts'] | null;
    sb_without_metrics: number;
  }>(sql`
    with sel as (${selectionQuery}),
    used as (
      select s.id as profile_id, a.ad_product from sel s cross join unnest(${textArray(always)}) as a(ad_product)
      union
      select distinct c.profile_id, c.ad_product from amazon_ads_campaigns c
        where c.profile_id in (select id from sel) and c.ad_product = any(${textArray(withCampaigns)})
    ),
    per_product as (
      select u.ad_product,
        case when count(*) = count(m.imported_through)
          then to_char(min(m.imported_through), 'YYYY-MM-DD') end as data_through,
        (count(*) - count(m.imported_through))::int as profiles_without_data
      from used u
      left join amazon_ads_profile_metrics_imported_through m
        on m.profile_id = u.profile_id and m.ad_product = u.ad_product
      group by u.ad_product
    )
    select
      (select to_char(max(j.finished_at) at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
        from job_runs j
        where j.organization_id = ${selection.orgId}
          and j.job = 'reports-sync' and j.status = 'success'
          and j.scope in (select p.connection_id::text from amazon_ads_profiles p where p.id in (select id from sel))
      ) as last_sync_at,
      (select json_agg(json_build_object('adProduct', ad_product, 'dataThrough', data_through,
          'profilesWithoutData', profiles_without_data) order by ad_product) from per_product) as ad_products,
      (select count(*)::int from amazon_ads_campaigns c
        where c.profile_id in (select id from sel) and c.ad_product = 'SPONSORED_BRANDS' and c.removed_at is null
          and not exists (select 1 from amazon_ads_campaign_daily_metrics m
            where m.profile_id = c.profile_id and m.campaign_id = c.id)) as sb_without_metrics`);
  return {
    lastSyncAt: row?.last_sync_at ?? null,
    adProducts: row?.ad_products ?? [],
    sbCampaignsWithoutMetrics: row?.sb_without_metrics ?? 0,
  };
}

function addDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// Negatives
// ---------------------------------------------------------------------------

export interface NegativeRow {
  id: string;
  profileId: string;
  accountName: string;
  countryCode: string;
  currencyCode: string;
  adProduct: string;
  /** Keyword-Text bzw. Ausdruck als Text. */
  name: string | null;
  state: string;
  removed: boolean;
  /** Ebene, Kampagne, Ad Group, Art, Match-Typ, Ausdruck. */
  attributes: Record<string, unknown>;
}

/** Negatives der Auswahl (F6, ohne Kennzahlen), sortiert nach Kampagne und Text, höchstens `MAX_ANALYTICS_ROWS`. */
export async function queryNegatives(
  db: Db,
  input: AnalyticsSelection & { filter?: ExplorerFilter; limit?: number },
): Promise<{ rows: NegativeRow[]; totalRows: number; truncated: boolean }> {
  const selectionQuery = await selectionSql(db, input);
  if (selectionQuery === null) return { rows: [], totalRows: 0, truncated: false };
  const filter = input.filter ?? {};
  const limit = Math.min(input.limit ?? MAX_ANALYTICS_ROWS, MAX_ANALYTICS_ROWS);
  const where: SQL[] = [
    ...removedFilter(filter),
    ...parentFilters(filter, { campaign: true, adGroup: true }),
  ];
  if (filter.portfolioIds) where.push(sql`c.portfolio_id = any(${uuidArray(filter.portfolioIds)})`);
  if (input.adProducts) where.push(sql`e.ad_product = any(${textArray(input.adProducts)})`);
  const rows = await db.execute<Record<string, unknown>>(sql`
    select e.id, e.profile_id, p.account_name, p.country_code, p.currency_code, e.ad_product,
      coalesce(e.keyword_text, e.expression::text) as name, e.state, e.removed_at is not null as removed,
      json_build_object('amazonId', e.amazon_target_id, 'level', e.level, 'campaignId', e.campaign_id,
        'campaignName', c.name, 'adGroupId', e.ad_group_id, 'adGroupName', g.name, 'targetType', e.target_type,
        'keywordText', e.keyword_text, 'matchType', e.match_type, 'expression', e.expression) as attributes,
      count(*) over () as total_rows
    from amazon_ads_negative_targets e
    join (${selectionQuery}) p on p.id = e.profile_id
    join amazon_ads_campaigns c on c.id = e.campaign_id
    left join amazon_ads_ad_groups g on g.id = e.ad_group_id
    ${where.length > 0 ? sql`where ${sql.join(where, sql` and `)}` : sql``}
    order by c.name asc nulls last, name asc nulls last, e.id
    limit ${limit}`);
  const totalRows = rows.length > 0 ? Number(rows[0]!.total_rows) : 0;
  return {
    rows: rows.map((row) => ({
      id: String(row.id),
      profileId: String(row.profile_id),
      accountName: String(row.account_name),
      countryCode: String(row.country_code),
      currencyCode: String(row.currency_code),
      adProduct: String(row.ad_product),
      name: (row.name as string | null) ?? null,
      state: String(row.state),
      removed: Boolean(row.removed),
      attributes: row.attributes as Record<string, unknown>,
    })),
    totalRows,
    truncated: totalRows > rows.length,
  };
}
