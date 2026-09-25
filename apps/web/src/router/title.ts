import type { RouteLocationNormalizedGeneric } from 'vue-router';

/** i18n-Key des Seitentitels für den Browser-Tab; `null` = nur „ProfitBash“. */
export function pageTitleKey(route: Pick<RouteLocationNormalizedGeneric, 'meta'>): string | null {
  return route.meta.titleKey ?? null;
}
