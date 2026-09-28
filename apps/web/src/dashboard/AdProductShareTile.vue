<script setup lang="ts">
import { formatPercent } from '@profitbash/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import HintBadge from '../analytics/HintBadge.vue';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useSessionStore } from '../stores/session';
import { metricView } from './format';
import type { useDashboardQueries } from './queries';

/** Anteil je Ad-Typ an Spend und Umsatz, mit ACoS (F11); erklärt die SB-Preview-Lücke, sobald SB vorkommt. */
const props = defineProps<{ query: ReturnType<typeof useDashboardQueries>['dashboard'] }>();

const { t } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const data = computed(() => props.query.data.value);

/** Balkenbreite als CSS-Prozent (nur Anzeige); der Wert selbst kommt als Decimal-String von der API. */
const width = (share: string | null | undefined) =>
  share ? `${Math.max(0, Math.min(100, Number(share) * 100))}%` : '0%';

const rows = computed(() => {
  const d = data.value;
  if (!d) return [];
  return d.byAdProduct.map((group) => ({
    key: group.key ?? '',
    label: t(`analytics.adProduct.${group.key}`),
    spend: metricView('cost', group, d.meta, locale.value),
    sales: metricView('sales', group, d.meta, locale.value),
    acos: metricView('acos', group, d.meta, locale.value),
    shareCost: group.share?.cost ?? null,
    shareSales: group.share?.sales ?? null,
  }));
});

const hasSb = computed(
  () =>
    data.value?.byAdProduct.some((g) => g.key === 'SPONSORED_BRANDS') === true ||
    data.value?.status.adProducts.some((p) => p.adProduct === 'SPONSORED_BRANDS') === true,
);
const sbGap = computed(() =>
  hasSb.value ? (data.value?.status.sbCampaignsWithoutMetrics ?? 0) : 0,
);
</script>

<template>
  <section
    data-dashboard-ad-products
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    :aria-busy="query.isPending.value"
  >
    <h2 class="text-headline-sm text-ink">{{ t('dashboard.adProducts.title') }}</h2>
    <InlineError
      v-if="query.isError.value && !data"
      :message="t('dashboard.loadFailed')"
      retryable
      :retrying="query.isFetching.value"
      @retry="query.refetch()"
    />
    <div v-else-if="!data" class="flex flex-col gap-space-md">
      <SkeletonBlock v-for="n in 3" :key="n" height="3rem" />
    </div>
    <p v-else-if="rows.length === 0" class="text-body-sm text-ink-secondary">
      {{ t('dashboard.adProducts.empty') }}
    </p>
    <ul v-else class="flex flex-col gap-space-md">
      <li v-for="row in rows" :key="row.key" class="flex flex-col gap-space-xs">
        <div class="flex flex-wrap items-baseline justify-between gap-x-space-sm">
          <span class="flex items-center gap-space-xs text-body-md font-medium text-ink">
            {{ row.label }}
            <HintBadge
              v-for="hint in [...row.spend.hints, ...row.acos.hints].filter(
                (h, i, all) => h.kind !== 'approx' && all.findIndex((o) => o.kind === h.kind) === i,
              )"
              :key="hint.kind"
              :hint="hint"
            />
          </span>
          <span class="font-data text-data-md text-ink">
            <span v-if="row.spend.hints.some((h) => h.kind === 'approx')" aria-hidden="true"
              >≈ </span
            >{{ row.spend.value }}
            <span class="text-ink-tertiary">
              · {{ t('dashboard.adProducts.sales', { value: row.sales.value }) }} ·
              {{ t('dashboard.adProducts.acos', { value: row.acos.value }) }}</span
            >
          </span>
        </div>
        <div
          class="grid grid-cols-[7rem_1fr_3.5rem] items-center gap-x-space-sm gap-y-1 text-body-sm"
        >
          <span class="text-ink-tertiary">{{ t('dashboard.adProducts.spendShare') }}</span>
          <span class="h-2 overflow-hidden rounded-full bg-well" aria-hidden="true">
            <span
              class="block h-full rounded-full bg-violet"
              :style="{ width: width(row.shareCost) }"
            />
          </span>
          <span class="text-right font-data text-data-sm text-ink-secondary">
            {{ formatPercent(row.shareCost, locale) }}
          </span>
          <span class="text-ink-tertiary">{{ t('dashboard.adProducts.salesShare') }}</span>
          <span class="h-2 overflow-hidden rounded-full bg-well" aria-hidden="true">
            <span
              class="block h-full rounded-full bg-lime-deep"
              :style="{ width: width(row.shareSales) }"
            />
          </span>
          <span class="text-right font-data text-data-sm text-ink-secondary">
            {{ formatPercent(row.shareSales, locale) }}
          </span>
        </div>
      </li>
    </ul>
    <div
      v-if="sbGap > 0"
      class="flex flex-col gap-space-xs rounded-control bg-well p-space-sm text-body-sm"
    >
      <p class="font-medium text-ink">{{ t('dashboard.adProducts.sbGap', sbGap) }}</p>
      <p class="text-ink-secondary">{{ t('dashboard.adProducts.sbGapText') }}</p>
    </div>
  </section>
</template>
