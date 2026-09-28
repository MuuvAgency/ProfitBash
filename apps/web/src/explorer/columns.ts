import {
  compareDecimalNullsLast,
  formatCurrency,
  formatNumber,
  formatPercent,
  MISSING_VALUE,
  type AttributionSetting,
  type ExplorerLevel,
  type Locale,
} from '@profitbash/shared';
import type { CellClassParams, ColDef, ValueGetterParams } from 'ag-grid-community';
import type { ExplorerRowsData } from '../api/client';
import { changeTone, formatChange, type MetricKey } from '../analytics/metrics';

/**
 * Spalten des Explorers je Ebene (`phase-2.md` F6, F7, 2.8). Beträge bleiben Decimal-Strings: `valueGetter` liefert den
 * String (Sortierung über `compareDecimalNullsLast`, CSV ohne Formatierung), angezeigt wird über die Helper aus
 * `@profitbash/shared` in der Originalwährung der Zeile; die Summenzeile in der Anzeigewährung (mit „≈“, wenn umgerechnet).
 */

export type ExplorerRow = ExplorerRowsData['rows'][number];
export type GridRow = ExplorerRow & { isTotal?: boolean };

type Translate = (key: string, values?: Record<string, unknown>) => string;

export interface ColumnContext {
  t: Translate;
  locale: Locale;
  attribution: AttributionSetting;
  /** Kontotyp je Profil (`filter-options`), für die Attribution „wie Konsole“. */
  accountTypeOf: (profileId: string) => string | undefined;
  /** Währung der Summenzeile. */
  displayCurrency: string;
  /** Summenzeile umgerechnet („≈“). */
  converted: boolean;
}

type MetricKind = 'money' | 'count' | 'ratio' | 'factor';
const METRIC_KIND: Record<MetricKey, MetricKind> = {
  impressions: 'count',
  clicks: 'count',
  cost: 'money',
  sales: 'money',
  purchases: 'count',
  units: 'count',
  ctr: 'ratio',
  cpc: 'money',
  cvr: 'ratio',
  acos: 'ratio',
  roas: 'factor',
  cpm: 'money',
  vcpm: 'money',
};

interface ColumnSpec {
  id: string;
  levels: readonly ExplorerLevel[] | 'all' | 'metrics';
  defaultLevels?: readonly ExplorerLevel[] | 'all';
}

const METRIC_LEVELS = 'metrics' as const;
const ENTITY_LEVELS: ExplorerLevel[] = ['adGroup', 'target', 'productAd', 'searchTerm', 'negative'];

/** Wählbare Spalten (außer „Name“) in ihrer Reihenfolge. */
export const OPTIONAL_COLUMNS: ColumnSpec[] = [
  { id: 'state', levels: 'all', defaultLevels: 'all' },
  { id: 'adProduct', levels: 'all', defaultLevels: 'all' },
  { id: 'profile', levels: 'all', defaultLevels: 'all' },
  { id: 'currency', levels: 'all' },
  { id: 'portfolio', levels: ['campaign'], defaultLevels: ['campaign'] },
  { id: 'campaign', levels: ENTITY_LEVELS, defaultLevels: ENTITY_LEVELS },
  {
    id: 'adGroup',
    levels: ['target', 'productAd', 'searchTerm', 'negative'],
    defaultLevels: ['target', 'productAd', 'searchTerm'],
  },
  { id: 'target', levels: ['searchTerm'], defaultLevels: ['searchTerm'] },
  {
    id: 'matchType',
    levels: ['target', 'searchTerm', 'negative'],
    defaultLevels: ['target', 'negative'],
  },
  { id: 'negativeLevel', levels: ['negative'], defaultLevels: ['negative'] },
  { id: 'asin', levels: ['productAd'], defaultLevels: ['productAd'] },
  { id: 'sku', levels: ['productAd'], defaultLevels: ['productAd'] },
  { id: 'targetingType', levels: ['campaign'] },
  { id: 'budget', levels: ['portfolio', 'campaign'], defaultLevels: ['campaign'] },
  { id: 'biddingStrategy', levels: ['campaign'] },
  { id: 'costType', levels: ['campaign', 'adGroup', 'target'] },
  { id: 'defaultBid', levels: ['adGroup'], defaultLevels: ['adGroup'] },
  { id: 'bid', levels: ['target'], defaultLevels: ['target'] },
  { id: 'attribution', levels: METRIC_LEVELS },
  { id: 'impressions', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'clicks', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'ctr', levels: METRIC_LEVELS },
  { id: 'cost', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'cpc', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'sales', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'acos', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'roas', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'purchases', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'units', levels: METRIC_LEVELS },
  { id: 'cvr', levels: METRIC_LEVELS },
  { id: 'viewableImpressions', levels: METRIC_LEVELS },
  { id: 'vcpm', levels: METRIC_LEVELS },
  { id: 'changeCost', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'changeSales', levels: METRIC_LEVELS, defaultLevels: 'all' },
  { id: 'changeAcos', levels: METRIC_LEVELS },
];

