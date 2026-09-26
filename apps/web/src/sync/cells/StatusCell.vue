<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { JobRunCellParams } from './types';

defineProps<{ params: JobRunCellParams }>();
const { t } = useI18n();

const DOT = { running: 'bg-violet animate-pulse', success: 'bg-lime', failed: 'bg-loss' } as const;
</script>

<template>
  <span v-if="params.data" class="inline-flex items-center gap-1.5">
    <span :class="['size-2 shrink-0 rounded-full', DOT[params.data.status]]" aria-hidden="true" />
    {{ t(`sync.status.${params.data.status}`) }}
  </span>
</template>
