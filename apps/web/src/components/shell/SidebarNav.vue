<script setup lang="ts">
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import type { NavGroup } from '../../navigation/navigation';

withDefaults(
  defineProps<{
    /** Präfix für IDs, falls die Navigation mehrfach auf der Seite ist. */
    idPrefix?: string;
    groups: NavGroup[];
    /** Nur Icons; Beschriftung per `aria-label` und Tooltip. */
    collapsed?: boolean;
  }>(),
  { idPrefix: 'nav', collapsed: false },
);

const emit = defineEmits<{ navigate: [] }>();
const { t } = useI18n();
const route = useRoute();
</script>

<template>
  <nav :aria-label="t('nav.label')" class="flex flex-col gap-space-lg">
    <section
      v-for="group in groups"
      :key="group.id"
      class="flex flex-col gap-space-xs"
      :aria-labelledby="`${idPrefix}-group-${group.id}`"
    >
      <h2
        :id="`${idPrefix}-group-${group.id}`"
        :class="[
          'px-space-md text-label-eyebrow uppercase text-on-panel-muted',
          collapsed ? 'sr-only' : '',
        ]"
      >
        {{ t(group.labelKey) }}
      </h2>
      <ul class="flex flex-col gap-0.5">
        <li v-for="item in group.items" :key="item.id">
          <RouterLink
            v-tooltip.right="collapsed ? t(item.labelKey) : undefined"
            :to="item.path"
            :aria-label="collapsed ? t(item.labelKey) : undefined"
            :aria-current="route.meta.navItemId === item.id ? 'page' : undefined"
            :class="[
              'flex items-center gap-space-sm rounded-control py-space-sm text-body-md outline-none transition-colors',
              'focus-visible:ring-2 focus-visible:ring-violet',
              collapsed ? 'justify-center px-space-sm' : 'px-space-md',
              route.meta.navItemId === item.id
                ? 'bg-violet font-semibold text-on-violet shadow-active'
                : 'text-on-panel/70 hover:bg-on-panel/10 hover:text-on-panel',
            ]"
            @click="emit('navigate')"
          >
            <i :class="['pi', `pi-${item.icon}`, 'shrink-0 text-body-lg']" aria-hidden="true" />
            <span v-if="!collapsed" class="truncate">{{ t(item.labelKey) }}</span>
          </RouterLink>
        </li>
      </ul>
    </section>
  </nav>
</template>