const hasMetrics = (level: ExplorerLevel) => level !== 'negative';

function availableAt(spec: ColumnSpec, level: ExplorerLevel): boolean {
  if (spec.levels === 'all') return true;
  if (spec.levels === METRIC_LEVELS) return hasMetrics(level);
  return spec.levels.includes(level);
}

export function columnsForLevel(level: ExplorerLevel): string[] {
  return OPTIONAL_COLUMNS.filter((spec) => availableAt(spec, level)).map((spec) => spec.id);
}

export function defaultVisibleColumns(level: ExplorerLevel): Set<string> {
  return new Set(
    OPTIONAL_COLUMNS.filter(
      (spec) =>
        availableAt(spec, level) &&
        spec.defaultLevels !== undefined &&
        (spec.defaultLevels === 'all' || spec.defaultLevels.includes(level)),
    ).map((spec) => spec.id),
  );
}

/** Attribution einer Zeile nach F4 (wie `selectAttribution` im Rechenkern, nur als Beschriftung). */
export function attributionLabel(
  adProduct: string | null,
  accountType: string | undefined,
  setting: AttributionSetting,
  t: Translate,
): string {
  if (!adProduct) return MISSING_VALUE;
  if (setting === 'clicks14d') return t('explorer.attribution.clicks', { days: 14 });
  if (adProduct === 'SPONSORED_PRODUCTS') {
    return t('explorer.attribution.clicks', { days: accountType === 'vendor' ? 14 : 7 });
  }
  return t('explorer.attribution.clicksViews', { days: 14 });
}

/** Summenzeile (angeheftet unten) im Format einer Zeile. */
export function totalRow(
  total:
    | NonNullable<ExplorerRowsData['total']>
    | Pick<NonNullable<ExplorerRowsData['total']>, 'current' | 'comparison' | 'change'>,
  currency: string,
): GridRow {
  const change = total.change
    ? (Object.fromEntries(
        Object.entries(total.change).map(([key, value]) => [key, value.relative]),
      ) as ExplorerRow['change'])
    : null;
  return {
    id: '__total__',
    isTotal: true,
    profileId: '',
    accountName: '',
    countryCode: '',
    currencyCode: currency,
    adProduct: null,
    name: null,
    state: null,
    removed: false,
    placeholder: false,
    hasMetrics: true,
    attributes: {},
    current: total.current,
    comparison: total.comparison,
    change,
    attribution: null,
  };
}

