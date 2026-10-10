<script setup lang="ts">
import {
  BID_STACK_STRATEGIES,
  MAX_BID_STACK_AUDIENCES,
  simulateBidStack,
  type BidStackResult,
} from '@profitbash/engine';
import { formatCurrency, formatNumber } from '@profitbash/shared';
import Button from 'primevue/button';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { useRoute } from 'vue-router';
import PageHeader from '../components/common/PageHeader.vue';
import { useSessionStore } from '../stores/session';
import { simulatorStateFromQuery } from '../tools/bid-simulator/link';
import { inputClass, labelClass } from '../tools/catalog/draft';
import ToolsTabs from '../tools/ToolsTabs.vue';

/**
 * Gebots-Stack-Simulator (`phase-4.md` 4.8, F12): Aus Basisgebot, Strategie und Anpassungen (Platzierung, Amazon
 * Business, Zielgruppen) entsteht je Kombination eine Spanne des Gebots. Rechnet im Browser mit der Engine, ohne
 * Daten zu laden; aus dem Explorer kommen Strategie, Platzierungen und Währung einer Kampagne über die Query.
 */
const { t } = useI18n();
const id = useId();
const route = useRoute();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);

const initial = simulatorStateFromQuery(route.query);
const bid = ref(initial.bid);
const strategy = ref(initial.strategy);
const top = ref(String(initial.top));
const productPages = ref(String(initial.productPages));
const restOfSearch = ref(String(initial.restOfSearch));
const amazonBusiness = ref(initial.amazonBusiness === null ? '' : String(initial.amazonBusiness));
const audiences = ref<{ label: string; percentage: string }[]>([]);

const percent = (value: string) => (value.trim() === '' ? 0 : Number(value));
const result = computed<BidStackResult | null>(() => {
  try {
    return simulateBidStack({
      bid: bid.value.trim(),
      strategy: strategy.value,
      placements: {
        top: percent(top.value),
        productPages: percent(productPages.value),
        restOfSearch: percent(restOfSearch.value),
      },
      amazonBusiness: amazonBusiness.value.trim() === '' ? null : percent(amazonBusiness.value),
      audiences: audiences.value.map((entry, index) => ({
        label: entry.label.trim() || t('bidSimulator.audienceFallback', { number: index + 1 }),
        percentage: percent(entry.percentage),
      })),
    });
  } catch (error) {
    if (error instanceof RangeError) return null;
    throw error;
  }
});

