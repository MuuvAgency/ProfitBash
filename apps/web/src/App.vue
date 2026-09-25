<script setup lang="ts">
import Toast from 'primevue/toast';
import { ref } from 'vue';
import { useRouter } from 'vue-router';
import SkeletonBlock from './components/common/SkeletonBlock.vue';
import { useColorSchemeSync } from './theme/useColorScheme';

useColorSchemeSync();

// Bis die erste Navigation (inkl. /api/me) entschieden ist: Skelett in Form der Shell.
const ready = ref(false);
void useRouter()
  .isReady()
  .finally(() => {
    ready.value = true;
  });
</script>

<template>
  <Toast position="bottom-right" />
  <RouterView v-if="ready" />
  <div v-else class="flex min-h-dvh bg-canvas" aria-busy="true">
    <div class="hidden w-64 shrink-0 bg-panel lg:block" />
    <div class="flex flex-1 flex-col gap-space-lg p-margin">
      <SkeletonBlock width="16rem" height="2rem" />
      <SkeletonBlock shape="tile" height="12rem" />
    </div>
  </div>
</template>
