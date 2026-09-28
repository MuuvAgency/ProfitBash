<script setup lang="ts">
import { formatDateTime, formatDay } from '@profitbash/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { DateRange } from '../analytics/periods';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useSessionStore } from '../stores/session';
import type { useDashboardQueries } from './queries';

/**
 * Datenstand (F11, 2.2): „Daten bis“, vorläufige Tage, letzter Sync, Kurse bis (Warnung ab mehr als 5 Tagen),
 * Profile ohne Datenstand und hängende Ad-Typen, erster Tag mit Daten (F5).
 */
const props = defineProps<{
  query: ReturnType<typeof useDashboardQueries>['dashboard'];
  range: DateRange;
}>();

const { t } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const data = computed(() => props.query.data.value);
const day = (value: string | null) =>
  value ? formatDay(value, locale.value) : t('dashboard.status.none');

const facts = computed(() => {
  const d = data.value;
  if (!d) return [];
  return [
    {
      key: 'dataThrough',
      label: t('dashboard.status.dataThrough'),
      value: day(d.meta.dataThrough),
    },
    {
      key: 'provisionalFrom',
      label: t('dashboard.status.provisionalFrom'),
      value: day(d.meta.provisionalFrom),
    },
    {
      key: 'lastSync',
      label: t('dashboard.status.lastSync'),
      value: d.status.lastSyncAt
        ? formatDateTime(d.status.lastSyncAt, locale.value)
        : t('dashboard.status.never'),
    },
    { key: 'fx', label: t('dashboard.status.fxRatesThrough'), value: day(d.fxRatesThrough) },
    { key: 'earliest', label: t('dashboard.status.earliestDate'), value: day(d.meta.earliestDate) },
  ];
});

const warnings = computed(() => {
  const d = data.value;
  if (!d) return [];
  const list: string[] = [];
  if (d.fxRatesStale) list.push(t('dashboard.status.fxStale'));
  if (d.meta.profilesWithoutData > 0) {
    list.push(t('dashboard.status.profilesWithoutData', d.meta.profilesWithoutData));
  }
  const dates = d.status.adProducts
    .map((p) => p.dataThrough)
    .filter((v): v is string => v !== null);
  const newest = dates.sort().at(-1);
  for (const product of d.status.adProducts) {
    const adProduct = t(`analytics.adProduct.${product.adProduct}`);
    if (product.dataThrough === null) {
      list.push(t('dashboard.status.adProductMissing', { adProduct }));
    } else if (newest && product.dataThrough < newest) {
      list.push(
        t('dashboard.status.adProductBehind', { adProduct, date: day(product.dataThrough) }),
      );
    }
  }
  if (d.meta.earliestDate && props.range.from < d.meta.earliestDate) {
    list.push(t('dashboard.status.beforeEarliest', { date: day(d.meta.earliestDate) }));
  }
  return list;
});
</script>

<template>
  <section
    data-dashboard-status
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    :aria-busy="query.isPending.value"
  >
    <h2 class="text-headline-sm text-ink">{{ t('dashboard.status.title') }}</h2>
    <InlineError
      v-if="query.isError.value && !data"
      :message="t('dashboard.loadFailed')"
      retryable
      :retrying="query.isFetching.value"
      @retry="query.refetch()"
    />
    <div v-else-if="!data" class="flex flex-col gap-space-sm">
      <SkeletonBlock v-for="n in 5" :key="n" height="1.25rem" />
    </div>
    <template v-else>
      <dl class="grid grid-cols-[auto_1fr] gap-x-space-md gap-y-space-xs text-body-sm">
        <template v-for="fact in facts" :key="fact.key">
          <dt class="text-ink-tertiary">{{ fact.label }}</dt>
          <dd class="text-right font-data text-data-sm text-ink">{{ fact.value }}</dd>
        </template>
      </dl>
      <ul v-if="warnings.length" class="flex flex-col gap-space-xs">
        <li
          v-for="warning in warnings"
          :key="warning"
          class="flex items-start gap-space-xs text-body-sm text-ink-secondary"
        >
          <i class="pi pi-exclamation-triangle mt-0.5 shrink-0 text-warn" aria-hidden="true" />
          <span>{{ warning }}</span>
        </li>
      </ul>
    </template>
  </section>
</template>
