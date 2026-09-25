<script setup lang="ts">
defineProps<{
  title: string;
  /** Kleine Überzeile, z. B. Bereich oder Status. */
  eyebrow?: string;
  description?: string;
}>();
</script>

<template>
  <header class="flex flex-col gap-space-md sm:flex-row sm:items-end sm:justify-between">
    <div class="flex min-w-0 flex-col gap-space-xs">
      <p v-if="eyebrow" class="text-label-eyebrow uppercase text-ink-tertiary">{{ eyebrow }}</p>
      <h1 class="text-headline-md text-ink sm:text-headline-lg">{{ title }}</h1>
      <p v-if="description" class="max-w-[65ch] text-body-md text-ink-secondary">
        {{ description }}
      </p>
    </div>
    <div v-if="$slots.actions" class="flex shrink-0 items-center gap-space-sm">
      <slot name="actions" />
    </div>
  </header>
</template>
