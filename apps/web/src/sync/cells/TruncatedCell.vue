<script setup lang="ts">
import type { JobRunCellParams } from './types';

defineProps<{ params: JobRunCellParams }>();
</script>

<!-- Text einer schmalen Flex-Spalte: gekürzt mit Ellipse, vollständig im nativen Tooltip. -->
<template>
  <span class="min-w-0 truncate" :title="params.valueFormatted ?? String(params.value ?? '')">
    {{ params.valueFormatted ?? params.value }}
  </span>
</template>
