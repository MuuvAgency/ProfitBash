<script setup lang="ts">
import { MAX_PROTECTED_TERMS, protectedTermsSchema, type Client } from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import Textarea from 'primevue/textarea';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { useUpdateProtectedTerms } from './queries';

/**
 * Geschützte Begriffe eines Clients (Marke, Hero-Begriffe; `phase-2b.md` 2b.2): ein Begriff je Zeile. Suchbegriffe, die
 * einen davon enthalten, bekommen in der Suchbegriff-Analyse nie den Vorschlag „Negieren“.
 */
const props = defineProps<{
  /** `null` = geschlossen. */
  client: Client | null;
}>();
const emit = defineEmits<{ close: [] }>();

const { t } = useI18n();
const update = useUpdateProtectedTerms();

const text = ref('');
const error = ref<string | null>(null);

// Auf die ID hören, nicht auf das Objekt: Die Liste ersetzt den Client nach dem Speichern und beim Neuladen, das
// darf weder eine laufende Eingabe noch eine laufende Speicherung zurücksetzen.
watch(
  () => props.client?.id,
  () => {
    const client = props.client;
    if (!client) return;
    text.value = client.protectedTerms.join('\n');
    error.value = null;
    update.reset();
  },
  { immediate: true },
);

async function submit() {
  if (!props.client) return;
  const terms = text.value
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '');
  if (!protectedTermsSchema.safeParse(terms).success) {
    error.value = t('connections.protectedTerms.invalid', { max: MAX_PROTECTED_TERMS });
    return;
  }
  error.value = null;
  try {
    await update.mutateAsync({ id: props.client.id, protectedTerms: terms });
    emit('close');
  } catch (cause) {
    error.value = t(errorMessageKey(cause instanceof ApiError ? cause.code : 'UNKNOWN'));
  }
}
</script>

<template>
  <Dialog
    :visible="client !== null"
    modal
    :closable="!update.isPending.value"
    :close-on-escape="!update.isPending.value"
    :header="t('connections.protectedTerms.title', { client: client?.name ?? '' })"
    :style="{ width: 'min(32rem, calc(100vw - 2rem))' }"
    @update:visible="(visible) => !visible && emit('close')"
  >
    <form class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
      <InlineError v-if="error" :message="error" />
      <div class="flex flex-col gap-space-sm">
        <label for="protected-terms" class="text-body-sm font-semibold text-ink">
          {{ t('connections.protectedTerms.label') }}
        </label>
        <Textarea
          id="protected-terms"
          v-model="text"
          rows="8"
          autocomplete="off"
          spellcheck="false"
          class="font-data"
          fluid
        />
        <p class="text-body-sm text-ink-secondary">{{ t('connections.protectedTerms.hint') }}</p>
      </div>
      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('common.cancel')"
          severity="secondary"
          variant="text"
          :disabled="update.isPending.value"
          @click="emit('close')"
        />
        <Button type="submit" :label="t('common.save')" :loading="update.isPending.value" />
      </div>
    </form>
  </Dialog>
</template>
