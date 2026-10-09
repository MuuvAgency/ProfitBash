<script setup lang="ts">
import {
  BLOCK_BIDDING_STRATEGIES,
  BLOCK_SD_OPTIMIZATIONS,
  type CatalogBlock,
} from '@profitbash/shared';
import { useI18n } from 'vue-i18n';
import { inputClass, integerInput, labelClass, moneyInput, useCatalogDraft } from './draft';

/**
 * Bausteine: Werte ändern (Bezeichnung, Kürzel, Gebote, Budget, Strategie, Platzierungen, Rückblick). Art und Targeting
 * eines Bausteins sind fest; neue Arten von Bausteinen kommen mit dem Setup, das sie anlegen kann (4.4, 4.9, 4.10).
 */
const { t } = useI18n();
const { draft, canEdit } = useCatalogDraft();

type PlacementField = 'topOfSearch' | 'productPages' | 'restOfSearch';
const PLACEMENTS: PlacementField[] = ['topOfSearch', 'productPages', 'restOfSearch'];
function setPlacement(block: CatalogBlock, field: PlacementField, raw: string) {
  if (!block.placements) return;
  block.placements[field] = integerInput(raw) ?? 0;
}
function setLookback(block: CatalogBlock, raw: string) {
  block.lookbackDays = integerInput(raw) ?? null;
}
function targetingText(block: CatalogBlock) {
  const parts = [t(`catalog.targeting.${block.targeting}`)];
  if (block.matchType) parts.push(t(`catalog.matchType.${block.matchType}`));
  if (block.productMatch) parts.push(t(`catalog.productMatch.${block.productMatch}`));
  return parts.join(', ');
}
const fieldClass = 'flex min-w-0 flex-col gap-space-xs text-body-sm text-ink-secondary';
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <p class="text-body-sm text-ink-secondary">{{ t('catalog.eur') }}</p>
    <section
      v-for="block in draft.blocks"
      :key="block.key"
      :data-block="block.key"
      class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    >
      <header class="flex flex-wrap items-baseline gap-x-space-md gap-y-space-xs">
        <h3 class="text-body-md font-semibold text-ink">{{ block.label }}</h3>
        <span class="font-data text-body-sm text-ink-tertiary">{{ block.key }}</span>
        <span class="text-body-sm text-ink-secondary">
          {{ t(`catalog.adProduct.${block.adProduct}`) }} · {{ targetingText(block) }} ·
          {{ t(`catalog.block.structureValue.${block.structure}`) }} ·
          {{ t(`catalog.source.${block.source}`) }}
        </span>
      </header>
      <p v-if="block.description" class="max-w-prose text-body-sm text-ink-secondary">
        {{ block.description }}
      </p>
      <div class="grid grid-cols-1 gap-space-md sm:grid-cols-2 lg:grid-cols-4">
        <label :class="fieldClass">
          <span :class="labelClass">{{ t('catalog.block.label') }}</span>
          <input v-model="block.label" type="text" :disabled="!canEdit" :class="inputClass" />
        </label>
        <label :class="fieldClass">
          <span :class="labelClass">{{ t('catalog.block.code') }}</span>
          <input
            :value="block.code"
            type="text"
            :disabled="!canEdit"
            :class="[inputClass, 'font-data uppercase']"
            @input="block.code = ($event.target as HTMLInputElement).value.trim().toUpperCase()"
          />
        </label>
        <label :class="fieldClass">
          <span :class="labelClass">{{ t('catalog.block.bid') }}</span>
          <input
            :value="block.defaultBid"
            data-block-bid
            inputmode="decimal"
            :disabled="!canEdit"
            :class="[inputClass, 'font-data']"
            @input="block.defaultBid = moneyInput(($event.target as HTMLInputElement).value)"
          />
        </label>
        <label :class="fieldClass">
          <span :class="labelClass">{{ t('catalog.block.budget') }}</span>
          <input
            :value="block.dailyBudget"
            data-block-budget
            inputmode="decimal"
            :disabled="!canEdit"
            :class="[inputClass, 'font-data']"
            @input="block.dailyBudget = moneyInput(($event.target as HTMLInputElement).value)"
          />
        </label>
        <label v-if="block.biddingStrategy" :class="fieldClass">
          <span :class="labelClass">{{ t('catalog.block.strategy') }}</span>
          <select v-model="block.biddingStrategy" :disabled="!canEdit" :class="inputClass">
            <option v-for="strategy in BLOCK_BIDDING_STRATEGIES" :key="strategy" :value="strategy">
              {{ t(`catalog.strategy.${strategy}`) }}
            </option>
          </select>
        </label>
        <label v-if="block.sdOptimization" :class="fieldClass">
          <span :class="labelClass">{{ t('catalog.block.sdOptimization') }}</span>
          <select v-model="block.sdOptimization" :disabled="!canEdit" :class="inputClass">
            <option v-for="option in BLOCK_SD_OPTIMIZATIONS" :key="option" :value="option">
              {{ t(`catalog.sdOptimization.${option}`) }}
            </option>
          </select>
        </label>
        <template v-if="block.placements">
          <label v-for="field in PLACEMENTS" :key="field" :class="fieldClass">
            <span :class="labelClass">{{ t(`catalog.block.${field}`) }}</span>
            <input
              :value="block.placements[field]"
              :data-block-top="field === 'topOfSearch' ? '' : undefined"
              inputmode="numeric"
              :disabled="!canEdit"
              :class="[inputClass, 'font-data']"
              @input="setPlacement(block, field, ($event.target as HTMLInputElement).value)"
            />
          </label>
        </template>
        <label v-if="block.lookbackDays !== null" :class="fieldClass">
          <span :class="labelClass">{{ t('catalog.block.lookback') }}</span>
          <input
            :value="block.lookbackDays"
            inputmode="numeric"
            :disabled="!canEdit"
            :class="[inputClass, 'font-data']"
            @input="setLookback(block, ($event.target as HTMLInputElement).value)"
          />
        </label>
      </div>
    </section>
  </div>
</template>
