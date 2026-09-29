<script setup lang="ts">
import Popover from 'primevue/popover';
import { ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProfileCellParams } from './types';

defineProps<{ params: ProfileCellParams }>();
const { t } = useI18n();
const popover = ref<InstanceType<typeof Popover>>();
const open = ref(false);
</script>

<!--
  Kontoname bricht um statt gekürzt zu werden (F14). „Entfernt“ erklärt sich per Klick im Popover statt im Tooltip,
  damit der Text auch auf Touch lesbar ist.
-->
<template>
  <div v-if="params.data" class="flex min-h-[52px] w-full min-w-0 items-center gap-space-sm py-2">
    <span data-wrap class="min-w-0 whitespace-normal wrap-break-word">{{
      params.data.accountName
    }}</span>
    <template v-if="params.data.removedAt">
      <button
        type="button"
        class="inline-flex shrink-0 items-center gap-1 rounded-full bg-loss-wash px-2 text-label-eyebrow uppercase text-on-loss-wash hover:underline focus-visible:outline-2 focus-visible:outline-violet"
        aria-haspopup="dialog"
        :aria-expanded="open"
        @click="popover?.toggle($event)"
      >
        <span class="size-1.5 rounded-full bg-loss" aria-hidden="true" />
        {{ t('connections.profiles.removed') }}
      </button>
      <Popover ref="popover" @show="open = true" @hide="open = false">
        <p class="max-w-xs text-body-sm text-ink-secondary">
          {{ t('connections.profiles.removedHint') }}
        </p>
      </Popover>
    </template>
  </div>
</template>
