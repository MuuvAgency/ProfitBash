<script setup lang="ts">
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Drawer from 'primevue/drawer';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import BrandMark from '../components/brand/BrandMark.vue';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import QuickTools from '../components/shell/QuickTools.vue';
import SidebarPanel from '../components/shell/SidebarPanel.vue';
import { errorMessageKey } from '../i18n';
import { useSessionStore } from '../stores/session';
import { useSidebarState } from './useSidebarState';

const { t } = useI18n();
const session = useSessionStore();
const { collapsed, toggle } = useSidebarState();
const mobileNavOpen = ref(false);
const shortcutsOpen = ref(false);
const retrying = ref(false);

const noOrganization = computed(
  () => session.me !== null && session.me.activeOrganizationId === null,
);

async function retry() {
  retrying.value = true;
  try {
    await session.load();
  } finally {
    retrying.value = false;
  }
}
</script>

<template>
  <!-- /api/me fehlgeschlagen: Fehler statt leerer Shell -->
  <main
    v-if="session.status === 'error'"
    class="flex min-h-dvh items-center justify-center bg-canvas p-margin"
  >
    <div
      class="flex w-full max-w-md flex-col gap-space-md rounded-tile bg-tile p-space-xl shadow-tile"
    >
      <BrandMark class="text-ink" />
      <h1 class="text-headline-md text-ink">{{ t('shell.loadErrorTitle') }}</h1>
      <p class="text-body-md text-ink-secondary">{{ t('shell.loadErrorText') }}</p>
      <InlineError
        :message="t(errorMessageKey(session.loadError?.code ?? 'UNKNOWN'))"
        retryable
        :retrying="retrying"
        @retry="retry"
      />
    </div>
  </main>

  <div v-else-if="session.me" class="min-h-dvh bg-canvas lg:flex">
    <!-- Desktop: feste, einklappbare Sidebar -->
    <aside
      :class="[
        'sticky top-0 hidden h-dvh shrink-0 shadow-raised transition-[width] duration-200 lg:block',
        collapsed ? 'w-20' : 'w-64',
      ]"
    >
      <SidebarPanel
        id-prefix="desktop"
        :collapsed="collapsed"
        collapsible
        @toggle-collapsed="toggle"
        @show-shortcuts="shortcutsOpen = true"
      />
    </aside>

    <!-- Mobil: Kopfzeile mit Menü-Schublade -->
    <header
      class="sticky top-0 z-40 flex h-16 items-center justify-between gap-space-sm bg-canvas/85 px-margin-mobile shadow-tile backdrop-blur-xl lg:hidden"
    >
      <Button
        icon="pi pi-bars"
        variant="text"
        severity="secondary"
        :aria-label="t('shell.openMenu')"
        :aria-expanded="mobileNavOpen"
        @click="mobileNavOpen = true"
      />
      <RouterLink :to="{ name: 'home' }" class="text-ink"><BrandMark /></RouterLink>
      <QuickTools variant="bar" collapsed />
    </header>
    <Drawer
      v-model:visible="mobileNavOpen"
      position="left"
      :show-close-icon="false"
      class="w-72! border-0! bg-panel!"
      :pt="{ content: { class: 'p-0! h-full' }, header: { class: 'hidden' } }"
    >
      <SidebarPanel
        id-prefix="mobile"
        closable
        @close="mobileNavOpen = false"
        @navigate="mobileNavOpen = false"
        @show-shortcuts="shortcutsOpen = true"
      />
    </Drawer>

    <main
      class="min-w-0 flex-1 px-margin-mobile py-space-lg sm:px-margin lg:px-space-xl lg:py-space-xl"
    >
      <div class="mx-auto flex w-full max-w-360 flex-col gap-space-lg">
        <p
          v-if="noOrganization"
          role="status"
          class="rounded-control bg-violet-wash px-space-md py-space-sm text-body-sm text-ink"
        >
          {{ t('shell.noOrganization') }}
        </p>
        <RouterView v-slot="{ Component }">
          <Suspense>
            <component :is="Component" />
            <template #fallback>
              <div class="flex flex-col gap-space-lg" role="status" aria-busy="true">
                <span class="sr-only">{{ t('common.loading') }}</span>
                <SkeletonBlock width="16rem" height="2rem" />
                <SkeletonBlock shape="tile" height="12rem" />
              </div>
            </template>
          </Suspense>
        </RouterView>
      </div>
    </main>

    <Dialog
      v-model:visible="shortcutsOpen"
      modal
      :header="t('shortcuts.title')"
      class="w-full max-w-md"
    >
      <p class="text-body-md text-ink-secondary">{{ t('shortcuts.empty') }}</p>
    </Dialog>
  </div>
</template>
