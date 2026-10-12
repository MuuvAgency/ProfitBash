<script setup lang="ts">
import { formatDateTime, type AuditEvent, type AuditEventListQuery } from '@profitbash/shared';
import { useInfiniteQuery, useQuery } from '@tanstack/vue-query';
import Button from 'primevue/button';
import DatePicker from 'primevue/datepicker';
import Select from 'primevue/select';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute, useRouter } from 'vue-router';
import { api } from '../api';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/** Audit-Log der aktiven Organisation (`phase-6.md` 6.1), nur Org-Admins. */

const { t, te } = useI18n();
const route = useRoute();
const router = useRouter();
const orgId = useActiveOrgId();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);

// --- Filter (in der URL, damit sich ein gefiltertes Log verlinken lässt) -------------------

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const AREA = /^[a-z_]{1,64}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const FILTER_KEYS = ['area', 'actor', 'from', 'to'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
const PATTERNS: Record<FilterKey, RegExp> = { area: AREA, actor: UUID, from: DAY, to: DAY };

/** Ungültige Werte (alte Links, Tippfehler) gelten als „Alle“. */
const filters = computed(() => {
  const result: Partial<Record<FilterKey, string>> = {};
  for (const key of FILTER_KEYS) {
    const value = route.query[key];
    if (typeof value === 'string' && PATTERNS[key].test(value)) result[key] = value;
  }
  return result;
});
const hasFilter = computed(() => Object.keys(filters.value).length > 0);

function setFilters(patch: Partial<Record<FilterKey, string | null>>) {
  const query = { ...route.query };
  for (const [key, value] of Object.entries(patch)) {
    if (value) query[key] = value;
    else delete query[key];
  }
  void router.replace({ query });
}
const resetFilters = () => setFilters({ area: null, actor: null, from: null, to: null });

/** Kalendertag in der Zeitzone des Browsers; `addDays: 1` macht aus dem letzten Tag die offene Obergrenze. */
function localDay(day: string, addDays = 0): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date + addDays);
}
const toDay = (date: Date) =>
  [date.getFullYear(), date.getMonth() + 1, date.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');

const apiQuery = computed<AuditEventListQuery>(() => {
  const { area, actor, from, to } = filters.value;
  return {
    ...(area && { area }),
    ...(actor && { actorUserId: actor }),
    ...(from && { from: localDay(from).toISOString() }),
    ...(to && { to: localDay(to, 1).toISOString() }),
  };
});

const pickerValue = computed(() => {
  const { from, to } = filters.value;
  return from ? [localDay(from), to ? localDay(to) : null] : null;
});
function onRangeChange(value: unknown) {
  if (!Array.isArray(value)) return setFilters({ from: null, to: null });
  const [from, to] = value as (Date | null)[];
  // Erst mit beiden Enden übernehmen, sonst stünde ein halber Zeitraum in der URL.
  if (from && to) setFilters({ from: toDay(from), to: toDay(to) });
}

// --- Daten ---------------------------------------------------------------------------------

const enabled = computed(() => orgId.value !== null);
const filterOptions = useQuery({
  queryKey: computed(() => ['audit-events', orgId.value, 'filters'] as const),
  queryFn: () => api.auditEvents.filters(),
  enabled,
});
const pages = useInfiniteQuery({
  queryKey: computed(() => ['audit-events', orgId.value, 'list', apiQuery.value] as const),
  queryFn: ({ pageParam }) =>
    api.auditEvents.list({ ...apiQuery.value, ...(pageParam !== null && { cursor: pageParam }) }),
  initialPageParam: null as string | null,
  getNextPageParam: (last) => last.nextCursor,
  enabled,
  // Beim Öffnen immer neu laden: Das Log soll den Stand von jetzt zeigen.
  staleTime: 0,
});
const events = computed(() => pages.data.value?.pages.flatMap((page) => page.events) ?? []);

/** Bekannte Schlüssel als Text, neue unverändert (die API kennt keine feste Liste). */
const label = (group: 'area' | 'action', key: string) => {
  const path = `audit.${group}.${key.replace('.', ':')}`;
  return te(path) ? t(path) : key;
};

const areaOptions = computed(() =>
  (filterOptions.data.value?.areas ?? []).map((area) => ({
    value: area,
    label: label('area', area),
  })),
);
const actorOptions = computed(() =>
  (filterOptions.data.value?.actors ?? []).map((actor) => ({
    value: actor.id,
    label: `${actor.name} (${actor.email})`,
  })),
);

/**
 * Aktion aus einer Impersonation (6.5): Handelnder ist der Superadmin, das `target` nennt den Nutzer. Dessen Name
 * ist nur bekannt, wenn er selbst im Log vorkommt.
 */
function impersonatedAs(target: AuditEvent['target']): string | null {
  const userId = target.impersonatedUserId;
  if (typeof userId !== 'string') return null;
  const user = filterOptions.data.value?.actors.find((actor) => actor.id === userId);
  return user ? t('audit.impersonatedAs', { name: user.name }) : t('audit.impersonatedAsUnknown');
}

/** Kurzbeschreibung des Objekts, soweit es einen Namen hat; alles Weitere steht in den Details. */
function targetSummary(target: AuditEvent['target']): string {
  for (const key of ['name', 'email', 'fileName']) {
    const value = target[key];
    if (typeof value === 'string' && value !== '') return value;
  }
  return '';
}
</script>

<template>
  <div class="flex flex-col gap-space-xl">
    <PageHeader
      :title="t('nav.audit')"
      :eyebrow="t('audit.eyebrow')"
      :description="t('audit.description')"
    />

    <div class="flex flex-wrap items-end gap-space-md">
      <div class="flex w-full flex-col gap-space-xs sm:w-56">
        <span id="audit-filter-area" class="text-body-sm text-ink-secondary">
          {{ t('audit.filter.area') }}
        </span>
        <Select
          :model-value="filters.area ?? null"
          :options="areaOptions"
          option-label="label"
          option-value="value"
          :placeholder="t('audit.filter.all')"
          aria-labelledby="audit-filter-area"
          show-clear
          size="small"
          fluid
          @update:model-value="(value: string | null) => setFilters({ area: value })"
        />
      </div>
      <div class="flex w-full flex-col gap-space-xs sm:w-72">
        <span id="audit-filter-actor" class="text-body-sm text-ink-secondary">
          {{ t('audit.filter.actor') }}
        </span>
        <Select
          :model-value="filters.actor ?? null"
          :options="actorOptions"
          option-label="label"
          option-value="value"
          :placeholder="t('audit.filter.all')"
          aria-labelledby="audit-filter-actor"
          show-clear
          size="small"
          fluid
          @update:model-value="(value: string | null) => setFilters({ actor: value })"
        />
      </div>
      <div class="flex w-full flex-col gap-space-xs sm:w-60">
        <label for="audit-filter-range" class="text-body-sm text-ink-secondary">
          {{ t('audit.filter.range') }}
        </label>
        <DatePicker
          input-id="audit-filter-range"
          :model-value="pickerValue"
          selection-mode="range"
          :manual-input="false"
          :max-date="new Date()"
          :placeholder="t('audit.filter.all')"
          date-format="dd.mm.yy"
          show-button-bar
          size="small"
          fluid
          @update:model-value="onRangeChange"
        />
      </div>
    </div>

    <InlineError
      v-if="pages.isError.value && events.length === 0"
      :message="t('audit.loadError')"
      retryable
      :retrying="pages.isFetching.value"
      @retry="pages.refetch()"
    />

    <div v-else-if="pages.isPending.value && orgId !== null" role="status" aria-busy="true">
      <span class="sr-only">{{ t('common.loading') }}</span>
      <SkeletonBlock shape="tile" height="16rem" />
    </div>

    <section
      v-else-if="events.length === 0 && hasFilter"
      class="flex flex-col items-start gap-space-md rounded-tile bg-tile p-space-lg shadow-tile"
    >
      <p class="text-body-md text-ink-secondary">{{ t('audit.emptyFiltered') }}</p>
      <Button
        :label="t('audit.filter.reset')"
        severity="secondary"
        variant="outlined"
        size="small"
        @click="resetFilters"
      />
    </section>

    <EmptyState
      v-else-if="events.length === 0"
      icon="history"
      :title="t('audit.emptyTitle')"
      :text="t('audit.emptyText')"
    />

    <section v-else class="rounded-tile bg-tile shadow-tile" :aria-label="t('audit.label')">
      <ul class="flex flex-col divide-y divide-line">
        <li
          v-for="event in events"
          :key="event.id"
          data-audit-event
          class="grid gap-x-space-md gap-y-space-xs p-space-md md:grid-cols-[13rem_14rem_1fr]"
        >
          <span class="font-data text-body-sm text-ink-secondary">
            {{ formatDateTime(event.createdAt, locale) }}
          </span>
          <span class="min-w-0 truncate text-body-sm" :title="event.actor?.email">
            {{ event.actor?.name ?? t('audit.system') }}
          </span>
          <div class="flex min-w-0 flex-col gap-space-xs">
            <span class="text-body-md">
              {{ label('action', event.action) }}
              <span v-if="targetSummary(event.target)" class="text-ink-secondary">
                · {{ targetSummary(event.target) }}
              </span>
              <span
                v-if="impersonatedAs(event.target)"
                data-audit-impersonated
                class="text-ink-secondary"
              >
                · {{ impersonatedAs(event.target) }}
              </span>
            </span>
            <details>
              <summary class="cursor-pointer text-body-sm text-ink-secondary">
                {{ t('audit.details') }}
              </summary>
              <pre
                class="mt-space-xs overflow-x-auto rounded-control bg-well p-space-sm font-data text-body-sm"
                >{{ JSON.stringify(event.target, null, 2) }}</pre>
            </details>
          </div>
        </li>
      </ul>
      <div v-if="pages.hasNextPage.value" class="flex justify-center p-space-sm">
        <Button
          :label="t('audit.loadMore')"
          variant="text"
          size="small"
          :loading="pages.isFetchingNextPage.value"
          @click="pages.fetchNextPage()"
        />
      </div>
      <InlineError v-if="pages.isError.value" :message="t('audit.loadError')" />
    </section>
  </div>
</template>
