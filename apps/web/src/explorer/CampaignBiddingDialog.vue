<script setup lang="ts">
import {
  AD_CHANGE_BIDDING_STRATEGIES,
  AD_CHANGE_PLACEMENTS,
  type AdChangeField,
  type AdChangePlacementField,
} from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import type { AdChangeInputData, StageAdChangesData } from '../api/client';
import { useStageChanges } from '../changes/queries';
import StageResult from '../changes/StageResult.vue';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { amazonLabel } from './amazon-labels';
import type { GridRow } from './columns';
import { currentFieldValue, parsePercentInput, type OpenEntry } from './editing';

/**
 * Gebotsstrategie und Gebotsanpassung je Platzierung einer SP-Kampagne (`phase-3.md` F3, 3.5). Der Dialog zeigt den
 * Stand von Amazon bzw. die eigene Vormerkung und schickt beim Speichern nur die Felder, die hier geändert wurden
 * (ein Wert, der wieder dem Stand von Amazon entspricht, nimmt die Vormerkung zurück).
 */
const props = defineProps<{
  visible: boolean;
  row: GridRow | null;
  /** Offene Änderungen an einem Feld der Kampagne. */
  entryFor: (row: GridRow, field: AdChangeField) => OpenEntry | undefined;
  /**
   * Die offenen Änderungen sind geladen. Ohne sie zeigte der Dialog statt einer eigenen Vormerkung den Stand von
   * Amazon, und Speichern nähme die Vormerkung zurück.
   */
  ready: boolean;
}>();
const emit = defineEmits<{ close: []; staged: [] }>();

const i18n = useI18n();
const { t } = i18n;
const id = useId();
const stage = useStageChanges();

const placementFields = Object.keys(AD_CHANGE_PLACEMENTS) as AdChangePlacementField[];
const strategy = ref('');
const placements = ref<Record<string, string>>({});
/** Werte beim Öffnen: Gesendet wird nur, was davon abweicht. */
const initial = ref<Record<string, string>>({});
const result = ref<StageAdChangesData | null>(null);
const errorKey = ref<string | null>(null);

const valueOf = (row: GridRow, field: AdChangeField) =>
  props.entryFor(row, field)?.mine?.after ?? currentFieldValue(row, field);

watch(
  // Auch wenn die offenen Änderungen erst nach dem Öffnen eintreffen.
  () => [props.visible, props.row?.id, props.ready] as const,
  ([visible]) => {
    if (!visible || !props.row) return;
    strategy.value = valueOf(props.row, 'bidding_strategy') ?? '';
    placements.value = Object.fromEntries(
      placementFields.map((field) => [field, valueOf(props.row!, field) ?? '0']),
    );
    initial.value = { bidding_strategy: strategy.value, ...placements.value };
    result.value = null;
    errorKey.value = null;
    stage.reset();
  },
  { immediate: true },
);

const settable = (value: string) =>
  (AD_CHANGE_BIDDING_STRATEGIES as readonly string[]).includes(value);
const strategyOptions = computed(() => [
  // Regelbasiert oder unbekannt: bleibt stehen, lässt sich hier aber nicht wählen.
  ...(strategy.value && !settable(strategy.value)
    ? [{ value: strategy.value, disabled: true }]
    : []),
  ...AD_CHANGE_BIDDING_STRATEGIES.map((value) => ({ value, disabled: false })),
]);
const strategyLabel = (value: string) =>
  amazonLabel('biddingStrategy', value, { t, te: i18n.te }) ?? value;

const parsed = computed(() =>
  Object.fromEntries(
    placementFields.map((field) => [field, parsePercentInput(placements.value[field] ?? '')]),
  ),
);
const invalid = computed(() => placementFields.filter((field) => parsed.value[field] === null));
/** Ohne setzbare Strategie nimmt Amazon keine Gebotsanpassungen an (`BIDDING_STRATEGY_NOT_SUPPORTED`). */
const strategyMissing = computed(() => !settable(strategy.value));
const changedFields = computed(() => [
  ...(settable(strategy.value) && strategy.value !== initial.value.bidding_strategy
    ? (['bidding_strategy'] as const)
    : []),
  ...placementFields.filter(
    (field) => parsed.value[field] !== null && parsed.value[field] !== initial.value[field],
  ),
]);
const canSubmit = computed(
  () =>
    props.row !== null &&
    props.ready &&
    invalid.value.length === 0 &&
    changedFields.value.length > 0 &&
    // Ohne setzbare Strategie scheiterten Platzierungen erst beim Übermitteln.
    !strategyMissing.value &&
    !stage.isPending.value,
);

