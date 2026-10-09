<script setup lang="ts">
import { CATALOG_AD_PRODUCTS, MAX_CATALOG_PRESETS, type CatalogPreset } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { inputClass, integerInput, labelClass, moneyInput, useCatalogDraft } from './draft';

/** Presets: Name, Beschreibung, Standard, Bausteine und Abweichungen je Baustein (`phase-4.md` 4.2, F-S8). */
const { t } = useI18n();
const id = useId();
const { draft, canEdit } = useCatalogDraft();
const blocksByProduct = computed(() =>
  CATALOG_AD_PRODUCTS.map((adProduct) => ({
    adProduct,
    blocks: draft.value.blocks.filter((block) => block.adProduct === adProduct),
  })).filter((group) => group.blocks.length > 0),
);
const blockByKey = computed(() => new Map(draft.value.blocks.map((block) => [block.key, block])));

const entry = (preset: CatalogPreset, key: string) => preset.blocks.find((e) => e.block === key);
function toggle(preset: CatalogPreset, key: string) {
  if (entry(preset, key)) preset.blocks = preset.blocks.filter((e) => e.block !== key);
  else {
    // In der Reihenfolge des Katalogs einsortieren.
    const order = draft.value.blocks.map((block) => block.key);
    preset.blocks = [...preset.blocks, { block: key }].sort(
      (a, b) => order.indexOf(a.block) - order.indexOf(b.block),
    );
  }
}
function setDefault(key: string) {
  for (const preset of draft.value.presets) preset.isDefault = preset.key === key;
}
type OverrideField = 'defaultBid' | 'dailyBudget' | 'topOfSearch' | 'lookbackDays';
function setOverride(preset: CatalogPreset, key: string, field: OverrideField, raw: string) {
  const target = entry(preset, key);
  if (!target) return;
  if (field === 'defaultBid' || field === 'dailyBudget') {
    const value = moneyInput(raw);
    if (value === '') delete target[field];
    else target[field] = value;
  } else {
    const value = integerInput(raw);
    if (value === undefined) delete target[field];
    else target[field] = value;
  }
}

