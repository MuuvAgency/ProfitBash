import { formatDecimal, parseDecimal } from '@profitbash/engine';
import type { AttributionSetting } from '@profitbash/shared/analytics';
import { sql, type SQL } from 'drizzle-orm';
import {
  visibleProfilesScope,
  visibleSellerAccountsScope,
  type ProfileVisibilityInput,
} from './access';
import {
  fxSql,
  MAX_ANALYTICS_ROWS,
  queryDashboard,
  uuidArray,
  type CurrencyInfo,
  type DateRange,
} from './ads-analytics';
import type { Db } from './client';

/**
 * Verkaufsanalyse (Phase 7, 7.4): Umsatz, Stück und Bestellungen der sichtbaren Seller-Konten aus
 * `amazon_sp_daily_sales`, in der Anzeigewährung (Kurse wie im Dashboard, „≈“), dazu Werbekosten und
 * Anzeigen-Umsatz der Ads-Profile, die zum selben Client und Marktplatz gehören (TACoS, organischer Umsatz).
 *
 * **Umsatz** = `item-price` − Aktionsrabatt (Betrag, Vorzeichen egal), ohne Versand und Geschenkverpackung.
 * **Brutto/netto:** Außer in den USA und Kanada enthalten Amazon-Preise die Steuer (netto = Preis − `item-tax`);
 * in US/CA kommt sie dazu (brutto = Preis + `item-tax`).
 */

export interface SalesQuery extends ProfileVisibilityInput {
  clientIds?: readonly string[] | undefined;
  withoutClient?: boolean | undefined;
  /** Nur Konten, die zu diesen Ads-Profilen gehören (Client und Marktplatz). */
  profileIds?: readonly string[] | undefined;
  period: DateRange;
  comparison?: DateRange | null | undefined;
  /** `auto` oder ein Währungscode. */
  currency: string;
  attribution: AttributionSetting;
}

export interface SalesSums {
  revenueNet: string;
  revenueGross: string;
  units: number;
  orders: number;
  /** Stück ohne Preis (selbst versandt, „Pending“): Ihr Umsatz fehlt noch. */
  unpricedUnits: number;
}

export interface SalesDay {
  date: string;
  revenueNet: string;
  revenueGross: string;
  units: number;
}

export interface SalesProduct {
  sellerAccountId: string;
  countryCode: string;
  currencyCode: string;
  sku: string;
  asin: string | null;
  current: Omit<SalesSums, 'unpricedUnits'>;
  comparison: Omit<SalesSums, 'unpricedUnits'> | null;
}

export interface AdTotals {
  cost: string | null;
  sales: string | null;
}

export interface SalesResult extends CurrencyInfo {
  /** Sichtbare Seller-Konten der Auswahl. */
  accounts: number;
  missingFxCurrencies: string[];
  totals: { current: SalesSums; comparison: SalesSums | null };
  days: SalesDay[];
  comparisonDays: SalesDay[];
  products: SalesProduct[];
  truncated: boolean;
  /** Werbung der Ads-Profile desselben Clients und Marktplatzes; `null` ohne solche Profile. */
  ads: { profiles: number; current: AdTotals; comparison: AdTotals | null } | null;
}

// shortcut: Steuer-exklusive Preise nur für US und CA angenommen; mit echten Dateien (7.12) prüfen.
const TAX_EXCLUSIVE_COUNTRIES = ['US', 'CA'];

const EMPTY_SUMS: SalesSums = {
  revenueNet: '0',
  revenueGross: '0',
  units: 0,
  orders: 0,
  unpricedUnits: 0,
};

const inRange = (column: SQL, range: DateRange) =>
  sql`${column} between ${range.from}::date and ${range.to}::date`;

/** Umgerechnete Beträge auf 12 Nachkommastellen (gerundet wird erst bei der Anzeige). */
const amount = (value: unknown) =>
  value === null || value === undefined
    ? '0'
    : formatDecimal(parseDecimal(String(value)).toDecimalPlaces(12));

