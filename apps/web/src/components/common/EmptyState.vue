<script setup lang="ts">
defineProps<{
  title: string;
  text?: string;
  /** PrimeIcons-Name ohne `pi-`. */
  icon?: string;
}>();
</script>

<template>
  <section
    class="flex flex-col items-start gap-space-md rounded-tile bg-tile p-space-lg shadow-tile sm:p-space-xl"
  >
    <span
      v-if="icon"
      class="flex size-12 items-center justify-center rounded-control bg-violet-wash text-violet"
      aria-hidden="true"
    >
      <i :class="['pi', `pi-${icon}`, 'text-headline-sm']" />
    </span>
    <div class="flex flex-col gap-space-xs">
      <h2 class="text-headline-sm text-ink">{{ title }}</h2>
      <p v-if="text" class="max-w-[65ch] text-body-md text-ink-secondary">{{ text }}</p>
    </div>
    <div v-if="$slots.default" class="flex flex-wrap gap-space-sm">
      <slot />
    </div>
  </section>
</template>
