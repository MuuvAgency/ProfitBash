<script setup lang="ts">
import type { Client } from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { useCreateClient } from './queries';

const props = defineProps<{
  /** Account-Name des Profils, dem der neue Client zugeordnet wird; `null` = geschlossen. */
  accountName: string | null;
}>();
const emit = defineEmits<{ created: [client: Client]; close: [] }>();

const { t } = useI18n();
const createClient = useCreateClient();

const name = ref('');
const errorKey = ref<string | null>(null);

watch(
  () => props.accountName,
  (accountName) => {
    if (accountName === null) return;
    name.value = '';
    errorKey.value = null;
    createClient.reset();
  },
);

async function submit() {
  const trimmed = name.value.trim();
  if (!trimmed) {
    errorKey.value = 'connections.clientDialog.required';
    return;
  }
  errorKey.value = null;
  try {
    emit('created', await createClient.mutateAsync(trimmed));
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
</script>

<template>
  <Dialog
    :visible="accountName !== null"
    modal
    :closable="!createClient.isPending.value"
    :close-on-escape="!createClient.isPending.value"
    :header="t('connections.clientDialog.title')"
    :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
    @update:visible="(visible) => !visible && emit('close')"
  >
    <form class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
      <InlineError v-if="errorKey" :message="t(errorKey)" />
      <div class="flex flex-col gap-space-sm">
        <label for="create-client-name" class="text-body-sm font-semibold text-ink">
          {{ t('connections.clientDialog.name') }}
        </label>
        <InputText
          id="create-client-name"
          v-model="name"
          autocomplete="off"
          maxlength="120"
          fluid
          autofocus
          :invalid="errorKey === 'connections.clientDialog.required'"
        />
        <p class="text-body-sm text-ink-secondary">
          {{ t('connections.clientDialog.hint', { account: accountName ?? '' }) }}
        </p>
      </div>
      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('connections.clientDialog.cancel')"
          severity="secondary"
          variant="text"
          :disabled="createClient.isPending.value"
          @click="emit('close')"
        />
        <Button
          type="submit"
          :label="t('connections.clientDialog.submit')"
          :loading="createClient.isPending.value"
        />
      </div>
    </form>
  </Dialog>
</template>
