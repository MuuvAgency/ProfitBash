import {
  compareDecimalNullsLast,
  formatCurrency,
  formatNumber,
  formatPercent,
  MISSING_VALUE,
  type Locale,
} from '@profitbash/shared';
import type { CellClassParams, ColDef, ICellRendererParams } from 'ag-grid-community';
import { markRaw } from 'vue';
import type { RouteLocationRaw } from 'vue-router';
import type { SearchTermAnalysisData, SearchTermNgramData, SearchTermRowData } from '../api/client';
import DecimalFilter from '../explorer/DecimalFilter.vue';
import { targetLabel, type Labels } from '../explorer/amazon-labels';
import EntityLinkCell, { type EntityLinkCellParams } from './EntityLinkCell.vue';
import type { ExplorerLinkLevel } from './explorer-link';

/**
 * Spalten der Suchbegriff-Analyse (2b.2b): Suchbegriffe mit Einstufung und Wortbausteine (N-Gramme). Beträge in der
 * Währung des Profils (ein Profil je Ansicht, keine Umrechnung), Sortierung und Filter über Decimal-Strings.
 */

const METRICS = [
  'impressions',
  'clicks',
  'ctr',
  'cost',
  'cpc',
  'sales',
  'acos',
  'roas',
  'purchases',
  'units',
  'cvr',
] as const;
type Metric = (typeof METRICS)[number];

const KIND: Record<Metric, 'count' | 'money' | 'ratio' | 'factor'> = {
  impressions: 'count',
  clicks: 'count',
  ctr: 'ratio',
  cost: 'money',
  cpc: 'money',
  sales: 'money',
  acos: 'ratio',
  roas: 'factor',
  purchases: 'count',
  units: 'count',
  cvr: 'ratio',
};

type Sums = Record<Metric, string | null>;

/** Zeile des Suchbegriff-Grids; die Summenzeile (unten angeheftet) trägt nur die Kennzahlen. */
export type TermGridRow =
  (SearchTermRowData & { isTotal?: false }) | ({ id: string; isTotal: true } & Sums);

export type NgramGridRow = SearchTermNgramData & { id: string };

export interface ColumnContext extends Labels {
  locale: Locale;
  currency: string;
  /** Ziel im Explorer für Kampagne bzw. Ad Group einer Zeile (2b.2e); fehlt oder `null`: reiner Text. */
  explorerLink?: (level: ExplorerLinkLevel, row: SearchTermRowData) => RouteLocationRaw | null;
}

