<script setup lang="ts">
import { CHANGE_KEYS, MAX_TIME_SERIES_ENTITY_IDS } from '@profitbash/shared';
import Select from 'primevue/select';
import { computed, defineAsyncComponent, h, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { formatMetricValue, type MetricKey } from '../analytics/metrics';
import type { DateRange } from '../analytics/periods';
import { fillDays, type ChartSeriesDef } from '../charts/time-series';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useSessionStore } from '../stores/session';
import type { useExplorerSeries } from './queries';

/** AG Charts als eigener Chunk (wie im Dashboard). */
const TimeSeriesChart = defineAsyncComponent({
  loader: () => import('../charts/TimeSeriesChart.vue'),
  loadingComponent: { render: () => h(SkeletonBlock, { height: '14rem', shape: 'tile' }) },
});

/** Tagesverlauf von bis zu zwei Kennzahlen über dem Grid (F6): Auswahl bzw. markierte Zeilen. */
const props = defineProps<{
  query: ReturnType<typeof useExplorerSeries>;
  metrics: [MetricKey, MetricKey];
  range: DateRange;
  selectedCount: number;
}>();
const emit = defineEmits<{ metrics: [metrics: [MetricKey, MetricKey]] }>();

const { t } = useI18n();
const session = useSessionStore();
const id = useId();

const options = computed(() =>
  CHANGE_KEYS.map((key) => ({ value: key, label: t(`explorer.column.${key}`) })),
);
const data = computed(() => props.query.data.value);

const series = computed<ChartSeriesDef[]>(() => {
  const currency = data.value?.meta.currency ?? 'EUR';
  return props.metrics.map((key, index) => ({
    key,
    label: t(`explorer.column.${key}`),
    kind: index === 0 ? 'bar' : 'line',
    axis: index === 0 ? 'left' : 'right',
    format: (value: string) =>
      formatMetricValue(key, value, { currency, locale: session.preferences.locale }),
  }));
});

const points = computed(() => {
  const d = data.value;
  if (!d) return [];
  const value = (day: (typeof d.days)[number], key: MetricKey) =>
    key in day.derived
      ? day.derived[key as keyof typeof day.derived]
      : (day.sums[key as keyof typeof day.sums] ?? null);
  return fillDays(
    d.days.map((day) => ({
      date: day.date,
      values: Object.fromEntries(props.metrics.map((key) => [key, value(day, key)])),
    })),
    props.range,
    [...props.metrics],
    { earliestDate: d.meta.earliestDate, dataThrough: d.meta.dataThrough },
  );
});

const label = computed(() =>
  t('explorer.chart.label', {
    first: t(`explorer.column.${props.metrics[0]}`),
    second: t(`explorer.column.${props.metrics[1]}`),
  }),
);
</script>

<template>
  <section
    data-explorer-chart
    class="flex min-w-0 flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <div class="flex flex-wrap items-end gap-space-md">
      <div class="flex w-44 flex-col gap-space-xs">
        <label :for="`${id}-m1`" class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('explorer.chart.first') }}
        </label>
        <Select
          :input-id="`${id}-m1`"
          :model-value="metrics[0]"
          :options="options"
          option-label="label"
          option-value="value"
          size="small"
          @update:model-value="(key: MetricKey) => emit('metrics', [key, metrics[1]])"
        />
      </div>
      <div class="flex w-44 flex-col gap-space-xs">
        <label :for="`${id}-m2`" class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('explorer.chart.second') }}
        </label>
        <Select
          :input-id="`${id}-m2`"
          :model-value="metrics[1]"
          :options="options"
          option-label="label"
          option-value="value"
          size="small"
          @update:model-value="(key: MetricKey) => emit('metrics', [metrics[0], key])"
        />
      </div>
      <p v-if="selectedCount > MAX_TIME_SERIES_ENTITY_IDS" class="text-body-sm text-warn">
        {{ t('explorer.chart.tooMany', { max: MAX_TIME_SERIES_ENTITY_IDS }) }}
      </p>
      <p v-else-if="selectedCount > 0" class="text-body-sm text-ink-secondary">
        {{ t('explorer.chart.selected', selectedCount) }}
      </p>
    </div>
    <InlineError
      v-if="query.isError.value && !data"
      :message="t('explorer.chart.failed')"
      retryable
      :retrying="query.isFetching.value"
      @retry="query.refetch()"
    />
    <SkeletonBlock v-else-if="!data" height="14rem" shape="tile" />
    <TimeSeriesChart
      v-else
      :label="label"
      :points="points"
      :series="series"
      :provisional-from="data.meta.provisionalFrom"
      height="14rem"
    />
  </section>
</template>
