<script setup lang="ts">
import { useI18n } from 'vue-i18n';

withDefaults(defineProps<{ size?: 'md' | 'lg'; compact?: boolean }>(), {
  size: 'md',
  compact: false,
});

const { t } = useI18n();
</script>

<template>
  <span class="inline-flex items-center gap-space-xs">
    <span
      :class="[
        'font-bold uppercase tracking-tight',
        size === 'lg' ? 'text-headline-lg' : 'text-headline-sm',
        compact ? 'sr-only' : '',
      ]"
      >{{ t('app.name') }}</span
    >
    <span class="size-2 shrink-0 rounded-full bg-lime" aria-hidden="true" />
  </span>
</template>
