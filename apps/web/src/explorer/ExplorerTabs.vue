<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { RouterLink, type RouteLocationRaw } from 'vue-router';

/** Reiter des Explorers: die Ebenen und die Suchbegriff-Analyse (eigene Seite, 2b.2). */
defineProps<{
  tabs: { key: string; label: string; to: RouteLocationRaw }[];
  active: string;
}>();

const { t } = useI18n();
</script>

<template>
  <nav :aria-label="t('explorer.tabs')" class="-mx-space-xs overflow-x-auto px-space-xs">
    <ul class="flex gap-space-xs">
      <li v-for="tab in tabs" :key="tab.key">
        <RouterLink
          :to="tab.to"
          :aria-current="tab.key === active ? 'page' : undefined"
          :class="[
            'block whitespace-nowrap rounded-control px-space-md py-space-sm text-body-md transition-colors',
            tab.key === active
              ? 'bg-violet text-on-violet shadow-active'
              : 'text-ink-secondary hover:bg-violet-wash hover:text-ink',
          ]"
          >{{ tab.label }}</RouterLink
        >
      </li>
    </ul>
  </nav>
</template>
