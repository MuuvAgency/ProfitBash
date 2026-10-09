<script setup lang="ts">
import {
  AD_CHANGE_STATES,
  adChangeAdjustmentIssue,
  type AdChangeField,
  type ExplorerLevel,
} from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { ApiError } from '../api';
import type { StageAdChangesData } from '../api/client';
import { useStageChanges } from '../changes/queries';
import StageResult from '../changes/StageResult.vue';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { parseDecimalInput } from '../search-terms/decimal-input';
import type { GridRow } from './columns';
import {
  bulkInputs,
  editIssue,
  fieldCurrency,
  parseMoneyInput,
  type BulkEdit,
  type MoneyField,
} from './editing';

/**
 * Bulk-Dialog für markierte Zeilen (`phase-3.md` 3.5): Status setzen oder einen Betrag (Budget, Standardgebot, Gebot)
 * ändern: fester Wert, ±Prozent oder ±Betrag (Dominik, 2026-10-08). Prozent und Beträge rechnet der Server auf den
 * Stand der Entity; feste Werte und Beträge gelten je Währung der Zeile. Die Änderungen landen im Warenkorb.
 */
const props = defineProps<{
  visible: boolean;
  level: ExplorerLevel;
  field: Extract<AdChangeField, 'state' | MoneyField>;
  rows: GridRow[];
}>();
const emit = defineEmits<{ close: []; staged: [] }>();

const { t } = useI18n();
const id = useId();
const stage = useStageChanges();

const isState = computed(() => props.field === 'state');
const editable = computed(() =>
  props.rows.filter((row) => editIssue(props.level, row, props.field) === null),
);
const skippedCount = computed(() => props.rows.length - editable.value.length);
const currencies = computed(() =>
  isState.value
    ? []
    : [
        ...new Set(editable.value.map((row) => fieldCurrency(row, props.field as MoneyField))),
      ].sort(),
);
const stateOptions = computed(() =>
  // Negatives lassen sich nur archivieren (F3).
  props.level === 'negative' ? (['ARCHIVED'] as const) : AD_CHANGE_STATES,
);

const state = ref<string | null>(null);
const mode = ref<'fixed' | 'percent' | 'amount'>('fixed');
const direction = ref<'increase' | 'decrease'>('increase');
const percentText = ref('');
const amountTexts = ref<Record<string, string>>({});
const result = ref<StageAdChangesData | null>(null);
const errorKey = ref<string | null>(null);

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    state.value = props.level === 'negative' ? 'ARCHIVED' : null;
    mode.value = 'fixed';
    direction.value = 'increase';
    percentText.value = '';
    amountTexts.value = {};
    result.value = null;
    errorKey.value = null;
    stage.reset();
  },
  { immediate: true },
);

// Ein Wert für „fester Wert“ ist kein Betrag für „erhöhen um“: beim Wechsel der Art leeren.
watch(mode, () => {
  percentText.value = '';
  amountTexts.value = {};
});

/** Prozent: Decimal-String über 0 mit höchstens zwei Nachkommastellen, beim Senken unter 100. */
const percent = computed(() => {
  const value = parseDecimalInput(percentText.value);
  if (value === null) return null;
  const signed = `${direction.value === 'decrease' ? '-' : ''}${value}`;
  return adChangeAdjustmentIssue('percent', signed) === null ? value : null;
});
const amounts = computed(() => {
  const values: Record<string, string> = {};
  for (const currency of currencies.value) {
    const value = parseMoneyInput(amountTexts.value[currency] ?? '');
    if (value !== null) values[currency] = value;
  }
  return values;
});

const percentInvalid = computed(() => percentText.value.trim() !== '' && percent.value === null);
const amountInvalid = (currency: string) =>
  (amountTexts.value[currency] ?? '').trim() !== '' && amounts.value[currency] === undefined;

const edit = computed<BulkEdit | null>(() => {
  if (props.field === 'state') {
    return state.value ? { field: 'state', value: state.value } : null;
  }
  if (mode.value === 'percent') {
    return percent.value === null
      ? null
      : { field: props.field, mode: 'percent', direction: direction.value, value: percent.value };
  }
  // Jede Währung braucht ihren Wert: Sonst bliebe ein Teil der markierten Zeilen still unverändert.
  if (Object.keys(amounts.value).length !== currencies.value.length) return null;
  return mode.value === 'fixed'
    ? { field: props.field, mode: 'fixed', values: amounts.value }
    : { field: props.field, mode: 'amount', direction: direction.value, values: amounts.value };
});
const canSubmit = computed(
  () => edit.value !== null && editable.value.length > 0 && !stage.isPending.value,
);

