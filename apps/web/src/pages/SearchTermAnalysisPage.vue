<script setup lang="ts">
import {
  formatCurrency,
  formatDateTime,
  formatDay,
  formatNumber,
  formatPercent,
  MAX_HARVEST_TERMS_PER_REQUEST,
} from '@profitbash/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { computed, ref, shallowRef, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter, type LocationQueryRaw } from 'vue-router';
import { api, ApiError } from '../api';
import type { HarvestMarkResultData, SearchTermPeriodData, SearchTermRowData } from '../api/client';
import { useChangeRights } from '../changes/queries';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import ExplorerTabs from '../explorer/ExplorerTabs.vue';
import {
  EXPLORER_TABS,
  pathForLevel,
  SEARCH_TERM_ANALYSIS_PATH,
  SEARCH_TERM_ANALYSIS_TAB,
} from '../explorer/state';
import { downloadCsv, fileNamePart } from '../grid/csv';
import { errorMessageKey } from '../i18n';
import { canAccess } from '../navigation/navigation';
import { harvestTerms } from '../search-terms/actions';
import {
  formatSearchTermMetric,
  harvestColumns,
  ngramColumns,
  termColumns,
  totalRow,
  type ColumnContext,
  type NgramGridRow,
  type TermGridRow,
} from '../search-terms/columns';
import { fractionToPercent } from '../search-terms/decimal-input';
import DeletePeriodDialog from '../search-terms/DeletePeriodDialog.vue';
import { explorerEntityLink } from '../search-terms/explorer-link';
import NegativeDialog from '../search-terms/NegativeDialog.vue';
import RulesDialog from '../search-terms/RulesDialog.vue';
import SearchTermGrid from '../search-terms/SearchTermGrid.vue';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Suchbegriff-Analyse (`phase-2b.md` 2b.2b): Suchbegriffe eines Profils für **einen** Datei-Zeitraum (aus den
 * Suchbegriff-Blättern der Bulk-Datei) mit Einstufung Ernten / Negieren / Beobachten und den Wortbausteinen
 * (N-Gramme). Kein freier Zeitraum: Zeiträume verschiedener Dateien überlappen sich und werden nie addiert.
 * Aktionen (`phase-3.md` 3.8, F9): markierte Suchbegriffe als Negativ in den Warenkorb legen oder für den Harvest
 * vormerken; die Merkliste des Profils ist die dritte Ansicht. Zustand in der URL (`profile`, `from`, `to`, `view`,
 * `class`).
 */
const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();
const session = useSessionStore();
const orgId = useActiveOrgId();
const queryClient = useQueryClient();
const id = useId();
const locale = computed(() => session.preferences.locale);
const canWrite = computed(() => session.me?.features['sp-explorer']?.write ?? false);
// Negatives sind Änderungen bei Amazon: Recht `write` im Feature `changes` (wie das Bearbeiten im Explorer).
const { canWrite: canWriteChanges } = useChangeRights();
const canSelect = computed(() => canWrite.value || canWriteChanges.value);
// Einen Zeitraum löschen darf nur, wer die Datei auch wieder hochladen kann: Org-Admins (wie die Seite
// „Clients & Connections“ mit dem Upload), so prüft es auch die API.
const canDeletePeriod = computed(
  () => canWrite.value && (session.me ? canAccess('orgAdmin', session.me) : false),
);

const tabs = computed(() => [
  ...EXPLORER_TABS.map((tab) => ({
    key: tab.level as string,
    label: t(`explorer.tab.${tab.level}`),
    to: pathForLevel(tab.level),
  })),
  {
    key: SEARCH_TERM_ANALYSIS_TAB,
    label: t('searchTerms.tab'),
    to: SEARCH_TERM_ANALYSIS_PATH,
  },
]);

// --- Auswahl: Profil und Datei-Zeitraum ---------------------------------------------------

const periodsQuery = useQuery({
  queryKey: computed(() => ['search-terms', orgId.value, 'periods'] as const),
  queryFn: () => api.searchTerms.periods(),
  enabled: computed(() => orgId.value !== null),
});
const periods = computed(() => periodsQuery.data.value ?? []);

const one = (value: unknown) => (typeof value === 'string' ? value : null);
const periodKey = (period: Pick<SearchTermPeriodData, 'periodStart' | 'periodEnd'>) =>
  `${period.periodStart}_${period.periodEnd}`;

/** Gültige Auswahl: Profil aus der URL (sonst das erste), dazu sein Zeitraum aus der URL (sonst der neueste). */
const selected = computed<SearchTermPeriodData | null>(() => {
  const all = periods.value;
  const profileId = one(route.query.profile);
  const ofProfile = all.filter((p) => p.profileId === profileId);
  const candidates =
    ofProfile.length > 0 ? ofProfile : all.filter((p) => p.profileId === all[0]?.profileId);
  const wanted = `${one(route.query.from)}_${one(route.query.to)}`;
  return candidates.find((p) => periodKey(p) === wanted) ?? candidates[0] ?? null;
});

