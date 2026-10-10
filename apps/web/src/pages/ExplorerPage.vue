<script setup lang="ts">
import {
  AD_PRODUCTS,
  formatNumber,
  type AdChangeField,
  type AdProduct,
  type ExplorerLevel,
  type TagEntityType,
} from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import InputText from 'primevue/inputtext';
import MultiSelect from 'primevue/multiselect';
import { computed, onScopeDispose, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  RouterLink,
  useRoute,
  useRouter,
  type LocationQueryRaw,
  type RouteLocationRaw,
} from 'vue-router';
import { api, ApiError } from '../api';
import FilterBar from '../analytics/FilterBar.vue';
import type { MetricKey } from '../analytics/metrics';
import { resolvePeriod } from '../analytics/periods';
import { useAnalyticsFilters } from '../analytics/useAnalyticsFilters';
import {
  useChangeRights,
  useDiscardChanges,
  useOpenChanges,
  usePendingCount,
  useStageChanges,
} from '../changes/queries';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import {
  buildColumnDefs,
  columnsForLevel,
  defaultVisibleColumns,
  totalRow,
  type GridRow,
} from '../explorer/columns';
import BulkEditDialog from '../explorer/BulkEditDialog.vue';
import CampaignBiddingDialog from '../explorer/CampaignBiddingDialog.vue';
import {
  editIssue,
  entityTypeOf,
  indexOpenChanges,
  openEntry,
  type MoneyField,
  type OpenChange,
} from '../explorer/editing';
import ExplorerChart from '../explorer/ExplorerChart.vue';
import ExplorerGrid from '../explorer/ExplorerGrid.vue';
import ExplorerTabs from '../explorer/ExplorerTabs.vue';
import AssignTagsDialog from '../tags/AssignTagsDialog.vue';
import { tagsById, useTagRights, useTags } from '../tags/queries';
import { useExplorerRows, useExplorerSeries } from '../explorer/queries';
import {
  childLevel,
  drillQuery,
  EXPLORER_TABS,
  explorerStateFromRoute,
  pathForLevel,
  SEARCH_TERM_ANALYSIS_PATH,
  SEARCH_TERM_ANALYSIS_TAB,
  type DrillDown,
  parseProductTerms,
  type GridSort,
} from '../explorer/state';
import { downloadCsv } from '../grid/csv';
import { errorMessageKey } from '../i18n';
import SavedViewsMenu from '../saved-views/SavedViewsMenu.vue';
import { explorerTarget, filtersFromView, viewState } from '../saved-views/view-state';
import { useSessionStore } from '../stores/session';
import { simulatorLink } from '../tools/bid-simulator/link';
import { useToolRights } from '../tools/queries';
import type { SavedView } from '@profitbash/shared';

/**
 * Explorer (`phase-2.md` F6, F7, 2.8): Reiter je Ebene, Drill-Down mit Brotkrumen, Chart über dem Grid, Spaltenauswahl,
 * Sortierung und Filter im Browser, CSV-Export. Zustand in der URL (Ebene als Pfad, Drill-Down, Filterleiste), die
 * Spaltenauswahl je Ebene in `ui_state`.
 */
const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);
const filters = useAnalyticsFilters();
const id = useId();

const state = computed(() => explorerStateFromRoute(route.path, route.query));
const level = computed(() => state.value.level);
const hasProfiles = computed(() => (filters.options.data.value?.profiles.length ?? 0) > 0);
const enabled = computed(() => filters.ready.value && hasProfiles.value);
const range = computed(() => resolvePeriod(filters.state.value.period, filters.today.value));

const rows = useExplorerRows(filters.query, state, enabled);
const data = computed(() => rows.data.value);

// --- Links: Reiter, Drill-Down, Brotkrumen -----------------------------------------------

/** Namen der Brotkrumen je Verlaufseintrag (beim Drill-Down gesetzt), sonst aus den Zeilen. */
type Crumbs = Partial<Record<'portfolio' | 'campaign' | 'adGroup', string>>;
const CRUMBS_KEY = 'explorerCrumbs';

