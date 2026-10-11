<script setup lang="ts">
import { MAX_PRESET_SWITCHES, type PresetSwitch } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import {
  inputClass,
  integerInput,
  labelClass,
  moneyInput,
  numberText,
  useCatalogDraft,
} from './draft';

/**
 * Preset-Wechsel (`phase-5.md` 5.11a): „von Preset → nach Preset“ mit Bedingungen auf die Kennzahlen der
 * Produktgruppe; die Automatik schlägt den Wechsel vor (5.11b), gewechselt wird von Hand.
 */
const { t } = useI18n();
const id = useId();
const { draft, canEdit } = useCatalogDraft();
const names = computed(() => new Map(draft.value.presets.map((p) => [p.key, p.name])));
const name = (key: string) => names.value.get(key) ?? key;
const switchName = (entry: PresetSwitch) => ({ from: name(entry.from), to: name(entry.to) });
const fieldLabel = (field: string, entry: PresetSwitch) =>
  t('catalog.switches.label', { field: t(`catalog.switches.${field}`), ...switchName(entry) });

const from = ref('');
const to = ref('');
const canAdd = computed(
  () =>
    from.value !== '' &&
    to.value !== '' &&
    from.value !== to.value &&
    draft.value.presetSwitches.length < MAX_PRESET_SWITCHES &&
    !draft.value.presetSwitches.some((e) => e.from === from.value && e.to === to.value),
);
function add() {
  if (!canAdd.value) return;
  draft.value.presetSwitches.push({
    from: from.value,
    to: to.value,
    minOrders: null,
    minSpend: null,
    acos: null,
  });
  to.value = '';
}
function setComparison(entry: PresetSwitch, value: string) {
  entry.acos =
    value === 'lte' || value === 'gte'
      ? { comparison: value, percentOfGoal: entry.acos?.percentOfGoal ?? 100 }
      : null;
}
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <p class="max-w-prose text-body-sm text-ink-secondary">
      {{ t('catalog.switches.description') }} {{ t('catalog.switches.eur') }}
    </p>
    <p v-if="draft.presetSwitches.length === 0" class="text-body-md text-ink-secondary">
      {{ t('catalog.switches.empty') }}
    </p>
    <ul v-else class="flex flex-col">
      <li
        v-for="(entry, index) in draft.presetSwitches"
        :key="`${entry.from}>${entry.to}`"
        :data-switch="`${entry.from}>${entry.to}`"
        class="flex min-h-11 flex-wrap items-end gap-space-sm border-b border-line py-space-sm last:border-b-0"
      >
        <span class="min-w-0 flex-1 basis-64 self-center text-body-md text-ink">
          {{ name(entry.from) }} <span aria-hidden="true">→</span> {{ name(entry.to) }}
        </span>
        <label class="flex w-28 flex-col gap-space-xs text-body-sm text-ink-secondary">
          {{ t('catalog.switches.minOrders') }}
          <input
            data-switch-orders
            :value="numberText(entry.minOrders)"
            :aria-label="fieldLabel('minOrders', entry)"
            inputmode="numeric"
            :disabled="!canEdit"
            :class="[inputClass, 'font-data']"
            @input="
              entry.minOrders = integerInput(($event.target as HTMLInputElement).value) ?? null
            "
          />
        </label>
        <label class="flex w-28 flex-col gap-space-xs text-body-sm text-ink-secondary">
          {{ t('catalog.switches.minSpend') }}
          <input
            data-switch-spend
            :value="entry.minSpend ?? ''"
            :aria-label="fieldLabel('minSpend', entry)"
            inputmode="decimal"
            :disabled="!canEdit"
            :class="[inputClass, 'font-data']"
            @input="entry.minSpend = moneyInput(($event.target as HTMLInputElement).value) || null"
          />
        </label>
        <label class="flex w-32 flex-col gap-space-xs text-body-sm text-ink-secondary">
          {{ t('catalog.switches.comparison') }}
          <select
            data-switch-comparison
            :value="entry.acos?.comparison ?? ''"
            :aria-label="fieldLabel('comparison', entry)"
            :disabled="!canEdit"
            :class="inputClass"
            @change="setComparison(entry, ($event.target as HTMLSelectElement).value)"
          >
            <option value="">{{ t('catalog.switches.comparisonValue.none') }}</option>
            <option value="lte">{{ t('catalog.switches.comparisonValue.lte') }}</option>
            <option value="gte">{{ t('catalog.switches.comparisonValue.gte') }}</option>
          </select>
        </label>
        <label
          v-if="entry.acos"
          class="flex w-28 flex-col gap-space-xs text-body-sm text-ink-secondary"
        >
          {{ t('catalog.switches.acos') }}
          <input
            data-switch-acos
            :value="numberText(entry.acos.percentOfGoal)"
            :aria-label="fieldLabel('acos', entry)"
            inputmode="numeric"
            :disabled="!canEdit"
            :class="[inputClass, 'font-data']"
            @input="
              entry.acos.percentOfGoal =
                integerInput(($event.target as HTMLInputElement).value) ?? NaN
            "
          />
        </label>
        <Button
          v-if="canEdit"
          icon="pi pi-times"
          severity="secondary"
          variant="text"
          size="small"
          :aria-label="t('catalog.switches.remove', switchName(entry))"
          @click="draft.presetSwitches.splice(index, 1)"
        />
      </li>
    </ul>
    <div v-if="canEdit" class="flex flex-wrap items-end gap-space-sm">
      <div class="flex min-w-0 flex-1 basis-56 flex-col gap-space-xs">
        <label :for="`${id}-from`" :class="labelClass">{{ t('catalog.switches.from') }}</label>
        <select :id="`${id}-from`" v-model="from" data-switch-from :class="inputClass">
          <option value="" disabled />
          <option v-for="preset in draft.presets" :key="preset.key" :value="preset.key">
            {{ preset.name }}
          </option>
        </select>
      </div>
      <div class="flex min-w-0 flex-1 basis-56 flex-col gap-space-xs">
        <label :for="`${id}-to`" :class="labelClass">{{ t('catalog.switches.to') }}</label>
        <select :id="`${id}-to`" v-model="to" data-switch-to :class="inputClass">
          <option value="" disabled />
          <option v-for="preset in draft.presets" :key="preset.key" :value="preset.key">
            {{ preset.name }}
          </option>
        </select>
      </div>
      <Button
        icon="pi pi-plus"
        severity="secondary"
        data-switch-add
        :label="t('catalog.switches.add')"
        :disabled="!canAdd"
        @click="add"
      />
    </div>
  </section>
</template>
