<script setup lang="ts">
import { useI18n } from 'vue-i18n';

/** Unterseiten von „Tools“ (`phase-4.md`); weitere kommen mit Setup (4.5) und Portfolio (4.7). */
defineProps<{ current: 'product-groups' | 'catalog' }>();
const { t } = useI18n();
const tabs = [
  { key: 'product-groups', to: '/ads/tools/product-groups', label: 'tools.productGroups' },
  { key: 'catalog', to: '/ads/tools/catalog', label: 'tools.catalog' },
] as const;
</script>

<template>
  <nav :aria-label="t('tools.tabs')" class="flex gap-space-xs overflow-x-auto">
    <RouterLink
      v-for="item in tabs"
      :key="item.key"
      :to="item.to"
      :aria-current="current === item.key ? 'page' : undefined"
      :class="[
        'whitespace-nowrap rounded-control px-space-md py-space-sm text-body-md outline-none transition-colors focus-visible:ring-2 focus-visible:ring-violet',
        current === item.key
          ? 'bg-violet font-semibold text-on-violet shadow-active'
          : 'text-ink-secondary hover:bg-violet-wash hover:text-ink',
      ]"
    >
      {{ t(item.label) }}
    </RouterLink>
  </nav>
</template>