const profileOptions = computed(() => {
  const seen = new Map<string, { value: string; label: string }>();
  for (const period of periods.value) {
    if (!seen.has(period.profileId)) {
      seen.set(period.profileId, {
        value: period.profileId,
        label: `${period.accountName} · ${period.countryCode}`,
      });
    }
  }
  return [...seen.values()];
});

const rangeLabel = (period: Pick<SearchTermPeriodData, 'periodStart' | 'periodEnd'>) =>
  `${formatDay(period.periodStart, locale.value)} – ${formatDay(period.periodEnd, locale.value)}`;

const periodOptions = computed(() =>
  periods.value
    .filter((period) => period.profileId === selected.value?.profileId)
    .map((period) => ({
      value: periodKey(period),
      label: t('searchTerms.periodOption', {
        range: rangeLabel(period),
        rows: formatNumber(String(period.rows), locale.value),
      }),
    })),
);

function navigate(patch: LocationQueryRaw, replace = false) {
  const query: LocationQueryRaw = { ...route.query, ...patch };
  for (const key of Object.keys(query)) {
    if (query[key] === undefined || query[key] === null) delete query[key];
  }
  return router[replace ? 'replace' : 'push']({ path: SEARCH_TERM_ANALYSIS_PATH, query });
}

// Die URL nennt immer die geltende Auswahl (auch nach unbekannten Angaben oder einem Link ohne Parameter), ohne
// Verlaufseintrag. Nur solange diese Seite die Route ist: Beim Verlassen darf nichts zurückleiten.
watch(
  [
    selected,
    () => route.path,
    () => route.query.profile,
    () => route.query.from,
    () => route.query.to,
  ],
  ([period, path, profile, from, to]) => {
    if (!period || path !== SEARCH_TERM_ANALYSIS_PATH) return;
    if (profile !== period.profileId || from !== period.periodStart || to !== period.periodEnd) {
      void navigate(
        { profile: period.profileId, from: period.periodStart, to: period.periodEnd },
        true,
      );
    }
  },
  { immediate: true },
);

function onProfile(profileId: string) {
  const first = periods.value.find((period) => period.profileId === profileId);
  if (first) {
    void navigate({ profile: profileId, from: first.periodStart, to: first.periodEnd });
  }
}

function onPeriod(key: string) {
  const [from, to] = key.split('_');
  void navigate({ from, to });
}

// --- Analyse ------------------------------------------------------------------------------

const request = computed(() =>
  selected.value
    ? {
        profileId: selected.value.profileId,
        periodStart: selected.value.periodStart,
        periodEnd: selected.value.periodEnd,
      }
    : null,
);

const analysis = useQuery({
  queryKey: computed(() => ['search-terms', orgId.value, 'analysis', request.value] as const),
  queryFn: () => api.searchTerms.analysis(request.value!),
  enabled: computed(() => request.value !== null),
  // Beim Wechsel von Profil oder Zeitraum bleiben die alten Werte blass stehen, bis die neuen da sind.
  placeholderData: keepPreviousData,
  // Bis zu 10 000 Zeilen: keine tiefen Proxys (die Zeilen werden nie verändert, nur ersetzt).
  shallow: true,
});
const busy = computed(() => analysis.isFetching.value);
const data = computed(() => analysis.data.value);
const meta = computed(() => data.value?.meta);
const currency = computed(() => meta.value?.currency ?? selected.value?.currencyCode ?? '');

// --- Ansicht und Filter -------------------------------------------------------------------

const VIEWS = ['terms', 'ngrams', 'harvest'] as const;
type View = (typeof VIEWS)[number];
const view = computed<View>(() => VIEWS.find((entry) => entry === route.query.view) ?? 'terms');
const CLASSES = ['harvest', 'negate', 'watch'] as const;
type Classification = SearchTermRowData['classification'];
/**
 * Zusätzliche Filter (2b.2f): Zeilen der Suchbegriffe, die erst über alle Targets zusammen ein Kandidat sind
 * (keine Zeile erreicht die Einstufung allein).
 */
const ACROSS_FILTERS = { 'harvest-across': 'harvest', 'negate-across': 'negate' } as const;
type AcrossFilter = keyof typeof ACROSS_FILTERS;
const ACROSS_KEYS = Object.keys(ACROSS_FILTERS) as AcrossFilter[];
type ClassFilter = Classification | AcrossFilter;
const classFilter = computed<ClassFilter | null>(() => {
  const value = one(route.query.class);
  return [...CLASSES, ...ACROSS_KEYS].find((entry) => entry === value) ?? null;
});
const isAcrossFilter = (value: ClassFilter): value is AcrossFilter => value in ACROSS_FILTERS;

// Die Einstufung filtert nur die Suchbegriffe: Die Wortbausteine nehmen sie nicht mit.
const setView = (next: View) =>
  navigate(next === 'terms' ? { view: undefined } : { view: next, class: undefined });

