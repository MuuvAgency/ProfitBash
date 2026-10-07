<script setup lang="ts">
import { formatDate } from '@profitbash/shared';
import { computed } from 'vue';
import { useSessionStore } from '../../stores/session';
import { useFileStalenessHints } from '../staleness';
import type { ProfileCellParams } from './types';

/** „Letzter Import“ eines Profils ohne Connection mit Hinweisen auf veraltete Daten (1.11f). */
const props = defineProps<{ params: ProfileCellParams }>();
const session = useSessionStore();

const profile = computed(() => props.params.data);
const hints = useFileStalenessHints(() => profile.value ?? null);
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
