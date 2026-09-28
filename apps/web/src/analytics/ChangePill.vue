<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from '../stores/session';
import { changeTone, formatChange, isShownAsNoChange, type MetricKey } from './metrics';

/**
 * Veränderung zum Vergleich als Pille (DESIGN.md §4): Farbe nach Bedeutung (Dominik, 2026-09-28), Pfeil, Text für
 * Screenreader. `onDark` für die dunkle Hero-Kachel.
 */
const props = defineProps<{ metric: MetricKey; change: string | null; onDark?: boolean }>();

const { t } = useI18n();
const session = useSessionStore();

const tone = computed(() => changeTone(props.metric, props.change));
const unchanged = computed(() => props.change === null || isShownAsNoChange(props.change));
const text = computed(() => formatChange(props.change, session.preferences.locale));
const words = computed(() => {
  if (unchanged.value) return t('analytics.kpi.unchanged');
  return t(props.change!.startsWith('-') ? 'analytics.kpi.decrease' : 'analytics.kpi.increase', {
    value: text.value,
  });
});
const toneClass = computed(() => {
  const onDark = props.onDark === true;
  switch (tone.value) {
    case 'positive':
      return onDark ? 'bg-lime/15 text-lime' : 'bg-lime/25 text-lime-deep';
    case 'negative':
      return onDark ? 'bg-loss/20 text-on-loss-wash' : 'bg-loss-wash text-on-loss-wash';
    default:
      return onDark ? 'bg-on-panel/10 text-on-panel-muted' : 'bg-well text-ink-secondary';
  }
});
const arrow = computed(() =>
  unchanged.value
    ? 'pi-minus'
    : props.change!.startsWith('-')
      ? 'pi-arrow-down-right'
      : 'pi-arrow-up-right',
);
</script>

<template>
  <span
    v-if="tone !== null"
    data-kpi-change
    :data-tone="tone"
    :class="[
      'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-data text-data-sm',
      toneClass,
    ]"
  >
    <i :class="['pi', arrow, 'text-[0.625rem]']" aria-hidden="true" />
    <span aria-hidden="true">{{ text }}</span>
    <span class="sr-only">{{ words }}</span>
  </span>
</template>
