<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import ChangePill from '../analytics/ChangePill.vue';
import HintBadge from '../analytics/HintBadge.vue';
import type { DateRange } from '../analytics/periods';
import TimeSeriesChart from '../charts/TimeSeriesChart.vue';
import { fillDays, type ChartSeriesDef } from '../charts/time-series';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useSessionStore } from '../stores/session';
import { formatMetricValue } from '../analytics/metrics';
import { metricView } from './format';
import type { useDashboardQueries } from './queries';

/** Hero-Kachel (F11): Spend und Umsatz mit Veränderung und Tagesverlauf, dunkel wie „Netto-Profit“ der Referenz. */
const props = defineProps<{
  queries: ReturnType<typeof useDashboardQueries>;
  range: DateRange;
}>();

const { t } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);

const data = computed(() => props.queries.dashboard.data.value);
const metrics = computed(() => {
  const d = data.value;
  if (!d) return [];
  return (['cost', 'sales'] as const).map((key) => ({
    key,
    label: t(`dashboard.kpi.${key}`),
    ...metricView(key, d.total, d.meta, locale.value),
  }));
});

const series = computed(() => props.queries.heroSeries.data.value);
const chartSeries = computed<ChartSeriesDef[]>(() => {
  const currency = series.value?.meta.currency ?? 'EUR';
  const format = (key: 'cost' | 'sales') => (value: string) =>
    formatMetricValue(key, value, { currency, locale: locale.value });
  return [
    {
      key: 'cost',
      label: t('dashboard.kpi.cost'),
      kind: 'bar',
      axis: 'left',
      format: format('cost'),
    },
    {
      key: 'sales',
      label: t('dashboard.kpi.sales'),
      kind: 'line',
      axis: 'right',
      format: format('sales'),
    },
  ];
});
const points = computed(() => {
  const s = series.value;
  if (!s) return [];
  return fillDays(
    s.days.map((day) => ({
      date: day.date,
      values: { cost: day.sums.cost, sales: day.sums.sales },
    })),
    props.range,
    ['cost', 'sales'],
    { earliestDate: s.meta.earliestDate, dataThrough: s.meta.dataThrough },
  );
});
</script>

<template>
  <section
    data-dashboard-hero
    class="flex min-w-0 flex-col gap-space-lg rounded-hero bg-panel p-space-lg text-on-panel shadow-tile sm:p-space-xl"
    :aria-busy="queries.dashboard.isPending.value"
  >
    <h2 class="text-label-eyebrow uppercase text-on-panel-muted">
      {{ t('dashboard.hero.eyebrow') }}
    </h2>

    <InlineError
      v-if="queries.dashboard.isError.value && !data"
      :message="t('dashboard.loadFailed')"
      retryable
      :retrying="queries.dashboard.isFetching.value"
      @retry="queries.dashboard.refetch()"
    />
    <div v-else class="grid grid-cols-1 gap-space-lg sm:grid-cols-2">
      <template v-if="data">
        <div v-for="metric in metrics" :key="metric.key" class="flex min-w-0 flex-col gap-space-xs">
          <div class="flex items-center gap-space-xs">
            <h3 class="text-body-sm text-on-panel-muted">{{ metric.label }}</h3>
            <HintBadge v-for="hint in metric.hints" :key="hint.kind" :hint="hint" on-dark />
          </div>
          <p data-kpi-value class="font-data text-headline-lg text-on-panel sm:text-data-hero">
            <span v-if="metric.hints.some((h) => h.kind === 'approx')" aria-hidden="true">≈ </span
            >{{ metric.value }}
          </p>
          <div class="flex flex-wrap items-center gap-space-sm">
            <ChangePill :metric="metric.key" :change="metric.change" on-dark />
            <span v-if="metric.comparisonValue" class="font-data text-data-sm text-on-panel-muted">
              {{ t('analytics.kpi.comparisonValue', { value: metric.comparisonValue }) }}
            </span>
          </div>
        </div>
      </template>
      <template v-else>
        <div v-for="n in 2" :key="n" class="flex flex-col gap-space-sm">
          <SkeletonBlock height="1rem" width="40%" />
          <SkeletonBlock height="2.5rem" width="75%" />
        </div>
      </template>
    </div>

    <div class="min-h-[14rem] rounded-tile bg-on-panel/5 p-space-sm">
      <InlineError
        v-if="queries.heroSeries.isError.value && !series"
        :message="t('dashboard.hero.chartFailed')"
        retryable
        :retrying="queries.heroSeries.isFetching.value"
        @retry="queries.heroSeries.refetch()"
      />
      <SkeletonBlock v-else-if="!series" height="13rem" shape="tile" />
      <p
        v-else-if="series.days.length === 0"
        class="flex h-[13rem] items-center justify-center text-body-sm text-on-panel-muted"
      >
        {{ t('dashboard.hero.noDays') }}
      </p>
      <TimeSeriesChart
        v-else
        :label="t('dashboard.hero.chartLabel')"
        :points="points"
        :series="chartSeries"
        :provisional-from="series.meta.provisionalFrom"
        height="13rem"
        scheme="dark"
      />
    </div>
  </section>
</template>