const toggleClass = (next: ClassFilter) =>
  navigate({ class: classFilter.value === next ? undefined : next, view: undefined });

const NGRAM_SIZES = [1, 2, 3] as const;
const ngramSize = ref<number | null>(null);

/** Sprung in den Explorer (2b.2e): Client und Datei-Zeitraum der gezeigten Analyse, nicht der Auswahl im Wechsel. */
const explorerLink = computed<ColumnContext['explorerLink']>(() => {
  const source = meta.value;
  return source ? (level, row) => explorerEntityLink(source, level, row) : undefined;
});
const columnContext = computed<ColumnContext>(() => ({
  t,
  te,
  locale: locale.value,
  currency: currency.value,
  explorerLink: explorerLink.value,
  ...(canWriteChanges.value && { onNegative: (row) => openNegative([row]) }),
  ...(canWrite.value && { onHarvest: (row) => void markForHarvest([row]) }),
}));
const termDefs = computed(() => termColumns(columnContext.value));
const ngramDefs = computed(() => ngramColumns(columnContext.value));

const termRows = computed<TermGridRow[]>(() => {
  const rows = data.value?.rows ?? [];
  const filter = classFilter.value;
  if (filter === null) return rows;
  if (isAcrossFilter(filter)) {
    const wanted = ACROSS_FILTERS[filter];
    return rows.filter((row) => row.termOnlyAcrossTargets && row.termClassification === wanted);
  }
  return rows.filter((row) => row.classification === filter);
});
/** Suchbegriffe, die erst über alle Targets Kandidaten sind; ohne Treffer nur, solange der Filter noch gilt. */
const acrossEntries = computed(() =>
  ACROSS_KEYS.map((key) => ({
    key,
    target: ACROSS_FILTERS[key],
    value: data.value?.termCountsOnlyAcrossTargets[ACROSS_FILTERS[key]] ?? 0,
  })).filter((entry) => entry.value > 0 || classFilter.value === entry.key),
);
const total = computed(() => (data.value ? totalRow(data.value.total) : null));
const ngramRows = computed<NgramGridRow[]>(() =>
  (data.value?.ngrams ?? [])
    .filter((ngram) => ngramSize.value === null || ngram.size === ngramSize.value)
    .map((ngram) => ({ ...ngram, id: `${ngram.size}:${ngram.gram}` })),
);

const count = (value: number) => formatNumber(String(value), locale.value);
const metric = (key: 'cost' | 'sales' | 'acos' | 'cvr') =>
  formatSearchTermMetric(key, data.value?.total[key], {
    locale: locale.value,
    currency: currency.value,
  });

// Erlaubt sind zwei Nachkommastellen: nicht auf eine runden (25,55 % bliebe sonst „25,6 %“).
const acosText = (fraction: string) =>
  formatPercent(fraction, locale.value, {
    fractionDigits: Math.max(1, (fractionToPercent(fraction).split('.')[1] ?? '').length),
  });

/** Die geltenden Regeln des Profils (Regeln der Organisation, je Feld vom Profil überschrieben). */
const rulesText = computed(() => {
  const rules = meta.value?.rules;
  if (!rules) return null;
  return {
    harvest: t('searchTerms.rules.harvest', {
      purchases: t('searchTerms.rules.purchases', rules.harvestMinPurchases),
      acos: acosText(rules.harvestMaxAcos),
    }),
    negate: t('searchTerms.rules.negate', {
      clicks: t('searchTerms.rules.clicks', rules.negateMinClicks),
      cost: formatCurrency(rules.negateMinCost, currency.value, locale.value),
    }),
  };
});

const RULE_KEYS = [
  'harvestMinPurchases',
  'harvestMaxAcos',
  'negateMinClicks',
  'negateMinCost',
] as const;

/** Welche Werte für dieses Profil abweichen (2b.2g) und was dafür sonst für alle Profile gilt. */
const overrideText = computed(() => {
  const m = meta.value;
  if (!m) return null;
  const keys = RULE_KEYS.filter((key) => m.ruleOverrides[key] !== null);
  if (keys.length === 0) return null;
  const org = m.organizationRules;
  const value = {
    harvestMinPurchases: count(org.harvestMinPurchases),
    harvestMaxAcos: acosText(org.harvestMaxAcos),
    negateMinClicks: count(org.negateMinClicks),
    negateMinCost: formatCurrency(org.negateMinCost, currency.value, locale.value),
  };
  return {
    overridden: t('searchTerms.rules.overridden', {
      fields: keys.map((key) => t(`searchTerms.rules.field.${key}`)).join(', '),
    }),
    organization: t('searchTerms.rules.organization', {
      values: keys
        .map((key) => t(`searchTerms.rules.organizationValue.${key}`, { value: value[key] }))
        .join(', '),
    }),
  };
});