function addPreset() {
  let number = draft.value.presets.length + 1;
  while (draft.value.presets.some((preset) => preset.key === `preset-${number}`)) number++;
  draft.value.presets.push({
    key: `preset-${number}`,
    name: t('catalog.preset.newName'),
    description: '',
    blocks:
      draft.value.presets.find((preset) => preset.isDefault)?.blocks.map((e) => ({ ...e })) ?? [],
    isDefault: false,
  });
}
function removePreset(key: string) {
  draft.value.presets = draft.value.presets.filter((preset) => preset.key !== key);
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <section
      v-for="preset in draft.presets"
      :key="preset.key"
      :data-preset="preset.key"
      class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    >
      <div class="flex flex-wrap items-end gap-space-md">
        <div class="flex min-w-0 flex-1 basis-56 flex-col gap-space-xs">
          <label :for="`${id}-${preset.key}-name`" :class="labelClass">{{
            t('catalog.preset.name')
          }}</label>
          <input
            :id="`${id}-${preset.key}-name`"
            v-model="preset.name"
            data-preset-name
            type="text"
            autocomplete="off"
            :disabled="!canEdit"
            :class="inputClass"
          />
        </div>
        <label class="flex min-h-11 items-center gap-space-sm text-body-md text-ink">
          <input
            type="radio"
            name="preset-default"
            :value="preset.key"
            :checked="preset.isDefault"
            :disabled="!canEdit"
            class="size-4 accent-violet"
            @change="setDefault(preset.key)"
          />
          {{ t('catalog.preset.default') }}
        </label>
        <Button
          v-if="canEdit && !preset.isDefault"
          icon="pi pi-trash"
          severity="secondary"
          variant="text"
          size="small"
          :aria-label="t('catalog.preset.remove', { name: preset.name })"
          @click="removePreset(preset.key)"
        />
      </div>
      <div class="flex flex-col gap-space-xs">
        <label :for="`${id}-${preset.key}-description`" :class="labelClass">{{
          t('catalog.preset.description')
        }}</label>
        <textarea
          :id="`${id}-${preset.key}-description`"
          v-model="preset.description"
          rows="2"
          :disabled="!canEdit"
          class="min-w-0 rounded-control bg-well px-space-md py-space-sm text-body-md text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet disabled:text-ink-secondary"
        />
      </div>

      <fieldset
        v-for="group in blocksByProduct"
        :key="group.adProduct"
        class="flex min-w-0 flex-col gap-space-xs"
      >
        <legend :class="['mb-space-xs', labelClass]">
          {{ t(`catalog.adProduct.${group.adProduct}`) }}
        </legend>
        <div class="flex flex-wrap gap-x-space-lg">
          <label
            v-for="block in group.blocks"
            :key="block.key"
            class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
          >
            <input
              type="checkbox"
              :data-preset-block="block.key"
              :checked="entry(preset, block.key) !== undefined"
              :disabled="!canEdit"
              class="size-4 accent-violet"
              @change="toggle(preset, block.key)"
            />
            {{ block.label }}
            <span class="font-data text-body-sm text-ink-tertiary">{{ block.code }}</span>
          </label>
        </div>
      </fieldset>

      <details v-if="preset.blocks.length > 0" class="flex flex-col gap-space-sm">
        <summary class="min-h-11 cursor-pointer py-space-sm text-body-md text-violet">
          {{ t('catalog.preset.overrides') }}
        </summary>
        <ul class="flex flex-col">
          <li
            v-for="item in preset.blocks"
            :key="item.block"
            class="flex flex-wrap items-end gap-space-sm border-b border-line py-space-sm last:border-b-0"
          >
            <span class="min-w-0 flex-1 basis-40 text-body-md text-ink">
              {{ blockByKey.get(item.block)?.label ?? item.block }}
            </span>
            <label class="flex w-28 flex-col gap-space-xs text-body-sm text-ink-secondary">
              {{ t('catalog.preset.bid') }}
              <input
                :value="item.defaultBid ?? ''"
                :placeholder="blockByKey.get(item.block)?.defaultBid"
                inputmode="decimal"
                :disabled="!canEdit"
                :class="[inputClass, 'font-data']"
                @input="
                  setOverride(
                    preset,
                    item.block,
                    'defaultBid',
                    ($event.target as HTMLInputElement).value,
                  )
                "
              />
            </label>
            <label class="flex w-28 flex-col gap-space-xs text-body-sm text-ink-secondary">
              {{ t('catalog.preset.budget') }}
              <input
                :value="item.dailyBudget ?? ''"
                :placeholder="blockByKey.get(item.block)?.dailyBudget"
                inputmode="decimal"
                :disabled="!canEdit"
                :class="[inputClass, 'font-data']"
                @input="
                  setOverride(
                    preset,
                    item.block,
                    'dailyBudget',
                    ($event.target as HTMLInputElement).value,
                  )
                "
              />
            </label>
            <label
              v-if="blockByKey.get(item.block)?.placements"
              class="flex w-28 flex-col gap-space-xs text-body-sm text-ink-secondary"
            >
              {{ t('catalog.preset.top') }}
              <input
                :value="item.topOfSearch ?? ''"
                :placeholder="String(blockByKey.get(item.block)?.placements?.topOfSearch ?? '')"
                inputmode="numeric"
                :disabled="!canEdit"
                :class="[inputClass, 'font-data']"
                @input="
                  setOverride(
                    preset,
                    item.block,
                    'topOfSearch',
                    ($event.target as HTMLInputElement).value,
                  )
                "
              />
            </label>
            <label
              v-if="blockByKey.get(item.block)?.lookbackDays"
              class="flex w-28 flex-col gap-space-xs text-body-sm text-ink-secondary"
            >
              {{ t('catalog.preset.lookback') }}
              <input
                :value="item.lookbackDays ?? ''"
                :placeholder="String(blockByKey.get(item.block)?.lookbackDays ?? '')"
                inputmode="numeric"
                :disabled="!canEdit"
                :class="[inputClass, 'font-data']"
                @input="
                  setOverride(
                    preset,
                    item.block,
                    'lookbackDays',
                    ($event.target as HTMLInputElement).value,
                  )
                "
              />
            </label>
          </li>
        </ul>
      </details>
    </section>

    <div v-if="canEdit && draft.presets.length < MAX_CATALOG_PRESETS">
      <Button
        icon="pi pi-plus"
        severity="secondary"
        data-preset-add
        :label="t('catalog.preset.add')"
        @click="addPreset"
      />
    </div>
  </div>
</template>