export function formatSearchTermMetric(
  key: Metric,
  value: string | null | undefined,
  { locale, currency }: Pick<ColumnContext, 'locale' | 'currency'>,
): string {
  if (value === null || value === undefined) return MISSING_VALUE;
  switch (KIND[key]) {
    case 'money':
      return formatCurrency(value, currency, locale);
    case 'ratio':
      return formatPercent(value, locale);
    case 'factor':
      return formatNumber(value, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    case 'count':
      return formatNumber(value, locale, { maximumFractionDigits: 0 });
  }
}

const DATA_CELL = 'font-data text-right justify-end';

function metricColumns<T extends Sums>(context: ColumnContext): ColDef<T>[] {
  return METRICS.map((key) => ({
    colId: key,
    headerName: context.t(`explorer.column.${key}`),
    valueGetter: ({ data }) => data?.[key] ?? null,
    valueFormatter: ({ value }) =>
      formatSearchTermMetric(key, value as string | null | undefined, context),
    comparator: compareDecimalNullsLast,
    // CSV wie im Explorer: roher Decimal-String (Anteile als Bruch), die Währung in der Spalte `currency`.
    useValueFormatterForExport: false,
    type: 'rightAligned',
    cellClass: DATA_CELL,
    filter: markRaw(DecimalFilter),
    // Anteile erscheinen in Prozent: Filtereingabe „30“ meint 30 %.
    ...(KIND[key] === 'ratio' && { filterParams: { scale: 2 } }),
  }));
}

/** Währung des Profils: nie sichtbar, aber immer im CSV-Export (`gridCsv`). */
function currencyColumn<T>(context: ColumnContext): ColDef<T> {
  return {
    colId: 'currency',
    headerName: context.t('explorer.column.currency'),
    valueGetter: () => context.currency,
    hide: true,
  };
}

/** Einstufung als Text, bei „Beobachten“ mit Grund. */
export function classificationLabel(
  row: Pick<SearchTermRowData, 'classification' | 'reason'>,
  t: Labels['t'],
): string {
  const label = t(`searchTerms.class.${row.classification}`);
  return row.reason ? `${label} · ${t(`searchTerms.reason.${row.reason}`)}` : label;
}

const CLASS_TONE: Record<SearchTermRowData['classification'], string> = {
  harvest: 'text-lime-deep font-medium',
  negate: 'text-loss font-medium',
  watch: 'text-ink-secondary',
};

/**
 * Einstufung des Suchbegriffs über alle Targets (2b.2f), nur wenn sie von der Einstufung der Zeile abweicht (der
 * Grund allein zählt nicht): Sonst sagt sie nichts Neues. Bei „Beobachten“ mit Grund wie die Zeile selbst. Gezählt
 * werden Zeilen, nicht Targets: Schreibweisen eines Begriffs oder Ad-Typen können sich ein Target teilen.
 */
export function acrossTargetsLabel(
  row: Pick<
    SearchTermRowData,
    'classification' | 'termClassification' | 'termReason' | 'termTargets'
  >,
  { t, locale }: Pick<ColumnContext, 't' | 'locale'>,
): string | null {
  if (row.termClassification === row.classification) return null;
  return t('searchTerms.acrossTargets.cell', {
    label: classificationLabel(
      { classification: row.termClassification, reason: row.termReason },
      t,
    ),
    // `count` wählt Ein- oder Mehrzahl, `n` ist die formatierte Zahl.
    rows: t('searchTerms.acrossTargets.rows', {
      count: row.termTargets,
      n: formatNumber(String(row.termTargets), locale),
    }),
  });
}

/** Farbe der zweiten Zeile (Einstufung über alle Targets); das Gewicht bleibt normal, die Zeile selbst führt. */
const ACROSS_TONE: Record<SearchTermRowData['classification'], string> = {
  harvest: 'text-lime-deep',
  negate: 'text-loss',
  watch: 'text-ink-secondary',
};

/** Trennt im Wert der Spalte „Einstufung“ die Zeile selbst von der Einstufung über alle Targets. */
const ACROSS_SEPARATOR = '\n';

/**
 * Wert der Spalte „Einstufung“: die Einstufung der Zeile, bei Abweichung dahinter die über alle Targets. Beides
 * steht im Wert, weil das Grid eine Zelle nur neu zeichnet, wenn sich ihr Wert ändert (die Zeilen behalten nach
 * einem Neuladen ihre ID). Textfilter und Sortierung der Spalte sehen damit bewusst auch die zweite Zeile: „Ernten“
 * findet auch Zeilen, deren Begriff erst über alle Targets ein Harvest ist.
 */
function classificationValue(row: SearchTermRowData, context: ColumnContext): string {
  const own = classificationLabel(row, context.t);
  const across = acrossTargetsLabel(row, context);
  return across === null ? own : `${own}${ACROSS_SEPARATOR}${across}`;
}

/** Zelle „Einstufung“: zeichnet die beiden Teile des Werts als zwei Zeilen. */
function classificationCell({ data, value }: ICellRendererParams<TermGridRow>): HTMLElement {
  const [ownText = MISSING_VALUE, across] =
    typeof value === 'string' ? value.split(ACROSS_SEPARATOR) : [];
  // Eigene Zeilenhöhen: Die Zelle des Grids ist sonst so hoch wie die Zeile, zwei Zeilen passten nicht hinein.
  const cell = document.createElement('span');
  cell.className = 'flex min-w-0 flex-col';
  const own = document.createElement('span');
  own.className = 'truncate text-body-md';
  own.textContent = ownText;
  cell.append(own);
  if (across !== undefined && data && !data.isTotal) {
    const line = document.createElement('span');
    line.className = `truncate text-body-sm font-normal ${ACROSS_TONE[data.termClassification]}`;
    line.textContent = across;
    line.title = across;
    cell.append(line);
  }
  return cell;
}

export function termColumns(context: ColumnContext): ColDef<TermGridRow>[] {
  const { t } = context;
  const text = (
    id: string,
    header: string,
    get: (row: SearchTermRowData) => string | null,
    extra: Partial<ColDef<TermGridRow>> = {},
  ): ColDef<TermGridRow> => ({
    colId: id,
    headerName: header,
    valueGetter: ({ data }) => (data && !data.isTotal ? get(data) : null),
    valueFormatter: ({ value }) =>
      value === null || value === undefined ? MISSING_VALUE : String(value),
    filter: 'agTextColumnFilter',
    ...extra,
  });
  /** Name als Link in den Explorer (Kampagne, Ad Group), soweit die Entity im Profil bekannt ist. */
  const link = (level: ExplorerLinkLevel): Partial<ColDef<TermGridRow>> => ({
    cellRenderer: markRaw(EntityLinkCell),
    cellRendererParams: {
      linkFor: (row) => (row.isTotal ? null : (context.explorerLink?.(level, row) ?? null)),
    } satisfies EntityLinkCellParams,
  });
  const defs: ColDef<TermGridRow>[] = [
    {
      colId: 'searchTerm',
      headerName: t('searchTerms.column.searchTerm'),
      valueGetter: ({ data }) =>
        !data ? null : data.isTotal ? t('explorer.total') : data.searchTerm,
      pinned: 'left',
      lockPinned: true,
      minWidth: 240,
      filter: 'agTextColumnFilter',
    },
    text('classification', t('searchTerms.column.classification'), (row) =>
      classificationValue(row, context),
    ),
    text('campaign', t('explorer.column.campaign'), (row) => row.campaignName, link('campaign')),
    text('adGroup', t('explorer.column.adGroup'), (row) => row.adGroupName, link('adGroup')),
    text('target', t('explorer.column.target'), (row) =>
      targetLabel(
        { keywordText: row.keywordText, matchType: row.matchType, expression: row.expression },
        context,
      ),
    ),
    ...metricColumns<TermGridRow>(context),
    currencyColumn<TermGridRow>(context),
  ];
  return defs.map((def) =>
    def.colId === 'classification'
      ? {
          ...def,
          // Platz für die zweite Zeile „Über alle Targets: … (n Zeilen)“; längere Texte kürzt die Zelle (Titel).
          minWidth: 300,
          cellRenderer: classificationCell,
          // Nur für den CSV-Export (die Zelle zeichnet der Renderer aus dem Wert): beide Teile in einer Zeile.
          valueFormatter: ({ value }: { value: unknown }) =>
            typeof value === 'string' ? value.replace(ACROSS_SEPARATOR, '; ') : '',
          cellClass: ({ data }: CellClassParams<TermGridRow>) =>
            `flex items-center ${data && !data.isTotal ? CLASS_TONE[data.classification] : ''}`,
        }
      : def,
  );
}

export function ngramColumns(context: ColumnContext): ColDef<NgramGridRow>[] {
  const { t, locale } = context;
  return [
    {
      colId: 'gram',
      headerName: t('searchTerms.column.gram'),
      field: 'gram',
      pinned: 'left',
      lockPinned: true,
      minWidth: 220,
      filter: 'agTextColumnFilter',
    },
    {
      colId: 'size',
      headerName: t('searchTerms.column.size'),
      field: 'size',
      type: 'rightAligned',
      cellClass: DATA_CELL,
      maxWidth: 110,
    },
    {
      colId: 'searchTerms',
      headerName: t('searchTerms.column.searchTerms'),
      field: 'searchTerms',
      valueFormatter: ({ value }) => formatNumber(String(value ?? 0), locale),
      useValueFormatterForExport: false,
      type: 'rightAligned',
      cellClass: DATA_CELL,
    },
    ...metricColumns<NgramGridRow>(context),
    currencyColumn<NgramGridRow>(context),
  ];
}

export function totalRow(total: SearchTermAnalysisData['total']): TermGridRow {
  return { id: '__total__', isTotal: true, ...total };
}
