<script setup lang="ts">
import Popover from 'primevue/popover';
import { useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';

defineProps<{ collapsed?: boolean; variant?: 'panel' | 'bar' }>();

const { t } = useI18n();
const popover = useTemplateRef<InstanceType<typeof Popover>>('popover');
</script>

<template>
  <div>
    <button
      v-tooltip.right="collapsed ? t('quickTools.button') : undefined"
      type="button"
      :aria-label="t('quickTools.button')"
      aria-haspopup="dialog"
      :class="[
        'flex items-center gap-space-sm rounded-control p-space-sm text-body-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet',
        variant === 'bar'
          ? 'text-ink-secondary hover:bg-well hover:text-ink'
          : 'w-full text-on-panel/70 hover:bg-on-panel/10 hover:text-on-panel',
        collapsed ? 'justify-center' : 'px-space-md',
      ]"
      @click="popover?.toggle($event)"
    >
      <i class="pi pi-briefcase shrink-0 text-body-lg" aria-hidden="true" />
      <span v-if="!collapsed && variant !== 'bar'">{{ t('quickTools.button') }}</span>
    </button>
    <Popover ref="popover" :aria-label="t('quickTools.title')">
      <div class="flex max-w-xs flex-col gap-space-xs p-space-xs">
        <h2 class="text-headline-sm text-ink">{{ t('quickTools.title') }}</h2>
        <p class="text-body-sm text-ink-secondary">{{ t('quickTools.empty') }}</p>
      </div>
    </Popover>
  </div>
</template>