export async function querySales(db: Db, input: SalesQuery): Promise<SalesResult> {
  const comparison = input.comparison ?? null;
  const accounts = await selectedAccounts(db, input);
  if (accounts.length === 0) {
    return {
      currency: input.currency === 'auto' ? 'EUR' : input.currency,
      converted: false,
      accounts: 0,
      missingFxCurrencies: [],
      totals: { current: EMPTY_SUMS, comparison: comparison && EMPTY_SUMS },
      days: [],
      comparisonDays: [],
      products: [],
      truncated: false,
      ads: null,
    };
  }
  const currencies = [...new Set(accounts.map((a) => a.currency_code))];
  const currency =
    input.currency === 'auto' ? (currencies.length === 1 ? currencies[0]! : 'EUR') : input.currency;
  const ids = uuidArray(accounts.map((a) => a.id));
  const periods = { period: input.period, comparison };
  const flag = (range: DateRange | null) => (range ? inRange(sql`d.date`, range) : sql`false`);
  const anyRange = comparison
    ? sql`(${inRange(sql`d.date`, input.period)} or ${inRange(sql`d.date`, comparison)})`
    : inRange(sql`d.date`, input.period);
  const sums = (prefix: 'cur' | 'cmp') => {
    const when = `filter (where y.in_${prefix})`;
    const money = `filter (where y.in_${prefix} and y.factor is not null)`;
    return sql.raw(`sum(y.net * y.factor) ${money} as ${prefix}_net,
      sum(y.gross * y.factor) ${money} as ${prefix}_gross,
      coalesce(sum(y.units) ${when}, 0)::int as ${prefix}_units,
      coalesce(sum(y.orders) ${when}, 0)::int as ${prefix}_orders,
      coalesce(sum(y.unpriced_units) ${when}, 0)::int as ${prefix}_unpriced`);
  };

  const rows = [
    ...(await db.execute<Record<string, unknown>>(sql`
    with sel as (select a.currency_code from amazon_sp_accounts a where a.id = any(${ids})),
    fx as (${fxSql(sql`select * from sel`, currency, periods)}),
    y as (
      select d.date, d.seller_account_id, d.sku, d.asin, d.units, d.orders, d.unpriced_units,
        a.currency_code, a.country_code, fx.factor,
        ${flag(input.period)} as in_cur, ${flag(comparison)} as in_cmp,
        case when a.country_code = any(${sql.param(TAX_EXCLUSIVE_COUNTRIES)}::text[])
          then d.item_price - abs(d.item_promotion_discount)
          else d.item_price - abs(d.item_promotion_discount) - d.item_tax end as net,
        case when a.country_code = any(${sql.param(TAX_EXCLUSIVE_COUNTRIES)}::text[])
          then d.item_price - abs(d.item_promotion_discount) + d.item_tax
          else d.item_price - abs(d.item_promotion_discount) end as gross
      from amazon_sp_daily_sales d
      join amazon_sp_accounts a on a.id = d.seller_account_id
      left join fx on fx.day = d.date and fx.currency = a.currency_code
      where d.seller_account_id = any(${ids}) and ${anyRange}
    )
    select grouping(y.date) as g_date, grouping(y.seller_account_id) as g_product,
      y.date::text as date, y.seller_account_id, y.sku, max(y.asin) as asin,
      max(y.country_code) as country_code, max(y.currency_code) as currency_code,
      array_agg(distinct y.currency_code) filter (where y.factor is null) as missing_fx,
      ${sums('cur')}, ${sums('cmp')}
    from y
    group by grouping sets ((), (y.date), (y.seller_account_id, y.sku))
    order by cur_net desc nulls last, y.sku`)),
  ];

  const sumsOf = (row: Record<string, unknown> | undefined, prefix: 'cur' | 'cmp') => ({
    revenueNet: amount(row?.[`${prefix}_net`]),
    revenueGross: amount(row?.[`${prefix}_gross`]),
    units: Number(row?.[`${prefix}_units`] ?? 0),
    orders: Number(row?.[`${prefix}_orders`] ?? 0),
  });
  const total = rows.find((row) => row.g_date === 1 && row.g_product === 1);
  const orders = await distinctOrders(db, ids, input.period, comparison);
  const totalSums = (prefix: 'cur' | 'cmp'): SalesSums => ({
    ...sumsOf(total, prefix),
    orders: orders[prefix],
    unpricedUnits: Number(total?.[`${prefix}_unpriced`] ?? 0),
  });
  const day = (row: Record<string, unknown>, prefix: 'cur' | 'cmp'): SalesDay => {
    const { orders: _orders, ...rest } = sumsOf(row, prefix);
    return { date: String(row.date), ...rest };
  };
  const dayRows = rows
    .filter((row) => row.g_date === 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  const productRows = rows.filter((row) => row.g_product === 0);
  const ads = await adTotals(db, input, accounts, currency, periods);

  return {
    currency,
    converted: currencies.some((code) => code !== currency) || (ads?.converted ?? false),
    accounts: accounts.length,
    missingFxCurrencies: [
      ...new Set([...((total?.missing_fx as string[] | null) ?? []), ...(ads?.missing ?? [])]),
    ].sort(),
    totals: {
      current: totalSums('cur'),
      comparison: comparison ? totalSums('cmp') : null,
    },
    days: dayRows
      .filter((row) => inPeriod(String(row.date), input.period))
      .map((row) => day(row, 'cur')),
    comparisonDays: comparison
      ? dayRows
          .filter((row) => inPeriod(String(row.date), comparison))
          .map((row) => day(row, 'cmp'))
      : [],
    products: productRows.slice(0, MAX_ANALYTICS_ROWS).map((row) => ({
      sellerAccountId: String(row.seller_account_id),
      countryCode: String(row.country_code),
      currencyCode: String(row.currency_code),
      sku: String(row.sku),
      asin: (row.asin as string | null) ?? null,
      current: sumsOf(row, 'cur'),
      comparison: comparison ? sumsOf(row, 'cmp') : null,
    })),
    truncated: productRows.length > MAX_ANALYTICS_ROWS,
    ads: ads && { profiles: ads.profiles, current: ads.current, comparison: ads.comparison },
  };
}

const inPeriod = (date: string, range: DateRange) => date >= range.from && date <= range.to;

/** Sichtbare Konten der Auswahl (Access-Layer), mit Client und Marktplatz für die Zuordnung der Ads-Profile. */
async function selectedAccounts(db: Db, input: SalesQuery) {
  const scope = await visibleSellerAccountsScope(db, input);
  if (scope === null) return [];
  const conditions: SQL[] = [sql`a.id in (${scope.ids})`];
  if (input.clientIds) {
    conditions.push(
      input.withoutClient
        ? sql`(a.client_id = any(${uuidArray(input.clientIds)}) or a.client_id is null)`
        : sql`a.client_id = any(${uuidArray(input.clientIds)})`,
    );
  } else if (input.withoutClient) {
    conditions.push(sql`a.client_id is null`);
  }
  if (input.profileIds) {
    conditions.push(sql`exists (select 1 from amazon_ads_profiles p
      where p.id = any(${uuidArray(input.profileIds)}) and p.client_id = a.client_id
        and p.marketplace_id = a.marketplace_id)`);
  }
  return [
    ...(await db.execute<{
      id: string;
      client_id: string | null;
      marketplace_id: string;
      currency_code: string;
    }>(sql`select a.id, a.client_id, a.marketplace_id, a.currency_code from amazon_sp_accounts a
      where ${sql.join(conditions, sql` and `)} order by a.id`)),
  ];
}

/** Bestellungen ohne Doppel (eine Bestellung mit mehreren SKUs zählt einmal), ohne Stornierte. */
async function distinctOrders(db: Db, ids: SQL, period: DateRange, comparison: DateRange | null) {
  const date = sql`i.purchase_date`;
  const [row] = await db.execute<{ cur: number; cmp: number }>(sql`
    select count(distinct (i.seller_account_id, i.amazon_order_id))
        filter (where ${inRange(date, period)})::int as cur,
      ${comparison ? sql`count(distinct (i.seller_account_id, i.amazon_order_id)) filter (where ${inRange(date, comparison)})::int` : sql`0`} as cmp
    from amazon_sp_order_items i
    where i.seller_account_id = any(${ids})
      and i.order_status <> 'Cancelled' and coalesce(i.item_status, '') <> 'Cancelled'
      and (${inRange(date, period)}${comparison ? sql` or ${inRange(date, comparison)}` : sql``})`);
  return { cur: Number(row?.cur ?? 0), cmp: Number(row?.cmp ?? 0) };
}

/**
 * Werbekosten und Anzeigen-Umsatz der sichtbaren Ads-Profile, die zum Client und Marktplatz eines gewählten
 * Kontos gehören (`phase-7.md` „Verknüpfung Ads ↔ Seller-Konto“), über die Summen des Dashboards.
 */
async function adTotals(
  db: Db,
  input: SalesQuery,
  accounts: Awaited<ReturnType<typeof selectedAccounts>>,
  currency: string,
  periods: { period: DateRange; comparison: DateRange | null },
) {
  const pairs = accounts.filter((a) => a.client_id !== null);
  const scope = await visibleProfilesScope(db, input);
  if (pairs.length === 0 || scope === null) return null;
  const matched = await db.execute<{ id: string }>(sql`
    select p.id from amazon_ads_profiles p
    where p.id in (${scope.ids})
      ${input.profileIds ? sql`and p.id = any(${uuidArray(input.profileIds)})` : sql``}
      and (p.client_id, p.marketplace_id) in (${sql.join(
        pairs.map((a) => sql`(${a.client_id}::uuid, ${a.marketplace_id})`),
        sql`, `,
      )})`);
  const profileIds = matched.map((row) => row.id);
  if (profileIds.length === 0) return null;
  const dashboard = await queryDashboard(db, {
    userId: input.userId,
    orgId: input.orgId,
    profileIds,
    period: periods.period,
    comparison: periods.comparison,
    currency,
    attribution: input.attribution,
  });
  const pick = (sums: { cost: string | null; sales: string | null }) => ({
    cost: sums.cost,
    sales: sums.sales,
  });
  return {
    profiles: profileIds.length,
    current: pick(dashboard.totals.current),
    comparison: dashboard.totals.comparison && pick(dashboard.totals.comparison),
    converted: dashboard.converted,
    missing: dashboard.totals.missingFxCurrencies,
  };
}
