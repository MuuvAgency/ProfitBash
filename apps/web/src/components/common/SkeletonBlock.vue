<script setup lang="ts">
import Skeleton from 'primevue/skeleton';

/** Lade-Platzhalter in der Form des späteren Inhalts (keine Spinner, DESIGN.md §4). */
withDefaults(
  defineProps<{
    width?: string;
    height?: string;
    /** `tile` für Kacheln, `line` für Textzeilen, `circle` für Avatare. */
    shape?: 'tile' | 'line' | 'circle';
  }>(),
  { width: '100%', height: undefined, shape: 'line' },
);
</script>

<template>
  <Skeleton
    :width="width"
    :height="height ?? (shape === 'tile' ? '8rem' : shape === 'circle' ? width : '1rem')"
    :shape="shape === 'circle' ? 'circle' : 'rectangle'"
    :class="shape === 'tile' ? 'rounded-tile!' : 'rounded-control!'"
    aria-hidden="true"
    data-skeleton
  />
</template>
