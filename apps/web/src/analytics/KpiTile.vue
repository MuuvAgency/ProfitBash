<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import ChangePill from './ChangePill.vue';
import HintBadge from './HintBadge.vue';
import type { MetricHint } from './hints';
import type { MetricKey } from './metrics';

/**
 * KPI-Kachel (DESIGN.md §4 „KPI / Metric block“): Überzeile, großer Wert in Mono, Veränderung als Pille mit Farbe
 * nach Bedeutung, Vergleichswert und Hinweise. Werte kommen fertig formatiert (Helper aus `@profitbash/shared`).
 * Slot `detail`: Zusatzwert unter dem Wert (z. B. CPC bei den Klicks).
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

const approx = computed(() => props.hints.some((hint) => hint.kind === 'approx'));
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
      <p v-if="$slots.detail" class="font-data text-data-sm text-ink-secondary">
        <slot name="detail" />
      </p>
      <div class="flex flex-wrap items-center gap-x-space-sm gap-y-space-xs">
        <ChangePill :metric="metric" :change="change" />
        <span v-if="comparisonValue" class="font-data text-data-sm text-ink-tertiary">
          {{ t('analytics.kpi.comparisonValue', { value: comparisonValue }) }}
        </span>
      </div>
    </template>
  </article>
</template>
