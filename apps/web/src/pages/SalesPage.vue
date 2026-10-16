<script setup lang="ts">
import { formatNumber, type Locale } from '@profitbash/shared';
import { keepPreviousData, useQuery } from '@tanstack/vue-query';
import SelectButton from 'primevue/selectbutton';
import { computed, defineAsyncComponent, h, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import FilterBar from '../analytics/FilterBar.vue';
import KpiTile from '../analytics/KpiTile.vue';
import type { MetricHint } from '../analytics/hints';
import { formatMetricValue, type MetricKey } from '../analytics/metrics';
import { resolvePeriod } from '../analytics/periods';
import { useAnalyticsFilters } from '../analytics/useAnalyticsFilters';
import { api } from '../api';
import type { SalesData } from '../api/client';
import { fillDays, type ChartSeriesDef } from '../charts/time-series';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useVatMode, type VatMode } from '../profit/useVatMode';
import { useSessionStore } from '../stores/session';

/** AG Charts in eigenem Chunk wie im Dashboard. */
const TimeSeriesChart = defineAsyncComponent({
  loader: () => import('../charts/TimeSeriesChart.vue'),
  loadingComponent: { render: () => h(SkeletonBlock, { height: '16rem', shape: 'tile' }) },
});

/**
 * Verkaufsanalyse (`phase-7.md` 7.4): Umsatz, Bestellungen, Stück, TACoS und organischer Umsatz der Seller-Konten in
 * der Auswahl der Filterleiste, Tagesverlauf und Produkte. Umsatz netto oder brutto (F6, persönlich); TACoS immer netto.
 */
const { t } = useI18n();
const session = useSessionStore();
const locale = computed<Locale>(() => session.preferences.locale);
const filters = useAnalyticsFilters();
const { mode: vat } = useVatMode();
const vatLabelId = useId();

/** Höchstzahl Zeilen der Produkttabelle; alle Produkte zeigt `/profit/products` (7.5). */
const PRODUCT_ROWS = 100;

const body = computed(() => {
  const q = filters.query.value;
  return {
    ...(q.clientIds && { clientIds: q.clientIds }),
    ...(q.withoutClient !== undefined && { withoutClient: q.withoutClient }),
    ...(q.profileIds && { profileIds: q.profileIds }),
    period: q.period,
    comparison: q.comparison,
    currency: q.currency,
    attribution: q.attribution,
  };
});
const sales = useQuery({
  queryKey: computed(() => ['profit', 'sales', body.value] as const),
  queryFn: () => api.profit.sales(body.value),
  enabled: filters.ready,
  placeholderData: keepPreviousData,
});
const data = computed(() => sales.data.value);
const range = computed(() => resolvePeriod(filters.state.value.period, filters.today.value));

const revenueKey = computed(() => (vat.value === 'net' ? 'revenueNet' : 'revenueGross') as const);
const organicKey = computed(() => (vat.value === 'net' ? 'organicNet' : 'organicGross') as const);
const vatOptions = computed(() =>
  (['net', 'gross'] as const).map((value) => ({ value, label: t(`salesPage.vat.${value}`) })),
);

function hints(d: SalesData, money: boolean): MetricHint[] {
  return [
    ...(money && d.meta.converted ? [{ kind: 'approx' as const }] : []),
    ...(d.meta.missingFxCurrencies.length
      ? [{ kind: 'missingFx' as const, currencies: d.meta.missingFxCurrencies }]
      : []),
  ];
}

type TileKey = 'revenue' | 'orders' | 'units' | 'tacos' | 'organic';
const TILE_KEYS: TileKey[] = ['revenue', 'orders', 'units', 'tacos', 'organic'];
/** Farbe der Veränderung wie die passende Werbekennzahl (Umsatz gut, TACoS wie ACoS). */
const TONE: Record<TileKey, MetricKey> = {
  revenue: 'sales',
  orders: 'purchases',
  units: 'units',
  tacos: 'acos',
  organic: 'sales',
};

