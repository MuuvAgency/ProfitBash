<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PendingAdChangeData, SubmittedAdChangeData } from '../api/client';
import { useSessionStore } from '../stores/session';
import { changeSubject, changeValueText } from './labels';

/**
 * Eine Änderung in Worten: was (Art, Name, Lage) und welches Feld von welchem auf welchen Wert; beim Anlegen eines
 * Negatives nur, was angelegt wird.
 */
const props = defineProps<{ change: PendingAdChangeData | SubmittedAdChangeData }>();

const i18n = useI18n();
const { t } = i18n;
const session = useSessionStore();
const labels = computed(() => ({ t, te: i18n.te, locale: session.preferences.locale }));

const subject = computed(() => changeSubject(props.change, labels.value));
const value = (text: string | null) =>
  changeValueText(props.change.field, text, props.change.currencyCode, labels.value);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-0.5">
    <p class="text-label-eyebrow uppercase text-ink-tertiary">{{ subject.kind }}</p>
    <p class="break-words text-body-md font-semibold text-ink">{{ subject.name }}</p>
    <p v-if="subject.path" class="break-words text-body-sm text-ink-secondary">
      {{ subject.path }}
    </p>
  </div>
  <div class="flex min-w-0 flex-col gap-0.5">
    <template v-if="change.field">
      <p class="text-label-eyebrow uppercase text-ink-tertiary">
        {{ t(`changes.field.${change.field}`) }}
      </p>
      <p class="font-data text-body-md text-ink">
        <span class="text-ink-secondary">{{ value(change.before) }}</span>
        <i
          class="pi pi-arrow-right mx-space-xs text-[0.625rem] text-ink-tertiary"
          aria-hidden="true"
        />
        <span class="sr-only">{{ t('changes.becomes') }}</span>
        <span class="font-semibold">{{ value(change.after) }}</span>
      </p>
    </template>
    <p v-else class="text-body-sm text-ink-secondary">{{ t('changes.createNegative') }}</p>
  </div>
</template>
