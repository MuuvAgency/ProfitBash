<script setup lang="ts">
import {
  AMAZON_MARKETPLACES,
  FILE_PROFILE_ACCOUNT_TYPES,
  marketplaceFor,
  type FileProfileCreate,
  type Profile,
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
import { countryName } from './country';
import { useCreateFileProfile } from './queries';

const props = defineProps<{ visible: boolean }>();
const emit = defineEmits<{ created: [profile: Profile]; close: [] }>();

const { t } = useI18n();
const createProfile = useCreateFileProfile();

const DEFAULT_COUNTRY = 'DE';

const name = ref('');
const countryCode = ref(DEFAULT_COUNTRY);
const currencyCode = ref('');
const timezone = ref('');
const accountType = ref<FileProfileCreate['accountType']>('seller');
const errorKey = ref<string | null>(null);

/** Währung und Zeitzone folgen dem Marktplatz; eine von Hand gewählte Zeitzone ersetzt erst der nächste Wechsel. */
function applyMarketplace(code: string) {
  const marketplace = marketplaceFor(code);
  if (!marketplace) return;
  currencyCode.value = marketplace.currencyCode;
  timezone.value = marketplace.timezone;
}

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    name.value = '';
    countryCode.value = DEFAULT_COUNTRY;
    applyMarketplace(DEFAULT_COUNTRY);
    accountType.value = 'seller';
    errorKey.value = null;
    createProfile.reset();
  },
  { immediate: true },
);
watch(countryCode, applyMarketplace);

const marketplaceOptions = computed(() =>
  AMAZON_MARKETPLACES.map((m) => ({
    value: m.countryCode,
    label: countryName(m.countryCode),
  })).sort((a, b) => a.label.localeCompare(b.label, 'de')),
);
/** Kanonische IANA-Namen (wie die Prüfung in `fileProfileCreateSchema`). */
const timezoneOptions = Intl.supportedValuesOf('timeZone');
const accountTypeOptions = computed(() =>
  FILE_PROFILE_ACCOUNT_TYPES.map((type) => ({
    value: type,
    label: t(`connections.profiles.accountType.${type}`),
  })),
);

async function submit() {
  const trimmed = name.value.trim();
  if (!trimmed) {
    errorKey.value = 'connections.fileProfiles.dialog.required';
    return;
  }
  errorKey.value = null;
  try {
    emit(
      'created',
      await createProfile.mutateAsync({
        accountName: trimmed,
        countryCode: countryCode.value,
        currencyCode: currencyCode.value,
        timezone: timezone.value,
        accountType: accountType.value,
      }),
    );
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :closable="!createProfile.isPending.value"
    :close-on-escape="!createProfile.isPending.value"
    :header="t('connections.fileProfiles.dialog.title')"
    :style="{ width: 'min(32rem, calc(100vw - 2rem))' }"
    @update:visible="(value) => !value && emit('close')"
  >
    <form class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
      <InlineError v-if="errorKey" :message="t(errorKey)" />
      <div class="flex flex-col gap-space-sm">
        <label for="create-file-profile-name" class="text-body-sm font-semibold text-ink">
          {{ t('connections.fileProfiles.dialog.name') }}
        </label>
        <InputText
          id="create-file-profile-name"
          v-model="name"
          autocomplete="off"
          maxlength="120"
          fluid
          autofocus
          :invalid="errorKey === 'connections.fileProfiles.dialog.required'"
        />
        <p class="text-body-sm text-ink-secondary">
          {{ t('connections.fileProfiles.dialog.nameHint') }}
        </p>
      </div>
      <div class="grid gap-space-md sm:grid-cols-2">
        <div class="flex flex-col gap-space-sm">
          <span class="text-body-sm font-semibold text-ink">
            {{ t('connections.fileProfiles.dialog.marketplace') }}
          </span>
          <Select
            v-model="countryCode"
            :options="marketplaceOptions"
            option-label="label"
            option-value="value"
            :aria-label="t('connections.fileProfiles.dialog.marketplace')"
            fluid
          />
        </div>
        <div class="flex flex-col gap-space-sm">
          <span class="text-body-sm font-semibold text-ink">
            {{ t('connections.fileProfiles.dialog.accountType') }}
          </span>
          <Select
            v-model="accountType"
            :options="accountTypeOptions"
            option-label="label"
            option-value="value"
            :aria-label="t('connections.fileProfiles.dialog.accountType')"
            fluid
          />
        </div>
        <div class="flex flex-col gap-space-sm">
          <span class="text-body-sm font-semibold text-ink">
            {{ t('connections.fileProfiles.dialog.currency') }}
          </span>
          <!-- Amazon legt die Währung je Marktplatz fest: nur Anzeige. -->
          <span
            data-testid="file-profile-currency"
            class="flex min-h-10 items-center rounded-control bg-well px-space-md font-data text-ink"
            >{{ currencyCode }}</span
          >
        </div>
        <div class="flex flex-col gap-space-sm">
          <span class="text-body-sm font-semibold text-ink">
            {{ t('connections.fileProfiles.dialog.timezone') }}
          </span>
          <Select
            v-model="timezone"
            :options="timezoneOptions"
            filter
            :aria-label="t('connections.fileProfiles.dialog.timezone')"
            class="font-data"
            fluid
          />
        </div>
      </div>
      <p class="text-body-sm text-ink-secondary">
        {{ t('connections.fileProfiles.dialog.defaultsHint') }}
      </p>
      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('connections.fileProfiles.dialog.cancel')"
          severity="secondary"
          variant="text"
          :disabled="createProfile.isPending.value"
          @click="emit('close')"
        />
        <Button
          type="submit"
          :label="t('connections.fileProfiles.dialog.submit')"
          :loading="createProfile.isPending.value"
        />
      </div>
    </form>
  </Dialog>
</template>
