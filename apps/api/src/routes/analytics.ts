import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { REPORT_AD_PRODUCT_SELECTION } from '@profitbash/amazon-ads';
import {
  latestFxRateDate,
  listSelectableCurrencies,
  listVisibleClientsAndProfiles,
  MAX_ANALYTICS_ROWS,
  queryDashboard,
  queryDataStatus,
  queryExplorerRows,
  queryNegatives,
  queryTimeSeries,
  resolveDisplayCurrency,
  type AnalyticsQuery,
  type AnalyticsSelection,
  type AnalyticsTotals,
  type CurrencyInfo,
  type Db,
  type ExplorerFilter,
  type ExplorerRow,
  type MetricSums,
} from '@profitbash/db';
import { change, deriveMetrics } from '@profitbash/engine';
import {
  analyticsQuerySchema,
  asinSearchRequestSchema,
  CHANGE_KEYS,
  DEFAULT_ATTRIBUTION_SETTING,
  dashboardResponseSchema,
  errorResponseSchema,
  explorerRowsRequestSchema,
  explorerRowsResponseSchema,
  filterOptionsRequestSchema,
  filterOptionsResponseSchema,
  isFxRateStale,
  timeSeriesRequestSchema,
  timeSeriesResponseSchema,
  type ChangeKey,
  type ExplorerRowResponse,
  type FeatureKey,
} from '@profitbash/shared';
import type { z } from 'zod';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';