// --- Aktionen auf Suchbegriffe (3.8) ---------------------------------------------------------

/** Das Grid der gewählten Ansicht (es gibt immer nur eines). */
const grid = shallowRef<{
  csv: (note?: string) => string;
  ready: boolean;
  clearSelection: () => void;
}>();

const selectedIds = ref<string[]>([]);
// Die Markierung gilt für die gezeigten Zeilen: Mit Ansicht, Filter, Profil oder Zeitraum fällt sie weg.
// Über den Inhalt der Auswahl, nicht das Objekt: Der URL-Abgleich erzeugt es neu, ohne dass sich etwas ändert.
const requestKey = computed(() => JSON.stringify(request.value));
watch([view, classFilter, requestKey], () => (selectedIds.value = []));
const selectedTermRows = computed(() => {
  const ids = new Set(selectedIds.value);
  return (data.value?.rows ?? []).filter((row) => ids.has(row.id));
});
function clearSelection() {
  grid.value?.clearSelection();
  selectedIds.value = [];
}

const negativeOpen = ref(false);
/** Die Zeilen, für die der Dialog fragt: beim Öffnen festgehalten (eine Zeile oder die Markierung). */
const negativeRows = shallowRef<SearchTermRowData[]>([]);
function openNegative(rows: SearchTermRowData[]) {
  if (rows.length === 0) return;
  negativeRows.value = rows;
  negativeOpen.value = true;
}