function link(path: string, query: LocationQueryRaw, crumbs: Crumbs = knownCrumbs.value) {
  const base = filters.linkTo(path, {}) as { state: Record<string, unknown> };
  const known = Object.fromEntries(Object.entries(crumbs).filter(([, name]) => name !== undefined));
  return { path, query, state: { ...base.state, [CRUMBS_KEY]: known } };
}

function withoutSearch(query: LocationQueryRaw, level: ExplorerLevel): LocationQueryRaw {
  if (level === 'productAd') return query;
  const { q: _q, ...rest } = query;
  return rest;
}

const tabs = computed(() => [
  ...EXPLORER_TABS.map((tab) => ({
    key: tab.level as string,
    label: t(`explorer.tab.${tab.level}`),
    // Die Suche nach ASIN/SKU gehört zum Reiter Product Ads; andere Reiter nehmen sie nicht mit.
    to: link(pathForLevel(tab.level), withoutSearch(route.query, tab.level)) as RouteLocationRaw,
  })),
  // Eigene Seite mit eigener Auswahl (Profil und Datei-Zeitraum statt Filterleiste).
  {
    key: SEARCH_TERM_ANALYSIS_TAB,
    label: t('searchTerms.tab'),
    to: SEARCH_TERM_ANALYSIS_PATH as RouteLocationRaw,
  },
]);

const historyVersion = ref(0);
onScopeDispose(router.afterEach(() => historyVersion.value++));
const storedCrumbs = computed<Crumbs>(() => {
  void historyVersion.value;
  void route.fullPath;
  const value = (router.options.history.state as Record<string, unknown> | undefined)?.[CRUMBS_KEY];
  return value && typeof value === 'object' ? (value as Crumbs) : {};
});

const firstAttribute = (key: string) => {
  const value = data.value?.rows[0]?.attributes[key];
  return typeof value === 'string' ? value : undefined;
};
/** Echte Namen (aus dem Verlauf oder den Zeilen), ohne die allgemeinen Ersatztexte: nur sie werden weitergegeben. */
const knownCrumbs = computed<Crumbs>(() => ({
  ...(state.value.drill.portfolioId && {
    portfolio: storedCrumbs.value.portfolio ?? firstAttribute('portfolioName'),
  }),
  ...(state.value.drill.campaignId && {
    campaign: storedCrumbs.value.campaign ?? firstAttribute('campaignName'),
  }),
  ...(state.value.drill.adGroupId && {
    adGroup: storedCrumbs.value.adGroup ?? firstAttribute('adGroupName'),
  }),
}));
const currentCrumbs = computed<Crumbs>(() => ({
  ...(state.value.drill.portfolioId && {
    portfolio:
      storedCrumbs.value.portfolio ??
      firstAttribute('portfolioName') ??
      t('explorer.crumb.portfolio'),
  }),
  ...(state.value.drill.campaignId && {
    campaign:
      storedCrumbs.value.campaign ?? firstAttribute('campaignName') ?? t('explorer.crumb.campaign'),
  }),
  ...(state.value.drill.adGroupId && {
    adGroup:
      storedCrumbs.value.adGroup ?? firstAttribute('adGroupName') ?? t('explorer.crumb.adGroup'),
  }),
}));

/** Filter-Parameter der Seite ohne Drill-Down. */
const baseQuery = computed<LocationQueryRaw>(() => {
  const { portfolio: _p, campaign: _c, adGroup: _g, ...rest } = route.query;
  return rest;
});

const selectionLabel = computed(() => {
  const s = filters.state.value;
  const options = filters.options.data.value;
  if (!options || (s.clientIds.length === 0 && !s.withoutClient))
    return t('analytics.filter.allProfiles');
  if (s.profileIds) return t('analytics.filter.profileCount', s.profileIds.length);
  return options.clients
    .filter((c) => s.clientIds.includes(c.id))
    .map((c) => c.name)
    .concat(s.withoutClient ? [t('analytics.filter.withoutClient')] : [])
    .join(', ');
});

