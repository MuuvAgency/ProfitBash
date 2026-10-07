<script setup lang="ts">
import Button from 'primevue/button';
import { useI18n } from 'vue-i18n';
import type { ProfileCellParams } from './types';

const props = defineProps<{ params: ProfileCellParams }>();
const { t } = useI18n();

function open() {
  if (props.params.data) props.params.context.openFiles(props.params.data);
}
</script>

<template>
  <Button
    v-if="params.data"
    :label="t('connections.fileProfiles.openFiles')"
    icon="pi pi-upload"
    size="small"
    severity="secondary"
    variant="outlined"
    :aria-label="
      t('connections.fileProfiles.openFilesFor', {
        account: params.data.accountName,
        country: params.data.countryCode,
      })
    "
    @click="open"
  />
</template>
