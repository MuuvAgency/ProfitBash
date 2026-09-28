<script setup lang="ts">
import { compareDecimal } from '@profitbash/shared';
import type { IDoesFilterPassParams, IFilterParams } from 'ag-grid-community';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * Filter für Beträge und Zähler als Decimal-Strings (`phase-2.md` F7): „mindestens“/„höchstens“, verglichen mit
 * `compareDecimal`, nie über `number`. Eingaben mit Komma oder Punkt; fehlende Werte passen nie, sobald er aktiv ist.
 */
export interface DecimalFilterModel {
  min?: string;
  max?: string;
}

const props = defineProps<{ params: IFilterParams & { scale?: number } }>();
const { t } = useI18n();
const id = useId();

const min = ref('');
const max = ref('');

const DECIMAL = /^-?\d+(\.\d+)?$/;
/** Auch „.5“ und „5.“ (wie Tabellenkalkulationen). */
const loose = (value: string) =>
  value.replace(/^(-?)\./, (_, sign: string) => `${sign}0.`).replace(/\.$/, '');
const normalize = (value: string) => value.trim().replace(/\s/g, '').replace(',', '.');
const parsed = (value: string) => {
  const normalized = loose(normalize(value));
  return normalized === '' ? null : DECIMAL.test(normalized) ? normalized : undefined;
};
/**
 * Anteile zeigt das Grid in Prozent, die Werte sind Brüche (0.25 = 25 %): Die Eingabe wird um `scale` Stellen verschoben
 * („30“ → „0.30“), als String, ohne `number`.
 */
function shiftLeft(value: string, places: number): string {
  if (places <= 0) return value;
  const negative = value.startsWith('-');
  const [integer = '0', fraction = ''] = (negative ? value.slice(1) : value).split('.');
  const padded = integer.padStart(places + 1, '0');
  const shifted = `${padded.slice(0, -places)}.${padded.slice(-places)}${fraction}`;
  return `${negative ? '-' : ''}${shifted.replace(/^0+(?=\d)/, '')}`;
}
const bound = (value: string) => {
  const result = parsed(value);
  return result ? shiftLeft(result, props.params.scale ?? 0) : result;
};

const invalid = computed(() => parsed(min.value) === undefined || parsed(max.value) === undefined);

function isFilterActive(): boolean {
  return !invalid.value && (parsed(min.value) !== null || parsed(max.value) !== null);
}

function doesFilterPass({ node }: IDoesFilterPassParams): boolean {
  const value = props.params.getValue(node) as string | null | undefined;
  if (value === null || value === undefined) return false;
  const lower = bound(min.value);
  const upper = bound(max.value);
  if (lower && compareDecimal(value, lower) < 0) return false;
  if (upper && compareDecimal(value, upper) > 0) return false;
  return true;
}

function getModel(): DecimalFilterModel | null {
  if (!isFilterActive()) return null;
  const lower = parsed(min.value);
  const upper = parsed(max.value);
  return { ...(lower && { min: lower }), ...(upper && { max: upper }) };
}

function setModel(model: DecimalFilterModel | null) {
  min.value = model?.min ?? '';
  max.value = model?.max ?? '';
}

function onInput() {
  // Auch bei ungültiger Eingabe melden: dann ist der Filter inaktiv und die Zeilen erscheinen wieder.
  props.params.filterChangedCallback();
}

defineExpose({ isFilterActive, doesFilterPass, getModel, setModel });
</script>

<template>
  <div class="flex w-56 flex-col gap-space-sm p-space-sm text-body-sm">
    <label :for="`${id}-min`" class="flex flex-col gap-1 text-ink-secondary">
      {{ t('explorer.decimalFilter.min') }}
      <input
        :id="`${id}-min`"
        v-model="min"
        inputmode="decimal"
        class="rounded-control border border-outline bg-tile-peak px-2 py-1 font-data text-ink"
        @input="onInput"
      />
    </label>
    <label :for="`${id}-max`" class="flex flex-col gap-1 text-ink-secondary">
      {{ t('explorer.decimalFilter.max') }}
      <input
        :id="`${id}-max`"
        v-model="max"
        inputmode="decimal"
        class="rounded-control border border-outline bg-tile-peak px-2 py-1 font-data text-ink"
        @input="onInput"
      />
    </label>
    <p v-if="invalid" class="text-loss">{{ t('explorer.decimalFilter.invalid') }}</p>
  </div>
</template>
