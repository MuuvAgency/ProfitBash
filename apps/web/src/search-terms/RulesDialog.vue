<script setup lang="ts">
import { searchTermRuleOverridesSchema, searchTermRulesSchema } from '@profitbash/shared';
import { useMutation } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import InputText from 'primevue/inputtext';
import { computed, reactive, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import type { SearchTermRuleOverridesData, SearchTermRulesData } from '../api/client';
import InlineError from '../components/common/InlineError.vue';
import { errorMessageKey } from '../i18n';
import { fractionToPercent, parseDecimalInput, percentToFraction } from './decimal-input';

/**
 * Regeln der Einstufung ändern (Recht „write“ im Explorer): oben die Regeln der Organisation für alle Profile,
 * darunter abweichende Werte nur für das gewählte Profil (2b.2g; leer = wie für alle). ACoS wird in Prozent
 * eingegeben und als Bruch gespeichert; die Spend-Grenze gilt in der Währung des jeweiligen Profils.
 */
const props = defineProps<{
  visible: boolean;
  /** Regeln der Organisation (nicht die geltenden des Profils). */
  rules: SearchTermRulesData;
  /** Abweichende Werte des Profils; `null` je Feld = wie die Organisation. */
  overrides: SearchTermRuleOverridesData;
  profileId: string;
  profileLabel: string;
  currency: string;
}>();
const emit = defineEmits<{ close: []; saved: [] }>();

const { t } = useI18n();

const FIELDS = [
  { key: 'harvestMinPurchases', id: 'harvest-purchases', group: 'harvest', kind: 'whole' },
  { key: 'harvestMaxAcos', id: 'harvest-acos', group: 'harvest', kind: 'percent' },
  { key: 'negateMinClicks', id: 'negate-clicks', group: 'negate', kind: 'whole' },
  { key: 'negateMinCost', id: 'negate-cost', group: 'negate', kind: 'amount' },
] as const;
type Field = (typeof FIELDS)[number];
type Key = Field['key'];
type Texts = Record<Key, string>;
const GROUPS = ['harvest', 'negate'] as const;

const blank = (): Texts => ({
  harvestMinPurchases: '',
  harvestMaxAcos: '',
  negateMinClicks: '',
  negateMinCost: '',
});
/** Eingaben als Text: für alle Profile und nur für dieses Profil; `initial` ist der Stand beim Öffnen. */
const all = reactive(blank());
const own = reactive(blank());
let initial = { all: blank(), own: blank() };
const errorKey = ref<string | null>(null);
/** Die Regeln für alle sind schon gespeichert, die des Profils noch nicht (Fehler dazwischen). */
const partlySaved = ref(false);
/** Gespeichert, die Seite lädt neu und schließt dann: bis dahin bleibt alles gesperrt (kein zweites Absenden). */
const done = ref(false);

const WHOLE = /^\d{1,7}$/;
const comma = (value: string) => value.replace('.', ',');

function display(field: Field, value: number | string | null): string {
  if (value === null) return '';
  if (field.kind === 'percent') return comma(fractionToPercent(String(value)));
  return comma(String(value));
}

/** Eingabe → Wert für die API; `undefined`, wenn sie keine gültige Zahl ist. */
function parse(field: Field, text: string): number | string | undefined {
  if (field.kind === 'whole') return WHOLE.test(text.trim()) ? Number(text.trim()) : undefined;
  const decimal = parseDecimalInput(text);
  if (decimal === null) return undefined;
  return field.kind === 'percent' ? percentToFraction(decimal) : decimal;
}

const changed = (now: Texts, before: Texts) =>
  FIELDS.some((field) => now[field.key].trim() !== before[field.key]);
const locked = computed(() => save.isPending.value || done.value);
const hasOwn = computed(() => FIELDS.some((field) => own[field.key].trim() !== ''));

function parsedRules(): SearchTermRulesData | null {
  const values = Object.fromEntries(
    FIELDS.map((field) => [field.key, parse(field, all[field.key])]),
  );
  const result = searchTermRulesSchema.safeParse(values);
  return result.success ? result.data : null;
}

function parsedOverrides(): SearchTermRuleOverridesData | null {
  const values = Object.fromEntries(
    FIELDS.map((field) => [
      field.key,
      own[field.key].trim() === '' ? null : parse(field, own[field.key]),
    ]),
  );
  const result = searchTermRuleOverridesSchema.safeParse(values);
  return result.success ? result.data : null;
}

const save = useMutation({
  mutationFn: async (input: {
    rules: SearchTermRulesData | null;
    overrides: SearchTermRuleOverridesData | null;
  }) => {
    if (input.rules) {
      await api.searchTerms.saveRules(input.rules);
      partlySaved.value = true;
      // Die Felder sind während des Speicherns gesperrt: Der Text ist der gesendete Stand.
      for (const field of FIELDS) initial.all[field.key] = all[field.key].trim();
    }
    if (input.overrides) {
      await api.searchTerms.saveProfileRules({
        profileId: props.profileId,
        overrides: input.overrides,
      });
    }
  },
});

watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    for (const field of FIELDS) {
      all[field.key] = display(field, props.rules[field.key]);
      own[field.key] = display(field, props.overrides[field.key]);
    }
    initial = { all: { ...all }, own: { ...own } };
    errorKey.value = null;
    partlySaved.value = false;
    done.value = false;
    save.reset();
  },
  { immediate: true },
);

