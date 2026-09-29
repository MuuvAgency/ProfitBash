import { MAX_TIME_SERIES_ENTITY_IDS } from '@profitbash/shared';
import { useQuery } from '@tanstack/vue-query';
import { computed, type ComputedRef } from 'vue';
import { api } from '../api';
import type { ExplorerRowsInput } from '../api/client';
import type { AnalyticsQueryBody } from '../analytics/filters';
import { explorerQuery, type ExplorerState } from './state';

/**
 * Zeilen des Explorers. Entschieden (Dominik, 2026-09-28, `phase-2.md` 2.4 „Offen“): erst die Zeilen **ohne** Vergleich
 * (unter 1 s auch bei Targets und Suchbegriffen über alle Profile), danach dieselbe Anfrage **mit** Vergleich; bis sie da
 * ist, zeigen die Veränderungs-Spalten „–“. Negatives haben keine Kennzahlen, also keinen Vergleich.
 */
export function useExplorerRows(
  filters: ComputedRef<AnalyticsQueryBody>,
  state: ComputedRef<ExplorerState>,
  enabled: ComputedRef<boolean>,
) {
  const body = computed<ExplorerRowsInput>(() => ({
    ...filters.value,
    ...explorerQuery(state.value),
  }));
  const wantsComparison = computed(
    () => state.value.level !== 'negative' && body.value.comparison !== null,
  );

  const base = useQuery({
    queryKey: computed(
      () => ['analytics', 'explorer', { ...body.value, comparison: null }] as const,
    ),
    queryFn: () => api.analytics.explorerRows({ ...body.value, comparison: null }),
    enabled,
    // Bis zu 10 000 Zeilen: keine tiefen Proxys (die Zeilen werden nie verändert, nur ersetzt; 2.13).
    shallow: true,
  });

  const full = useQuery({
    queryKey: computed(() => ['analytics', 'explorer', body.value] as const),
    queryFn: () => api.analytics.explorerRows(body.value),
    enabled: computed(() => enabled.value && wantsComparison.value && base.isSuccess.value),
    shallow: true,
  });

  const data = computed(() =>
    wantsComparison.value && full.data.value ? full.data.value : base.data.value,
  );
  const comparisonPending = computed(
    () => wantsComparison.value && base.isSuccess.value && !full.data.value && !full.isError.value,
  );

  return { base, full, data, comparisonPending, wantsComparison, body };
}

/** Tagesreihe für den Chart: aktuelle Auswahl oder die markierten Zeilen (höchstens 200, sonst die ganze Auswahl). */
export function useExplorerSeries(
  body: ComputedRef<ExplorerRowsInput>,
  selectedIds: ComputedRef<string[]>,
  enabled: ComputedRef<boolean>,
) {
  return useQuery({
    queryKey: computed(
      () => ['analytics', 'timeseries', 'explorer', body.value, selectedIds.value] as const,
    ),
    queryFn: () => {
      const { level, ...rest } = body.value;
      const ids = selectedIds.value;
      return api.analytics.timeSeries({
        ...rest,
        comparison: null,
        level: level === 'negative' ? 'campaign' : level,
        ...(ids.length > 0 && ids.length <= MAX_TIME_SERIES_ENTITY_IDS && { entityIds: ids }),
      });
    },
    enabled: computed(() => enabled.value && body.value.level !== 'negative'),
  });
}
