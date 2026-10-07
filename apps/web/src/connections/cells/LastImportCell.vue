<script setup lang="ts">
import {
  FILE_BULK_STALE_AFTER_DAYS,
  FILE_METRICS_STALE_AFTER_DAYS,
  fileDataStaleness,
  formatDate,
} from '@profitbash/shared';
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from '../../stores/session';
import type { ProfileCellParams } from './types';

/** „Letzter Import“ eines Profils ohne Connection mit Hinweisen auf veraltete Daten (1.11f). */
const props = defineProps<{ params: ProfileCellParams }>();
const { t } = useI18n();
const session = useSessionStore();

const profile = computed(() => props.params.data);
// Stand beim Anzeigen (`new Date()` ist nicht reaktiv); die Liste lädt nach jedem Upload neu.
const hints = computed(() => {
  if (!profile.value) return [];
  return fileDataStaleness(profile.value, new Date()).map((hint) =>
    hint === 'noBulk'
      ? t('connections.fileProfiles.noBulk')
      : hint === 'bulkStale'
        ? t('connections.fileProfiles.bulkStale', { days: FILE_BULK_STALE_AFTER_DAYS })
        : t('connections.fileProfiles.metricsStale', { days: FILE_METRICS_STALE_AFTER_DAYS }),
  );
});
</script>

<template>
  <div v-if="profile" class="flex flex-col gap-0.5 py-1">
    <span v-if="profile.lastBulkImportAt" class="font-data">
      {{ formatDate(profile.lastBulkImportAt, session.preferences.locale) }}
    </span>
    <span
      v-for="hint in hints"
      :key="hint"
      class="flex items-start gap-1 text-body-sm text-ink"
      data-testid="stale-hint"
    >
      <i class="pi pi-exclamation-triangle mt-0.5 text-warn" aria-hidden="true" />
      {{ hint }}
    </span>
  </div>
</template>
