<script setup lang="ts">
import { watchEffect } from 'vue';
import { isOpenFileImport, useFileImportsQuery } from './queries';

/**
 * Ohne Ausgabe: verfolgt eine hochgeladene Datei bis zum Ende ihres Imports, auch nach dem Schließen des Dialogs
 * (1.11f). Danach lädt die Karte die Profile neu („Letzter Import“, Hinweise auf veraltete Daten).
 */
const props = defineProps<{ profileId: string; importId: string }>();
const emit = defineEmits<{ done: [] }>();

const query = useFileImportsQuery(() => props.profileId, {
  awaitImportId: () => props.importId,
});
let reported = false;
watchEffect(() => {
  const fileImport = query.data.value?.find((i) => i.id === props.importId);
  if (!reported && fileImport && !isOpenFileImport(fileImport)) {
    reported = true;
    emit('done');
  }
});
</script>

<template>
  <span hidden />
</template>
