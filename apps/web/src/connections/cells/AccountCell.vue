<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import type { ProfileCellParams } from './types';

defineProps<{ params: ProfileCellParams }>();
const { t } = useI18n();
</script>

<template>
  <span v-if="params.data" class="flex min-w-0 items-center gap-space-sm">
    <span class="truncate">{{ params.data.accountName }}</span>
    <span
      v-if="params.data.removedAt"
      v-tooltip.top="t('connections.profiles.removedHint')"
      class="inline-flex shrink-0 items-center gap-1 rounded-full bg-loss-wash px-2 text-label-eyebrow uppercase text-on-loss-wash"
    >
      <span class="size-1.5 rounded-full bg-loss" aria-hidden="true" />
      {{ t('connections.profiles.removed') }}
    </span>
  </span>
</template>
