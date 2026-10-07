import { AD_PRODUCTS, CHANGE_KEYS, type AdProduct, type ExplorerLevel } from '@profitbash/shared';
import type { LocationQuery, LocationQueryRaw } from 'vue-router';
import type { MetricKey } from '../analytics/metrics';

/**
 * Zustand des Explorers (`phase-2.md` F6) in der URL: Ebene als Pfad (`/ads/explorer/targets`), Drill-Down als je eine
 * ID (`portfolio`, `campaign`, `adGroup`), entfernte Entities (`removed=1`), Ad-Typen (`adp`, F1) und die Kennzahlen des
 * Charts (`m1`, `m2`). Die Auswahl der Filterleiste kommt aus `useAnalyticsFilters` (geteilt mit dem Dashboard).
 */

export const EXPLORER_BASE_PATH = '/ads/explorer';

export const EXPLORER_TABS: { level: ExplorerLevel; segment: string }[] = [
  { level: 'portfolio', segment: 'portfolios' },
  { level: 'campaign', segment: 'campaigns' },
  { level: 'adGroup', segment: 'ad-groups' },
  { level: 'target', segment: 'targets' },
  { level: 'productAd', segment: 'product-ads' },
  { level: 'searchTerm', segment: 'search-terms' },
  { level: 'negative', segment: 'negatives' },
];

/** Suchbegriff-Analyse (2b.2): eigene Seite unter dem Explorer, als weiterer Reiter verlinkt. */
export const SEARCH_TERM_ANALYSIS_PATH = `${EXPLORER_BASE_PATH}/search-term-analysis`;
export const SEARCH_TERM_ANALYSIS_TAB = 'searchTermAnalysis';

export const DEFAULT_EXPLORER_LEVEL: ExplorerLevel = 'campaign';

export function levelFromPath(path: string): ExplorerLevel {
  const segment = path.slice(EXPLORER_BASE_PATH.length).replace(/^\/+|\/+$/g, '');
  return EXPLORER_TABS.find((tab) => tab.segment === segment)?.level ?? DEFAULT_EXPLORER_LEVEL;
}

export function pathForLevel(level: ExplorerLevel): string {
  return `${EXPLORER_BASE_PATH}/${EXPLORER_TABS.find((tab) => tab.level === level)!.segment}`;
}

const CHILD: Partial<Record<ExplorerLevel, ExplorerLevel>> = {
  portfolio: 'campaign',
  campaign: 'adGroup',
  adGroup: 'target',
};

/** Ebene, die ein Klick auf eine Zeile öffnet (`null`: kein Drill-Down). */
export function childLevel(level: ExplorerLevel): ExplorerLevel | null {
  return CHILD[level] ?? null;
}

export interface DrillDown {
  portfolioId: string | null;
  campaignId: string | null;
  adGroupId: string | null;
}

export interface ExplorerState {
  level: ExplorerLevel;
  drill: DrillDown;
  includeRemoved: boolean;
  /** Leer = alle Ad-Typen. */
  adProducts: AdProduct[];
  chartMetrics: [MetricKey, MetricKey];
  /** Eine Spalte (`colId`) mit Richtung; `null` = Reihenfolge des Servers (Spend absteigend). */
  sort: GridSort | null;
  /** ASINs/SKUs der Suche im Reiter Product Ads (`q`, F10); leer = keine Suche. */
  productSearch: string[];
}

/** Wie `MAX_ASIN_SEARCH_TERMS` und die Länge je Begriff in `@profitbash/shared`. */
const MAX_PRODUCT_TERMS = 100;
const MAX_TERM_LENGTH = 60;

/**
 * Eingabe von ASINs/SKUs (auch aus der Zwischenablage): getrennt durch Leerzeichen, Komma, Semikolon oder Zeilenumbruch,
 * doppelte (ohne Groß-/Kleinschreibung) fallen weg, zu lange Begriffe ebenso, höchstens 100.
 */
export function parseProductTerms(text: string): string[] {
  const seen = new Set<string>();
  const terms: string[] = [];
  for (const raw of text.split(/[\s,;]+/)) {
    const term = raw.trim();
    if (!term || term.length > MAX_TERM_LENGTH || seen.has(term.toUpperCase())) continue;
    seen.add(term.toUpperCase());
    // Wie eingegeben: Die Suche ignoriert Groß-/Kleinschreibung.
    terms.push(term);
    if (terms.length === MAX_PRODUCT_TERMS) break;
  }
  return terms;
}

export interface GridSort {
  column: string;
  direction: 'asc' | 'desc';
}

export const DEFAULT_CHART_METRICS: [MetricKey, MetricKey] = ['cost', 'sales'];

/** Parameter des Explorers; andere (Filterleiste) bleiben beim Wechsel erhalten. */
export const EXPLORER_QUERY_KEYS = [
  'portfolio',
  'campaign',
  'adGroup',
  'removed',
  'adp',
  'm1',
  'm2',
  'sort',
  'q',
];

