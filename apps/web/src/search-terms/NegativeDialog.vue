<script setup lang="ts">
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import type { SearchTermRowData, StageAdChangesData } from '../api/client';
import { useStageChanges } from '../changes/queries';
import StageResult from '../changes/StageResult.vue';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import {
  isAsinSearchTerm,
  negativeInputs,
  type NegativeLevel,
  type NegativeMatchType,
} from './actions';

/**
 * „Negativ anlegen“ für Suchbegriffe (`phase-3.md` 3.8, F9): Standard ist „negativ exakt“ in der Ad Group der
 * Zeile, umstellbar auf Kampagnenebene und Wortgruppe. Die Negatives landen im Warenkorb (Herkunft
 * `search_terms`), an Amazon geht erst etwas beim Übermitteln. Was es an der Stelle schon gibt, lehnt der Server ab
 * (`alreadyExists`, steht im Ergebnis); geschützte Begriffe des Clients gehen nur mit Bestätigung mit.
 */
const props = defineProps<{ visible: boolean; rows: SearchTermRowData[] }>();
const emit = defineEmits<{ close: []; staged: [] }>();

const { t } = useI18n();
const stage = useStageChanges('search_terms');

const level = ref<NegativeLevel>('adGroup');
const matchType = ref<NegativeMatchType>('EXACT');
const confirmProtected = ref(false);
const result = ref<StageAdChangesData | null>(null);
const errorKey = ref<string | null>(null);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    level.value = 'adGroup';
    matchType.value = 'EXACT';
    confirmProtected.value = false;
    result.value = null;
    errorKey.value = null;
    stage.reset();
  },
  { immediate: true },
);

const prepared = computed(() =>
  negativeInputs(props.rows, {
    level: level.value,
    matchType: matchType.value,
    confirmProtected: confirmProtected.value,
  }),
);
const protectedCount = computed(() => props.rows.filter((row) => row.protected).length);
const hasKeywords = computed(() => props.rows.some((row) => !isAsinSearchTerm(row.searchTerm)));
const hasAsins = computed(() => props.rows.some((row) => isAsinSearchTerm(row.searchTerm)));
const single = computed(() => (props.rows.length === 1 ? props.rows[0]! : null));
const canSubmit = computed(() => prepared.value.inputs.length > 0 && !stage.isPending.value);

async function submit() {
  if (!canSubmit.value) return;
  errorKey.value = null;
  try {
    result.value = await stage.mutateAsync(prepared.value.inputs);
    emit('staged');
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :closable="!stage.isPending.value"
    :close-on-escape="!stage.isPending.value"
    :header="
      single
        ? t('searchTerms.negative.titleOne', { term: single.searchTerm })
        : t('searchTerms.negative.title', { count: rows.length }, rows.length)
    "
    :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
    @update:visible="(next) => !next && emit('close')"
  >
    <div v-if="result" class="flex flex-col gap-space-lg">
      <StageResult :result="result" />
      <p class="text-body-sm text-ink-secondary">{{ t('searchTerms.negative.nextStep') }}</p>
      <div class="flex justify-end">
        <Button type="button" :label="t('common.close')" @click="emit('close')" />
      </div>
    </div>

    <form v-else class="flex flex-col gap-space-lg" @submit.prevent="submit">
      <InlineError v-if="errorKey" :message="t(errorKey)" />

      <fieldset class="flex flex-col gap-space-xs">
        <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('searchTerms.negative.level.label') }}
        </legend>
        <label
          v-for="option in ['adGroup', 'campaign'] as const"
          :key="option"
          class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
        >
          <input
            v-model="level"
            type="radio"
            name="negative-level"
            :value="option"
            class="size-4 accent-violet"
          />
          {{ t(`searchTerms.negative.level.${option}`) }}
        </label>
      </fieldset>

      <fieldset v-if="hasKeywords" class="flex flex-col gap-space-xs">
        <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('searchTerms.negative.matchType.label') }}
        </legend>
        <label
          v-for="option in ['EXACT', 'PHRASE'] as const"
          :key="option"
          class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
        >
          <input
            v-model="matchType"
            type="radio"
            name="negative-match-type"
            :value="option"
            class="size-4 accent-violet"
          />
          {{ t(`searchTerms.negative.matchType.${option}`) }}
        </label>
      </fieldset>
      <p v-if="hasAsins" class="text-body-sm text-ink-secondary">
        {{ t('searchTerms.negative.asinHint') }}
      </p>

      <div
        v-if="protectedCount > 0"
        class="flex flex-col gap-space-xs rounded-control bg-well px-space-md py-space-sm"
      >
        <p class="text-body-sm text-ink">
          <i class="pi pi-shield mr-space-xs text-warn" aria-hidden="true" />{{
            t('searchTerms.negative.protected', { count: protectedCount }, protectedCount)
          }}
        </p>
        <label class="flex min-h-11 items-center gap-space-sm text-body-md text-ink">
          <input
            v-model="confirmProtected"
            data-confirm-protected
            type="checkbox"
            class="size-4 accent-violet"
          />
          {{ t('searchTerms.negative.confirmProtected', protectedCount) }}
        </label>
      </div>

      <p
        v-if="prepared.skipped.noEntity > 0"
        class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
      >
        <i class="pi pi-info-circle mr-space-xs text-warn" aria-hidden="true" />{{
          t(
            'searchTerms.negative.skipped.noEntity',
            { count: prepared.skipped.noEntity },
            prepared.skipped.noEntity,
          )
        }}
      </p>
      <p
        v-if="prepared.skipped.tooLong > 0"
        class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
      >
        <i class="pi pi-info-circle mr-space-xs text-warn" aria-hidden="true" />{{
          t(
            'searchTerms.negative.skipped.tooLong',
            { count: prepared.skipped.tooLong },
            prepared.skipped.tooLong,
          )
        }}
      </p>

      <p class="text-body-sm text-ink-secondary" data-negative-summary>
        {{
          t(
            'searchTerms.negative.summary',
            { count: prepared.inputs.length },
            prepared.inputs.length,
          )
        }}
        {{ t('searchTerms.negative.existingHint') }}
      </p>

      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('common.cancel')"
          severity="secondary"
          variant="text"
          :disabled="stage.isPending.value"
          @click="emit('close')"
        />
        <Button
          type="submit"
          data-negative-submit
          :label="t('searchTerms.negative.submit')"
          :loading="stage.isPending.value"
          :disabled="!canSubmit"
        />
      </div>
    </form>
  </Dialog>
</template>
