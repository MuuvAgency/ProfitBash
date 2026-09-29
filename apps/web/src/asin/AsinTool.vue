<script setup lang="ts">
import { formatNumber } from '@profitbash/shared';
import { useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Textarea from 'primevue/textarea';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import { api } from '../api';
import type { ExplorerRowsData } from '../api/client';
import {
  DEFAULT_FILTER_STATE,
  parseStoredFilters,
  sanitizeFilterState,
  toAnalyticsQuery,
} from '../analytics/filters';
import { formatMetricValue } from '../analytics/metrics';
import { todayInBrowser } from '../analytics/periods';
import { filterOptionsQueryKey } from '../analytics/useAnalyticsFilters';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { parseProductTerms, pathForLevel } from '../explorer/state';
import { useSessionStore } from '../stores/session';

/**
 * ASIN-Quick-Tool (`phase-2.md` F10, 2.11): Wo wird eine ASIN oder SKU beworben, und was bringt sie? Sucht in ASIN und
 * SKU der Product Ads und in den ASINs von Ads mit mehreren Produkten; Kennzahlen je Ad (ein Ad mit mehreren ASINs
 * erscheint einmal). Zeitraum, Währung und Auswahl aus der zuletzt benutzten Filterleiste (`ui_state`), ohne die URL der
 * aktuellen Seite zu ändern. Ein Klick öffnet den Reiter Product Ads im Explorer.
 */
const emit = defineEmits<{ navigate: [] }>();

const { t } = useI18n();
const id = useId();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);

/** Höchstzahl gezeigter Treffer; alle stehen im Explorer. */
const SHOWN = 30;

const stored = useQuery({
  queryKey: ['ui-state', 'analytics', 'filters'] as const,
  queryFn: () => api.getUiState('analytics', 'filters'),
  staleTime: Infinity,
  retry: false,
});
const options = useQuery({
  queryKey: filterOptionsQueryKey,
  queryFn: () => api.analytics.filterOptions(),
  staleTime: 5 * 60_000,
});
const filterState = computed(() => {
  const raw = parseStoredFilters(stored.data.value) ?? DEFAULT_FILTER_STATE;
  return options.data.value ? sanitizeFilterState(raw, options.data.value) : raw;
});

const input = ref('');
const terms = ref<string[]>([]);
const inputError = ref(false);

function submit() {
  const parsed = parseProductTerms(input.value);
  inputError.value = parsed.length === 0;
  terms.value = parsed;
}

const ready = computed(
  () =>
    terms.value.length > 0 &&
    (stored.isFetched.value || stored.isError.value) &&
    !!options.data.value,
);
const body = computed(() => ({
  ...toAnalyticsQuery(filterState.value, todayInBrowser()),
  comparison: null,
  terms: terms.value,
}));
const search = useQuery({
  queryKey: computed(() => ['analytics', 'asin-search', body.value] as const),
  queryFn: () => api.analytics.asinSearch(body.value),
  enabled: ready,
  staleTime: 60_000,
});

type Row = ExplorerRowsData['rows'][number];
const rows = computed(() => search.data.value?.rows ?? []);
const shown = computed(() => rows.value.slice(0, SHOWN));

const attr = (row: Row, key: string) => {
  const value = row.attributes[key];
  return typeof value === 'string' ? value : null;
};
const asinCount = (row: Row) => {
  const value = row.attributes.asins;
  return Array.isArray(value) ? value.length : 0;
};
const metric = (row: Row, key: 'cost' | 'sales' | 'acos') => {
  const value =
    key === 'acos' ? (row.current?.derived.acos ?? null) : (row.current?.sums[key] ?? null);
  return formatMetricValue(key, value, { currency: row.currencyCode, locale: locale.value });
};

const productAdsPath = pathForLevel('productAd');
function explorerLink(row?: Row): RouteLocationRaw {
  const q = terms.value.join(',');
  if (!row) return { path: productAdsPath, query: { q } };
  const campaign = attr(row, 'campaignId');
  const adGroup = attr(row, 'adGroupId');
  return {
    path: productAdsPath,
    query: { ...(campaign && { campaign }), ...(adGroup && { adGroup }), q },
  };
}
const periodLabel = computed(() => t(`analytics.period.${filterState.value.period.preset}`));
</script>

