import type { SavedViewArea, SavedViewState } from '@profitbash/shared';
import { DEFAULT_FILTER_STATE, parseStoredFilters, type FilterState } from '../analytics/filters';
import type { MetricKey } from '../analytics/metrics';
import { explorerStateToQuery, pathForLevel, type ExplorerState } from '../explorer/state';

/**
 * Zustand gespeicherter Ansichten (`phase-2.md` F8, 2.9): Filterleiste, im Explorer zusätzlich Ebene, Drill-Down,
 * Spalten, Sortierung und Chart-Kennzahlen. Laden wirkt wie selbst eingestellt: URL, Verlauf, `ui_state`.
 */

export function viewState(
  area: SavedViewArea,
  filters: FilterState,
  explorer?: { explorer: ExplorerState; columns: string[] | null },
): SavedViewState {
  const state: SavedViewState = {
    filters: {
      clientIds: [...filters.clientIds],
      withoutClient: filters.withoutClient,
      profileIds: filters.profileIds ? [...filters.profileIds] : null,
      period:
        filters.period.preset === 'custom' && filters.period.range
          ? { preset: 'custom', range: { ...filters.period.range } }
          : { preset: filters.period.preset },
      comparison: filters.comparison,
      currency: filters.currency,
      attribution: filters.attribution,
      // Nur mit Tag-Filter: Ansichten ohne ihn bleiben gleich den vor 3.7 gespeicherten.
      ...(filters.tagIds.length > 0 && { tagIds: [...filters.tagIds].sort() }),
    },
  };
  if (area === 'explorer' && explorer) {
    const e = explorer.explorer;
    state.explorer = {
      level: e.level,
      drill: { ...e.drill },
      includeRemoved: e.includeRemoved,
      adProducts: [...e.adProducts],
      chartMetrics: [...e.chartMetrics],
      columns: explorer.columns ? [...explorer.columns] : null,
      sort: e.sort ? { ...e.sort } : null,
      ...(e.level === 'productAd' &&
        e.productSearch.length > 0 && { productSearch: [...e.productSearch] }),
    };
  }
  return state;
}

/** Filterleiste aus einer Ansicht (dieselbe Prüfung wie die zuletzt benutzte Auswahl). */
export function filtersFromView(state: SavedViewState): FilterState {
  return parseStoredFilters(state.filters) ?? DEFAULT_FILTER_STATE;
}

/** Ziel im Explorer: Pfad der Ebene, Parameter nur aus der Ansicht (alte Drill-Downs fallen weg). */
export function explorerTarget(state: SavedViewState): {
  path: string;
  query: Record<string, string>;
} {
  const explorer = state.explorer!;
  return {
    path: pathForLevel(explorer.level),
    query: explorerStateToQuery({
      drill: explorer.drill,
      includeRemoved: explorer.includeRemoved,
      adProducts: explorer.adProducts,
      chartMetrics: explorer.chartMetrics as [MetricKey, MetricKey],
      sort: explorer.sort,
      productSearch: explorer.productSearch ?? [],
    }),
  };
}

/** JSON mit sortierten Schlüsseln (die DB speichert `jsonb` in eigener Reihenfolge). */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/** Vergleichbare Form: Listen ohne Reihenfolge (IDs, Ad-Typen, Spalten sortiert). */
function canonical(state: SavedViewState): string {
  const sorted = (list: readonly string[] | null) => (list ? [...list].sort() : null);
  return stableJson({
    ...state,
    filters: {
      ...state.filters,
      clientIds: sorted(state.filters.clientIds),
      profileIds: sorted(state.filters.profileIds),
    },
    ...(state.explorer && {
      explorer: {
        ...state.explorer,
        adProducts: sorted(state.explorer.adProducts),
        columns: sorted(state.explorer.columns),
      },
    }),
  });
}

/** Ansicht, die genau dem aktuellen Zustand entspricht (Anzeige im Menü), sonst `null`. */
export function matchingView<T extends { state: SavedViewState }>(
  views: readonly T[],
  current: SavedViewState,
): T | null {
  const key = canonical(current);
  return views.find((view) => canonical(view.state) === key) ?? null;
}
