import { useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, onScopeDispose, ref, shallowRef, watch } from 'vue';
import {
  useRoute,
  useRouter,
  type HistoryState,
  type LocationQuery,
  type RouteLocationRaw,
} from 'vue-router';
import { useTagRights, useTags } from '../tags/queries';
import { api } from '../api';
import {
  filterStateFromQuery,
  filterStateToQuery,
  mergeFilterQuery,
  parseStoredFilters,
  sanitizeFilterState,
  toAnalyticsQuery,
  type FilterState,
} from './filters';
import { todayInBrowser } from './periods';

const UI_STATE_SCOPE = 'analytics';
/** Eine Auswahl für Dashboard und Explorer (Dominik, 2026-09-28: geteilt). */
const UI_STATE_KEY = 'filters';
const uiStateQueryKey = ['ui-state', UI_STATE_SCOPE, UI_STATE_KEY] as const;

/** Als reines JSON in `history.state` (strukturiert klonbar, keine Proxys). */
function toHistoryValue(state: FilterState): HistoryState {
  return JSON.parse(JSON.stringify(state)) as HistoryState;
}

export const filterOptionsQueryKey = ['analytics', 'filter-options'] as const;

/** Zustand je Verlaufseintrag (`history.state`): Zurück/Vor stellt so auch die Profilauswahl wieder her. */
const HISTORY_STATE_KEY = 'analyticsFilters';

/**
 * Link auf eine Auswertung (Dashboard, Explorer) mit der Auswahl `state`: kurzer Zustand in der URL, der ganze (auch die
 * Profile) im Verlaufseintrag. In einem neuen Tab fehlt der Verlaufseintrag: Dort gelten die Profile der letzten
 * eigenen Auswahl (Merker `pf=1`).
 */
export function filterLink(path: string, state: FilterState) {
  return {
    path,
    query: filterStateToQuery(state),
    state: { [HISTORY_STATE_KEY]: toHistoryValue(state) },
  };
}

/**
 * Filterleiste von Dashboard und Explorer (`phase-2.md` F2–F5): Zustand aus der URL, ohne Filter-Parameter die letzte
 * Auswahl aus `ui_state`. Änderungen erzeugen einen Verlaufseintrag (Zurück-Taste) und werden gespeichert.
 * `ready` wird wahr, sobald gespeicherte Auswahl (auch fehlgeschlagen) und Filteroptionen da sind; erst dann sollen
 * die Widgets laden, sonst fragten sie zweimal an.
 *
 * Vorrang: Zustand des Verlaufseintrags (auch die Profile), sonst die letzte Auswahl; Filter-Parameter der URL
 * überschreiben beides (ein geteilter Link ohne Verlaufseintrag nimmt Profile nur mit `pf=1` aus der eigenen letzten
 * Auswahl, innerhalb der verlinkten Clients).
 */
