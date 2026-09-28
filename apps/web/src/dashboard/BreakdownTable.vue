<script setup lang="ts">
import { compareDecimalNullsLast } from '@profitbash/shared';
import SelectButton from 'primevue/selectbutton';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import type { useAnalyticsFilters } from '../analytics/useAnalyticsFilters';
import type { MetricKey } from '../analytics/metrics';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useSessionStore } from '../stores/session';
import { metricView, type MetricsTotal } from './format';
import type { useDashboardQueries } from './queries';

/**
 * Kennzahlen je Client bzw. Profil (F11) mit Sprung in den Explorer. Als einfache Tabelle (wenige Zeilen), die bei
 * 1440 px auch mit klassischer Scrollbar passt (F14); auf schmalen Bildschirmen scrollt sie in ihrer Kachel.
 */
const props = defineProps<{
  query: ReturnType<typeof useDashboardQueries>['dashboard'];
  filters: ReturnType<typeof useAnalyticsFilters>;
}>();

const { t } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const data = computed(() => props.query.data.value);
const viewLabelId = useId();

type View = 'client' | 'profile';
const view = ref<View>('client');
const viewOptions = computed(() => [
  { value: 'client', label: t('dashboard.breakdown.byClient') },
  { value: 'profile', label: t('dashboard.breakdown.byProfile') },
]);

const COLUMNS: MetricKey[] = ['cost', 'sales', 'acos', 'roas', 'purchases', 'clicks', 'cpc'];
const columnLabel = (key: MetricKey) =>
  key === 'cpc'
    ? 'CPC'
    : t(`dashboard.kpi.${key as 'cost' | 'sales' | 'acos' | 'roas' | 'purchases' | 'clicks'}`);

const sort = ref<{ key: MetricKey; descending: boolean } | null>(null);
function toggleSort(key: MetricKey) {
  sort.value =
    sort.value?.key === key
      ? { key, descending: !sort.value.descending }
      : { key, descending: true };
}
const ariaSort = (key: MetricKey) =>
  sort.value?.key === key ? (sort.value.descending ? 'descending' : 'ascending') : 'none';

function rawValue(total: MetricsTotal, key: MetricKey): string | null {
  const period = total.current;
  return key in period.derived
    ? period.derived[key as keyof typeof period.derived]
    : period.sums[key as keyof typeof period.sums];
}

const profiles = computed(() => props.filters.options.data.value?.profiles ?? []);

const rows = computed(() => {
  const d = data.value;
  if (!d) return [];
  const groups = view.value === 'client' ? d.byClient : d.byProfile;
  const list = groups.map((group) => {
    const name =
      group.label ?? (view.value === 'client' ? t('dashboard.breakdown.withoutClient') : '–');
    const clientId =
      view.value === 'client'
        ? group.key
        : (profiles.value.find((p) => p.id === group.key)?.clientId ?? null);
    const link = props.filters.linkTo(
      '/ads/explorer',
      view.value === 'client'
        ? {
            clientIds: group.key ? [group.key] : [],
            withoutClient: group.key === null,
            profileIds: null,
          }
        : {
            clientIds: clientId ? [clientId] : [],
            withoutClient: clientId === null,
            profileIds: group.key ? [group.key] : null,
          },
    );
    return {
      key: group.key ?? 'none',
      name,
      detail:
        view.value === 'profile'
          ? [group.countryCode, group.currencyCode].filter(Boolean).join(' · ')
          : '',
      link,
      total: group as MetricsTotal,
      cells: COLUMNS.map((key) => ({ key, ...metricView(key, group, d.meta, locale.value) })),
    };
  });
  const s = sort.value;
  if (!s) return list;
  return [...list].sort((a, b) => {
    const result = compareDecimalNullsLast(
      rawValue(a.total, s.key),
      rawValue(b.total, s.key),
      undefined,
      undefined,
      s.descending,
    );
    return s.descending ? -result : result;
  });
});
</script>

<template>
  <section
    data-dashboard-breakdown
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    :aria-busy="query.isPending.value"
  >
    <div class="flex flex-wrap items-center justify-between gap-space-sm">
      <h2 :id="viewLabelId" class="text-headline-sm text-ink">
        {{ t('dashboard.breakdown.title') }}
      </h2>
      <SelectButton
        :model-value="view"
        :options="viewOptions"
        option-label="label"
        option-value="value"
        :allow-empty="false"
        :aria-labelledby="viewLabelId"
        size="small"
        @update:model-value="(value: View) => (view = value)"
      >
        <template #option="{ option }">
          <span :data-view="option.value">{{ option.label }}</span>
        </template>
      </SelectButton>
    </div>
    <InlineError
      v-if="query.isError.value && !data"
      :message="t('dashboard.loadFailed')"
      retryable
      :retrying="query.isFetching.value"
      @retry="query.refetch()"
    />
    <div v-else-if="!data" class="flex flex-col gap-space-sm">
      <SkeletonBlock v-for="n in 4" :key="n" height="2.25rem" />
    </div>
    <p v-else-if="rows.length === 0" class="text-body-sm text-ink-secondary">
      {{ t('dashboard.breakdown.empty') }}
    </p>
    <div v-else class="-mx-space-md overflow-x-auto px-space-md sm:-mx-space-lg sm:px-space-lg">
      <table class="w-full min-w-[46rem] border-collapse text-body-sm">
        <thead>
          <tr class="border-b border-line text-label-eyebrow uppercase text-ink-secondary">
            <th scope="col" class="py-space-sm pr-space-sm text-left font-bold">
              {{ t('dashboard.breakdown.name') }}
            </th>
            <th
              v-for="column in COLUMNS"
              :key="column"
              scope="col"
              class="py-space-sm pl-space-sm text-right font-bold"
              :aria-sort="ariaSort(column)"
            >
              <button
                type="button"
                class="inline-flex items-center gap-1 uppercase hover:text-ink focus-visible:outline-2 focus-visible:outline-violet"
                :aria-label="t('dashboard.breakdown.sortBy', { column: columnLabel(column) })"
                @click="toggleSort(column)"
              >
                {{ columnLabel(column) }}
                <i
                  v-if="sort?.key === column"
                  :class="['pi text-[0.625rem]', sort.descending ? 'pi-arrow-down' : 'pi-arrow-up']"
                  aria-hidden="true"
                />
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.key" class="odd:bg-well/60">
            <th scope="row" class="max-w-[16rem] py-space-sm pr-space-sm text-left font-normal">
              <RouterLink
                :to="row.link"
                :aria-label="t('dashboard.breakdown.openExplorer', { name: row.name })"
                class="block truncate font-medium text-violet hover:underline"
                >{{ row.name }}</RouterLink
              >
              <span v-if="row.detail" class="block font-data text-data-sm text-ink-tertiary">{{
                row.detail
              }}</span>
            </th>
            <td
              v-for="cell in row.cells"
              :key="cell.key"
              class="whitespace-nowrap py-space-sm pl-space-sm text-right font-data text-data-md text-ink"
            >
              <span v-if="cell.hints.some((h) => h.kind === 'approx')" aria-hidden="true">≈ </span
              >{{ cell.value }}
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>
