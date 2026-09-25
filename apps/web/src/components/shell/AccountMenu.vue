<script setup lang="ts">
import { useQueryClient } from '@tanstack/vue-query';
import Menu from 'primevue/menu';
import type { MenuItem } from 'primevue/menuitem';
import { useToast } from 'primevue/usetoast';
import { computed, useTemplateRef } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRouter } from 'vue-router';
import { SETTINGS_PATH } from '../../navigation/navigation';
import { useSessionStore } from '../../stores/session';
import { toggledTheme } from '../../theme/mode';
import { useColorScheme } from '../../theme/useColorScheme';

defineProps<{ collapsed?: boolean }>();
const emit = defineEmits<{ showShortcuts: [] }>();

const { t } = useI18n();
const router = useRouter();
const toast = useToast();
const queryClient = useQueryClient();
const session = useSessionStore();
const scheme = useColorScheme();
const menu = useTemplateRef<InstanceType<typeof Menu>>('menu');

const me = computed(() => session.me);
const activeOrganization = computed(() =>
  me.value?.organizations.find((org) => org.id === me.value?.activeOrganizationId),
);
const initials = computed(() =>
  (me.value?.user.name || me.value?.user.email || '?')
    .split(/[\s@.]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join(''),
);

function fail(summaryKey: string) {
  toast.add({ severity: 'error', summary: t(summaryKey), life: 6000 });
}

async function toggleTheme() {
  try {
    await session.setTheme(toggledTheme(scheme.value));
  } catch {
    fail('account.themeSaveFailed');
  }
}

async function switchOrganization(organizationId: string) {
  try {
    await session.switchOrganization(organizationId);
    queryClient.clear();
    // Rechte und Menü der neuen Organisation: Guards für die aktuelle Seite erneut prüfen.
    await router.replace({ path: router.currentRoute.value.fullPath, force: true });
  } catch {
    fail('account.switchFailed');
  }
}

async function signOut() {
  try {
    await session.signOut();
    queryClient.clear();
    await router.push({ name: 'login' });
  } catch {
    fail('account.signOutFailed');
  }
}

const items = computed<MenuItem[]>(() => {
  const organizations = me.value?.organizations ?? [];
  const orgItems: MenuItem[] =
    organizations.length > 1
      ? [
          {
            label: t('account.switchOrganization'),
            items: organizations.map((org) => ({
              label: org.name,
              icon: org.id === activeOrganization.value?.id ? 'pi pi-check' : 'pi pi-building',
              disabled: org.id === activeOrganization.value?.id,
              command: () => void switchOrganization(org.id),
            })),
          },
          { separator: true },
        ]
      : [];
  return [
    ...orgItems,
    {
      label: scheme.value === 'dark' ? t('account.lightMode') : t('account.darkMode'),
      icon: scheme.value === 'dark' ? 'pi pi-sun' : 'pi pi-moon',
      command: () => void toggleTheme(),
    },
    {
      label: t('account.settings'),
      icon: 'pi pi-cog',
      command: () => void router.push(SETTINGS_PATH),
    },
    {
      label: t('account.shortcuts'),
      icon: 'pi pi-question-circle',
      command: () => emit('showShortcuts'),
    },
    { separator: true },
    { label: t('account.signOut'), icon: 'pi pi-sign-out', command: () => void signOut() },
  ];
});
</script>

<template>
  <div>
    <button
      type="button"
      :aria-label="t('account.menu')"
      aria-haspopup="menu"
      aria-controls="account-menu"
      :class="[
        'flex w-full items-center gap-space-sm rounded-control p-space-sm text-left outline-none transition-colors',
        'hover:bg-on-panel/10 focus-visible:ring-2 focus-visible:ring-violet',
        collapsed ? 'justify-center' : '',
      ]"
      @click="menu?.toggle($event)"
    >
      <span
        class="flex size-9 shrink-0 items-center justify-center rounded-full bg-violet text-body-sm font-semibold text-on-panel"
        aria-hidden="true"
        >{{ initials }}</span
      >
      <span v-if="!collapsed" class="flex min-w-0 flex-1 flex-col">
        <span class="truncate text-body-sm font-semibold text-on-panel">{{ me?.user.name }}</span>
        <span class="truncate text-body-sm text-on-panel-muted">
          {{ activeOrganization?.name }}
          <template v-if="activeOrganization"
            >· {{ t(`account.role.${activeOrganization.role}`) }}</template
          >
        </span>
      </span>
      <i v-if="!collapsed" class="pi pi-angle-up shrink-0 text-on-panel-muted" aria-hidden="true" />
    </button>
    <Menu id="account-menu" ref="menu" :model="items" popup />
  </div>
</template>
