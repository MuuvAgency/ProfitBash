<script setup lang="ts">
import ToggleSwitch from 'primevue/toggleswitch';
import { useI18n } from 'vue-i18n';
import type { ProfileCellParams } from './types';

const props = defineProps<{ params: ProfileCellParams }>();
const { t } = useI18n();

function onChange(isHidden: boolean) {
  const profile = props.params.data;
  if (profile && isHidden !== profile.isHidden) props.params.context.patch(profile, { isHidden });
}
</script>

<template>
  <ToggleSwitch
    v-if="params.data"
    :model-value="params.data.isHidden"
    :aria-label="
      t('connections.profiles.hideFor', {
        account: params.data.accountName,
        country: params.data.countryCode,
      })
    "
    @update:model-value="onChange"
  />
</template>
