<script setup lang="ts">
import WrapText from '../../components/common/WrapText.vue';
import type { JobRunCellParams } from './types';

defineProps<{ params: JobRunCellParams }>();
</script>

<!--
  Text einer schmalen Flex-Spalte: bricht um (bevorzugt nach „@“, notfalls im Wort), statt gekürzt zu werden. So bleibt
  er ohne Tooltip lesbar, auch auf Touch (`phase-2.md` F14); die Zeile wächst mit (`autoHeight`).
-->
<template>
  <div class="flex min-h-[52px] w-full min-w-0 items-center py-2">
    <span data-wrap class="min-w-0 whitespace-normal wrap-anywhere"
      ><WrapText :text="String(params.valueFormatted ?? params.value ?? '')"
    /></span>
  </div>
</template>
