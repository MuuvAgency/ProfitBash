<script setup lang="ts">
withDefaults(
  defineProps<{
    title: string;
    text?: string;
    /** PrimeIcons-Name ohne `pi-`. */
    icon?: string;
    /** `h1`, wenn der Zustand die ganze Seite ausmacht (z. B. „Kein Zugriff“). */
    headingLevel?: 'h1' | 'h2';
  }>(),
  { text: undefined, icon: undefined, headingLevel: 'h2' },
);
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
      <component :is="headingLevel" class="text-headline-sm text-ink">{{ title }}</component>
      <p v-if="text" class="max-w-prose text-body-md text-ink-secondary">{{ text }}</p>
    </div>
    <div v-if="$slots.default" class="flex flex-wrap gap-space-sm">
      <slot />
    </div>
  </section>
</template>