const breadcrumbs = computed(() => {
  const { drill } = state.value;
  const crumbs = currentCrumbs.value;
  const items: { key: string; label: string; to: ReturnType<typeof link> | null }[] = [];
  const hasDrill = drill.portfolioId || drill.campaignId || drill.adGroupId;
  items.push({
    key: 'selection',
    label: selectionLabel.value,
    to: hasDrill
      ? link(pathForLevel(drill.portfolioId ? 'portfolio' : 'campaign'), baseQuery.value, {})
      : null,
  });
  const steps: { key: keyof Crumbs; param: string; id: string | null; level: ExplorerLevel }[] = [
    { key: 'portfolio', param: 'portfolio', id: drill.portfolioId, level: 'campaign' },
    { key: 'campaign', param: 'campaign', id: drill.campaignId, level: 'adGroup' },
    { key: 'adGroup', param: 'adGroup', id: drill.adGroupId, level: 'target' },
  ];
  const query: LocationQueryRaw = { ...baseQuery.value };
  const kept: Crumbs = {};
  for (const step of steps) {
    if (!step.id) continue;
    query[step.param] = step.id;
    kept[step.key] = knownCrumbs.value[step.key];
    const last = step === steps.filter((s) => s.id).at(-1);
    items.push({
      key: step.key,
      label: crumbs[step.key] ?? '',
      to:
        last && level.value === step.level
          ? null
          : link(pathForLevel(step.level), { ...query }, { ...kept }),
    });
  }
  return items;
});

function linkFor(row: GridRow) {
  const child = childLevel(level.value);
  if (!child) return null;
  const parents: Partial<DrillDown> = { ...state.value.drill };
  const target = drillQuery(baseQuery.value, level.value, row.id, parents);
  const crumbKey = level.value as keyof Crumbs;
  return link(target.path, target.query, {
    ...knownCrumbs.value,
    [crumbKey]: row.name ?? t('explorer.unknownName'),
  });
}

// --- Bearbeiten (`phase-3.md` 3.5) ---------------------------------------------------------

const { canView: canViewChanges, canWrite: canWriteChanges } = useChangeRights();
const { canView: canViewTools } = useToolRights();

// --- Tags (`phase-3.md` 3.7) ----------------------------------------------------------------

const { canView: canViewTags, canWrite: canWriteTags } = useTagRights();
const tagsQuery = useTags();
const tagMap = computed(() => tagsById(tagsQuery.data.value));
const TAG_ENTITY_BY_LEVEL: Partial<Record<ExplorerLevel, TagEntityType>> = {
  campaign: 'campaign',
  adGroup: 'ad_group',
  target: 'target',
  productAd: 'product_ad',
};
const tagEntityType = computed(() => TAG_ENTITY_BY_LEVEL[level.value] ?? null);
const tagRows = shallowRef<GridRow[] | null>(null);
const pendingCount = usePendingCount();
/** Ebenen, deren Zeilen sich ändern lassen (Kampagnen, Ad Groups, Targets, Product Ads, Negatives). */
const editableLevel = computed(() => entityTypeOf(level.value) !== null);
/** Genau ein Profil gewählt: Die offenen Änderungen kommen nur für dieses (sonst für alle sichtbaren). */
const openProfileId = computed(() => {
  const profileIds = filters.state.value.profileIds;
  return profileIds?.length === 1 ? profileIds[0] : undefined;
});
const openChanges = useOpenChanges(
  openProfileId,
  computed(() => enabled.value && editableLevel.value),
);
const openIndex = computed(() => indexOpenChanges(openChanges.data.value?.changes ?? []));
const entryFor = (row: GridRow, field: AdChangeField) =>
  openEntry(openIndex.value, level.value, row.id, field);

