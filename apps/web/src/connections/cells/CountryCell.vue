<script setup lang="ts">
import { computed } from 'vue';
import { countryName } from '../country';
import CountryFlag from '../CountryFlag.vue';
import type { ProfileCellParams } from './types';

const props = defineProps<{ params: ProfileCellParams }>();
const code = computed(() => props.params.data?.countryCode ?? '');
</script>

<!-- Lange Namen („Vereinigtes Königreich“) brechen um statt gekürzt zu werden (F14); die Zeile wächst mit. -->
<template>
  <div class="flex min-h-[52px] w-full min-w-0 items-center gap-space-sm py-2">
    <CountryFlag :country-code="code" />
    <span data-wrap class="min-w-0 whitespace-normal wrap-break-word">
      {{ countryName(code) }}
      <span class="font-data text-data-sm whitespace-nowrap text-ink-tertiary">{{ code }}</span>
    </span>
  </div>
</template>