async function submit() {
  const rules = parsedRules();
  const overrides = parsedOverrides();
  if (!rules || !overrides) {
    errorKey.value = 'searchTerms.rulesDialog.invalid';
    return;
  }
  errorKey.value = null;
  const allChanged = changed(all, initial.all);
  const ownChanged = changed(own, initial.own);
  if (!allChanged && !ownChanged) {
    close();
    return;
  }
  try {
    await save.mutateAsync({
      rules: allChanged ? rules : null,
      overrides: ownChanged ? overrides : null,
    });
    done.value = true;
    emit('saved');
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}

/** Nach einem halb gelungenen Speichern lädt die Seite trotzdem neu. */
function close() {
  if (partlySaved.value) emit('saved');
  else emit('close');
}

function resetOwn() {
  Object.assign(own, blank());
}
</script>

<template>
  <Dialog
    :visible="visible"
    modal
    :closable="!locked"
    :close-on-escape="!locked"
    :header="t('searchTerms.rulesDialog.title')"
    :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
    @update:visible="(next) => !next && close()"
  >
    <form class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
      <p class="text-body-sm text-ink-secondary">{{ t('searchTerms.rulesDialog.intro') }}</p>
      <InlineError v-if="errorKey" :message="t(errorKey)" />

      <fieldset
        v-for="scope in ['all', 'own'] as const"
        :key="scope"
        class="flex flex-col gap-space-sm"
      >
        <legend class="text-body-md font-semibold text-ink">
          {{
            scope === 'all'
              ? t('searchTerms.rulesDialog.allProfiles')
              : t('searchTerms.rulesDialog.thisProfile', { profile: profileLabel })
          }}
        </legend>
        <div
          v-for="group in GROUPS"
          :key="group"
          role="group"
          :aria-labelledby="`rules-${scope}-${group}`"
          class="flex flex-col gap-space-xs"
        >
          <p :id="`rules-${scope}-${group}`" class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t(`searchTerms.class.${group}`) }}
          </p>
          <div class="grid gap-space-md sm:grid-cols-2">
            <div
              v-for="field in FIELDS.filter((f) => f.group === group)"
              :key="field.key"
              class="flex flex-col gap-space-xs"
            >
              <label
                :for="scope === 'all' ? `rules-${field.id}` : `rules-profile-${field.id}`"
                class="text-body-sm font-semibold text-ink"
              >
                {{ t(`searchTerms.rulesDialog.${field.key}`) }}
              </label>
              <InputText
                v-if="scope === 'all'"
                :id="`rules-${field.id}`"
                v-model="all[field.key]"
                :disabled="locked"
                :inputmode="field.kind === 'whole' ? 'numeric' : 'decimal'"
                autocomplete="off"
                class="font-data"
                fluid
              />
              <InputText
                v-else
                :id="`rules-profile-${field.id}`"
                v-model="own[field.key]"
                :disabled="locked"
                aria-describedby="rules-profile-hint"
                :placeholder="all[field.key]"
                :inputmode="field.kind === 'whole' ? 'numeric' : 'decimal'"
                autocomplete="off"
                class="font-data"
                fluid
              />
            </div>
          </div>
        </div>
        <p v-if="scope === 'all'" class="text-body-sm text-ink-secondary">
          {{ t('searchTerms.rulesDialog.costHint', { currency }) }}
        </p>
        <div v-else class="flex flex-wrap items-start justify-between gap-space-sm">
          <p id="rules-profile-hint" class="min-w-0 flex-1 text-body-sm text-ink-secondary">
            {{ t('searchTerms.rulesDialog.thisProfileHint', { currency }) }}
          </p>
          <Button
            v-if="hasOwn"
            type="button"
            :label="t('searchTerms.rulesDialog.reset')"
            size="small"
            severity="secondary"
            variant="text"
            :disabled="locked"
            @click="resetOwn"
          />
        </div>
      </fieldset>

      <div class="flex justify-end gap-space-sm">
        <Button
          type="button"
          :label="t('common.cancel')"
          severity="secondary"
          variant="text"
          :disabled="locked"
          @click="close"
        />
        <Button type="submit" :label="t('common.save')" :loading="locked" />
      </div>
    </form>
  </Dialog>
</template>
