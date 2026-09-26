<script setup lang="ts">
import { MISSING_VALUE } from '@profitbash/shared';
import Select from 'primevue/select';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import type { ProfileCellParams } from './types';

const props = defineProps<{ params: ProfileCellParams }>();
const { t } = useI18n();

/** Eigene Option „Neuen Client anlegen …“; kann keine Client-ID sein (UUID). */
const NEW_CLIENT = 'new-client';

const options = computed(() => [
  { value: null, label: t('connections.profiles.noClient') },
  ...props.params.context.clients.map((client) => ({ value: client.id, label: client.name })),
  { value: NEW_CLIENT, label: t('connections.profiles.newClient') },
]);

/** Setzt die Auswahl zurück, wenn „Neuen Client anlegen …“ gewählt wurde (der Dialog entscheidet). */
const resetKey = ref(0);

function onChange(value: string | null) {
  const profile = props.params.data;
  if (!profile) return;
  if (value === NEW_CLIENT) {
    resetKey.value += 1;
    props.params.context.createClient(profile);
    return;
  }
  if (value !== profile.clientId) props.params.context.patch(profile, { clientId: value });
}
</script>

<template>
  <Select
    v-if="params.data"
    :key="resetKey"
    :model-value="params.data.clientId"
    :options="options"
    option-label="label"
    option-value="value"
    :placeholder="params.context.clientsReady ? t('connections.profiles.noClient') : MISSING_VALUE"
    :disabled="!params.context.clientsReady"
    :aria-label="
      t('connections.profiles.clientFor', {
        account: params.data.accountName,
        country: params.data.countryCode,
      })
    "
    size="small"
    fluid
    @update:model-value="onChange"
  />
</template>
