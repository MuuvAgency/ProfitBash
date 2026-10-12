<script setup lang="ts">
import {
  CONNECTION_REGIONS,
  sellerConnectionCreateSchema,
  type SellerAccountsSync,
  type SellerConnection,
} from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import Select from 'primevue/select';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { useCreateSellerConnection } from './queries';

/**
 * „Token eintragen“ (`phase-7.md` F1). Mit `connection` wird dieselbe Seller-ID neu verbunden: Region und
 * Seller-ID stehen dann fest. Die Felder werden bei jedem Öffnen geleert; Secrets bleiben nie im Zustand.
 */
const props = defineProps<{ visible: boolean; connection: SellerConnection | null }>();
const emit = defineEmits<{ saved: [result: SellerAccountsSync]; close: [] }>();

const { t } = useI18n();
const save = useCreateSellerConnection();

const region = ref<(typeof CONNECTION_REGIONS)[number]>('eu');
const sellerId = ref('');
const clientId = ref('');
const clientSecret = ref('');
const refreshToken = ref('');
const errorKey = ref<string | null>(null);

watch(
  () => props.visible,
  (visible) => {
    region.value = props.connection?.region ?? 'eu';
    sellerId.value = props.connection?.amazonSellerId ?? '';
    clientId.value = '';
    clientSecret.value = '';
    refreshToken.value = '';
    errorKey.value = null;
    if (visible) save.reset();
  },
  { immediate: true },
);

const regionOptions = computed(() =>
  CONNECTION_REGIONS.map((value) => ({ value, label: t(`connections.region.${value}`) })),
);

async function submit() {
  const parsed = sellerConnectionCreateSchema.safeParse({
    region: region.value,
    amazonSellerId: sellerId.value.trim().toUpperCase(),
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    refreshToken: refreshToken.value,
  });
  if (!parsed.success) {
    const empty = [sellerId, clientId, clientSecret, refreshToken].some((f) => !f.value.trim());
    errorKey.value = empty
      ? 'connections.sellerAccounts.dialog.required'
      : 'errors.VALIDATION_ERROR';
    return;
  }
  errorKey.value = null;
  try {
    emit('saved', await save.mutateAsync(parsed.data));
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}

const fields = computed(() => [
  {
    id: 'seller-connection-seller-id',
    model: sellerId,
    label: t('connections.sellerAccounts.dialog.sellerId'),
    hint: t('connections.sellerAccounts.dialog.sellerIdHint'),
    type: 'text',
    readonly: props.connection !== null,
  },
  {
    id: 'seller-connection-client-id',
    model: clientId,
    label: t('connections.sellerAccounts.dialog.clientId'),
    hint: null,
    type: 'text',
    readonly: false,
  },
  {
    id: 'seller-connection-client-secret',
    model: clientSecret,
    label: t('connections.sellerAccounts.dialog.clientSecret'),
    hint: null,
    type: 'password',
    readonly: false,
  },
  {
    id: 'seller-connection-refresh-token',
    model: refreshToken,
    label: t('connections.sellerAccounts.dialog.refreshToken'),
    hint: t('connections.sellerAccounts.dialog.refreshTokenHint'),
    type: 'password',
    readonly: false,
  },
]);
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :closable="!save.isPending.value"
    :close-on-escape="!save.isPending.value"
    :header="
      t(
        connection
          ? 'connections.sellerAccounts.dialog.reconnectTitle'
          : 'connections.sellerAccounts.dialog.title',
      )
    "
    :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
    @update:visible="(value) => !value && emit('close')"
  >
    <form class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
      <p class="text-body-sm text-ink-secondary">
        {{ t('connections.sellerAccounts.dialog.intro') }}
      </p>
      <InlineError v-if="errorKey" :message="t(errorKey)" />
      <div class="flex flex-col gap-space-sm">
        <span class="text-body-sm font-semibold text-ink">
          {{ t('connections.sellerAccounts.dialog.region') }}
        </span>
        <Select
          v-model="region"
          :options="regionOptions"
          option-label="label"
          option-value="value"
          :aria-label="t('connections.sellerAccounts.dialog.region')"
          :disabled="connection !== null"
          fluid
        />
      </div>
      <div v-for="field in fields" :key="field.id" class="flex flex-col gap-space-sm">
        <label :for="field.id" class="text-body-sm font-semibold text-ink">{{ field.label }}</label>
        <InputText
          :id="field.id"
          v-model="field.model.value"
          :type="field.type"
          :readonly="field.readonly"
          autocomplete="off"
          spellcheck="false"
          class="font-data"
          fluid
        />
        <p v-if="field.hint" class="text-body-sm text-ink-secondary">{{ field.hint }}</p>
      </div>
      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('connections.sellerAccounts.dialog.cancel')"
          severity="secondary"
          variant="text"
          :disabled="save.isPending.value"
          @click="emit('close')"
        />
        <Button
          type="submit"
          :label="t('connections.sellerAccounts.dialog.submit')"
          :loading="save.isPending.value"
        />
      </div>
    </form>
  </Dialog>
</template>
