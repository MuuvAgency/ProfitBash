import type { Locale } from '@profitbash/shared';
import type { DashboardData } from '../api/client';
import { metricHints, type MetricHint } from '../analytics/hints';
import { formatMetricValue, type MetricKey } from '../analytics/metrics';

export type MetricsTotal = DashboardData['total'];

/** Wert, Vergleichswert, Veränderung und Hinweise einer Kennzahl aus einer Summe der API. */
export function metricView(
  key: MetricKey,
  total: MetricsTotal,
  meta: DashboardData['meta'],
  locale: Locale,
): { value: string; comparisonValue: string | null; change: string | null; hints: MetricHint[] } {
  const pick = (period: MetricsTotal['current']) =>
    key in period.derived
      ? period.derived[key as keyof typeof period.derived]
      : period.sums[key as keyof typeof period.sums];
  const ctx = { currency: meta.currency, locale };
  return {
    value: formatMetricValue(key, pick(total.current), ctx),
    comparisonValue: total.comparison ? formatMetricValue(key, pick(total.comparison), ctx) : null,
    change: total.change?.[key].relative ?? null,
    hints: metricHints(key, { meta, attribution: total.attribution }),
  };
}
