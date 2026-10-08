<script setup lang="ts">
import { formatDay, formatNumber } from '@profitbash/shared';
import { useMutation } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import type { SearchTermPeriodData } from '../api/client';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';

/**
 * Einen Datei-Zeitraum der Suchbegriff-Analyse löschen (`phase-2b.md` 2b.2d, Recht „write“ im Explorer): Ein beim
 * Upload falsch angegebener Zeitraum bliebe sonst für immer in der Auswahl. Gelöscht werden nur die Suchbegriffe
 * dieses Zeitraums; die Datei lässt sich erneut hochladen.
 */
const props = defineProps<{ visible: boolean; period: SearchTermPeriodData | null }>();
const emit = defineEmits<{ close: []; deleted: [period: SearchTermPeriodData] }>();

const { t } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const errorKey = ref<string | null>(null);

const remove = useMutation({
  mutationFn: (period: SearchTermPeriodData) =>
    api.searchTerms.deletePeriod({
      profileId: period.profileId,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
    }),
});

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    errorKey.value = null;
    remove.reset();
  },
  { immediate: true },
);

async function confirm() {
  const period = props.period;
  if (!period) return;
  errorKey.value = null;
  try {
    await remove.mutateAsync(period);
    emit('deleted', period);
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :closable="!remove.isPending.value"
    :close-on-escape="!remove.isPending.value"
    :header="t('searchTerms.deletePeriod.title')"
    :style="{ width: 'min(32rem, calc(100vw - 2rem))' }"
    @update:visible="(next) => !next && emit('close')"
  >
    <div v-if="period" class="flex flex-col gap-space-lg">
      <InlineError v-if="errorKey" :message="t(errorKey)" />
      <dl class="flex flex-col gap-space-sm">
        <div>
          <dt class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('searchTerms.profile') }}
          </dt>
          <dd class="text-body-md text-ink">{{ period.accountName }} · {{ period.countryCode }}</dd>
        </div>
        <div>
          <dt class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('searchTerms.period') }}
          </dt>
          <dd class="font-data text-body-md text-ink">
            {{ formatDay(period.periodStart, locale) }} – {{ formatDay(period.periodEnd, locale) }}
            ·
            {{
              t('searchTerms.deletePeriod.rows', {
                rows: formatNumber(String(period.rows), locale),
              })
            }}
          </dd>
        </div>
      </dl>
      <p class="text-body-sm text-ink-secondary">{{ t('searchTerms.deletePeriod.text') }}</p>
      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('common.cancel')"
          severity="secondary"
          variant="text"
          :disabled="remove.isPending.value"
          @click="emit('close')"
        />
        <Button
          type="button"
          :label="t('searchTerms.deletePeriod.confirm')"
          severity="danger"
          :loading="remove.isPending.value"
          @click="confirm"
        />
      </div>
    </div>
  </Dialog>
</template>
