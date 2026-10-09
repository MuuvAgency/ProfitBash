<script setup lang="ts">
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../../api';
import type { StructureCatalogData } from '../../api/client';
import InlineError from '../../components/common/InlineError.vue';
import { errorMessageKey } from '../../i18n';
import { useSetClientPreset, useToolRights } from '../queries';
import { inputClass } from './draft';

/**
 * Preset je Client (F-S8). Gespeichert wird sofort je Client (nicht mit dem Katalog) und nur gegen den gespeicherten
 * Katalog: Presets aus dem ungespeicherten Entwurf stehen hier erst nach dem Speichern zur Wahl.
 */
const props = defineProps<{ data: StructureCatalogData }>();
const { t } = useI18n();
const { canWrite } = useToolRights();
const save = useSetClientPreset();
const errorKey = ref<string | null>(null);

const presetFor = computed(
  () => new Map(props.data.clientPresets.map((entry) => [entry.clientId, entry.presetKey])),
);
const defaultName = computed(
  () => props.data.catalog.presets.find((preset) => preset.isDefault)?.name ?? '',
);

async function change(clientId: string, value: string) {
  errorKey.value = null;
  try {
    await save.mutateAsync({ clientId, presetKey: value === '' ? null : value });
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <p class="max-w-prose text-body-sm text-ink-secondary">
      {{ t('catalog.assignments.description') }}
    </p>
    <InlineError v-if="errorKey" :message="t(errorKey)" />
    <p v-if="data.clients.length === 0" class="text-body-md text-ink-secondary">
      {{ t('catalog.assignments.empty') }}
    </p>
    <ul v-else class="flex flex-col">
      <li
        v-for="client in data.clients"
        :key="client.id"
        class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
      >
        <label
          :for="`client-preset-${client.id}`"
          class="min-w-0 flex-1 basis-48 text-body-md text-ink"
          >{{ client.name }}</label
        >
        <select
          :id="`client-preset-${client.id}`"
          :data-client-preset="client.id"
          :value="presetFor.get(client.id) ?? ''"
          :disabled="!canWrite || save.isPending.value"
          :class="[inputClass, 'basis-64']"
          @change="change(client.id, ($event.target as HTMLSelectElement).value)"
        >
          <option value="">{{ t('catalog.assignments.useDefault', { name: defaultName }) }}</option>
          <option v-for="preset in data.catalog.presets" :key="preset.key" :value="preset.key">
            {{ preset.name }}
          </option>
        </select>
      </li>
    </ul>
  </section>
</template>