async function submit() {
  if (!edit.value || !canSubmit.value) return;
  errorKey.value = null;
  const { inputs } = bulkInputs(props.level, props.rows, edit.value);
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
    :header="
      t(`explorer.bulk.title.${field}`, {
        count: editable.length,
        entity: t(`explorer.bulk.entity.${level}`, editable.length),
      })
    "
    :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
    @update:visible="(next) => !next && emit('close')"
  >
    <div v-if="result" class="flex flex-col gap-space-lg">
      <StageResult :result="result" />
      <p class="text-body-sm text-ink-secondary">{{ t('explorer.bulk.nextStep') }}</p>
      <div class="flex justify-end">
        <Button type="button" :label="t('common.close')" @click="emit('close')" />
      </div>
    </div>

    <form v-else class="flex flex-col gap-space-lg" @submit.prevent="submit">
      <InlineError v-if="errorKey" :message="t(errorKey)" />
      <p
        v-if="skippedCount > 0"
        class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink"
      >
        <i class="pi pi-info-circle mr-space-xs text-warn" aria-hidden="true" />{{
          t('explorer.bulk.skipped', { count: skippedCount }, skippedCount)
        }}
      </p>

      <fieldset v-if="isState" class="flex flex-col gap-space-sm">
        <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('explorer.bulk.newState') }}
        </legend>
        <label
          v-for="option in stateOptions"
          :key="option"
          class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
        >
          <input
            v-model="state"
            type="radio"
            name="state"
            :value="option"
            class="size-4 accent-violet"
          />
          {{ t(`explorer.state.${option}`) }}
        </label>
        <p v-if="state === 'ARCHIVED'" class="text-body-sm text-on-loss-wash">
          <i class="pi pi-exclamation-triangle mr-space-xs" aria-hidden="true" />{{
            t('explorer.bulk.archiveWarning')
          }}
        </p>
      </fieldset>

      <template v-else>
        <fieldset class="flex flex-col gap-space-xs">
          <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('explorer.bulk.mode.label') }}
          </legend>
          <label
            v-for="option in ['fixed', 'percent', 'amount'] as const"
            :key="option"
            class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
          >
            <input
              v-model="mode"
              type="radio"
              name="mode"
              :value="option"
              class="size-4 accent-violet"
            />
            {{ t(`explorer.bulk.mode.${option}`) }}
          </label>
        </fieldset>

        <fieldset v-if="mode !== 'fixed'" class="flex flex-wrap gap-x-space-lg">
          <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('explorer.bulk.direction.label') }}
          </legend>
          <label
            v-for="option in ['increase', 'decrease'] as const"
            :key="option"
            class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
          >
            <input
              v-model="direction"
              type="radio"
              name="direction"
              :value="option"
              class="size-4 accent-violet"
            />
            {{ t(`explorer.bulk.direction.${option}`) }}
          </label>
        </fieldset>

        <div v-if="mode === 'percent'" class="flex flex-col gap-space-xs">
          <label :for="`${id}-percent`" class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('explorer.bulk.percentLabel') }}
          </label>
          <input
            :id="`${id}-percent`"
            v-model="percentText"
            data-bulk-value
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :aria-invalid="percentInvalid ? 'true' : undefined"
            :aria-describedby="percentInvalid ? `${id}-percent-hint` : undefined"
            :class="[
              'h-11 w-40 rounded-control bg-well px-space-md font-data text-ink outline-none focus-visible:ring-2',
              percentInvalid ? 'ring-2 ring-loss' : 'focus-visible:ring-violet',
            ]"
          />
          <p
            v-if="percentInvalid"
            :id="`${id}-percent-hint`"
            class="text-body-sm text-on-loss-wash"
          >
            {{ t('explorer.bulk.invalidPercent') }}
          </p>
        </div>
        <div v-else class="flex flex-wrap gap-space-md">
          <div v-for="currency in currencies" :key="currency" class="flex flex-col gap-space-xs">
            <label
              :for="`${id}-amount-${currency}`"
              class="text-label-eyebrow uppercase text-ink-tertiary"
            >
              {{ t(`explorer.bulk.amountLabel.${mode}`, { currency }) }}
            </label>
            <input
              :id="`${id}-amount-${currency}`"
              v-model="amountTexts[currency]"
              data-bulk-value
              type="text"
              inputmode="decimal"
              autocomplete="off"
              :aria-invalid="amountInvalid(currency) ? 'true' : undefined"
              :aria-describedby="amountInvalid(currency) ? `${id}-amount-hint` : undefined"
              :class="[
                'h-11 w-40 rounded-control bg-well px-space-md font-data text-ink outline-none focus-visible:ring-2',
                amountInvalid(currency) ? 'ring-2 ring-loss' : 'focus-visible:ring-violet',
              ]"
            />
          </div>
          <p
            v-if="currencies.some(amountInvalid)"
            :id="`${id}-amount-hint`"
            class="w-full text-body-sm text-on-loss-wash"
          >
            {{ t('explorer.edit.invalidMoney') }}
          </p>
        </div>
        <p class="text-body-sm text-ink-secondary">
          {{ t(mode === 'fixed' ? 'explorer.bulk.hint.fixed' : 'explorer.bulk.hint.relative') }}
        </p>
      </template>

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
          data-bulk-submit
          :label="t('explorer.bulk.submit')"
          :loading="stage.isPending.value"
          :disabled="!canSubmit"
        />
      </div>
    </form>
  </Dialog>
</template>
