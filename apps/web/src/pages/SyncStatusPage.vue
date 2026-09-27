<script setup lang="ts">
import {
  CONNECTION_JOB_NAMES,
  JOB_RUN_LIST_LIMIT,
  JOB_RUN_STATUSES,
  type ConnectionJobName,
  type JobRunListQuery,
  type JobRunStatus,
} from '@profitbash/shared';
import Button from 'primevue/button';
import Select from 'primevue/select';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter, type LocationQueryValue } from 'vue-router';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import JobRunGrid from '../sync/JobRunGrid.vue';
import { useJobRunsQuery } from '../sync/queries';

const { t } = useI18n();
const route = useRoute();
const router = useRouter();

// --- Filter (in der URL, damit Links wie „Sync eingeplant“ gefiltert öffnen) -----------------

function queryValue<T extends string>(
  value: LocationQueryValue | LocationQueryValue[] | undefined,
  allowed: readonly T[],
): T | undefined {
  // Unbekannte Werte (alte Links, Tippfehler) gelten als „Alle“.
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

const filters = computed<JobRunListQuery>(() => {
  const job = queryValue<ConnectionJobName>(route.query.job, CONNECTION_JOB_NAMES);
  const status = queryValue<JobRunStatus>(route.query.status, JOB_RUN_STATUSES);
  return { ...(job && { job }), ...(status && { status }) };
});
const hasFilter = computed(() => Object.keys(filters.value).length > 0);

function setFilter(name: keyof JobRunListQuery, value: string | null) {
  const query = { ...route.query };
  if (value) query[name] = value;
  else delete query[name];
  void router.replace({ query });
}

function resetFilters() {
  const query = { ...route.query };
  delete query.job;
  delete query.status;
  void router.replace({ query });
}

const jobOptions = computed(() => [
  { value: null, label: t('sync.filter.all') },
  ...CONNECTION_JOB_NAMES.map((job) => ({ value: job, label: t(`sync.job.${job}`) })),
]);
const statusOptions = computed(() => [
  { value: null, label: t('sync.filter.all') },
  ...JOB_RUN_STATUSES.map((status) => ({ value: status, label: t(`sync.status.${status}`) })),
]);

// --- Daten --------------------------------------------------------------------------------

const runsQuery = useJobRunsQuery(filters);
const runs = computed(() => runsQuery.data.value ?? []);
/** Nur Daten dieses Filters (Platzhalter aus dem vorigen Filter gibt es im Fehlerfall nicht). */
const hasData = computed(() => runsQuery.data.value !== undefined);

/** Nur „Aktualisieren“ zeigt den Ladezustand, das Nachfragen im Hintergrund nicht. */
const refreshing = ref(false);
async function refresh() {
  refreshing.value = true;
  try {
    await runsQuery.refetch();
  } finally {
    refreshing.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-space-xl">
    <PageHeader
      :title="t('nav.sync')"
      :eyebrow="t('sync.eyebrow')"
      :description="t('sync.description', { limit: JOB_RUN_LIST_LIMIT })"
    >
      <template #actions>
        <Button
          :label="t('sync.refresh')"
          icon="pi pi-refresh"
          severity="secondary"
          variant="outlined"
          :loading="refreshing"
          :disabled="runsQuery.isPending.value"
          @click="refresh"
        />
      </template>
    </PageHeader>

    <div class="flex flex-wrap items-end gap-space-md">
      <div class="flex w-full flex-col gap-space-xs sm:w-56">
        <label id="sync-filter-job-label" class="text-body-sm text-ink-secondary">
          {{ t('sync.filter.job') }}
        </label>
        <Select
          :model-value="filters.job ?? null"
          :options="jobOptions"
          option-label="label"
          option-value="value"
          :placeholder="t('sync.filter.all')"
          aria-labelledby="sync-filter-job-label"
          size="small"
          fluid
          @update:model-value="(value: string | null) => setFilter('job', value)"
        />
      </div>
      <div class="flex w-full flex-col gap-space-xs sm:w-56">
        <label id="sync-filter-status-label" class="text-body-sm text-ink-secondary">
          {{ t('sync.filter.status') }}
        </label>
        <Select
          :model-value="filters.status ?? null"
          :options="statusOptions"
          option-label="label"
          option-value="value"
          :placeholder="t('sync.filter.all')"
          aria-labelledby="sync-filter-status-label"
          size="small"
          fluid
          @update:model-value="(value: string | null) => setFilter('status', value)"
        />
      </div>
    </div>

    <!-- Bereits geladene Läufe bleiben stehen, wenn das Nachladen scheitert. -->
    <InlineError
      v-if="runsQuery.isError.value && hasData"
      :message="t('sync.refreshError')"
      retryable
      :retrying="runsQuery.isFetching.value"
      @retry="runsQuery.refetch()"
    />

    <div v-if="runsQuery.isPending.value" aria-busy="true">
      <SkeletonBlock shape="tile" height="16rem" />
    </div>

    <InlineError
      v-else-if="runsQuery.isError.value && !hasData"
      :message="t('sync.loadError')"
      retryable
      :retrying="runsQuery.isFetching.value"
      @retry="runsQuery.refetch()"
    />

    <section
      v-else-if="runs.length === 0 && hasFilter"
      class="flex flex-col items-start gap-space-md rounded-tile bg-tile p-space-lg shadow-tile"
    >
      <p class="text-body-md text-ink-secondary">{{ t('sync.emptyFiltered') }}</p>
      <Button
        :label="t('sync.filter.reset')"
        severity="secondary"
        variant="outlined"
        size="small"
        @click="resetFilters"
      />
    </section>

    <EmptyState
      v-else-if="runs.length === 0"
      icon="history"
      :title="t('sync.emptyTitle')"
      :text="t('sync.emptyText')"
    />

    <!-- Mindestbreite = Summe der Mindestbreiten der Spalten (JobRunGrid): darunter scrollt die Tabelle. -->
    <section
      v-else
      class="overflow-x-auto rounded-tile bg-tile shadow-tile"
      role="region"
      :aria-label="t('sync.label')"
    >
      <JobRunGrid class="min-w-[1090px]" :runs="runs" />
    </section>
  </div>
</template>
