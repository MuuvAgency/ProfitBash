<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useSessionStore } from '../stores/session';
import HintBadge from './HintBadge.vue';
import type { MetricHint } from './hints';
import { changeTone, formatChange, isShownAsNoChange, type MetricKey } from './metrics';

/**
 * KPI-Kachel (DESIGN.md §4 „KPI / Metric block“): Überzeile, großer Wert in Mono, Veränderung als Pille mit Farbe
 * nach Bedeutung, Vergleichswert und Hinweise. Werte kommen fertig formatiert (Helper aus `@profitbash/shared`).
 */
const props = withDefaults(
  defineProps<{
    label: string;
    metric: MetricKey;
    /** Formatierter Wert (`–` bei fehlendem Wert). */
    value?: string;
    /** Relative Veränderung (Bruch als Decimal-String); `null`/weggelassen ohne Vergleich. */
    change?: string | null;
    /** Formatierter Wert des Vergleichszeitraums. */
    comparisonValue?: string | null;
    hints?: MetricHint[];
    loading?: boolean;
  }>(),
  { value: '–', change: null, comparisonValue: null, hints: () => [], loading: false },
);

const { t } = useI18n();
const session = useSessionStore();

const approx = computed(() => props.hints.some((hint) => hint.kind === 'approx'));
const tone = computed(() => changeTone(props.metric, props.change));
const changeText = computed(() => formatChange(props.change, session.preferences.locale));
const changeWords = computed(() => {
  if (tone.value === null) return '';
  if (props.change === null || /^-?0(\.0+)?$/.test(props.change))
    return t('analytics.kpi.unchanged');
  return t(props.change.startsWith('-') ? 'analytics.kpi.decrease' : 'analytics.kpi.increase', {
    value: changeText.value,
  });
});
const pillClass = computed(
  () =>
    ({
      positive: 'bg-lime/25 text-lime-deep',
      negative: 'bg-loss-wash text-on-loss-wash',
      neutral: 'bg-well text-ink-secondary',
    })[tone.value ?? 'neutral'],
);
const arrow = computed(() =>
  props.change === null || isShownAsNoChange(props.change)
    ? 'pi-minus'
    : props.change.startsWith('-')
      ? 'pi-arrow-down-right'
      : 'pi-arrow-up-right',
);
</script>

<template>
  <article
    class="flex min-w-0 flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    :aria-busy="loading"
  >
    <div class="flex items-start justify-between gap-space-sm">
      <h3 data-kpi-label class="text-label-eyebrow uppercase text-ink-tertiary">{{ label }}</h3>
      <div v-if="hints.length && !loading" class="-mr-1 -mt-1.5 flex items-center">
        <HintBadge v-for="hint in hints" :key="hint.kind" :hint="hint" />
      </div>
    </div>
    <template v-if="loading">
      <SkeletonBlock height="1.75rem" width="70%" />
      <SkeletonBlock height="1.25rem" width="45%" />
    </template>
    <template v-else>
      <p data-kpi-value class="font-data text-data-lg text-ink">
        <span v-if="approx" aria-hidden="true">≈ </span>{{ value }}
      </p>
      <div class="flex flex-wrap items-center gap-x-space-sm gap-y-space-xs">
        <span
          v-if="tone !== null"
          data-kpi-change
          :data-tone="tone"
          :class="[
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-data text-data-sm',
            pillClass,
          ]"
        >
          <i :class="['pi', arrow, 'text-[0.625rem]']" aria-hidden="true" />
          <span aria-hidden="true">{{ changeText }}</span>
          <span class="sr-only">{{ changeWords }}</span>
        </span>
        <span v-if="comparisonValue" class="font-data text-data-sm text-ink-tertiary">
          {{ t('analytics.kpi.comparisonValue', { value: comparisonValue }) }}
        </span>
      </div>
    </template>
  </article>
</template>