const tiles = computed(() => {
  const d = data.value;
  if (!d) return null;
  const ctx = { currency: d.meta.currency, locale: locale.value };
  const fields = {
    revenue: revenueKey.value,
    orders: 'orders',
    units: 'units',
    tacos: 'tacos',
    organic: organicKey.value,
  } as const;
  return TILE_KEYS.map((key) => {
    const field = fields[key];
    const format = (value: string | number | null) =>
      formatMetricValue(TONE[key], value === null ? null : String(value), ctx);
    const changeKey = field === 'organicNet' || field === 'organicGross' ? null : field;
    return {
      key,
      label: t(`salesPage.kpi.${key}`, { vat: t(`salesPage.vat.${vat.value}`) }),
      metric: TONE[key],
      value: format(d.current[field]),
      comparisonValue: d.comparison ? format(d.comparison[field]) : null,
      change: changeKey ? (d.change?.[changeKey].relative ?? null) : null,
      hints: hints(d, key === 'revenue' || key === 'organic'),
    };
  });
});

const chartSeries = computed<ChartSeriesDef[]>(() => {
  const ctx = { currency: data.value?.meta.currency ?? 'EUR', locale: locale.value };
  return [
    {
      key: 'revenue',
      label: t('salesPage.kpi.revenue', { vat: t(`salesPage.vat.${vat.value}`) }),
      kind: 'bar',
      axis: 'left',
      format: (value) => formatMetricValue('sales', value, ctx),
    },
    {
      key: 'units',
      label: t('salesPage.kpi.units'),
      kind: 'line',
      axis: 'right',
      format: (value) => formatMetricValue('units', value, ctx),
    },
  ];
});
const points = computed(() => {
  const d = data.value;
  if (!d) return [];
  // Tage ohne Verkäufe im Zeitraum sind 0, keine Lücke (Verkäufe kommen täglich).
  return fillDays(
    d.days.map((day) => ({
      date: day.date,
      values: { revenue: day[revenueKey.value], units: String(day.units) },
    })),
    range.value,
    ['revenue', 'units'],
    { earliestDate: range.value.from, dataThrough: range.value.to },
  );
});

