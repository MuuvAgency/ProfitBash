import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import { computed, type ComputedRef } from 'vue';
import { api } from '../api';
import type { AnalyticsQueryBody } from '../analytics/filters';

/**
 * Daten des Dashboards: Summen (`/dashboard`) und Tagesverlauf der Hero-Kachel (`/timeseries`) als getrennte Abfragen,
 * damit ein Fehler nur sein Widget trifft. Beim Filterwechsel bleiben die vorigen Werte stehen, bis die neuen da sind.
 */
export function useDashboardQueries(
  query: ComputedRef<AnalyticsQueryBody>,
  enabled: ComputedRef<boolean>,
) {
  const dashboard = useQuery({
    queryKey: computed(() => ['analytics', 'dashboard', query.value] as const),
    queryFn: () => api.analytics.dashboard(query.value),
    enabled,
    placeholderData: keepPreviousData,
  });

  // Mit entfernten Kampagnen wie `/dashboard` (2.4 „Vertrag“), sonst passte der Verlauf nicht zur Summe.
  const heroSeries = useQuery({
    queryKey: computed(() => ['analytics', 'timeseries', 'dashboard-hero', query.value] as const),
    queryFn: () =>
      api.analytics.timeSeries({
        ...query.value,
        level: 'campaign',
        filter: { includeRemoved: true },
      }),
    enabled,
    placeholderData: keepPreviousData,
  });

  return { dashboard, heroSeries };
}