const SORT = /^([A-Za-z][A-Za-z0-9]{0,39})\.(asc|desc)$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function one(value: LocationQuery[string] | undefined): string | undefined {
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === 'string' ? first : undefined;
}

const uuid = (value: string | undefined) => (value && UUID.test(value) ? value : null);
const isMetric = (value: string | undefined): value is MetricKey =>
  value !== undefined && (CHANGE_KEYS as readonly string[]).includes(value);

export function explorerStateFromRoute(path: string, query: LocationQuery): ExplorerState {
  const m1 = one(query.m1);
  const m2 = one(query.m2);
  const adProducts = (one(query.adp)?.split(',') ?? []).filter((p): p is AdProduct =>
    (AD_PRODUCTS as readonly string[]).includes(p),
  );
  return {
    level: levelFromPath(path),
    drill: {
      portfolioId: uuid(one(query.portfolio)),
      campaignId: uuid(one(query.campaign)),
      adGroupId: uuid(one(query.adGroup)),
    },
    includeRemoved: one(query.removed) === '1',
    adProducts: [...new Set(adProducts)],
    chartMetrics: [
      isMetric(m1) ? m1 : DEFAULT_CHART_METRICS[0],
      isMetric(m2) ? m2 : DEFAULT_CHART_METRICS[1],
    ],
    sort: sortFrom(one(query.sort)),
    productSearch: parseProductTerms(one(query.q) ?? ''),
  };
}

function sortFrom(value: string | undefined): GridSort | null {
  const match = value ? SORT.exec(value) : null;
  return match ? { column: match[1]!, direction: match[2] as GridSort['direction'] } : null;
}

/** Parameter des Explorers für einen Zustand (Ansicht laden); Standardwerte fehlen wie in der Filterleiste. */
export function explorerStateToQuery(state: Omit<ExplorerState, 'level'>): Record<string, string> {
  const query: Record<string, string> = {};
  for (const key of ['portfolioId', 'campaignId', 'adGroupId'] as const) {
    const value = state.drill[key];
    if (value) query[PARAM_OF[key]] = value;
  }
  if (state.includeRemoved) query.removed = '1';
  if (state.adProducts.length > 0 && state.adProducts.length < AD_PRODUCTS.length) {
    // Feste Reihenfolge (wie die Auswahl im Explorer), damit gleiche Zustände gleiche Links ergeben.
    query.adp = AD_PRODUCTS.filter((p) => state.adProducts.includes(p)).join(',');
  }
  if (state.chartMetrics[0] !== DEFAULT_CHART_METRICS[0]) query.m1 = state.chartMetrics[0];
  if (state.chartMetrics[1] !== DEFAULT_CHART_METRICS[1]) query.m2 = state.chartMetrics[1];
  if (state.sort) query.sort = `${state.sort.column}.${state.sort.direction}`;
  if (state.productSearch.length > 0) query.q = state.productSearch.join(',');
  return query;
}

const DRILL_PARAM: Partial<Record<ExplorerLevel, keyof DrillDown>> = {
  portfolio: 'portfolioId',
  campaign: 'campaignId',
  adGroup: 'adGroupId',
};
const PARAM_OF: Record<keyof DrillDown, string> = {
  portfolioId: 'portfolio',
  campaignId: 'campaign',
  adGroupId: 'adGroup',
};

/** Ziel eines Klicks auf eine Zeile der Ebene `level`: nächste Ebene, gefiltert auf die Zeile, obere Filter bleiben. */
export function drillQuery(
  base: LocationQueryRaw,
  level: ExplorerLevel,
  id: string,
  parents: Partial<DrillDown>,
): { path: string; query: LocationQueryRaw } {
  const child = childLevel(level)!;
  // Nur die Ebenen oberhalb der geklickten bleiben; tiefere Drill-IDs (z. B. aus einem anderen Reiter) fallen weg.
  const order: (keyof DrillDown)[] = ['portfolioId', 'campaignId', 'adGroupId'];
  const own = DRILL_PARAM[level]!;
  const query: LocationQueryRaw = Object.fromEntries(
    Object.entries(base).filter(([key]) => !Object.values(PARAM_OF).includes(key)),
  );
  for (const key of order.slice(0, order.indexOf(own))) {
    const value = parents[key];
    if (value) query[PARAM_OF[key]] = value;
  }
  query[PARAM_OF[own]] = id;
  return { path: pathForLevel(child), query };
}

/** Ebene und Filter für `/api/ads/explorer/rows` bzw. `/timeseries`. */
export function explorerQuery(state: ExplorerState) {
  const { drill } = state;
  return {
    level: state.level,
    ...(state.adProducts.length > 0 && { adProducts: state.adProducts }),
    filter: {
      ...(drill.portfolioId && { portfolioIds: [drill.portfolioId] }),
      ...(drill.campaignId && { campaignIds: [drill.campaignId] }),
      ...(drill.adGroupId && { adGroupIds: [drill.adGroupId] }),
      ...(state.includeRemoved && { includeRemoved: true }),
      ...(state.level === 'productAd' &&
        state.productSearch.length > 0 && { productSearch: state.productSearch }),
    },
  };
}
