<script setup lang="ts">
import WrapText from '../../components/common/WrapText.vue';
import type { ProfileCellParams } from './types';

defineProps<{ params: ProfileCellParams }>();
</script>

<!-- Zeitzone in Mono, bricht bevorzugt nach „/“ um statt gekürzt zu werden (F14); die Zeile wächst mit. -->
<template>
  <div class="flex min-h-[50px] w-full min-w-0 items-center py-2">
    <span data-wrap class="min-w-0 whitespace-normal font-data wrap-anywhere"
      ><WrapText :text="params.data?.timezone ?? ''"
    /></span>
  </div>
</template>