<template>
  <div class="flex flex-col gap-space-md">
    <form class="flex flex-col gap-space-sm" role="search" @submit.prevent="submit">
      <label :for="`${id}-terms`" class="text-body-sm font-semibold text-ink">
        {{ t('asinTool.label') }}
      </label>
      <Textarea
        :id="`${id}-terms`"
        v-model="input"
        data-asin-input
        rows="3"
        auto-resize
        fluid
        class="font-data text-data-sm"
        :placeholder="t('asinTool.placeholder')"
        :invalid="inputError"
        @keydown.enter.exact.prevent="submit"
      />
      <p v-if="inputError" class="text-body-sm text-loss">{{ t('asinTool.required') }}</p>
      <div class="flex flex-wrap items-center justify-between gap-space-sm">
        <span class="text-body-sm text-ink-tertiary">{{
          t('asinTool.period', { period: periodLabel })
        }}</span>
        <Button
          type="submit"
          data-asin-submit
          icon="pi pi-search"
          :label="t('asinTool.submit')"
          size="small"
        />
      </div>
    </form>

    <template v-if="terms.length > 0">
      <InlineError
        v-if="search.isError.value"
        :message="t('asinTool.failed')"
        retryable
        :retrying="search.isFetching.value"
        @retry="search.refetch()"
      />
      <div v-else-if="!search.data.value" class="flex flex-col gap-space-sm" aria-busy="true">
        <SkeletonBlock v-for="n in 3" :key="n" height="3.5rem" />
      </div>
      <p v-else-if="rows.length === 0" class="text-body-sm text-ink-secondary">
        {{ t('asinTool.empty') }}
      </p>
      <template v-else>
        <p class="text-body-sm text-ink-secondary" role="status">
          {{
            t(
              'asinTool.count',
              { count: formatNumber(search.data.value.totalRows, locale) },
              search.data.value.totalRows,
            )
          }}
        </p>
        <ul class="flex max-h-80 flex-col gap-space-xs overflow-y-auto" data-asin-results>
          <li v-for="row in shown" :key="row.id">
            <RouterLink
              :to="explorerLink(row)"
              class="flex flex-col gap-space-xs rounded-control bg-well px-space-sm py-space-sm hover:bg-violet-wash focus-visible:outline-2 focus-visible:outline-violet"
              @click="emit('navigate')"
            >
              <span class="flex flex-wrap items-center gap-x-space-sm text-body-sm">
                <span class="font-data font-medium text-ink">{{
                  row.name ?? t('explorer.unknownName')
                }}</span>
                <span class="text-ink-tertiary">{{
                  t(`analytics.adProduct.${row.adProduct}`)
                }}</span>
                <span v-if="row.state" class="text-ink-tertiary"
                  >·
                  {{
                    $te(`explorer.state.${row.state}`)
                      ? t(`explorer.state.${row.state}`)
                      : row.state
                  }}</span
                >
                <span v-if="asinCount(row) > 1" class="text-ink-secondary"
                  >· {{ t('explorer.sharesAsins', { count: asinCount(row) }) }}</span
                >
              </span>
              <span class="truncate text-body-sm text-ink-secondary">
                {{ row.accountName }} · {{ attr(row, 'campaignName') ?? '–' }} ›
                {{ attr(row, 'adGroupName') ?? '–' }}
              </span>
              <span class="flex flex-wrap gap-x-space-md font-data text-data-sm text-ink">
                <span>{{ t('asinTool.spend') }} {{ metric(row, 'cost') }}</span>
                <span>{{ t('asinTool.sales') }} {{ metric(row, 'sales') }}</span>
                <span>{{ t('asinTool.acos') }} {{ metric(row, 'acos') }}</span>
              </span>
            </RouterLink>
          </li>
        </ul>
        <p v-if="rows.length > SHOWN" class="text-body-sm text-ink-tertiary">
          {{ t('asinTool.more', { count: formatNumber(rows.length - SHOWN, locale) }) }}
        </p>
      </template>
      <RouterLink
        :to="explorerLink()"
        data-asin-open-explorer
        class="self-start text-body-sm text-violet hover:underline"
        @click="emit('navigate')"
      >
        {{ t('asinTool.openExplorer') }}
      </RouterLink>
    </template>
    <p class="text-body-sm text-ink-tertiary">{{ t('asinTool.hint') }}</p>
  </div>
</template>
