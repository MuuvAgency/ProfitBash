<script setup lang="ts">
import {
  automationRuleSchema,
  MAX_RULE_CONDITIONS,
  MAX_RULE_NAME_LENGTH,
  RULE_COMPARATORS,
  RULE_LEVELS,
  RULE_METRICS,
  type AutomationRule,
  type RuleAction,
  type RuleComparator,
  type RuleLevel,
  type RuleMetric,
} from '@profitbash/shared';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';

/**
 * Dialog für eine Regel (`phase-5.md` 5.6b). Felder als Texte (Komma als Dezimaltrenner), geprüft mit dem Schema aus
 * shared; „Übernehmen“ gibt die Regel an die Liste zurück, gespeichert wird dort.
 */
const props = defineProps<{
  /** Die bearbeitete Regel; `null` = Dialog zu. */
  rule: AutomationRule | null;
  isNew: boolean;
  clients: readonly { id: string; name: string }[];
}>();
const emit = defineEmits<{ apply: [rule: AutomationRule]; close: [] }>();
const { t } = useI18n();
const id = useId();

const ACTION_TYPES = ['changePercent', 'changeAbsolute', 'set', 'pause'] as const;
interface ConditionInput {
  metric: RuleMetric;
  comparator: RuleComparator;
  value: string;
  relativeToGoal: boolean;
}
const name = ref('');
const level = ref<RuleLevel>('target');
const clientId = ref('');
const enabled = ref(true);
const conditions = ref<ConditionInput[]>([]);
const actionType = ref<RuleAction['type']>('changePercent');
const actionValue = ref('');

const comma = (value: string) => value.replace('.', ',');
const dot = (value: string) => value.trim().replace(',', '.').replace(/^\+/, '');
const emptyCondition = (): ConditionInput => ({
  metric: 'clicks',
  comparator: 'gte',
  value: '',
  relativeToGoal: false,
});

watch(
  () => props.rule,
  (rule) => {
    if (!rule) return;
    name.value = rule.name;
    level.value = rule.level;
    clientId.value = rule.clientId ?? '';
    enabled.value = rule.enabled;
    conditions.value = rule.conditions.map((c) => ({
      metric: c.metric,
      comparator: c.comparator,
      value: comma(c.value),
      relativeToGoal: c.relativeToGoal ?? false,
    }));
    if (conditions.value.length === 0) conditions.value = [emptyCondition()];
    actionType.value = rule.action.type;
    actionValue.value = rule.action.type === 'pause' ? '' : comma(rule.action.value);
  },
  { immediate: true },
);

/** Der Client der Regel fehlt in der Liste (gelöscht oder nicht sichtbar): als eigene Option erhalten. */
const unknownClient = computed(
  () => clientId.value !== '' && !props.clients.some((client) => client.id === clientId.value),
);

const parsed = computed(() =>
  automationRuleSchema.safeParse({
    id: props.rule?.id,
    name: name.value,
    level: level.value,
    conditions: conditions.value.map((c) => ({
      metric: c.metric,
      comparator: c.comparator,
      value: dot(c.value),
      ...(c.metric === 'acos' && c.relativeToGoal ? { relativeToGoal: true } : {}),
    })),
    action:
      actionType.value === 'pause'
        ? { type: 'pause' }
        : {
            type: actionType.value,
            field: level.value === 'target' ? 'bid' : 'budget',
            value: dot(actionValue.value),
          },
    clientId: clientId.value || null,
    enabled: enabled.value,
  }),
);
const invalidPaths = computed(
  () => new Set(parsed.value.success ? [] : parsed.value.error.issues.map((i) => i.path.join('.'))),
);
/** Markiert wird erst, wenn etwas im Feld steht; leere Pflichtfelder sperren nur „Übernehmen“. */
const invalid = (path: string, text: string) => text.trim() !== '' && invalidPaths.value.has(path);
const inputClass = (bad: boolean) => [
  'h-11 min-w-0 rounded-control bg-well px-space-md text-ink outline-none focus-visible:ring-2',
  bad ? 'ring-2 ring-loss' : 'focus-visible:ring-violet',
];
const labelClass = 'text-label-eyebrow uppercase text-ink-tertiary';

function submit() {
  if (parsed.value.success) emit('apply', parsed.value.data);
}
</script>

