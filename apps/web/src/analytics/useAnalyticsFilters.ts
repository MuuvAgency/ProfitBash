import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import { computed, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import {
  FILTER_QUERY_KEYS,
  filterStateFromQuery,
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

export const filterOptionsQueryKey = ['analytics', 'filter-options'] as const;

/**
 * Filterleiste von Dashboard und Explorer (`phase-2.md` F2–F5): Zustand aus der URL, ohne Filter-Parameter die letzte
 * Auswahl aus `ui_state`. Änderungen erzeugen einen Verlaufseintrag (Zurück-Taste) und werden gespeichert.
 * `ready` wird wahr, sobald gespeicherte Auswahl (auch fehlgeschlagen) und Filteroptionen da sind; erst dann sollen
 * die Widgets laden, sonst fragten sie zweimal an.
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

  const storedState = computed(() => parseStoredFilters(stored.data.value));
  const ready = computed(() => stored.isFetched.value && options.data.value !== undefined);

  const state = computed<FilterState>(() => {
    const raw = filterStateFromQuery(route.query, storedState.value);
    return options.data.value ? sanitizeFilterState(raw, options.data.value) : raw;
  });

  // Letzte Auswahl sichtbar in die URL übernehmen (teilbarer Link), ohne neuen Verlaufseintrag.
  watch(
    ready,
    (isReady) => {
      if (!isReady) return;
      const hasFilter = FILTER_QUERY_KEYS.some((key) => route.query[key] !== undefined);
      if (!hasFilter && storedState.value) {
        void router.replace({ query: mergeFilterQuery(route.query, state.value) });
      }
    },
    { immediate: true },
  );

  const save = useMutation({
    mutationFn: (value: FilterState) => api.putUiState(UI_STATE_SCOPE, UI_STATE_KEY, value),
  });

  function update(patch: Partial<FilterState>) {
    const next: FilterState = { ...state.value, ...patch };
    // Zuerst den Cache: Die URL trägt Profile nur als Merker, die IDs liest `filterStateFromQuery` von dort.
    queryClient.setQueryData(uiStateQueryKey, next);
    void router.push({ query: mergeFilterQuery(route.query, next) });
    save.mutate(next);
  }

  const today = todayInBrowser();
  const query = computed(() => toAnalyticsQuery(state.value, today));

  return { state, options, ready, update, query };
}