const stageChanges = useStageChanges();
const discardChanges = useDiscardChanges();
/** Meldung zur letzten Änderung in einer Zelle (abgelehnt oder gescheitert). */
const editNotice = ref<string | null>(null);
const errorText = (error: unknown) =>
  t(errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN'));

async function stageCell(row: GridRow, field: AdChangeField, value: string) {
  const entityType = entityTypeOf(level.value);
  if (!entityType) return;
  editNotice.value = null;
  try {
    const { results } = await stageChanges.mutateAsync([
      { operation: 'update', entityType, entityId: row.id, field, value },
    ]);
    const result = results[0];
    if (result?.outcome === 'rejected') {
      editNotice.value = t('explorer.edit.rejected', {
        name: row.name ?? t('explorer.unknownName'),
        reason: t(`changes.rejection.${result.reason}`),
      });
    }
  } catch (error) {
    editNotice.value = errorText(error);
  }
}
async function undoCell(change: OpenChange) {
  editNotice.value = null;
  try {
    await discardChanges.mutateAsync([change.id]);
  } catch (error) {
    editNotice.value = errorText(error);
  }
}

const gridContext = {
  linkFor,
  editing: {
    level: () => level.value,
    canWrite: () => canWriteChanges.value,
    entryFor,
    stage: stageCell,
    undo: undoCell,
  },
};

// --- Werkzeugleiste ------------------------------------------------------------------------

function setQuery(patch: Record<string, string | undefined>) {
  const query: LocationQueryRaw = { ...route.query };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete query[key];
    else query[key] = value;
  }
  void router.push({ path: route.path, query, state: link(route.path, query).state });
}

const adProductOptions = computed(() =>
  AD_PRODUCTS.map((adProduct) => ({
    value: adProduct,
    label: t(`analytics.adProduct.${adProduct}`),
  })),
);
function onAdProducts(value: AdProduct[]) {
  setQuery({
    adp: value.length > 0 && value.length < AD_PRODUCTS.length ? value.join(',') : undefined,
  });
}
function onRemoved(event: Event) {
  setQuery({ removed: (event.target as HTMLInputElement).checked ? '1' : undefined });
}
/** Sortierung per Klick: ohne neuen Verlaufseintrag (sonst stünde jeder Klick in der Zurück-Taste). */
function onSort(sort: GridSort | null) {
  const value = sort ? `${sort.column}.${sort.direction}` : undefined;
  if (value === (route.query.sort ?? undefined)) return;
  const query: LocationQueryRaw = { ...route.query, sort: value };
  if (value === undefined) delete query.sort;
  void router.replace({ path: route.path, query, state: link(route.path, query).state });
}
// Suche nach ASIN/SKU (nur Reiter Product Ads, F10): Eingabe lokal, übernommen mit Enter oder „Suchen“.
const searchText = ref('');
watch(
  () => state.value.productSearch.join(' '),
  (value) => (searchText.value = value),
  { immediate: true },
);
function applySearch() {
  const terms = parseProductTerms(searchText.value);
  setQuery({ q: terms.length > 0 ? terms.join(',') : undefined });
}
function clearSearch() {
  searchText.value = '';
  setQuery({ q: undefined });
}

function onChartMetrics([m1, m2]: [MetricKey, MetricKey]) {
  setQuery({ m1: m1 === 'cost' ? undefined : m1, m2: m2 === 'sales' ? undefined : m2 });
}

// Spaltenauswahl je Ebene in ui_state (Scope `explorer`).
const columnsKey = computed(() => `columns.${level.value}`);
const storedColumns = useQuery({
  queryKey: computed(() => ['ui-state', 'explorer', columnsKey.value] as const),
  queryFn: () => api.getUiState('explorer', columnsKey.value),
  staleTime: Infinity,
  retry: false,
});
const saveColumns = useMutation({
  mutationFn: (value: string[]) => api.putUiState('explorer', columnsKey.value, value),
});
const visibleColumns = computed(() => {
  const available = columnsForLevel(level.value);
  const stored = storedColumns.data.value;
  return Array.isArray(stored)
    ? new Set(stored.filter((c): c is string => typeof c === 'string' && available.includes(c)))
    : defaultVisibleColumns(level.value);
});
const columnOptions = computed(() =>
  columnsForLevel(level.value).map((column) => ({
    value: column,
    label: t(`explorer.column.${column}`),
  })),
);
function onColumns(value: string[]) {
  queryClient.setQueryData(['ui-state', 'explorer', columnsKey.value], value);
  saveColumns.mutate(value);
}

