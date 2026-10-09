<script setup lang="ts">
import { tagDotClass } from './colors';

/**
 * Ein Tag als kleine Marke: Farbpunkt und Name. Ohne `color` ein Tag von Amazon (nur Anzeige, gedämpft, mit
 * Umriss statt Punkt).
 */
defineProps<{ name: string; color?: string }>();
</script>

<template>
  <span
    :class="[
      'inline-flex max-w-full items-center gap-space-xs rounded-control px-space-sm py-0.5 text-body-sm',
      color ? 'bg-well text-ink' : 'text-ink-secondary ring-1 ring-inset ring-line',
    ]"
    :title="name"
  >
    <span
      v-if="color"
      :class="['size-2 shrink-0 rounded-full', tagDotClass(color)]"
      aria-hidden="true"
    />
    <span class="truncate">{{ name }}</span>
  </span>
</template>
