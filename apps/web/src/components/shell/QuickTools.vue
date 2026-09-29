<script setup lang="ts">
import Popover from 'primevue/popover';
import { computed, ref, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import AsinTool from '../../asin/AsinTool.vue';
import { useSessionStore } from '../../stores/session';

defineProps<{ collapsed?: boolean; variant?: 'panel' | 'bar' }>();

const { t } = useI18n();
const popover = useTemplateRef<InstanceType<typeof Popover>>('popover');
const open = ref(false);
const session = useSessionStore();
/** Das ASIN-Tool hängt am Feature des Explorers (`plan.md` §3). */
const asinTool = computed(() => session.me?.features['sp-explorer']?.view ?? false);
</script>

<template>
  <div>
    <button
      v-tooltip.right="collapsed ? t('quickTools.button') : undefined"
      type="button"
      :aria-label="t('quickTools.button')"
      aria-haspopup="dialog"
      :aria-expanded="open"
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
    <Popover
      ref="popover"
      :aria-label="t('quickTools.title')"
      @show="open = true"
      @hide="open = false"
    >
      <div
        v-if="asinTool"
        class="flex w-[min(28rem,calc(100vw-3rem))] flex-col gap-space-sm p-space-xs"
      >
        <h2 class="text-headline-sm text-ink">{{ t('asinTool.title') }}</h2>
        <AsinTool @navigate="popover?.hide()" />
      </div>
      <div v-else class="flex max-w-xs flex-col gap-space-xs p-space-xs">
        <h2 class="text-headline-sm text-ink">{{ t('quickTools.title') }}</h2>
        <p class="text-body-sm text-ink-secondary">{{ t('quickTools.empty') }}</p>
      </div>
    </Popover>
  </div>
</template>