const products = computed(() => {
  const d = data.value;
  if (!d) return [];
  const ctx = { currency: d.meta.currency, locale: locale.value };
  return d.products.slice(0, PRODUCT_ROWS).map((product) => ({
    key: `${product.sellerAccountId}:${product.sku}`,
    sku: product.sku,
    detail: [product.asin, product.countryCode].filter(Boolean).join(' · '),
    revenue: formatMetricValue('sales', product.current[revenueKey.value], ctx),
    orders: formatNumber(product.current.orders, locale.value),
    units: formatNumber(product.current.units, locale.value),
  }));
});
const refreshing = computed(() => sales.isPlaceholderData.value);
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('nav.group.profit')"
      :title="t('nav.sales')"
      :description="t('salesPage.description')"
    >
      <template #actions>
        <span :id="vatLabelId" class="sr-only">{{ t('salesPage.vat.label') }}</span>
        <SelectButton
          v-model="vat"
          :options="vatOptions"
          option-label="label"
          option-value="value"
          :allow-empty="false"
          :aria-labelledby="vatLabelId"
          size="small"
        >
          <template #option="{ option }">
            <span :data-vat="(option as { value: VatMode }).value">{{ option.label }}</span>
          </template>
        </SelectButton>
      </template>
    </PageHeader>

    <FilterBar :filters="filters" />

    <InlineError
      v-if="sales.isError.value && !data"
      :message="t('salesPage.loadFailed')"
      retryable
      :retrying="sales.isFetching.value"
      @retry="sales.refetch()"
    />
    <EmptyState
      v-else-if="data && data.meta.accounts === 0"
      icon="shopping-cart"
      :title="t('salesPage.empty.title')"
      :text="t('salesPage.empty.text')"
    />
    <div
      v-else
      class="flex flex-col gap-gutter transition-opacity"
      :class="{ 'opacity-60': refreshing }"
      :aria-busy="refreshing || !data"
    >
      <div class="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:grid-cols-5">
        <template v-if="tiles">
          <KpiTile
            v-for="tile in tiles"
            :key="tile.key"
            :label="tile.label"
            :metric="tile.metric"
            :value="tile.value"
            :change="tile.change"
            :comparison-value="tile.comparisonValue"
            :hints="tile.hints"
          />
        </template>
        <template v-else>
          <KpiTile
            v-for="key in TILE_KEYS"
            :key="key"
            :label="t(`salesPage.kpi.${key}`, { vat: t(`salesPage.vat.${vat}`) })"
            :metric="TONE[key]"
            loading
          />
        </template>
      </div>

      <ul v-if="data" class="flex flex-col gap-space-xs text-body-sm text-ink-secondary">
        <li v-if="data.meta.adProfiles === 0">{{ t('salesPage.note.noAds') }}</li>
        <li v-else>{{ t('salesPage.note.tacos') }}</li>
        <li v-if="data.current.unpricedUnits > 0">
          {{ t('salesPage.note.unpriced', data.current.unpricedUnits) }}
        </li>
      </ul>

      <section
        class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <h2 class="text-headline-sm text-ink">{{ t('salesPage.chart.title') }}</h2>
        <SkeletonBlock v-if="!data" height="16rem" shape="tile" />
        <TimeSeriesChart
          v-else
          :label="t('salesPage.chart.label')"
          :points="points"
          :series="chartSeries"
          :provisional-from="null"
        />
      </section>

      <section
        data-sales-products
        class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <h2 class="text-headline-sm text-ink">{{ t('salesPage.products.title') }}</h2>
        <div v-if="!data" class="flex flex-col gap-space-sm">
          <SkeletonBlock v-for="n in 4" :key="n" height="2.25rem" />
        </div>
        <p v-else-if="products.length === 0" class="text-body-sm text-ink-secondary">
          {{ t('salesPage.products.empty') }}
        </p>
        <div v-else class="-mx-space-md overflow-x-auto px-space-md sm:-mx-space-lg sm:px-space-lg">
          <table class="w-full min-w-[36rem] border-collapse text-body-sm">
            <thead>
              <tr class="border-b border-line text-label-eyebrow uppercase text-ink-secondary">
                <th scope="col" class="py-space-sm pr-space-sm text-left font-bold">
                  {{ t('salesPage.products.sku') }}
                </th>
                <th scope="col" class="py-space-sm pl-space-sm text-right font-bold">
                  {{ t('salesPage.kpi.revenue', { vat: t(`salesPage.vat.${vat}`) }) }}
                </th>
                <th scope="col" class="py-space-sm pl-space-sm text-right font-bold">
                  {{ t('salesPage.kpi.orders') }}
                </th>
                <th scope="col" class="py-space-sm pl-space-sm text-right font-bold">
                  {{ t('salesPage.kpi.units') }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in products" :key="row.key" class="odd:bg-well/60">
                <th scope="row" class="max-w-[18rem] py-space-sm pr-space-sm text-left font-normal">
                  <span class="block truncate font-data text-data-md text-ink">{{ row.sku }}</span>
                  <span v-if="row.detail" class="block font-data text-data-sm text-ink-tertiary">{{
                    row.detail
                  }}</span>
                </th>
                <td
                  class="whitespace-nowrap py-space-sm pl-space-sm text-right font-data text-data-md text-ink"
                >
                  <span v-if="data.meta.converted" aria-hidden="true">≈ </span>{{ row.revenue }}
                </td>
                <td
                  class="whitespace-nowrap py-space-sm pl-space-sm text-right font-data text-data-md text-ink"
                >
                  {{ row.orders }}
                </td>
                <td
                  class="whitespace-nowrap py-space-sm pl-space-sm text-right font-data text-data-md text-ink"
                >
                  {{ row.units }}
                </td>
              </tr>
            </tbody>
          </table>
          <p
            v-if="data.products.length > PRODUCT_ROWS || data.truncated"
            class="mt-space-sm text-body-sm text-ink-secondary"
          >
            {{ t('salesPage.products.limited', { shown: PRODUCT_ROWS }) }}
          </p>
        </div>
      </section>
    </div>
  </div>
</template>