// --- Gespeicherte Ansichten (F8) ------------------------------------------------------------

/** Spaltenauswahl der Ebene; `null` = Standard der Ebene (gleich, ob gespeichert oder nicht). */
const storedColumnList = computed(() => {
  const visible = visibleColumns.value;
  const defaults = defaultVisibleColumns(level.value);
  const isDefault = visible.size === defaults.size && [...visible].every((c) => defaults.has(c));
  return isDefault ? null : [...visible];
});
const currentView = computed(() =>
  filters.ready.value && storedColumns.isFetched.value
    ? viewState('explorer', filters.state.value, {
        explorer: state.value,
        columns: storedColumnList.value,
      })
    : null,
);
function applyView(view: SavedView, { replace }: { replace: boolean }) {
  const explorer = view.state.explorer;
  if (!explorer) return;
  // Spalten wie selbst gewählt (ui_state der Ebene); `null` = Standard der Ebene.
  const key = `columns.${explorer.level}`;
  const columns = explorer.columns ?? [...defaultVisibleColumns(explorer.level)];
  queryClient.setQueryData(['ui-state', 'explorer', key], columns);
  void api.putUiState('explorer', key, columns).catch(() => undefined);
  const target = explorerTarget(view.state);
  filters.update(filtersFromView(view.state), {
    path: target.path,
    query: target.query,
    state: { [CRUMBS_KEY]: {} },
    replace,
  });
}

// --- Grid ----------------------------------------------------------------------------------

const accountTypes = computed(
  () => new Map((filters.options.data.value?.profiles ?? []).map((p) => [p.id, p.accountType])),
);
const columnDefs = computed(() =>
  buildColumnDefs({
    level: level.value,
    visible: visibleColumns.value,
    sort: state.value.sort,
    t,
    te,
    locale: locale.value,
    attribution: filters.state.value.attribution,
    accountTypeOf: (profileId) => accountTypes.value.get(profileId),
    displayCurrency: data.value?.meta.currency ?? 'EUR',
    converted: data.value?.meta.converted ?? false,
    editable: canViewChanges.value,
    ...(canViewTags.value && { tags: tagMap.value }),
  }),
);
const gridRows = computed<GridRow[]>(() => data.value?.rows ?? []);
const total = computed(() =>
  data.value?.total ? totalRow(data.value.total, data.value.meta.currency) : null,
);

const selectedIds = ref<string[]>([]);
// Neue Auswahl, anderer Zeitraum, Drill-Down …: das Grid baut neu auf, alte Markierungen gelten nicht mehr.
watch(
  () => JSON.stringify(rows.body.value),
  () => (selectedIds.value = []),
);
const series = useExplorerSeries(
  rows.body,
  computed(() => selectedIds.value),
  enabled,
);

// --- Markierte Zeilen: Bulk-Dialoge, Strategie und Platzierungen (3.5) ---------------------

const selectedRows = computed(() => {
  const ids = new Set(selectedIds.value);
  return ids.size === 0 ? [] : gridRows.value.filter((row) => ids.has(row.id));
});
const BULK_MONEY_FIELD: Partial<Record<ExplorerLevel, MoneyField>> = {
  campaign: 'budget',
  adGroup: 'default_bid',
  target: 'bid',
};
const bulkMoneyField = computed(() => BULK_MONEY_FIELD[level.value] ?? null);
const canBulkEdit = computed(() => canWriteChanges.value && editableLevel.value);
const canBulkTag = computed(() => canWriteTags.value && tagEntityType.value !== null);
const showBulkBar = computed(
  () => (canBulkEdit.value || canBulkTag.value) && selectedRows.value.length > 0,
);
/** Strategie und Platzierungen gelten für genau eine SP-Kampagne. */
const biddingRow = computed(() => {
  const [row, ...rest] = selectedRows.value;
  return level.value === 'campaign' &&
    row &&
    rest.length === 0 &&
    editIssue('campaign', row, 'bidding_strategy') === null
    ? row
    : null;
});
const bulkField = ref<'state' | MoneyField | null>(null);
const bulkRows = shallowRef<GridRow[]>([]);
const biddingOpen = shallowRef<GridRow | null>(null);
function openBulk(field: 'state' | MoneyField) {
  bulkRows.value = selectedRows.value;
  bulkField.value = field;
}
watch(level, () => {
  bulkField.value = null;
  tagRows.value = null;
  biddingOpen.value = null;
  editNotice.value = null;
});

