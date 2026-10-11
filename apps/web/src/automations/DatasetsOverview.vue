<script setup lang="ts">
import { BULK_FILE_STALE_DAYS, formatDay, formatNumber } from '@profitbash/shared';
import { useQuery } from '@tanstack/vue-query';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import type { AutomationDatasetData } from '../api/client';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Abschnitt „Datensätze je Profil“ im Tab „Läufe“ (`phase-5.md` 5.13b): was die Automatik erwartet, was vorliegt
 * und was fehlt. Der Lauf überspringt nur, wofür Daten fehlen (ADR 006).
 */
// Dominiks wöchentlicher Download deckt die letzten 30 Tage ab (`phase-5.md` F2); kürzere Dateien gehen auch.
const RECOMMENDED_PERIOD_DAYS = 30;

const { t } = useI18n();
const session = useSessionStore();
const orgId = useActiveOrgId();
const locale = computed(() => session.preferences.locale);
const query = useQuery({
  queryKey: computed(() => ['automation-datasets', orgId.value] as const),
  queryFn: () => api.automations.datasets(),
  enabled: computed(() => orgId.value !== null),
});
const profiles = computed(() => query.data.value);
const names = (adProducts: string[]) =>
  adProducts.map((adProduct) => t(`analytics.adProduct.${adProduct}`)).join(', ');
const missing = (profile: AutomationDatasetData) =>
  profile.expectedAdProducts.filter(
    (adProduct) => !profile.metrics?.adProducts.includes(adProduct),
  );
const days = (n: number) => t('automations.datasets.days', { n: formatNumber(n, locale.value) }, n);
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <div class="flex flex-col gap-space-xs">
      <h2 class="text-headline-sm text-ink">{{ t('automations.datasets.title') }}</h2>
      <p class="max-w-prose text-body-sm text-ink-secondary">
        {{ t('automations.datasets.text') }}
      </p>
    </div>
    <InlineError
      v-if="query.isError.value && !profiles"
      :message="t('automations.datasets.loadFailed')"
      retryable
      :retrying="query.isFetching.value"
      @retry="query.refetch()"
    />
    <SkeletonBlock v-else-if="!profiles" shape="tile" height="6rem" />
    <p v-else-if="profiles.length === 0" class="text-body-sm text-ink-secondary">
      {{ t('automations.datasets.empty') }}
    </p>
    <ul v-else class="flex flex-col">
      <li
        v-for="profile in profiles"
        :key="profile.profileId"
        :data-dataset-row="profile.profileId"
        class="flex flex-col gap-space-xs border-b border-line py-space-sm last:border-b-0"
      >
        <span class="min-w-0 truncate text-body-md text-ink">{{ profile.accountName }}</span>
        <p v-if="!profile.metrics" class="text-body-sm text-warn">
          {{ t('automations.datasets.none') }}
        </p>
        <template v-else>
          <span class="text-body-sm text-ink-secondary">
            {{ t('automations.datasets.metrics') }} {{ names(profile.metrics.adProducts) }}
          </span>
          <p v-if="missing(profile).length > 0" class="text-body-sm text-warn">
            {{ t('automations.datasets.missingMetrics', { adProducts: names(missing(profile)) }) }}
          </p>
          <span
            v-if="profile.metrics.searchTermAdProducts.length > 0"
            class="text-body-sm text-ink-secondary"
          >
            {{ t('automations.datasets.searchTerms') }}
            {{ names(profile.metrics.searchTermAdProducts) }}
          </span>
          <p v-else class="text-body-sm text-warn">
            {{ t('automations.datasets.missingSearchTerms') }}
          </p>
          <span class="text-body-sm text-ink-secondary">
            {{ t('automations.datasets.period') }}
            <span class="font-data">
              {{ formatDay(profile.metrics.periodStart, locale) }} –
              {{ formatDay(profile.metrics.periodEnd, locale) }} ({{
                days(profile.metrics.periodDays)
              }})
            </span>
            <span v-if="profile.metrics.periodDays < RECOMMENDED_PERIOD_DAYS" class="text-warn">
              · {{ t('automations.datasets.shortPeriod', { n: RECOMMENDED_PERIOD_DAYS }) }}
            </span>
          </span>
          <span class="text-body-sm text-ink-secondary">
            {{ t('automations.datasets.uploaded') }}
            <span class="font-data">
              {{
                t(
                  'automations.datasets.age',
                  { n: formatNumber(profile.metrics.ageDays, locale) },
                  profile.metrics.ageDays,
                )
              }}
            </span>
            <span v-if="profile.metrics.ageDays >= BULK_FILE_STALE_DAYS" class="text-warn">
              · {{ t('automations.datasets.stale', { n: BULK_FILE_STALE_DAYS }) }}
            </span>
          </span>
        </template>
      </li>
    </ul>
  </section>
</template>
