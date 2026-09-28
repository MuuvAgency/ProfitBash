<script setup lang="ts">
import Button from 'primevue/button';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import FilterBar from '../analytics/FilterBar.vue';
import KpiTile from '../analytics/KpiTile.vue';
import { formatMetricValue } from '../analytics/metrics';
import { resolvePeriod } from '../analytics/periods';
import { useAnalyticsFilters } from '../analytics/useAnalyticsFilters';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import AdProductShareTile from '../dashboard/AdProductShareTile.vue';
import BreakdownTable from '../dashboard/BreakdownTable.vue';
import DashboardHero from '../dashboard/DashboardHero.vue';
import DataStatusTile from '../dashboard/DataStatusTile.vue';
import { metricView } from '../dashboard/format';
import { useDashboardQueries } from '../dashboard/queries';
import { canAccess } from '../navigation/navigation';
import { useSessionStore } from '../stores/session';

/**
 * Dashboard (`phase-2.md` F11, 2.7) im Kinetic-Bento-Look: Hero-Kachel (Spend, Umsatz, Tagesverlauf), KPI-Kacheln,
 * Anteil je Ad-Typ, Datenstand, Tabelle je Client/Profil. Jedes Widget hat eigene Lade-, Leer- und Fehlerzustände.
 */
const { t } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const filters = useAnalyticsFilters();

const hasProfiles = computed(() => (filters.options.data.value?.profiles.length ?? 0) > 0);
const enabled = computed(() => filters.ready.value && hasProfiles.value);
const queries = useDashboardQueries(filters.query, enabled);
const range = computed(() => resolvePeriod(filters.state.value.period, filters.today.value));
const isAdmin = computed(() => (session.me ? canAccess('orgAdmin', session.me) : false));

const data = computed(() => queries.dashboard.data.value);
const kpis = computed(() => {
  const d = data.value;
  if (!d) return null;
  const view = (key: 'acos' | 'roas' | 'purchases' | 'clicks') => ({
    key,
    label: t(`dashboard.kpi.${key}`),
    ...metricView(key, d.total, d.meta, locale.value),
  });
  return {
    tiles: [view('acos'), view('roas'), view('purchases'), view('clicks')],
    cpc: formatMetricValue('cpc', d.total.current.derived.cpc, {
      currency: d.meta.currency,
      locale: locale.value,
    }),
  };
});
const KPI_KEYS = ['acos', 'roas', 'purchases', 'clicks'] as const;
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('dashboard.eyebrow')"
      :title="t('nav.dashboard')"
      :description="t('dashboard.description')"
    />

    <FilterBar :filters="filters" :earliest-date="data?.meta.earliestDate ?? null" />

    <EmptyState
      v-if="filters.options.data.value && !hasProfiles"
      icon="link"
      :title="t('dashboard.noProfiles.title')"
      :text="isAdmin ? t('dashboard.noProfiles.textAdmin') : t('dashboard.noProfiles.text')"
    >
      <RouterLink v-if="isAdmin" v-slot="{ href, navigate }" to="/admin/connections" custom>
        <Button as="a" :href="href" :label="t('dashboard.noProfiles.action')" @click="navigate" />
      </RouterLink>
    </EmptyState>

    <div v-else class="grid grid-cols-1 gap-gutter lg:grid-cols-12">
      <DashboardHero :queries="queries" :range="range" class="lg:col-span-8" />

      <div class="grid grid-cols-1 gap-gutter sm:grid-cols-2 lg:col-span-4 lg:grid-cols-2">
        <InlineError
          v-if="queries.dashboard.isError.value && !data"
          class="sm:col-span-2"
          :message="t('dashboard.loadFailed')"
          retryable
          :retrying="queries.dashboard.isFetching.value"
          @retry="queries.dashboard.refetch()"
        />
        <template v-else-if="kpis">
          <KpiTile
            v-for="kpi in kpis.tiles"
            :key="kpi.key"
            :label="kpi.label"
            :metric="kpi.key"
            :value="kpi.value"
            :change="kpi.change"
            :comparison-value="kpi.comparisonValue"
            :hints="kpi.hints"
          >
            <template v-if="kpi.key === 'clicks'" #detail>
              {{ t('dashboard.kpi.cpc', { value: kpis.cpc }) }}
            </template>
          </KpiTile>
        </template>
        <template v-else>
          <KpiTile
            v-for="key in KPI_KEYS"
            :key="key"
            :label="t(`dashboard.kpi.${key}`)"
            :metric="key"
            loading
          />
        </template>
      </div>

      <AdProductShareTile :query="queries.dashboard" class="lg:col-span-7" />
      <DataStatusTile :query="queries.dashboard" :range="range" class="lg:col-span-5" />
      <BreakdownTable :query="queries.dashboard" :filters="filters" class="lg:col-span-12" />
    </div>
  </div>
</template>