<template>
  <Dialog
    :visible="rule !== null"
    modal
    :header="t(`automations.rules.dialog.${isNew ? 'titleNew' : 'titleEdit'}`)"
    :style="{ width: 'min(44rem, calc(100vw - 2rem))' }"
    @update:visible="(next) => !next && emit('close')"
  >
    <form v-if="rule" data-rule-form class="flex flex-col gap-space-lg" @submit.prevent="submit">
      <div class="flex flex-col gap-space-xs">
        <label :for="`${id}-name`" :class="labelClass">
          {{ t('automations.rules.dialog.name') }}
        </label>
        <input
          :id="`${id}-name`"
          v-model="name"
          data-rule-field="name"
          type="text"
          autocomplete="off"
          :maxlength="MAX_RULE_NAME_LENGTH"
          :class="inputClass(false)"
        />
      </div>

      <div class="grid gap-space-md sm:grid-cols-2">
        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-level`" :class="labelClass">
            {{ t('automations.rules.dialog.level') }}
          </label>
          <select
            :id="`${id}-level`"
            v-model="level"
            data-rule-field="level"
            :class="inputClass(false)"
          >
            <option v-for="option in RULE_LEVELS" :key="option" :value="option">
              {{ t(`automations.rules.level.${option}`) }}
            </option>
          </select>
        </div>
        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-client`" :class="labelClass">
            {{ t('automations.rules.dialog.client') }}
          </label>
          <select
            :id="`${id}-client`"
            v-model="clientId"
            data-rule-field="client"
            :class="inputClass(false)"
          >
            <option value="">{{ t('automations.rules.allClients') }}</option>
            <option v-if="unknownClient" :value="clientId">
              {{ t('automations.rules.unknownClient') }}
            </option>
            <option v-for="client in clients" :key="client.id" :value="client.id">
              {{ client.name }}
            </option>
          </select>
        </div>
      </div>

      <fieldset class="flex flex-col gap-space-sm">
        <legend :class="['mb-space-xs', labelClass]">
          {{ t('automations.rules.dialog.conditions') }}
        </legend>
        <div
          v-for="(condition, index) in conditions"
          :key="index"
          :data-condition="index"
          role="group"
          :aria-label="t('automations.rules.dialog.condition', { n: index + 1 })"
          class="flex flex-wrap items-center gap-space-sm"
        >
          <select
            v-model="condition.metric"
            data-rule-field="metric"
            :aria-label="t('automations.rules.dialog.metric')"
            :class="[inputClass(false), 'flex-1 basis-32']"
          >
            <option v-for="option in RULE_METRICS" :key="option" :value="option">
              {{ t(`automations.rules.metric.${option}`) }}
            </option>
          </select>
          <select
            v-model="condition.comparator"
            data-rule-field="comparator"
            :aria-label="t('automations.rules.dialog.comparator')"
            :class="[inputClass(false), 'flex-1 basis-32']"
          >
            <option v-for="option in RULE_COMPARATORS" :key="option" :value="option">
              {{ t(`automations.rules.comparatorLabel.${option}`) }}
            </option>
          </select>
          <input
            v-model="condition.value"
            data-rule-field="value"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :aria-label="t('automations.rules.dialog.value')"
            :aria-invalid="
              invalid(`conditions.${index}.value`, condition.value) ? 'true' : undefined
            "
            :class="[
              inputClass(invalid(`conditions.${index}.value`, condition.value)),
              'w-28 font-data',
            ]"
          />
          <label
            v-if="condition.metric === 'acos'"
            class="flex min-h-11 items-center gap-space-xs text-body-sm text-ink"
          >
            <input
              v-model="condition.relativeToGoal"
              data-rule-field="relative"
              type="checkbox"
              class="size-4 accent-violet"
            />
            {{ t('automations.rules.dialog.relativeToGoal') }}
          </label>
          <Button
            v-if="conditions.length > 1"
            type="button"
            data-condition-remove
            icon="pi pi-times"
            severity="secondary"
            variant="text"
            size="small"
            class="ml-auto"
            :aria-label="t('automations.rules.dialog.removeCondition', { n: index + 1 })"
            @click="conditions.splice(index, 1)"
          />
        </div>
        <Button
          v-if="conditions.length < MAX_RULE_CONDITIONS"
          type="button"
          data-condition-add
          icon="pi pi-plus"
          severity="secondary"
          variant="text"
          size="small"
          class="self-start"
          :label="t('automations.rules.dialog.addCondition')"
          @click="conditions.push(emptyCondition())"
        />
      </fieldset>

      <div class="grid gap-space-md sm:grid-cols-2">
        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-action`" :class="labelClass">
            {{ t('automations.rules.dialog.actionType') }}
          </label>
          <select
            :id="`${id}-action`"
            v-model="actionType"
            data-rule-field="action-type"
            :class="inputClass(false)"
          >
            <option v-for="option in ACTION_TYPES" :key="option" :value="option">
              {{ t(`automations.rules.field.${level === 'target' ? 'bid' : 'budget'}`) }}
              {{ t(`automations.rules.dialog.actionTypes.${option}`) }}
            </option>
          </select>
        </div>
        <div v-if="actionType !== 'pause'" class="flex flex-col gap-space-xs">
          <label :for="`${id}-action-value`" :class="labelClass">
            {{ t(`automations.rules.dialog.actionValue.${actionType}`) }}
          </label>
          <input
            :id="`${id}-action-value`"
            v-model="actionValue"
            data-rule-field="action-value"
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :aria-invalid="invalid('action.value', actionValue) ? 'true' : undefined"
            :aria-describedby="`${id}-action-hint`"
            :class="[inputClass(invalid('action.value', actionValue)), 'font-data']"
          />
          <p :id="`${id}-action-hint`" class="text-body-sm text-ink-secondary">
            {{ t(`automations.rules.dialog.actionHint.${actionType}`) }}
          </p>
        </div>
      </div>

      <label class="flex min-h-11 items-center gap-space-sm text-body-md text-ink">
        <input v-model="enabled" type="checkbox" class="size-4 accent-violet" />
        {{ t('automations.rules.enabled') }}
      </label>

      <div class="flex flex-wrap items-center justify-end gap-space-sm">
        <p class="mr-auto text-body-sm text-ink-secondary">
          {{ t('automations.rules.dialog.applyHint') }}
        </p>
        <Button
          type="button"
          :label="t('common.cancel')"
          severity="secondary"
          variant="text"
          @click="emit('close')"
        />
        <Button
          type="submit"
          data-rule-apply
          :label="t('automations.rules.dialog.apply')"
          :disabled="!parsed.success"
        />
      </div>
    </form>
  </Dialog>
</template>
