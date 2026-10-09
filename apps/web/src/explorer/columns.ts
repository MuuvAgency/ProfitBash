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
import { markRaw } from 'vue';
import type { ExplorerRowsData, TagData } from '../api/client';
import { rowTags, rowTagsText } from '../tags/row-tags';
import type { TagsCellParams } from '../tags/TagsCell.vue';
import { changeTone, formatChange, type MetricKey } from '../analytics/metrics';
import { amazonLabel, targetLabel } from './amazon-labels';
import DecimalFilter from './DecimalFilter.vue';
import { EDITABLE_COLUMN_FIELDS, entityTypeOf } from './editing';

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
  /** Gibt es den i18n-Key? */
  te: (key: string) => boolean;
  locale: Locale;
  attribution: AttributionSetting;
  /** Kontotyp je Profil (`filter-options`), für die Attribution „wie Konsole“. */
  accountTypeOf: (profileId: string) => string | undefined;
  /** Währung der Summenzeile. */
  displayCurrency: string;
  /** Summenzeile umgerechnet („≈“). */
  converted: boolean;
  /**
   * Status, Budget und Gebote mit der Zelle zum Bearbeiten (3.5): zeigt offene Änderungen und, mit dem Recht
   * `write`, die Eingabe. Sortierung, Filter und CSV bleiben beim Stand von Amazon.
   */
  editable?: boolean;
  /** Tags der Organisation nach ID (3.7); ohne Angabe (kein Recht `view` im Feature `tags`) fehlt die Spalte. */
  tags?: ReadonlyMap<string, TagData>;
}