async function submit() {
  const row = props.row;
  if (!row || !canSubmit.value) return;
  errorKey.value = null;
  const update = (field: AdChangeField, value: string): AdChangeInputData => ({
    operation: 'update',
    entityType: 'campaign',
    entityId: row.id,
    field,
    value,
  });
  const inputs = changedFields.value.map((field) =>
    update(field, field === 'bidding_strategy' ? strategy.value : parsed.value[field]!),
  );
  try {
    result.value = await stage.mutateAsync(inputs);
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
    :header="t('explorer.bidding.title')"
    :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
    @update:visible="(next) => !next && emit('close')"
  >
    <div v-if="row" class="flex flex-col gap-space-lg">
      <p class="text-body-md font-semibold text-ink">{{ row.name ?? t('explorer.unknownName') }}</p>

      <template v-if="result">
        <StageResult :result="result" />
        <p class="text-body-sm text-ink-secondary">{{ t('explorer.bulk.nextStep') }}</p>
        <div class="flex justify-end">
          <Button type="button" :label="t('common.close')" @click="emit('close')" />
        </div>
      </template>

      <form v-else class="flex flex-col gap-space-lg" @submit.prevent="submit">
        <InlineError v-if="errorKey" :message="t(errorKey)" />
        <p
          v-if="!ready"
          role="status"
          class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
        >
          <i class="pi pi-info-circle mr-space-xs text-warn" aria-hidden="true" />{{
            t('explorer.bidding.notReady')
          }}
        </p>
        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-strategy`" class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('explorer.column.biddingStrategy') }}
          </label>
          <select
            :id="`${id}-strategy`"
            v-model="strategy"
            data-bidding-strategy
            class="h-11 rounded-control bg-well px-space-md text-body-md text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet"
          >
            <option v-if="!strategy" value="" disabled>
              {{ t('explorer.bidding.noStrategy') }}
            </option>
            <option
              v-for="option in strategyOptions"
              :key="option.value"
              :value="option.value"
              :disabled="option.disabled"
            >
              {{ strategyLabel(option.value) }}
            </option>
          </select>
          <p v-if="strategyMissing" class="text-body-sm text-on-loss-wash">
            {{ t('explorer.bidding.strategyMissing') }}
          </p>
        </div>

        <fieldset class="flex flex-col gap-space-sm">
          <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('explorer.bidding.placements') }}
          </legend>
          <div
            v-for="field in placementFields"
            :key="field"
            class="flex items-center justify-between gap-space-md"
          >
            <label :for="`${id}-${field}`" class="text-body-md text-ink">
              {{ t(`explorer.bidding.placement.${field}`) }}
            </label>
            <span class="flex items-center gap-space-xs">
              <input
                :id="`${id}-${field}`"
                v-model="placements[field]"
                :data-placement="field"
                type="text"
                inputmode="numeric"
                autocomplete="off"
                :aria-invalid="parsed[field] === null ? 'true' : undefined"
                :class="[
                  'h-11 w-24 rounded-control bg-well px-space-md text-right font-data text-ink outline-none focus-visible:ring-2',
                  parsed[field] === null ? 'ring-2 ring-loss' : 'focus-visible:ring-violet',
                ]"
              />
              <span class="font-data text-ink-secondary" aria-hidden="true">%</span>
            </span>
          </div>
          <p :class="['text-body-sm', invalid.length ? 'text-on-loss-wash' : 'text-ink-secondary']">
            {{ t('explorer.bidding.placementHint') }}
          </p>
        </fieldset>

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
            data-bidding-submit
            :label="t('explorer.bulk.submit')"
            :loading="stage.isPending.value"
            :disabled="!canSubmit"
          />
        </div>
      </form>
    </div>
  </Dialog>
</template>