// --- CSV -----------------------------------------------------------------------------------

const grid = shallowRef<InstanceType<typeof ExplorerGrid>>();
/** Nach dem Vormerken gilt die Markierung als erledigt. */
const clearSelection = () => grid.value?.clearSelection();
function exportCsv() {
  const d = data.value;
  if (!grid.value || !d) return;
  const note = d.truncated
    ? t('explorer.csvTruncatedNote', {
        shown: formatNumber(d.maxRows, locale.value),
        total: formatNumber(d.totalRows, locale.value),
      })
    : undefined;
  downloadCsv(
    `profitbash-${level.value}-${range.value.from}_${range.value.to}.csv`,
    grid.value.csv(note),
  );
}

const truncatedText = computed(() => {
  const d = data.value;
  if (!d?.truncated) return null;
  return t('explorer.truncated', {
    shown: formatNumber(d.maxRows, locale.value),
    total: formatNumber(d.totalRows, locale.value),
  });
});
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('explorer.eyebrow')"
      :title="t('nav.explorer')"
      :description="t('explorer.description')"
    >
      <template #actions>
        <RouterLink
          v-if="canViewChanges && pendingCount !== null"
          to="/ads/changes"
          data-pending-link
          class="flex min-h-11 items-center gap-space-xs rounded-control px-space-md text-body-sm font-semibold text-violet outline-none hover:bg-violet-wash focus-visible:ring-2 focus-visible:ring-violet"
        >
          <i class="pi pi-history" aria-hidden="true" />
          {{ t('explorer.pendingLink', { count: formatNumber(String(pendingCount), locale) }) }}
        </RouterLink>
        <SavedViewsMenu
          area="explorer"
          :current="currentView"
          link-path="/ads/explorer"
          @apply="applyView"
        />
      </template>
    </PageHeader>

    <FilterBar :filters="filters" :earliest-date="data?.meta.earliestDate ?? null" />

    <EmptyState
      v-if="filters.options.data.value && !hasProfiles"
      icon="link"
      :title="t('dashboard.noProfiles.title')"
      :text="t('dashboard.noProfiles.text')"
    />

    <template v-else-if="!filters.options.isError.value">
      <ExplorerTabs :tabs="tabs" :active="level" />

      <nav :aria-label="t('explorer.breadcrumbs')">
        <ol class="flex flex-wrap items-center gap-x-space-xs text-body-sm text-ink-secondary">
          <li
            v-for="(crumb, index) in breadcrumbs"
            :key="crumb.key"
            class="flex items-center gap-x-space-xs"
          >
            <i
              v-if="index > 0"
              class="pi pi-angle-right text-[0.625rem] text-ink-tertiary"
              aria-hidden="true"
            />
            <RouterLink v-if="crumb.to" :to="crumb.to" class="text-violet hover:underline">{{
              crumb.label
            }}</RouterLink>
            <span v-else aria-current="location" class="font-medium text-ink">{{
              crumb.label
            }}</span>
          </li>
        </ol>
      </nav>

      <ExplorerChart
        v-if="level !== 'negative'"
        :query="series"
        :metrics="state.chartMetrics"
        :range="range"
        :selected-count="selectedIds.length"
        @metrics="onChartMetrics"
      />

      <section
        class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <div class="flex flex-wrap items-end gap-space-md">
          <div class="flex w-56 flex-col gap-space-xs">
            <label :for="`${id}-adp`" class="text-label-eyebrow uppercase text-ink-tertiary">
              {{ t('explorer.adProducts') }}
            </label>
            <MultiSelect
              :input-id="`${id}-adp`"
              :model-value="state.adProducts.length ? state.adProducts : [...AD_PRODUCTS]"
              :options="adProductOptions"
              option-label="label"
              option-value="value"
              :placeholder="t('explorer.allAdProducts')"
              :max-selected-labels="1"
              :selected-items-label="t('explorer.selectedItems', { count: '{0}' })"
              size="small"
              @update:model-value="onAdProducts"
            />
          </div>
          <div class="flex w-56 flex-col gap-space-xs">
            <label :for="`${id}-columns`" class="text-label-eyebrow uppercase text-ink-tertiary">
              {{ t('explorer.columns') }}
            </label>
            <MultiSelect
              :input-id="`${id}-columns`"
              :model-value="[...visibleColumns]"
              :options="columnOptions"
              option-label="label"
              option-value="value"
              :max-selected-labels="2"
              :selected-items-label="t('explorer.selectedItems', { count: '{0}' })"
              size="small"
              @update:model-value="onColumns"
            />
          </div>
          <form
            v-if="level === 'productAd'"
            class="flex min-w-0 flex-col gap-space-xs"
            role="search"
            @submit.prevent="applySearch"
          >
            <label :for="`${id}-search`" class="text-label-eyebrow uppercase text-ink-tertiary">
              {{ t('explorer.productSearch.label') }}
            </label>
            <div class="flex items-center gap-space-xs">
              <InputText
                :id="`${id}-search`"
                v-model="searchText"
                data-explorer-search
                size="small"
                autocomplete="off"
                :placeholder="t('explorer.productSearch.placeholder')"
                class="w-64 max-w-full font-data"
              />
              <Button
                type="submit"
                icon="pi pi-search"
                severity="secondary"
                size="small"
                :aria-label="t('explorer.productSearch.submit')"
              />
              <Button
                v-if="state.productSearch.length > 0"
                type="button"
                icon="pi pi-times"
                severity="secondary"
                text
                size="small"
                data-explorer-search-clear
                :aria-label="t('explorer.productSearch.clear')"
                @click="clearSearch"
              />
            </div>
          </form>
          <label class="flex min-h-11 items-center gap-space-sm text-body-sm text-ink">
            <input
              type="checkbox"
              data-explorer-removed
              class="size-4 accent-violet"
              :checked="state.includeRemoved"
              @change="onRemoved"
            />
            {{ t('explorer.includeRemoved') }}
          </label>
          <span class="flex-1" />
          <span v-if="data" class="font-data text-data-sm text-ink-tertiary">
            {{
              t(
                'explorer.rowCount',
                { count: formatNumber(data.rows.length, locale) },
                data.rows.length,
              )
            }}
          </span>
          <Button
            data-explorer-export
            icon="pi pi-download"
            :label="t('explorer.exportCsv')"
            severity="secondary"
            size="small"
            :disabled="!data || data.rows.length === 0"
            @click="exportCsv"
          />
        </div>

        <p
          v-if="truncatedText"
          role="status"
          class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
        >
          <i class="pi pi-info-circle mr-space-xs text-warn" aria-hidden="true" />{{
            truncatedText
          }}
        </p>
        <p v-if="rows.comparisonPending.value" role="status" class="text-body-sm text-ink-tertiary">
          {{ t('explorer.comparisonLoading') }}
        </p>
        <InlineError
          v-if="rows.full.isError.value"
          :message="t('explorer.comparisonFailed')"
          retryable
          :retrying="rows.full.isFetching.value"
          @retry="rows.full.refetch()"
        />

        <InlineError
          v-if="editableLevel && openChanges.isError.value"
          :message="t('explorer.openChangesFailed')"
          retryable
          :retrying="openChanges.isFetching.value"
          @retry="openChanges.refetch()"
        />
        <p
          v-if="openChanges.data.value?.truncated"
          role="status"
          class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
        >
          <i class="pi pi-info-circle mr-space-xs text-warn" aria-hidden="true" />{{
            t('explorer.openChangesTruncated')
          }}
        </p>
        <InlineError v-if="editNotice" data-edit-notice :message="editNotice" />

        <div
          v-if="showBulkBar"
          data-bulk-bar
          role="toolbar"
          :aria-label="t('explorer.bulk.toolbar')"
          class="flex flex-wrap items-center gap-space-sm rounded-control bg-violet-wash px-space-md py-space-sm"
        >
          <span class="font-data text-body-sm font-semibold text-ink">
            {{
              t('explorer.bulk.selected', {
                count: formatNumber(String(selectedRows.length), locale),
              })
            }}
          </span>
          <span class="flex-1" />
          <Button
            v-if="canBulkTag"
            data-bulk="tags"
            icon="pi pi-tags"
            :label="t('explorer.bulk.action.tags')"
            severity="secondary"
            size="small"
            @click="tagRows = selectedRows"
          />
          <Button
            v-if="canBulkEdit"
            data-bulk="state"
            :label="t('explorer.bulk.action.state')"
            severity="secondary"
            size="small"
            @click="openBulk('state')"
          />
          <Button
            v-if="canBulkEdit && bulkMoneyField"
            :data-bulk="bulkMoneyField"
            :label="t(`explorer.bulk.action.${bulkMoneyField}`)"
            severity="secondary"
            size="small"
            @click="openBulk(bulkMoneyField)"
          />
          <Button
            v-if="canBulkEdit && level === 'campaign'"
            v-tooltip.top="biddingRow ? undefined : t('explorer.bulk.biddingHint')"
            data-bulk="bidding"
            :label="t('explorer.bulk.action.bidding')"
            severity="secondary"
            size="small"
            :disabled="!biddingRow"
            @click="biddingOpen = biddingRow"
          />
          <!-- Gebots-Simulator (4.8, F12) mit Strategie und Platzierungen dieser Kampagne. -->
          <RouterLink
            v-if="canViewTools && biddingRow"
            data-bulk="simulate"
            :to="simulatorLink(biddingRow)"
            class="flex min-h-8 items-center gap-space-xs rounded-control px-space-sm text-body-sm font-semibold text-violet outline-none hover:bg-tile focus-visible:ring-2 focus-visible:ring-violet"
          >
            <i class="pi pi-calculator" aria-hidden="true" />
            {{ t('explorer.bulk.action.simulate') }}
          </RouterLink>
        </div>

        <InlineError
          v-if="rows.base.isError.value && !data"
          :message="t('explorer.loadFailed')"
          retryable
          :retrying="rows.base.isFetching.value"
          @retry="rows.base.refetch()"
        />
        <div v-else-if="!data" class="flex flex-col gap-space-sm" aria-busy="true">
          <SkeletonBlock v-for="n in 8" :key="n" height="2.25rem" />
        </div>
        <p v-else-if="data.rows.length === 0" class="text-body-sm text-ink-secondary">
          {{
            level === 'productAd' && state.productSearch.length > 0
              ? t('explorer.productSearch.empty')
              : t('explorer.empty')
          }}
        </p>
        <ExplorerGrid
          v-else
          ref="grid"
          :rows="gridRows"
          :total="total"
          :column-defs="columnDefs"
          :context="gridContext"
          @selection="(ids) => (selectedIds = ids)"
          @sort="onSort"
        />
      </section>
    </template>

    <AssignTagsDialog
      v-if="tagEntityType && canWriteTags"
      :visible="tagRows !== null"
      :entity-type="tagEntityType"
      :rows="tagRows ?? []"
      :tags="tagsQuery.data.value ?? []"
      @assigned="clearSelection"
      @close="tagRows = null"
    />
    <BulkEditDialog
      v-if="bulkField"
      visible
      :level="level"
      :field="bulkField"
      :rows="bulkRows"
      @staged="clearSelection"
      @close="bulkField = null"
    />
    <CampaignBiddingDialog
      :visible="biddingOpen !== null"
      :row="biddingOpen"
      :entry-for="entryFor"
      :ready="openChanges.isSuccess.value && !openChanges.data.value?.truncated"
      @staged="clearSelection"
      @close="biddingOpen = null"
    />
  </div>
</template>