type MetricKind = 'money' | 'count' | 'ratio' | 'factor';
/** Kennzahl-Spalten: Veränderungs-Kennzahlen und die sichtbaren Impressionen (nur SD). */
type ColumnMetric = MetricKey | 'viewableImpressions';
const METRIC_KIND: Record<ColumnMetric, MetricKind> = {
  viewableImpressions: 'count',
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
/** Ebenen mit eigenen Tags (`TAG_ENTITY_TYPES`). */
export const TAG_LEVELS: ExplorerLevel[] = ['campaign', 'adGroup', 'target', 'productAd'];
const NO_TAGS: ReadonlyMap<string, TagData> = new Map();

/** Wählbare Spalten (außer „Name“) in ihrer Reihenfolge. */
export const OPTIONAL_COLUMNS: ColumnSpec[] = [
  { id: 'state', levels: 'all', defaultLevels: 'all' },
  { id: 'adProduct', levels: 'all', defaultLevels: 'all' },
  { id: 'profile', levels: 'all', defaultLevels: 'all' },
  { id: 'currency', levels: 'all' },
  { id: 'portfolio', levels: ['campaign'], defaultLevels: ['campaign'] },
  { id: 'tags', levels: TAG_LEVELS, defaultLevels: TAG_LEVELS },
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

function metricValue(row: GridRow | undefined, key: ColumnMetric): string | null {
  const period = row?.current;
  if (!period) return null;
  if (key in period.derived) return period.derived[key as keyof typeof period.derived];
  return period.sums[key as keyof typeof period.sums] ?? null;
}

const DATA_CELL = 'font-data text-right justify-end';

export function buildColumnDefs(
  input: ColumnContext & {
    level: ExplorerLevel;
    visible: Set<string>;
    /** Sortierung aus der URL; alle anderen Spalten ausdrücklich ohne (sonst bliebe eine alte stehen). */
    sort?: { column: string; direction: 'asc' | 'desc' } | null;
  },
): ColDef<GridRow>[] {
  const { t, locale, level } = input;
  const currencyOf = (row: GridRow) => (row.isTotal ? input.displayCurrency : row.currencyCode);
  const approx = (row: GridRow | undefined) => (row?.isTotal && input.converted ? '≈ ' : '');

  const formatMetric = (key: ColumnMetric, row: GridRow | undefined, value: string | null) => {
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

  const metric = (key: ColumnMetric): ColDef<GridRow> => ({
    colId: key,
    headerName: t(`explorer.column.${key}`),
    valueGetter: ({ data }) => metricValue(data, key),
    valueFormatter: ({ data, value }) => formatMetric(key, data, value as string | null),
    comparator: compareDecimalNullsLast,
    useValueFormatterForExport: false,
    type: 'rightAligned',
    cellClass: DATA_CELL,
    filter: markRaw(DecimalFilter),
    // Anteile erscheinen in Prozent: Filtereingabe „30“ meint 30 %.
    ...(METRIC_KIND[key] === 'ratio' && { filterParams: { scale: 2 } }),
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

  /**
   * Beträge aus den Attributen (Budget, Gebote): roher Decimal-String für Sortierung, Filter und CSV, formatiert mit ihrer
   * Währung; Gebote bei vCPM-Kampagnen gelten je 1000 sichtbare Impressionen (plan.md §5).
   */
  const amount = (
    id: string,
    amountKey: string,
    currencyKey: string,
    perViewable = false,
  ): ColDef<GridRow> => ({
    colId: id,
    headerName: t(`explorer.column.${id}`),
    valueGetter: ({ data }) => (data && !data.isTotal ? attr(data, amountKey) : null),
    valueFormatter: ({ data, value }) => {
      if (value === null || value === undefined || !data) return MISSING_VALUE;
      const formatted = money(value as string, attr(data, currencyKey));
      return perViewable && attr(data, 'costType') === 'VCPM'
        ? t('explorer.perThousandViewable', { value: formatted })
        : formatted;
    },
    comparator: compareDecimalNullsLast,
    useValueFormatterForExport: false,
    type: 'rightAligned',
    cellClass: DATA_CELL,
    filter: markRaw(DecimalFilter),
  });

  const builders: Record<string, () => ColDef<GridRow>> = {
    state: () =>
      text('state', (row) => {
        if (!row.state) return null;
        const key = `explorer.state.${row.state}`;
        // Unbekannte Zustände (Amazon ergänzt gelegentlich) wie geliefert.
        return input.te(key) ? t(key) : row.state;
      }),
    adProduct: () =>
      text('adProduct', (row) =>
        row.adProduct ? t(`analytics.adProduct.${row.adProduct}`) : null,
      ),
    profile: () => text('profile', (row) => `${row.accountName} · ${row.countryCode}`),
    currency: () => text('currency', (row) => row.currencyCode),
    portfolio: () => text('portfolio', (row) => attr(row, 'portfolioName')),
    tags: () =>
      text('tags', (row) => rowTagsText(rowTags(row.attributes, input.tags ?? NO_TAGS)), {
        cellRenderer: 'tagsCell',
        cellRendererParams: { tags: () => input.tags ?? NO_TAGS } satisfies TagsCellParams,
        minWidth: 160,
      }),
    campaign: () => text('campaign', (row) => attr(row, 'campaignName')),
    adGroup: () => text('adGroup', (row) => attr(row, 'adGroupName')),
    target: () => text('target', (row) => targetLabel(row.attributes, input)),
    matchType: () =>
      text('matchType', (row) => amazonLabel('matchType', attr(row, 'matchType'), input)),
    negativeLevel: () =>
      text('negativeLevel', (row) => {
        const value = attr(row, 'level');
        return value ? t(`explorer.negativeLevel.${value}`) : null;
      }),
    asin: () => text('asin', (row) => attr(row, 'asin')),
    sku: () => text('sku', (row) => attr(row, 'sku')),
    targetingType: () =>
      text('targetingType', (row) =>
        amazonLabel('targetingType', attr(row, 'targetingType'), input),
      ),
    budget: () => amount('budget', 'budgetAmount', 'budgetCurrencyCode'),
    biddingStrategy: () =>
      text('biddingStrategy', (row) =>
        amazonLabel('biddingStrategy', attr(row, 'biddingStrategy'), input),
      ),
    costType: () =>
      text('costType', (row) =>
        attr(row, 'costType') === 'VCPM' ? 'vCPM' : row.adProduct ? 'CPC' : null,
      ),
    defaultBid: () => amount('defaultBid', 'defaultBid', 'defaultBidCurrencyCode', true),
    bid: () => amount('bid', 'bid', 'bidCurrencyCode', true),
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
    cellRenderer: 'nameCell',
    headerName: t(`explorer.column.name`),
    pinned: 'left',
    lockPinned: true,
    minWidth: 220,
    filter: 'agTextColumnFilter',
    valueGetter: ({ data }) => {
      if (!data) return null;
      if (data.isTotal) return t('explorer.total');
      // Targets und Negatives ohne Keyword heißen in der DB wie ihr Ausdruck (JSON): lesbar machen (2.13).
      const expression = data.attributes.expression;
      const readable =
        (level === 'target' || level === 'negative') &&
        !attr(data, 'keywordText') &&
        expression !== null &&
        typeof expression === 'object' &&
        Object.keys(expression).length > 0
          ? targetLabel(data.attributes, input)
          : null;
      const name = readable ?? data.name ?? t('explorer.unknownName');
      return data.removed ? t('explorer.removedSuffix', { name }) : name;
    },
  };

  // Die Währung ist immer da (für den CSV-Export), aber nur sichtbar, wenn gewählt.
  const optional = OPTIONAL_COLUMNS.filter(
    (spec) =>
      availableAt(spec, level) &&
      (input.visible.has(spec.id) || spec.id === 'currency') &&
      (spec.id !== 'tags' || input.tags !== undefined),
  ).map((spec) => {
    const def = (builders[spec.id] ?? (() => metric(spec.id as ColumnMetric)))();
    return spec.id === 'currency' ? { ...def, hide: !input.visible.has('currency') } : def;
  });

  const sortOf = (colId: string | undefined) =>
    input.sort && input.sort.column === colId ? input.sort.direction : null;
  const editCell = (def: ColDef<GridRow>): ColDef<GridRow> =>
    input.editable &&
    def.colId !== undefined &&
    def.colId in EDITABLE_COLUMN_FIELDS &&
    entityTypeOf(level) !== null
      ? {
          ...def,
          cellRenderer: 'editCell',
          minWidth: 132,
          // Pfeiltasten, Enter und Escape gehören der Eingabe in der Zelle, nicht der Navigation des Grids.
          suppressKeyboardEvent: ({ event }) =>
            event.target instanceof HTMLInputElement || event.target instanceof HTMLSelectElement,
        }
      : def;
  return [nameColumn, ...optional].map((def) => ({ ...editCell(def), sort: sortOf(def.colId) }));
}
