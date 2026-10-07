<script setup lang="ts">
import { searchTermRulesSchema } from '@profitbash/shared';
import { useMutation } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import type { SearchTermRulesData } from '../api/client';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { fractionToPercent, parseDecimalInput, percentToFraction } from './decimal-input';

/**
 * Regeln der Einstufung ändern (je Organisation, Recht „write“ im Explorer). ACoS wird in Prozent eingegeben und als
 * Bruch gespeichert; die Spend-Grenze gilt in der Währung des jeweiligen Profils.
 */
const props = defineProps<{ visible: boolean; rules: SearchTermRulesData; currency: string }>();
const emit = defineEmits<{ close: []; saved: [] }>();

const { t } = useI18n();

const purchases = ref('');
const acos = ref('');
const clicks = ref('');
const cost = ref('');
const errorKey = ref<string | null>(null);

const save = useMutation({
  mutationFn: (rules: SearchTermRulesData) => api.searchTerms.saveRules(rules),
});

const comma = (value: string) => value.replace('.', ',');

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    purchases.value = String(props.rules.harvestMinPurchases);
    acos.value = comma(fractionToPercent(props.rules.harvestMaxAcos));
    clicks.value = String(props.rules.negateMinClicks);
    cost.value = comma(props.rules.negateMinCost);
    errorKey.value = null;
    save.reset();
  },
  { immediate: true },
);

const WHOLE = /^\d{1,7}$/;

function parsed(): SearchTermRulesData | null {
  const percent = parseDecimalInput(acos.value);
  const minCost = parseDecimalInput(cost.value);
  if (!WHOLE.test(purchases.value.trim()) || !WHOLE.test(clicks.value.trim())) return null;
  if (percent === null || minCost === null) return null;
  const result = searchTermRulesSchema.safeParse({
    harvestMinPurchases: Number(purchases.value.trim()),
    harvestMaxAcos: percentToFraction(percent),
    negateMinClicks: Number(clicks.value.trim()),
    negateMinCost: minCost,
  });
  return result.success ? result.data : null;
}

async function submit() {
  const rules = parsed();
  if (!rules) {
    errorKey.value = 'searchTerms.rulesDialog.invalid';
    return;
  }
  errorKey.value = null;
  try {
    await save.mutateAsync(rules);
    emit('saved');
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :closable="!save.isPending.value"
    :close-on-escape="!save.isPending.value"
    :header="t('searchTerms.rulesDialog.title')"
    :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
    @update:visible="(next) => !next && emit('close')"
  >
    <form class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
      <p class="text-body-sm text-ink-secondary">{{ t('searchTerms.rulesDialog.intro') }}</p>
      <InlineError v-if="errorKey" :message="t(errorKey)" />

      <fieldset class="flex flex-col gap-space-sm">
        <legend class="text-body-md font-semibold text-ink">
          {{ t('searchTerms.class.harvest') }}
        </legend>
        <div class="grid gap-space-md sm:grid-cols-2">
          <div class="flex flex-col gap-space-xs">
            <label for="rules-harvest-purchases" class="text-body-sm font-semibold text-ink">
              {{ t('searchTerms.rulesDialog.harvestMinPurchases') }}
            </label>
            <InputText
              id="rules-harvest-purchases"
              v-model="purchases"
              inputmode="numeric"
              autocomplete="off"
              class="font-data"
              fluid
            />
          </div>
          <div class="flex flex-col gap-space-xs">
            <label for="rules-harvest-acos" class="text-body-sm font-semibold text-ink">
              {{ t('searchTerms.rulesDialog.harvestMaxAcos') }}
            </label>
            <InputText
              id="rules-harvest-acos"
              v-model="acos"
              inputmode="decimal"
              autocomplete="off"
              class="font-data"
              fluid
            />
          </div>
        </div>
      </fieldset>

      <fieldset class="flex flex-col gap-space-sm">
        <legend class="text-body-md font-semibold text-ink">
          {{ t('searchTerms.class.negate') }}
        </legend>
        <div class="grid gap-space-md sm:grid-cols-2">
          <div class="flex flex-col gap-space-xs">
            <label for="rules-negate-clicks" class="text-body-sm font-semibold text-ink">
              {{ t('searchTerms.rulesDialog.negateMinClicks') }}
            </label>
            <InputText
              id="rules-negate-clicks"
              v-model="clicks"
              inputmode="numeric"
              autocomplete="off"
              class="font-data"
              fluid
            />
          </div>
          <div class="flex flex-col gap-space-xs">
            <label for="rules-negate-cost" class="text-body-sm font-semibold text-ink">
              {{ t('searchTerms.rulesDialog.negateMinCost') }}
            </label>
            <InputText
              id="rules-negate-cost"
              v-model="cost"
              inputmode="decimal"
              autocomplete="off"
              class="font-data"
              fluid
            />
          </div>
        </div>
        <p class="text-body-sm text-ink-secondary">
          {{ t('searchTerms.rulesDialog.costHint', { currency }) }}
        </p>
      </fieldset>

      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('common.cancel')"
          severity="secondary"
          variant="text"
          :disabled="save.isPending.value"
          @click="emit('close')"
        />
        <Button type="submit" :label="t('common.save')" :loading="save.isPending.value" />
      </div>
    </form>
  </Dialog>
</template>
