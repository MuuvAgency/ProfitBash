<script setup lang="ts">
import type { Client } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import ProtectedTermsDialog from './ProtectedTermsDialog.vue';

/**
 * Clients der Organisation mit ihren geschützten Begriffen (`phase-2b.md` 2b.2, Dominik 2026-10-07: Pflege bei
 * „Clients & Connections“). Angelegt und zugeordnet werden Clients weiter an den Profilen.
 */
const props = defineProps<{ clients: Client[] }>();

const { t } = useI18n();

/** Aus der Liste gelesen, damit der Dialog nach dem Speichern den neuen Stand kennt. */
const editingId = ref<string | null>(null);
const editing = computed(() => props.clients.find((c) => c.id === editingId.value) ?? null);
</script>

<template>
  <section
    class="flex flex-col gap-space-lg rounded-tile bg-tile p-space-lg shadow-tile"
    :aria-label="t('connections.clients.title')"
  >
    <header class="flex min-w-0 items-start gap-space-md">
      <span
        class="flex size-12 shrink-0 items-center justify-center rounded-control bg-panel text-on-panel"
        aria-hidden="true"
      >
        <i class="pi pi-shield text-headline-sm" />
      </span>
      <div class="flex min-w-0 flex-col gap-space-xs">
        <h2 class="text-headline-sm text-ink">{{ t('connections.clients.title') }}</h2>
        <p class="max-w-prose text-body-sm text-ink-secondary">
          {{ t('connections.clients.description') }}
        </p>
      </div>
    </header>

    <ul class="flex flex-col gap-space-sm">
      <li
        v-for="client in clients"
        :key="client.id"
        class="flex flex-col gap-space-sm rounded-control bg-well px-space-md py-space-sm sm:flex-row sm:items-center sm:justify-between"
      >
        <div class="flex min-w-0 flex-col gap-space-xs">
          <span class="font-medium text-ink">{{ client.name }}</span>
          <span
            v-if="client.protectedTerms.length > 0"
            class="wrap-anywhere font-data text-body-sm text-ink-secondary"
            >{{ client.protectedTerms.join(', ') }}</span
          >
          <span v-else class="text-body-sm text-ink-tertiary">{{
            t('connections.clients.noProtectedTerms')
          }}</span>
        </div>
        <Button
          :label="t('connections.clients.editProtectedTerms')"
          :aria-label="t('connections.clients.editProtectedTermsFor', { client: client.name })"
          size="small"
          severity="secondary"
          class="shrink-0 self-start sm:self-center"
          @click="editingId = client.id"
        />
      </li>
    </ul>

    <ProtectedTermsDialog :client="editing" @close="editingId = null" />
  </section>
</template>