const amount = (value: string) =>
  initial.currency
    ? formatCurrency(value, initial.currency, locale.value)
    : formatNumber(value, locale.value, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const factor = (value: string) =>
  `× ${formatNumber(value, locale.value, { maximumFractionDigits: 4 })}`;
const rowKey = (row: BidStackResult['rows'][number]) =>
  `${row.placement}|${row.amazonBusiness ? 'ab' : '-'}|${row.audience ?? '-'}`;

function addAudience() {
  if (audiences.value.length < MAX_BID_STACK_AUDIENCES)
    audiences.value = [...audiences.value, { label: '', percentage: '0' }];
}
function removeAudience(index: number) {
  audiences.value = audiences.value.filter((_, position) => position !== index);
}
const placementFields = [
  { key: 'top', model: top, label: 'bidSimulator.placement.top' },
  { key: 'pp', model: productPages, label: 'bidSimulator.placement.productPages' },
  { key: 'ros', model: restOfSearch, label: 'bidSimulator.placement.restOfSearch' },
] as const;
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('bidSimulator.eyebrow')"
      :title="t('bidSimulator.title')"
      :description="t('bidSimulator.description')"
    />
    <ToolsTabs current="bid-simulator" />

    <section
      class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    >
      <p v-if="initial.name" data-simulator-source class="text-body-sm text-ink-secondary">
        {{ t('bidSimulator.source', { name: initial.name }) }}
      </p>
      <div class="grid gap-space-md sm:grid-cols-2 lg:grid-cols-4">
        <div class="flex min-w-0 flex-col gap-space-xs">
          <label :for="`${id}-bid`" :class="labelClass">{{ t('bidSimulator.bid') }}</label>
          <input
            :id="`${id}-bid`"
            v-model="bid"
            data-simulator-bid
            inputmode="decimal"
            :class="[inputClass, 'font-data tabular-nums']"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-space-xs">
          <label :for="`${id}-strategy`" :class="labelClass">
            {{ t('bidSimulator.strategy') }}
          </label>
          <select
            :id="`${id}-strategy`"
            v-model="strategy"
            data-simulator-strategy
            :class="inputClass"
          >
            <option v-for="item in BID_STACK_STRATEGIES" :key="item" :value="item">
              {{ t(`bidSimulator.strategies.${item}`) }}
            </option>
          </select>
        </div>
        <div
          v-for="field in placementFields"
          :key="field.key"
          class="flex min-w-0 flex-col gap-space-xs"
        >
          <label :for="`${id}-${field.key}`" :class="labelClass">{{ t(field.label) }}</label>
          <input
            :id="`${id}-${field.key}`"
            v-model="field.model.value"
            :data-simulator-top="field.key === 'top' ? '' : undefined"
            :data-simulator-placement="field.key"
            inputmode="numeric"
            :class="[inputClass, 'font-data tabular-nums']"
          />
        </div>
        <div class="flex min-w-0 flex-col gap-space-xs">
          <label :for="`${id}-ab`" :class="labelClass">{{
            t('bidSimulator.amazonBusiness')
          }}</label>
          <input
            :id="`${id}-ab`"
            v-model="amazonBusiness"
            data-simulator-ab
            inputmode="numeric"
            :placeholder="t('bidSimulator.notSet')"
            :class="[inputClass, 'font-data tabular-nums']"
          />
        </div>
      </div>
      <p class="text-body-sm text-ink-secondary">{{ t('bidSimulator.strategyHint') }}</p>

      <div class="flex flex-col gap-space-xs">
        <span :class="labelClass">{{ t('bidSimulator.audiences') }}</span>
        <p class="text-body-sm text-ink-secondary">{{ t('bidSimulator.audiencesHint') }}</p>
        <div
          v-for="(entry, index) in audiences"
          :key="index"
          class="flex flex-wrap items-end gap-space-sm"
        >
          <div class="flex min-w-0 flex-1 basis-48 flex-col gap-space-xs">
            <label :for="`${id}-aud-${index}`" :class="labelClass">
              {{ t('bidSimulator.audienceLabel') }}
            </label>
            <input
              :id="`${id}-aud-${index}`"
              v-model="entry.label"
              :data-simulator-audience-label="index"
              :class="inputClass"
            />
          </div>
          <div class="flex w-32 flex-col gap-space-xs">
            <label :for="`${id}-aud-pct-${index}`" :class="labelClass">
              {{ t('bidSimulator.audiencePercent') }}
            </label>
            <input
              :id="`${id}-aud-pct-${index}`"
              v-model="entry.percentage"
              :data-simulator-audience-percent="index"
              inputmode="numeric"
              :class="[inputClass, 'font-data tabular-nums']"
            />
          </div>
          <Button
            icon="pi pi-times"
            severity="secondary"
            variant="text"
            :aria-label="t('bidSimulator.removeAudience', { number: index + 1 })"
            @click="removeAudience(index)"
          />
        </div>
        <div>
          <Button
            data-simulator-add-audience
            icon="pi pi-plus"
            severity="secondary"
            size="small"
            :label="t('bidSimulator.addAudience')"
            :disabled="audiences.length >= MAX_BID_STACK_AUDIENCES"
            @click="addAudience"
          />
        </div>
      </div>
    </section>

    <section
      class="flex min-w-0 flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    >
      <h2 class="text-label-eyebrow uppercase text-ink-tertiary">
        {{ t('bidSimulator.result') }}
      </h2>
      <p v-if="!result" data-simulator-invalid role="alert" class="text-body-sm text-on-loss-wash">
        {{ t('bidSimulator.invalid') }}
      </p>
      <template v-else>
        <p data-simulator-highest class="text-body-md text-ink">
          {{ t('bidSimulator.highest') }}
          <span class="font-data font-semibold tabular-nums">{{ amount(result.highest) }}</span>
        </p>
        <p v-if="result.hints.includes('ruleBasedUnknown')" class="text-body-sm text-ink-secondary">
          {{ t('bidSimulator.ruleBased') }}
        </p>
        <!-- `relative`: Absolut positionierte Inhalte bleiben im Scroll-Bereich (Handy). -->
        <div class="relative min-w-0 overflow-x-auto">
          <table class="w-full min-w-[36rem] text-left text-body-sm">
            <thead class="text-label-eyebrow uppercase text-ink-tertiary">
              <tr>
                <th class="py-space-xs pr-space-md">{{ t('bidSimulator.column.placement') }}</th>
                <th class="py-space-xs pr-space-md">
                  {{ t('bidSimulator.column.amazonBusiness') }}
                </th>
                <th class="py-space-xs pr-space-md">{{ t('bidSimulator.column.audience') }}</th>
                <th class="py-space-xs pr-space-md text-right">
                  {{ t('bidSimulator.column.factor') }}
                </th>
                <th class="py-space-xs pr-space-md text-right">
                  {{ t('bidSimulator.column.min') }}
                </th>
                <th class="py-space-xs text-right">{{ t('bidSimulator.column.max') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in result.rows"
                :key="rowKey(row)"
                :data-stack-row="rowKey(row)"
                class="border-t border-line"
              >
                <td class="py-space-xs pr-space-md text-ink">
                  {{ t(`bidSimulator.placement.${row.placement}`) }}
                </td>
                <td class="py-space-xs pr-space-md text-ink-secondary">
                  {{ row.amazonBusiness ? t('bidSimulator.yes') : '—' }}
                </td>
                <td class="py-space-xs pr-space-md text-ink-secondary">
                  {{ row.audience ?? '—' }}
                </td>
                <td class="py-space-xs pr-space-md text-right font-data tabular-nums">
                  {{ factor(row.factor) }}
                </td>
                <td class="py-space-xs pr-space-md text-right font-data tabular-nums">
                  {{ amount(row.min) }}
                </td>
                <td class="py-space-xs text-right font-data font-semibold tabular-nums">
                  {{ amount(row.max) }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>
  </div>
</template>