const harvestKey = computed(
  () => ['search-terms', orgId.value, 'harvest', selected.value?.profileId ?? null] as const,
);
const harvestResult = ref<HarvestMarkResultData['counts'] | null>(null);
const harvestErrorKey = ref<string | null>(null);
const markHarvest = useMutation({
  /** In Stücken (`MAX_HARVEST_TERMS_PER_REQUEST`); scheitert ein Stück, sind die früheren schon vorgemerkt. */
  mutationFn: async (input: { period: NonNullable<typeof request.value>; terms: string[] }) => {
    const counts = { added: 0, alreadyMarked: 0, notFound: 0 };
    for (let start = 0; start < input.terms.length; start += MAX_HARVEST_TERMS_PER_REQUEST) {
      const part = await api.searchTerms.harvest.mark({
        ...input.period,
        searchTerms: input.terms.slice(start, start + MAX_HARVEST_TERMS_PER_REQUEST),
      });
      for (const key of Object.keys(counts) as (keyof typeof counts)[]) {
        counts[key] += part.counts[key];
      }
    }
    return counts;
  },
  // Die Kennzeichnung der Zeilen und die Merkliste kommen vom Server.
  onSettled: () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['search-terms', orgId.value, 'analysis'] }),
      queryClient.invalidateQueries({ queryKey: ['search-terms', orgId.value, 'harvest'] }),
    ]),
});
async function markForHarvest(rows: SearchTermRowData[]) {
  const period = request.value;
  if (!period || rows.length === 0 || markHarvest.isPending.value) return;
  harvestResult.value = null;
  harvestErrorKey.value = null;
  try {
    harvestResult.value = await markHarvest.mutateAsync({ period, terms: harvestTerms(rows) });
    clearSelection();
  } catch (error) {
    harvestErrorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
watch([view, requestKey], () => {
  harvestResult.value = null;
  harvestErrorKey.value = null;
});

// --- Harvest-Merkliste (3.8) ---------------------------------------------------------------

const harvestList = useQuery({
  queryKey: harvestKey,
  queryFn: () => api.searchTerms.harvest.list(selected.value!.profileId),
  enabled: computed(() => view.value === 'harvest' && selected.value !== null),
  placeholderData: keepPreviousData,
});
const harvestRows = computed(() => harvestList.data.value?.marks ?? []);
const harvestDefs = computed(() =>
  harvestColumns({ t, te, locale: locale.value }, selected.value?.currencyCode ?? ''),
);
const removeHarvest = useMutation({
  mutationFn: (ids: string[]) => api.searchTerms.harvest.remove(ids),
  onSettled: () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['search-terms', orgId.value, 'harvest'] }),
      queryClient.invalidateQueries({ queryKey: ['search-terms', orgId.value, 'analysis'] }),
    ]),
});
async function removeSelectedMarks() {
  if (selectedIds.value.length === 0 || removeHarvest.isPending.value) return;
  harvestErrorKey.value = null;
  try {
    await removeHarvest.mutateAsync(selectedIds.value);
    clearSelection();
  } catch (error) {
    harvestErrorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}

// --- CSV -----------------------------------------------------------------------------------

const viewRowCount = computed(
  () =>
    ({
      terms: termRows.value.length,
      ngrams: ngramRows.value.length,
      harvest: harvestRows.value.length,
    })[view.value],
);
// Ohne Zeilen gibt es kein Grid; bis seine API bereit ist, wäre die Datei leer.
const canExport = computed(() => grid.value?.ready === true && viewRowCount.value > 0);

/**
 * CSV der Ansicht, wie das Grid sie zeigt (Einstufung, Spaltenfilter, Sortierung), in der Schreibweise des Explorers.
 * Bei gekürzter Antwort enthält die Datei nur die geladenen Zeilen; ein eigener Hinweis steht dann vor der Kopfzeile.
 */
function exportCsv() {
  const m = meta.value;
  if (!grid.value?.ready) return;
  if (view.value === 'harvest') {
    const profile = selected.value;
    if (!profile) return;
    const part = fileNamePart(`${profile.accountName} ${profile.countryCode}`);
    downloadCsv(`profitbash-search-term-harvest-${part}.csv`, grid.value.csv());
    return;
  }
  if (!m) return;
  const terms = view.value === 'terms';
  const note = terms
    ? m.truncated
      ? t('searchTerms.csvTruncatedNote', { max: count(m.maxRows), total: count(m.totalRows) })
      : undefined
    : m.ngramsTruncated
      ? t('searchTerms.csvNgramsTruncatedNote', {
          max: count(m.maxNgrams),
          total: count(m.totalNgrams),
        })
      : undefined;
  const name = [
    'profitbash',
    terms ? 'search-term-analysis' : 'search-term-ngrams',
    terms ? classFilter.value : null,
    fileNamePart(`${m.accountName} ${m.countryCode}`),
    `${m.periodStart}_${m.periodEnd}`,
  ].filter(Boolean);
  downloadCsv(`${name.join('-')}.csv`, grid.value.csv(note));
}

// --- Regeln ändern ------------------------------------------------------------------------

const rulesOpen = ref(false);
async function onRulesSaved() {
  // Erst neu laden, dann schließen: Wer den Dialog sofort wieder öffnet, sieht die gespeicherten Werte.
  await queryClient.invalidateQueries({ queryKey: ['search-terms', orgId.value, 'analysis'] });
  rulesOpen.value = false;
}

// --- Zeitraum löschen (2b.2d) ---------------------------------------------------------------

const deleteOpen = ref(false);
/** Der Zeitraum, nach dem der Dialog fragt: beim Öffnen festgehalten, nicht die laufende Auswahl. */
const periodToDelete = ref<SearchTermPeriodData | null>(null);
function openDeletePeriod() {
  periodToDelete.value = selected.value;
  deleteOpen.value = periodToDelete.value !== null;
}
async function onPeriodDeleted(period: SearchTermPeriodData) {
  // Erst die Zeiträume neu laden, dann schließen (der Dialog bleibt bis dahin gesperrt): Die Auswahl fällt dann auf den nächsten gültigen Zeitraum (oder den Leerzustand),
  // die URL folgt per `replace`. Die Analyse des gelöschten Zeitraums bleibt nicht im Zwischenspeicher.
  await queryClient.invalidateQueries({ queryKey: ['search-terms', orgId.value, 'periods'] });
  queryClient.removeQueries({
    queryKey: [
      'search-terms',
      orgId.value,
      'analysis',
      {
        profileId: period.profileId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      },
    ],
  });
  deleteOpen.value = false;
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('explorer.eyebrow')"
      :title="t('searchTerms.title')"
      :description="t('searchTerms.description')"
    />

    <ExplorerTabs :tabs="tabs" :active="SEARCH_TERM_ANALYSIS_TAB" />

    <InlineError
      v-if="periodsQuery.isError.value"
      :message="t('searchTerms.periodsError')"
      retryable
      :retrying="periodsQuery.isFetching.value"
      @retry="periodsQuery.refetch()"
    />

    <SkeletonBlock v-else-if="periodsQuery.isPending.value" shape="tile" height="6rem" />

    <EmptyState
      v-else-if="periods.length === 0"
      icon="search"
      :title="t('searchTerms.empty.title')"
      :text="t('searchTerms.empty.text')"
    />

    <template v-else>
      <section
        class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <div class="flex flex-wrap items-end gap-space-md">
          <div class="flex w-64 max-w-full flex-col gap-space-xs">
            <label :for="`${id}-profile`" class="text-label-eyebrow uppercase text-ink-tertiary">
              {{ t('searchTerms.profile') }}
            </label>
            <Select
              :input-id="`${id}-profile`"
              :model-value="selected?.profileId"
              :options="profileOptions"
              option-label="label"
              option-value="value"
              size="small"
              @update:model-value="onProfile"
            />
          </div>
          <div class="flex w-96 max-w-full flex-col gap-space-xs">
            <label :for="`${id}-period`" class="text-label-eyebrow uppercase text-ink-tertiary">
              {{ t('searchTerms.period') }}
            </label>
            <Select
              :input-id="`${id}-period`"
              :model-value="selected ? periodKey(selected) : undefined"
              :options="periodOptions"
              option-label="label"
              option-value="value"
              size="small"
              class="font-data"
              @update:model-value="onPeriod"
            />
          </div>
          <Button
            v-if="canDeletePeriod && selected"
            :label="t('searchTerms.deletePeriod.action')"
            icon="pi pi-trash"
            size="small"
            severity="secondary"
            variant="text"
            @click="openDeletePeriod"
          />
        </div>
        <p class="max-w-prose text-body-sm text-ink-secondary">
          <template v-if="selected">
            {{ t('searchTerms.periodLine') }}
            <span class="font-data text-ink">{{ rangeLabel(selected) }}</span>
            <template v-if="meta?.importedAt">
              ·
              {{ t('searchTerms.importedAt') }}
              <span class="font-data">{{ formatDateTime(meta.importedAt, locale) }}</span>
            </template>
            <br />
          </template>
          {{ t('searchTerms.periodHint') }}
        </p>
      </section>

      <InlineError
        v-if="analysis.isError.value && !data"
        :message="t('searchTerms.analysisError')"
        retryable
        :retrying="analysis.isFetching.value"
        @retry="analysis.refetch()"
      />

      <template v-else-if="!data">
        <SkeletonBlock shape="tile" height="7rem" />
        <SkeletonBlock shape="tile" height="24rem" />
      </template>

      <template v-else>
        <InlineError
          v-if="analysis.isError.value"
          :message="t('searchTerms.staleError')"
          retryable
          :retrying="analysis.isFetching.value"
          @retry="analysis.refetch()"
        />
        <section
          class="grid gap-gutter lg:grid-cols-12"
          :aria-busy="busy"
          :class="busy ? 'opacity-60' : ''"
        >
          <div
            class="flex flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg lg:col-span-7"
          >
            <h2 class="text-label-eyebrow uppercase text-ink-tertiary">
              {{ t('searchTerms.classification') }}
            </h2>
            <div
              role="group"
              :aria-label="t('searchTerms.classFilter')"
              class="grid grid-cols-3 gap-space-sm"
            >
              <button
                v-for="entry in CLASSES"
                :key="entry"
                type="button"
                :aria-pressed="classFilter === entry"
                :class="[
                  'flex min-h-11 flex-col items-start gap-space-xs rounded-control px-space-md py-space-sm text-left transition-colors',
                  classFilter === entry
                    ? 'bg-violet-wash text-ink shadow-active'
                    : 'bg-well text-ink-secondary hover:bg-violet-wash',
                ]"
                @click="toggleClass(entry)"
              >
                <span class="text-body-sm">{{ t(`searchTerms.class.${entry}`) }}</span>
                <span
                  :class="[
                    'font-data text-headline-sm',
                    entry === 'harvest'
                      ? 'text-lime-deep'
                      : entry === 'negate'
                        ? 'text-loss'
                        : 'text-ink',
                  ]"
                  >{{ count(data.counts[entry]) }}</span
                >
              </button>
            </div>
            <div
              v-if="acrossEntries.length > 0"
              role="group"
              :aria-label="t('searchTerms.acrossTargets.filter')"
              class="flex flex-wrap items-center gap-x-space-sm gap-y-space-xs text-body-sm text-ink-secondary"
            >
              <span>{{ t('searchTerms.acrossTargets.lead') }}</span>
              <button
                v-for="entry in acrossEntries"
                :key="entry.key"
                type="button"
                :aria-pressed="classFilter === entry.key"
                :class="[
                  'min-h-11 rounded-control px-space-sm py-space-xs text-body-sm transition-colors',
                  classFilter === entry.key
                    ? 'bg-violet-wash text-ink'
                    : 'text-ink-secondary hover:bg-violet-wash',
                ]"
                @click="toggleClass(entry.key)"
              >
                <span class="font-data">{{ count(entry.value) }}</span>
                {{ t(`searchTerms.acrossTargets.${entry.target}`, entry.value) }}
              </button>
            </div>
            <dl class="flex flex-wrap gap-x-space-xl gap-y-space-sm">
              <div v-for="key in ['cost', 'sales', 'acos', 'cvr'] as const" :key="key">
                <dt class="text-label-eyebrow uppercase text-ink-tertiary">
                  {{ t(`explorer.column.${key}`) }}
                </dt>
                <dd class="font-data text-body-lg text-ink">{{ metric(key) }}</dd>
              </div>
            </dl>
          </div>

          <div
            class="flex flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg lg:col-span-5"
          >
            <div class="flex items-start justify-between gap-space-sm">
              <h2 class="text-label-eyebrow uppercase text-ink-tertiary">
                {{ t('searchTerms.rules.title') }}
              </h2>
              <Button
                v-if="canWrite"
                :label="t('searchTerms.rules.edit')"
                size="small"
                severity="secondary"
                variant="text"
                class="-my-1"
                @click="rulesOpen = true"
              />
            </div>
            <template v-if="rulesText">
              <p class="text-body-sm text-ink">{{ rulesText.harvest }}</p>
              <p class="text-body-sm text-ink">{{ rulesText.negate }}</p>
            </template>
            <p v-if="overrideText" class="text-body-sm text-ink-secondary">
              {{ overrideText.overridden }} {{ overrideText.organization }}
            </p>
            <p v-if="meta?.rulesAreDefault" class="text-body-sm text-ink-secondary">
              {{ t('searchTerms.rules.defaults') }}
            </p>
            <p class="text-body-sm text-ink-secondary">
              <template v-if="meta && meta.protectedTerms.length > 0">
                {{ t('searchTerms.protected.some', meta.protectedTerms.length) }}
                <span class="font-data">{{ meta.protectedTerms.slice(0, 8).join(', ') }}</span
                ><template v-if="meta.protectedTerms.length > 8"> …</template>
              </template>
              <template v-else>{{ t('searchTerms.protected.none') }}</template>
            </p>
          </div>
        </section>

        <section
          :class="[
            'flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg',
            busy ? 'opacity-60' : '',
          ]"
          :aria-busy="busy"
        >
          <div class="flex flex-wrap items-center gap-space-sm">
            <div role="group" :aria-label="t('searchTerms.view.label')" class="flex gap-space-xs">
              <button
                v-for="entry in VIEWS"
                :key="entry"
                type="button"
                :aria-pressed="view === entry"
                :class="[
                  'min-h-11 rounded-control px-space-md py-space-sm text-body-md transition-colors',
                  view === entry
                    ? 'bg-violet text-on-violet shadow-active'
                    : 'text-ink-secondary hover:bg-violet-wash hover:text-ink',
                ]"
                @click="setView(entry)"
              >
                {{ t(`searchTerms.view.${entry}`) }}
              </button>
            </div>
            <div
              v-if="view === 'ngrams'"
              role="group"
              :aria-label="t('searchTerms.ngramSize.label')"
              class="flex gap-space-xs"
            >
              <button
                v-for="size in [null, ...NGRAM_SIZES]"
                :key="size ?? 'all'"
                type="button"
                :aria-pressed="ngramSize === size"
                :class="[
                  'min-h-11 rounded-control px-space-sm py-space-xs text-body-sm transition-colors',
                  ngramSize === size
                    ? 'bg-violet-wash text-ink'
                    : 'text-ink-secondary hover:bg-violet-wash',
                ]"
                @click="ngramSize = size"
              >
                {{
                  size === null
                    ? t('searchTerms.ngramSize.all')
                    : t('searchTerms.ngramSize.n', size)
                }}
              </button>
            </div>
            <span class="flex-1" />
            <Button
              icon="pi pi-download"
              :label="t('explorer.exportCsv')"
              severity="secondary"
              size="small"
              :disabled="!canExport"
              @click="exportCsv"
            />
          </div>

          <template v-if="view === 'terms'">
            <p v-if="meta?.truncated" class="text-body-sm text-ink-secondary">
              {{
                t('searchTerms.truncated', {
                  max: count(meta.maxRows),
                  total: count(meta.totalRows),
                })
              }}
            </p>
            <p v-if="data.rows.length === 0" class="text-body-md text-ink-secondary">
              {{ t('searchTerms.noRows') }}
            </p>
            <p v-else-if="termRows.length === 0" class="text-body-md text-ink-secondary">
              {{
                t(
                  meta?.truncated
                    ? 'searchTerms.noRowsInClassTruncated'
                    : 'searchTerms.noRowsInClass',
                )
              }}
            </p>
            <template v-else>
              <div
                v-if="canSelect"
                role="toolbar"
                :aria-label="t('searchTerms.actions.toolbar')"
                class="flex flex-wrap items-center gap-space-sm"
              >
                <span class="font-data text-body-sm text-ink-secondary" aria-live="polite">
                  {{ t('explorer.bulk.selected', { count: count(selectedIds.length) }) }}
                </span>
                <Button
                  v-if="canWriteChanges"
                  icon="pi pi-ban"
                  :label="t('searchTerms.actions.negative')"
                  size="small"
                  severity="secondary"
                  :disabled="selectedTermRows.length === 0"
                  @click="openNegative(selectedTermRows)"
                />
                <Button
                  v-if="canWrite"
                  icon="pi pi-bookmark"
                  :label="t('searchTerms.actions.harvest')"
                  size="small"
                  severity="secondary"
                  :disabled="selectedTermRows.length === 0"
                  :loading="markHarvest.isPending.value"
                  @click="markForHarvest(selectedTermRows)"
                />
                <span v-if="selectedIds.length === 0" class="text-body-sm text-ink-secondary">
                  {{ t('searchTerms.actions.hint') }}
                </span>
              </div>
              <InlineError v-if="harvestErrorKey" :message="t(harvestErrorKey)" />
              <p
                v-if="harvestResult"
                data-harvest-result
                role="status"
                class="flex flex-wrap items-center gap-x-space-sm rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
              >
                <span>
                  <i class="pi pi-check-circle mr-space-xs text-lime-deep" aria-hidden="true" />{{
                    t(
                      'searchTerms.harvest.result.added',
                      { count: count(harvestResult.added) },
                      harvestResult.added,
                    )
                  }}
                </span>
                <span v-if="harvestResult.alreadyMarked > 0" class="text-ink-secondary">
                  {{
                    t(
                      'searchTerms.harvest.result.alreadyMarked',
                      { count: count(harvestResult.alreadyMarked) },
                      harvestResult.alreadyMarked,
                    )
                  }}
                </span>
                <span v-if="harvestResult.notFound > 0" class="text-ink-secondary">
                  {{
                    t(
                      'searchTerms.harvest.result.notFound',
                      { count: count(harvestResult.notFound) },
                      harvestResult.notFound,
                    )
                  }}
                </span>
                <button
                  type="button"
                  class="min-h-11 rounded-control px-space-sm font-medium text-violet hover:underline"
                  @click="setView('harvest')"
                >
                  {{ t('searchTerms.harvest.open') }}
                </button>
              </p>
              <SearchTermGrid
                ref="grid"
                :rows="termRows"
                :column-defs="termDefs"
                :total="total"
                :selectable="canSelect"
                @selection="(ids) => (selectedIds = ids)"
              />
            </template>
          </template>

          <template v-else-if="view === 'harvest'">
            <p class="max-w-prose text-body-sm text-ink-secondary">
              {{ t('searchTerms.harvest.hint') }}
            </p>
            <InlineError
              v-if="harvestList.isError.value"
              :message="t('searchTerms.harvest.error')"
              retryable
              :retrying="harvestList.isFetching.value"
              @retry="harvestList.refetch()"
            />
            <SkeletonBlock v-else-if="!harvestList.data.value" shape="tile" height="12rem" />
            <EmptyState
              v-else-if="harvestRows.length === 0"
              icon="bookmark"
              :title="t('searchTerms.harvest.empty.title')"
              :text="t('searchTerms.harvest.empty.text')"
            />
            <template v-else>
              <p v-if="harvestList.data.value.truncated" class="text-body-sm text-ink-secondary">
                {{
                  t('searchTerms.harvest.truncated', {
                    max: count(harvestList.data.value.maxMarks),
                  })
                }}
              </p>
              <div
                v-if="canWrite"
                role="toolbar"
                :aria-label="t('searchTerms.harvest.toolbar')"
                class="flex flex-wrap items-center gap-space-sm"
              >
                <span class="font-data text-body-sm text-ink-secondary" aria-live="polite">
                  {{ t('explorer.bulk.selected', { count: count(selectedIds.length) }) }}
                </span>
                <Button
                  icon="pi pi-trash"
                  :label="t('searchTerms.harvest.remove')"
                  size="small"
                  severity="secondary"
                  :disabled="selectedIds.length === 0"
                  :loading="removeHarvest.isPending.value"
                  @click="removeSelectedMarks"
                />
              </div>
              <InlineError v-if="harvestErrorKey" :message="t(harvestErrorKey)" />
              <SearchTermGrid
                ref="grid"
                :rows="harvestRows"
                :column-defs="harvestDefs"
                :selectable="canWrite"
                @selection="(ids) => (selectedIds = ids)"
              />
            </template>
          </template>

          <template v-else>
            <p class="max-w-prose text-body-sm text-ink-secondary">
              {{ t('searchTerms.ngramHint') }}
            </p>
            <p v-if="meta?.ngramsTruncated" class="text-body-sm text-ink-secondary">
              {{
                t('searchTerms.ngramsTruncated', {
                  max: count(meta.maxNgrams),
                  total: count(meta.totalNgrams),
                })
              }}
            </p>
            <p v-if="ngramRows.length === 0" class="text-body-md text-ink-secondary">
              {{ t('searchTerms.noRows') }}
            </p>
            <SearchTermGrid v-else ref="grid" :rows="ngramRows" :column-defs="ngramDefs" />
          </template>
        </section>
      </template>

      <NegativeDialog
        v-if="canWriteChanges"
        :visible="negativeOpen"
        :rows="negativeRows"
        @close="negativeOpen = false"
        @staged="clearSelection"
      />
      <RulesDialog
        v-if="meta && canWrite"
        :visible="rulesOpen"
        :rules="meta.organizationRules"
        :overrides="meta.ruleOverrides"
        :profile-id="meta.profileId"
        :profile-label="`${meta.accountName} · ${meta.countryCode}`"
        :currency="currency"
        @close="rulesOpen = false"
        @saved="onRulesSaved"
      />
    </template>

    <!-- Außerhalb der Zustände: Nach dem letzten Zeitraum (Leerzustand) schließt der Dialog noch regulär. -->
    <DeletePeriodDialog
      v-if="canDeletePeriod"
      :visible="deleteOpen"
      :period="periodToDelete"
      @close="deleteOpen = false"
      @deleted="onPeriodDeleted"
    />
  </div>
</template>