const attr = (row: GridRow | undefined, key: string): string | null => {
  const value = row?.attributes[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

function metricValue(row: GridRow | undefined, key: MetricKey): string | null {
  const period = row?.current;
  if (!period) return null;
  if (key in period.derived) return period.derived[key as keyof typeof period.derived];
  return period.sums[key as keyof typeof period.sums] ?? null;
}

const DATA_CELL = 'font-data text-right justify-end';

export function buildColumnDefs(
  input: ColumnContext & { level: ExplorerLevel; visible: Set<string> },
): ColDef<GridRow>[] {
  const { t, locale, level } = input;
  const currencyOf = (row: GridRow) => (row.isTotal ? input.displayCurrency : row.currencyCode);
  const approx = (row: GridRow | undefined) => (row?.isTotal && input.converted ? '≈ ' : '');

  const formatMetric = (key: MetricKey, row: GridRow | undefined, value: string | null) => {
    if (value === null || !row) return MISSING_VALUE;
    switch (METRIC_KIND[key]) {
      case 'money':
        return `${approx(row)}${formatCurrency(value, currencyOf(row), locale)}`;
      case 'ratio':
        return formatPercent(value, locale);
      case 'factor':
        return formatNumber(value, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      case 'count':
        return formatNumber(value, locale, { maximumFractionDigits: 0 });
    }
  };

  const money = (amount: string | null, currency: string | null) =>
    amount === null ? MISSING_VALUE : formatCurrency(amount, currency ?? '', locale);

  const text = (
    id: string,
    get: (row: GridRow) => string | null,
    extra: Partial<ColDef<GridRow>> = {},
  ): ColDef<GridRow> => ({
    colId: id,
    headerName: t(`explorer.column.${id}`),
    valueGetter: ({ data }: ValueGetterParams<GridRow>) =>
      data && !data.isTotal ? get(data) : null,
    valueFormatter: ({ value }) =>
      value === null || value === undefined ? MISSING_VALUE : String(value),
    filter: 'agTextColumnFilter',
    ...extra,
  });

  const metric = (key: MetricKey): ColDef<GridRow> => ({
    colId: key,
    headerName: t(`explorer.column.${key}`),
    valueGetter: ({ data }) => metricValue(data, key),
    valueFormatter: ({ data, value }) => formatMetric(key, data, value as string | null),
    comparator: compareDecimalNullsLast,
    useValueFormatterForExport: false,
    type: 'rightAligned',
    cellClass: DATA_CELL,
    filter: 'decimalFilter',
  });

  const changeColumn = (id: string, key: MetricKey): ColDef<GridRow> => ({
    colId: id,
    headerName: t(`explorer.column.${id}`),
    valueGetter: ({ data }) => data?.change?.[key] ?? null,
    valueFormatter: ({ value }) => formatChange((value as string | null) ?? null, locale),
    comparator: compareDecimalNullsLast,
    useValueFormatterForExport: false,
    type: 'rightAligned',
    cellClass: ({ value }: CellClassParams<GridRow>) => {
      const tone = changeTone(key, (value as string | null) ?? null);
      return [
        DATA_CELL,
        tone === 'positive'
          ? 'text-lime-deep'
          : tone === 'negative'
            ? 'text-loss'
            : 'text-ink-secondary',
      ];
    },
  });

  const bid = (amountKey: string, currencyKey: string) => (row: GridRow) => {
    const amount = attr(row, amountKey);
    if (amount === null) return null;
    const formatted = money(amount, attr(row, currencyKey));
    // Gebote bei vCPM-Kampagnen gelten je 1000 sichtbare Impressionen (plan.md §5).
    return attr(row, 'costType') === 'VCPM'
      ? t('explorer.perThousandViewable', { value: formatted })
      : formatted;
  };

  const builders: Record<string, () => ColDef<GridRow>> = {
    state: () =>
      text('state', (row) => {
        if (!row.state) return null;
        const key = `explorer.state.${row.state}`;
        const label = t(key);
        // Unbekannte Zustände (Amazon ergänzt gelegentlich) wie geliefert.
        return label === key ? row.state : label;
      }),
    adProduct: () =>
      text('adProduct', (row) =>
        row.adProduct ? t(`analytics.adProduct.${row.adProduct}`) : null,
      ),
    profile: () => text('profile', (row) => `${row.accountName} · ${row.countryCode}`),
    currency: () => text('currency', (row) => row.currencyCode),
    portfolio: () => text('portfolio', (row) => attr(row, 'portfolioName')),
    campaign: () => text('campaign', (row) => attr(row, 'campaignName')),
    adGroup: () => text('adGroup', (row) => attr(row, 'adGroupName')),
    target: () =>
      text('target', (row) => {
        const keyword = attr(row, 'keywordText');
        const match = attr(row, 'matchType');
        if (keyword) return match ? `${keyword} · ${match}` : keyword;
        const expression = row.attributes.expression;
        return expression ? JSON.stringify(expression) : null;
      }),
    matchType: () => text('matchType', (row) => attr(row, 'matchType')),
    negativeLevel: () =>
      text('negativeLevel', (row) => {
        const value = attr(row, 'level');
        return value ? t(`explorer.negativeLevel.${value}`) : null;
      }),
    asin: () => text('asin', (row) => attr(row, 'asin')),
    sku: () => text('sku', (row) => attr(row, 'sku')),
    targetingType: () => text('targetingType', (row) => attr(row, 'targetingType')),
    budget: () =>
      text(
        'budget',
        (row) => {
          const amount = attr(row, 'budgetAmount');
          return amount === null ? null : money(amount, attr(row, 'budgetCurrencyCode'));
        },
        { cellClass: DATA_CELL },
      ),
    biddingStrategy: () => text('biddingStrategy', (row) => attr(row, 'biddingStrategy')),
    costType: () =>
      text('costType', (row) =>
        attr(row, 'costType') === 'VCPM' ? 'vCPM' : row.adProduct ? 'CPC' : null,
      ),
    defaultBid: () =>
      text('defaultBid', bid('defaultBid', 'defaultBidCurrencyCode'), { cellClass: DATA_CELL }),
    bid: () => text('bid', bid('bid', 'bidCurrencyCode'), { cellClass: DATA_CELL }),
    attribution: () =>
      text('attribution', (row) =>
        attributionLabel(row.adProduct, input.accountTypeOf(row.profileId), input.attribution, t),
      ),
    changeCost: () => changeColumn('changeCost', 'cost'),
    changeSales: () => changeColumn('changeSales', 'sales'),
    changeAcos: () => changeColumn('changeAcos', 'acos'),
  };

  const nameColumn: ColDef<GridRow> = {
    colId: 'name',
    headerName: t(`explorer.column.name`),
    pinned: 'left',
    lockPinned: true,
    minWidth: 220,
    filter: 'agTextColumnFilter',
    valueGetter: ({ data }) => {
      if (!data) return null;
      if (data.isTotal) return t('explorer.total');
      const name = data.name ?? t('explorer.unknownName');
      return data.removed ? t('explorer.removedSuffix', { name }) : name;
    },
  };

  const optional = OPTIONAL_COLUMNS.filter(
    (spec) => availableAt(spec, level) && input.visible.has(spec.id),
  ).map((spec) => (builders[spec.id] ?? (() => metric(spec.id as MetricKey)))());

  return [nameColumn, ...optional];
}