/**
 * Auswertungen für Dashboard und Explorer (`docs/tasks/phase-2.md` 2.5). Alle Endpunkte sind POST (IDs im Body),
 * lesen nur über `@profitbash/db` (`ads-analytics`, Access-Layer) und liefern Beträge als Decimal-Strings.
 * Antworten werden komprimiert (`compress` in `app.ts`, F7).
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const errors = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: {
    description: 'Feature nicht gebucht oder kein Recht.',
    content: json(errorResponseSchema),
  },
};

const filterOptionsRoute = createRoute({
  method: 'post',
  path: '/ads/filter-options',
  tags: ['Auswertungen'],
  summary:
    'Auswahl der Filterleiste: sichtbare Clients und Profile, wählbare Währungen, Stand der Kurse',
  request: { body: { content: json(filterOptionsRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(filterOptionsResponseSchema) },
    ...errors,
  },
});

const explorerRowsRoute = createRoute({
  method: 'post',
  path: '/ads/explorer/rows',
  tags: ['Auswertungen'],
  summary: 'Explorer: Zeilen einer Ebene mit Vergleich und Summenzeile (höchstens 10 000 Zeilen)',
  request: { body: { content: json(explorerRowsRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(explorerRowsResponseSchema) },
    ...errors,
  },
});

const timeSeriesRoute = createRoute({
  method: 'post',
  path: '/ads/timeseries',
  tags: ['Auswertungen'],
  summary: 'Tagesverlauf der Auswahl in der Anzeigewährung (Chart, Hero-Kachel)',
  request: { body: { content: json(timeSeriesRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(timeSeriesResponseSchema) },
    ...errors,
  },
});

const dashboardRoute = createRoute({
  method: 'post',
  path: '/ads/dashboard',
  tags: ['Auswertungen'],
  summary: 'Dashboard: Summen gesamt und je Client, Profil und Ad-Typ',
  request: { body: { content: json(analyticsQuerySchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(dashboardResponseSchema) },
    ...errors,
  },
});

const asinSearchRoute = createRoute({
  method: 'post',
  path: '/ads/asin-search',
  tags: ['Auswertungen'],
  summary: 'ASIN-Quick-Tool: Product Ads zu ASINs oder SKUs mit Kennzahlen',
  request: { body: { content: json(asinSearchRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(explorerRowsResponseSchema) },
    ...errors,
  },
});

type QueryBody = z.infer<typeof explorerRowsRequestSchema>;

const DASHBOARD_OR_EXPLORER: readonly FeatureKey[] = ['dashboard', 'sp-explorer'];

export function registerAnalyticsRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (features: FeatureKey | readonly FeatureKey[]) => [
    requireSession(deps),
    requireFeature(deps, features, 'view'),
  ];

  /** Nutzer und aktive Organisation (die Guards garantieren beides). */
  const visibility = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };

  /** Anfrage → Abfrage der DB-Schicht; eine Anzeigewährung muss wählbar sein (F3). */
  async function toQuery(
    base: { userId: string; orgId: string },
    body: Omit<QueryBody, 'level' | 'filter'>,
  ): Promise<AnalyticsQuery> {
    const currency = body.currency ?? 'auto';
    if (currency !== 'auto') {
      const selectable = await listSelectableCurrencies(db, base);
      if (!selectable.includes(currency)) {
        throw new ApiError(
          400,
          'CURRENCY_NOT_SELECTABLE',
          `Währung ${currency} ist nicht wählbar (${selectable.join(', ')}).`,
        );
      }
    }
    return {
      ...base,
      ...selection(body),
      period: body.period,
      comparison: body.comparison ?? null,
      currency,
      attribution: body.attribution ?? DEFAULT_ATTRIBUTION_SETTING,
    };
  }

  app.openapi({ ...filterOptionsRoute, middleware: guard(DASHBOARD_OR_EXPLORER) }, async (c) => {
    const base = visibility(c);
    const [{ clients, profiles }, currencies, fxRatesThrough] = await Promise.all([
      listVisibleClientsAndProfiles(db, base),
      listSelectableCurrencies(db, base),
      latestFxRateDate(db),
    ]);
    return c.json(
      {
        clients,
        profiles,
        currencies,
        fxRatesThrough,
        fxRatesStale: isFxRateStale(fxRatesThrough, new Date()),
      },
      200,
    );
  });

  app.openapi({ ...explorerRowsRoute, middleware: guard('sp-explorer') }, async (c) => {
    const body = c.req.valid('json');
    const query = await toQuery(visibility(c), body);
    const filter = explorerFilter(body.filter);
    const meta = await dataStatus(db, query);
    if (body.level === 'negative') {
      const [negatives, display] = await Promise.all([
        queryNegatives(db, { ...query, filter }),
        resolveDisplayCurrency(db, query),
      ]);
      return c.json(
        {
          meta: { ...meta, ...display, missingFxCurrencies: [] },
          rows: negatives.rows.map((row): ExplorerRowResponse => ({
            ...row,
            placeholder: false,
            hasMetrics: false,
            current: null,
            comparison: null,
            change: null,
            attribution: null,
          })),
          totalRows: negatives.totalRows,
          truncated: negatives.truncated,
          maxRows: MAX_ANALYTICS_ROWS,
          total: null,
        },
        200,
      );
    }
    const result = await queryExplorerRows(db, { ...query, level: body.level, filter });
    return c.json(explorerResponse(result, meta), 200);
  });

  app.openapi({ ...asinSearchRoute, middleware: guard('sp-explorer') }, async (c) => {
    const body = c.req.valid('json');
    const query = await toQuery(visibility(c), body);
    const [result, meta] = await Promise.all([
      queryExplorerRows(db, {
        ...query,
        level: 'productAd',
        filter: { productSearch: body.terms },
      }),
      dataStatus(db, query),
    ]);
    return c.json(explorerResponse(result, meta), 200);
  });

  app.openapi({ ...timeSeriesRoute, middleware: guard(DASHBOARD_OR_EXPLORER) }, async (c) => {
    const body = c.req.valid('json');
    const query = await toQuery(visibility(c), body);
    const [result, meta] = await Promise.all([
      queryTimeSeries(db, {
        ...query,
        level: body.level,
        filter: explorerFilter(body.filter),
        ...(body.entityIds && { entityIds: body.entityIds }),
      }),
      dataStatus(db, query),
    ]);
    const day = (coverage: Coverage) => (d: { date: string; current: MetricSums }) => ({
      date: d.date,
      sums: d.current,
      derived: derived(d.current, coverage),
    });
    return c.json(
      {
        meta: { ...meta, ...currencyMeta(result, result.missingFxCurrencies) },
        days: result.days.map(day(result.attribution.coverage)),
        comparisonDays: result.comparisonDays.map(
          day((result.comparisonAttribution ?? result.attribution).coverage),
        ),
        attribution: result.attribution,
        comparisonAttribution: result.comparisonAttribution,
      },
      200,
    );
  });

  app.openapi({ ...dashboardRoute, middleware: guard('dashboard') }, async (c) => {
    const body = c.req.valid('json');
    const query = await toQuery(visibility(c), body);
    const [result, meta, fxRatesThrough] = await Promise.all([
      queryDashboard(db, query),
      dataStatus(db, query),
      latestFxRateDate(db),
    ]);
    const group = (g: (typeof result.byClient)[number]) => ({
      key: g.key,
      label: g.label,
      ...(g.countryCode !== undefined && { countryCode: g.countryCode }),
      ...(g.currencyCode !== undefined && { currencyCode: g.currencyCode }),
      ...metricsTotal(
        g.current,
        g.comparison,
        g.attribution,
        g.comparisonAttribution ?? g.attribution,
      ),
    });
    return c.json(
      {
        meta: { ...meta, ...currencyMeta(result, result.totals.missingFxCurrencies) },
        total: totalOf(result.totals),
        byClient: result.byClient.map(group),
        byProfile: result.byProfile.map(group),
        byAdProduct: result.byAdProduct.map(group),
        fxRatesThrough,
        fxRatesStale: isFxRateStale(fxRatesThrough, new Date()),
      },
      200,
    );
  });
}

