<script setup lang="ts">
import { formatDay, formatNumber } from '@profitbash/shared';
import { AgCharts } from 'ag-charts-vue3';
import { AG_CHARTS_LOCALE_DE_DE } from 'ag-charts-locale';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from '../stores/session';
import { useColorScheme } from '../theme/useColorScheme';
import './modules';
import { chartTheme } from './theme';
import { buildTimeSeriesOptions, type ChartPoint, type ChartSeriesDef } from './time-series';

/** Tagesverlauf (bis zu zwei Kennzahlen) mit Markierung vorläufiger Tage (F5). Farben folgen Hell/Dunkel. */
const props = withDefaults(
  defineProps<{
    /** Beschreibung für Screenreader (der Chart ist ein Canvas). */
    label: string;
    points: ChartPoint[];
    series: ChartSeriesDef[];
    provisionalFrom: string | null;
    height?: string;
    /** Farbschema erzwingen (z. B. `dark` auf der dunklen Hero-Kachel), sonst wie die App. */
    scheme?: 'light' | 'dark';
  }>(),
  { height: '16rem', scheme: undefined },
);

const { t } = useI18n();
const session = useSessionStore();
const appScheme = useColorScheme();

const options = computed(() => {
  const locale = session.preferences.locale;
  return {
    ...buildTimeSeriesOptions({
      points: props.points,
      series: props.series,
      provisionalFrom: props.provisionalFrom,
      provisionalLabel: t('analytics.hint.provisional'),
      formatDay: (day) => formatDay(day, locale),
      formatAxisValue: (value) => formatNumber(value, locale, { maximumFractionDigits: 0 }),
      theme: chartTheme(props.scheme ?? appScheme.value),
    }),
    locale: { localeText: AG_CHARTS_LOCALE_DE_DE },
  };
});
</script>

<template>
  <div role="img" :aria-label="label" :style="{ height }">
    <AgCharts :options="options" class="size-full" />
  </div>
</template>
