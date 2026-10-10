<script setup lang="ts">
import { formatDateTime, formatDay, formatNumber } from '@profitbash/shared';
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/** Tab „Läufe“ (`phase-5.md` 5.8): je Lauf Profil, Datenstand, Modus, Zähler und Hinweise. */
const { t, te } = useI18n();
const session = useSessionStore();
const orgId = useActiveOrgId();
const locale = computed(() => session.preferences.locale);
const query = useQuery({
  queryKey: computed(() => ['automation-runs', orgId.value] as const),
  queryFn: () => api.automations.runs(),
  enabled: computed(() => orgId.value !== null),
});
const runs = computed(() => query.data.value);
const counted = (key: string, n: number | undefined) =>
  t(`automations.runs.${key}`, { n: formatNumber(n ?? 0, locale.value) }, n ?? 0);
const warning = (code: string) =>
  te(`automations.runs.warning.${code}`) ? t(`automations.runs.warning.${code}`) : code;
</script>

<template>
  <InlineError
    v-if="query.isError.value && !runs"
    :message="t('automations.runs.loadFailed')"
    retryable
    :retrying="query.isFetching.value"
    @retry="query.refetch()"
  />
  <SkeletonBlock v-else-if="!runs" shape="tile" height="16rem" />
  <EmptyState
    v-else-if="runs.length === 0"
    icon="history"
    :title="t('automations.runs.empty.title')"
    :text="t('automations.runs.empty.text')"
  />
  <section
    v-else
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <div class="flex flex-col gap-space-xs">
      <h2 class="text-headline-sm text-ink">{{ t('automations.runs.title') }}</h2>
      <p class="max-w-prose text-body-sm text-ink-secondary">{{ t('automations.runs.text') }}</p>
    </div>
    <ul class="flex flex-col">
      <li
        v-for="run in runs"
        :key="run.id"
        :data-run-row="run.id"
        class="flex flex-col gap-space-xs border-b border-line py-space-sm last:border-b-0"
      >
        <div class="flex flex-wrap items-baseline justify-between gap-x-space-md">
          <span class="min-w-0 truncate text-body-md text-ink">{{ run.accountName }}</span>
          <time :datetime="run.createdAt" class="font-data text-body-sm text-ink-secondary">
            {{ formatDateTime(run.createdAt, locale) }}
          </time>
        </div>
        <span class="text-body-sm text-ink-secondary">
          {{ t(`automations.mode.${run.mode}.label`) }} ·
          <span class="font-data">
            {{
              t('automations.runs.period', {
                start: formatDay(run.periodStart, locale),
                end: formatDay(run.periodEnd, locale),
              })
            }}
          </span>
          ·
          <span class="font-data">
            {{
              t('automations.runs.importedAt', {
                date: formatDateTime(run.metricsImportedAt, locale),
              })
            }}
          </span>
        </span>
        <span class="font-data text-body-sm text-ink">
          {{ t('automations.runs.checked') }}
          {{ counted('targets', run.counts.targets) }},
          {{ counted('campaigns', run.counts.campaigns) }} →
          {{ counted('proposals', run.counts.proposals) }}
          <template v-if="run.counts.staged">, {{ counted('staged', run.counts.staged) }}</template>
          <template v-if="run.counts.dismissed">
            , {{ counted('dismissed', run.counts.dismissed) }}
          </template>
        </span>
        <p v-for="code in run.warnings" :key="code" class="text-body-sm text-warn">
          {{ warning(code) }}
        </p>
      </li>
    </ul>
  </section>
</template>