// ---------------------------------------------------------------------------
// Umwandlung
// ---------------------------------------------------------------------------

function selection(
  body: Omit<QueryBody, 'level' | 'filter'>,
): Omit<AnalyticsSelection, 'userId' | 'orgId'> {
  return {
    ...(body.clientIds && { clientIds: body.clientIds }),
    ...(body.withoutClient !== undefined && { withoutClient: body.withoutClient }),
    ...(body.profileIds && { profileIds: body.profileIds }),
    ...(body.adProducts && { adProducts: body.adProducts }),
  };
}

function explorerFilter(filter: QueryBody['filter']): ExplorerFilter {
  return {
    ...(filter?.portfolioIds && { portfolioIds: filter.portfolioIds }),
    ...(filter?.campaignIds && { campaignIds: filter.campaignIds }),
    ...(filter?.adGroupIds && { adGroupIds: filter.adGroupIds }),
    ...(filter?.includeRemoved !== undefined && { includeRemoved: filter.includeRemoved }),
  };
}

async function dataStatus(db: Db, query: AnalyticsQuery) {
  return queryDataStatus(db, query, REPORT_AD_PRODUCT_SELECTION);
}

function currencyMeta(info: CurrencyInfo, missingFxCurrencies: string[]) {
  return { currency: info.currency, converted: info.converted, missingFxCurrencies };
}

type Coverage = AnalyticsTotals['attribution']['coverage'];

/**
 * Abgeleitete Kennzahlen (2.1). Umsatz und Käufe nur, wenn sie in allen Zeilen der Summe vorliegen (`coverage`
 * vollständig), sonst entstünden ACoS, ROAS und CVR aus ungleichen Mengen.
 */
function derived(sums: MetricSums, coverage: Coverage) {
  return deriveMetrics({
    impressions: sums.impressions ?? '0',
    clicks: sums.clicks ?? '0',
    cost: sums.cost ?? '0',
    sales: coverage.sales === 'full' ? sums.sales : null,
    purchases: coverage.purchases === 'full' ? sums.purchases : null,
    viewableImpressions: sums.viewableImpressions,
    viewableCost: sums.viewableCost,
  });
}

function period(sums: MetricSums, coverage: Coverage) {
  return { sums, derived: derived(sums, coverage) };
}

const valueOf = (p: ReturnType<typeof period>, key: ChangeKey) =>
  key in p.sums ? p.sums[key as keyof MetricSums] : p.derived[key as keyof typeof p.derived];

function metricsTotal(
  current: MetricSums,
  comparison: MetricSums | null,
  attribution: AnalyticsTotals['attribution'],
  comparisonAttribution: AnalyticsTotals['attribution'] = attribution,
) {
  const cur = period(current, attribution.coverage);
  const cmp = comparison ? period(comparison, comparisonAttribution.coverage) : null;
  return {
    current: cur,
    comparison: cmp,
    change: cmp
      ? (Object.fromEntries(
          CHANGE_KEYS.map((key) => [key, change(valueOf(cur, key), valueOf(cmp, key))]),
        ) as Record<ChangeKey, ReturnType<typeof change>>)
      : null,
    attribution,
  };
}

function totalOf(totals: AnalyticsTotals) {
  return metricsTotal(
    totals.current,
    totals.comparison,
    totals.attribution,
    totals.comparisonAttribution ?? totals.attribution,
  );
}

function explorerResponse(
  result: Awaited<ReturnType<typeof queryExplorerRows>>,
  meta: Awaited<ReturnType<typeof dataStatus>>,
) {
  return {
    meta: { ...meta, ...currencyMeta(result, result.totals.missingFxCurrencies) },
    rows: result.rows.map(rowOf),
    totalRows: result.totalRows,
    truncated: result.truncated,
    maxRows: MAX_ANALYTICS_ROWS,
    total: totalOf(result.totals),
  };
}

function rowOf(row: ExplorerRow): ExplorerRowResponse {
  const total = metricsTotal(row.current, row.comparison, row.attribution);
  return {
    id: row.id,
    profileId: row.profileId,
    accountName: row.accountName,
    countryCode: row.countryCode,
    currencyCode: row.currencyCode,
    adProduct: row.adProduct,
    name: row.name,
    state: row.state,
    removed: row.removed,
    placeholder: row.placeholder,
    hasMetrics: row.hasMetrics,
    attributes: row.attributes,
    current: total.current,
    comparison: total.comparison,
    // Je Zeile nur die relative Veränderung (Nutzlast bei 10 000 Zeilen).
    change: total.change
      ? (Object.fromEntries(CHANGE_KEYS.map((key) => [key, total.change![key].relative])) as Record<
          ChangeKey,
          string | null
        >)
      : null,
    attribution: row.attribution,
  };
}