export function useAnalyticsFilters() {
  const route = useRoute();
  const router = useRouter();
  const queryClient = useQueryClient();

  const stored = useQuery({
    queryKey: uiStateQueryKey,
    queryFn: () => api.getUiState(UI_STATE_SCOPE, UI_STATE_KEY),
    staleTime: Infinity,
    retry: false,
  });

  const options = useQuery({
    queryKey: filterOptionsQueryKey,
    queryFn: () => api.analytics.filterOptions(),
    staleTime: 5 * 60_000,
  });

  // Tags (3.7): Ein Tag-Filter, den der Nutzer nicht auflösen kann (gelöschtes Tag, Link eines Kollegen, kein
  // Recht), ergäbe leere Auswertungen ohne sichtbaren Grund. Solche Tags gelten nicht; die URL räumt die nächste
  // Änderung auf (kein eigener Verlaufseintrag dafür).
  const { canView: canViewTags } = useTagRights();
  const tags = useTags();
  const knownTags = computed(() => (canViewTags.value ? tags.data.value : []));

  /** Letzte eigene Änderung: gilt vor einer gespeicherten Auswahl, die erst danach ankommt. */
  const local = shallowRef<FilterState | null>(null);
  const storedState = computed(() => local.value ?? parseStoredFilters(stored.data.value));
  const ready = computed(
    () =>
      (stored.isFetched.value || local.value !== null) &&
      options.data.value !== undefined &&
      // Mit Tag-Filter erst laden, wenn die Tags da sind (oder ihr Abruf gescheitert ist): sonst zwei Anfragen.
      (rawState.value.tagIds.length === 0 || !canViewTags.value || tags.isFetched.value),
  );

  // Zurück/Vor zwischen Einträgen mit gleicher URL (nur andere Profile) ändert `route` nicht: eigener Zähler.
  const historyVersion = ref(0);
  const removeAfterEach = router.afterEach(() => historyVersion.value++);
  onScopeDispose(removeAfterEach);

  const entryState = computed(() => {
    void historyVersion.value;
    void route.fullPath;
    const historyState = router.options.history.state as Record<string, unknown> | undefined;
    return parseStoredFilters(historyState?.[HISTORY_STATE_KEY]);
  });

  const rawState = computed(() =>
    filterStateFromQuery(route.query, entryState.value ?? storedState.value),
  );
  const state = computed<FilterState>(() => {
    const raw = rawState.value;
    return options.data.value
      ? sanitizeFilterState(raw, {
          ...options.data.value,
          ...(knownTags.value && { tags: knownTags.value }),
        })
      : raw;
  });

  // Ausgangszustand in URL und Verlaufseintrag festhalten (teilbarer Link; Zurück kehrt genau hierher zurück).
  watch(
    ready,
    (isReady) => {
      if (!isReady || entryState.value) return;
      void router.replace({
        query: mergeFilterQuery(route.query, state.value),
        state: { [HISTORY_STATE_KEY]: toHistoryValue(state.value) },
        force: true,
      });
    },
    { immediate: true },
  );

  // Speichern nacheinander, immer nur der neueste Stand (sonst könnten parallele Anfragen einander überholen).
  let pendingSave: FilterState | null = null;
  let saving = false;
  async function flushSave() {
    if (saving) return;
    saving = true;
    try {
      while (pendingSave) {
        const value = pendingSave;
        pendingSave = null;
        // Scheitert das Speichern, bleibt die Auswahl in URL und Verlauf; die nächste Änderung versucht es erneut.
        await api.putUiState(UI_STATE_SCOPE, UI_STATE_KEY, value).catch(() => undefined);
      }
    } finally {
      saving = false;
    }
  }

  /**
   * Auswahl ändern (neuer Verlaufseintrag, gespeichert als letzte Auswahl). `target` ersetzt Pfad und übrige Parameter
   * (Ansicht laden: Ebene und Drill-Down der Ansicht statt der aktuellen) und ergänzt den Verlaufseintrag.
   */
  function update(
    patch: Partial<FilterState>,
    target?: { path?: string; query?: LocationQuery; state?: HistoryState; replace?: boolean },
  ) {
    const next: FilterState = { ...state.value, ...patch };
    local.value = next;
    // Für andere Seiten (Explorer) ohne eigenen Verlaufseintrag.
    queryClient.setQueryData(uiStateQueryKey, next);
    void router[target?.replace ? 'replace' : 'push']({
      ...(target?.path && { path: target.path }),
      query: mergeFilterQuery(target?.query ?? route.query, next),
      state: { ...target?.state, [HISTORY_STATE_KEY]: toHistoryValue(next) },
      // Gleiche URL bei anderer Profilauswahl ist trotzdem ein neuer Eintrag.
      force: true,
    });
    pendingSave = next;
    void flushSave();
  }

  // „Heute“ neu bestimmen, wenn der Tab wieder aktiv wird (über Mitternacht offen gelassen).
  const today = ref(todayInBrowser());
  const refreshToday = () => (today.value = todayInBrowser());
  globalThis.addEventListener?.('focus', refreshToday);
  onScopeDispose(() => globalThis.removeEventListener?.('focus', refreshToday));

  const query = computed(() => toAnalyticsQuery(state.value, today.value));

  /**
   * Link auf eine andere Auswertung (z. B. den Explorer) mit geänderter Auswahl: kurzer Zustand in der URL, der ganze
   * (auch die Profile) im Verlaufseintrag.
   */
  function linkTo(path: string, patch: Partial<FilterState>): RouteLocationRaw {
    return filterLink(path, { ...state.value, ...patch });
  }

  return { state, options, ready, update, query, today, linkTo };
}
