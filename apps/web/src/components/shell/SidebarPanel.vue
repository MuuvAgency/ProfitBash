<script setup lang="ts">
import { computed } from 'vue';
import { formatNumber } from '@profitbash/shared';
import { useI18n } from 'vue-i18n';
import { usePendingCount } from '../../changes/queries';
import { visibleNavigation } from '../../navigation/navigation';
import { useSessionStore } from '../../stores/session';
import BrandMark from '../brand/BrandMark.vue';
import AccountMenu from './AccountMenu.vue';
import QuickTools from './QuickTools.vue';
import SidebarNav from './SidebarNav.vue';

const props = defineProps<{
  /** Präfix für IDs; Desktop-Sidebar und mobile Schublade existieren gleichzeitig. */
  idPrefix: string;
  collapsed?: boolean;
  /** Auf dem Desktop einklappbar; in der mobilen Schublade nicht. */
  collapsible?: boolean;
  /** Schließen-Button (mobile Schublade). */
  closable?: boolean;
}>();
const emit = defineEmits<{ toggleCollapsed: []; navigate: []; showShortcuts: []; close: [] }>();

const { t } = useI18n();
const session = useSessionStore();
const groups = computed(() => (session.me ? visibleNavigation(session.me) : []));
/** Warenkorb am Eintrag „Änderungen“ (3.5); ohne Zahl bei leerem Warenkorb oder wenn sie nicht bekannt ist. */
const pendingCount = usePendingCount();
const badges = computed(() => {
  const result: Record<string, { text: string; label: string }> = {};
  const count = pendingCount.value;
  if (count) {
    result.changes = {
      text: formatNumber(String(count), session.preferences.locale),
      label: t('changes.pendingCount', { count }, count),
    };
  }
  return result;
});
const toggleLabel = computed(() =>
  props.collapsed ? t('shell.expandSidebar') : t('shell.collapseSidebar'),
);
</script>

<template>
  <div class="flex h-full flex-col gap-space-lg bg-panel p-space-md text-on-panel">
    <div
      :class="[
        'flex items-center gap-space-sm',
        collapsed ? 'flex-col' : 'justify-between px-space-sm',
      ]"
    >
      <RouterLink
        :to="{ name: 'home' }"
        class="rounded-control py-space-xs outline-none focus-visible:ring-2 focus-visible:ring-violet"
        @click="emit('navigate')"
      >
        <BrandMark :compact="collapsed" />
      </RouterLink>
      <button
        v-if="collapsible"
        v-tooltip.right="collapsed ? toggleLabel : undefined"
        type="button"
        :aria-label="toggleLabel"
        :aria-expanded="!collapsed"
        class="flex size-9 items-center justify-center rounded-control text-on-panel-muted outline-none transition-colors hover:bg-on-panel/10 hover:text-on-panel focus-visible:ring-2 focus-visible:ring-violet"
        @click="emit('toggleCollapsed')"
      >
        <i
          :class="['pi', collapsed ? 'pi-angle-double-right' : 'pi-angle-double-left']"
          aria-hidden="true"
        />
      </button>
      <button
        v-if="closable"
        type="button"
        :aria-label="t('common.close')"
        class="flex size-9 items-center justify-center rounded-control text-on-panel-muted outline-none transition-colors hover:bg-on-panel/10 hover:text-on-panel focus-visible:ring-2 focus-visible:ring-violet"
        @click="emit('close')"
      >
        <i class="pi pi-times" aria-hidden="true" />
      </button>
    </div>

    <div class="-mx-space-xs min-h-0 flex-1 overflow-y-auto px-space-xs">
      <SidebarNav
        :id-prefix="idPrefix"
        :groups="groups"
        :collapsed="collapsed"
        :badges="badges"
        @navigate="emit('navigate')"
      />
    </div>

    <div class="flex flex-col gap-space-xs">
      <QuickTools :collapsed="collapsed" />
      <AccountMenu
        :id-prefix="idPrefix"
        :collapsed="collapsed"
        @show-shortcuts="emit('showShortcuts')"
      />
    </div>
  </div>
</template>
