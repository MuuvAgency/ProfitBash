<script setup lang="ts">
import {
  formatCurrency,
  formatNumber,
  MAX_AUTOMATION_RULES,
  type AutomationRule,
  type RuleCondition,
} from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useActiveOrgId, useSessionStore } from '../stores/session';
import RuleDialog from './RuleDialog.vue';

/**
 * Tab „Regeln“ (`phase-5.md` 5.6b): geordnete Liste (erste passende gewinnt), bearbeitet als Entwurf und als ganze
 * Liste mit der gelesenen Version gespeichert (409, wenn inzwischen jemand anderes gespeichert hat). Die Vorschau
 * prüft alle Targets der sichtbaren Profile und läuft deshalb nur auf Knopfdruck.
 */
const props = defineProps<{
  /** Sichtbare Clients; `undefined`, solange sie laden (dann wird kein Client als unbekannt markiert). */
  clients: readonly { id: string; name: string }[] | undefined;
  canWrite: boolean;
}>();
const { t } = useI18n();
const session = useSessionStore();
const orgId = useActiveOrgId();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);

const queryKey = computed(() => ['automation-rules', orgId.value] as const);
const query = useQuery({
  queryKey,
  queryFn: () => api.automations.rules(),
  enabled: computed(() => orgId.value !== null),
});
const data = computed(() => query.data.value);

/** Tiefe Kopie (structuredClone scheitert an reaktiven Proxies). */
const clone = (rules: readonly AutomationRule[]) =>
  JSON.parse(JSON.stringify(rules)) as AutomationRule[];
const draft = ref<AutomationRule[]>([]);
const loaded = ref(false);
const baseVersion = ref(0);
const serialized = computed(() => JSON.stringify(draft.value));
const dirty = computed(
  () => data.value !== undefined && serialized.value !== JSON.stringify(data.value.rules),
);
// Neue Daten vom Server übernehmen, solange der Entwurf nicht geändert ist (sonst ginge Arbeit verloren).
watch(
  data,
  (next, previous) => {
    if (!next) return;
    if (!loaded.value || (previous && serialized.value === JSON.stringify(previous.rules))) {
      draft.value = clone(next.rules);
      baseVersion.value = next.version;
      loaded.value = true;
    }
  },
  { immediate: true },
);
const stale = computed(
  () => data.value !== undefined && dirty.value && data.value.version !== baseVersion.value,
);

// Ungespeicherte Änderungen nicht still verlieren (Tab schließen, neu laden).
const onBeforeUnload = (event: BeforeUnloadEvent) => {
  if (dirty.value) event.preventDefault();
};
onMounted(() => window.addEventListener('beforeunload', onBeforeUnload));
onBeforeUnmount(() => window.removeEventListener('beforeunload', onBeforeUnload));

// --- Anzeige -----------------------------------------------------------------------------

const MONEY: ReadonlySet<string> = new Set(['spend', 'sales', 'cpc']);
const eur = (value: string) => formatCurrency(value, 'EUR', locale.value);
function conditionText(condition: RuleCondition) {
  const value = MONEY.has(condition.metric)
    ? eur(condition.value)
    : condition.metric === 'acos'
      ? t(`automations.rules.${condition.relativeToGoal ? 'percentOfGoal' : 'percent'}`, {
          value: formatNumber(condition.value, locale.value),
        })
      : formatNumber(condition.value, locale.value);
  return `${t(`automations.rules.metric.${condition.metric}`)} ${t(`automations.rules.comparator.${condition.comparator}`)} ${value}`;
}
function actionText({ action }: AutomationRule) {
  if (action.type === 'pause') return t('automations.rules.action.pause');
  const amount = action.value.replace('-', '');
  const shown = action.type === 'changePercent' ? formatNumber(amount, locale.value) : eur(amount);
  const sign = action.type === 'set' ? '' : action.value.startsWith('-') ? '−' : '+';
  return t(`automations.rules.action.${action.type}`, {
    field: t(`automations.rules.field.${action.field}`),
    value: sign + shown,
  });
}
const clientName = (clientId: string) =>
  props.clients?.find((client) => client.id === clientId)?.name ?? null;
const isUnknownClient = (rule: AutomationRule) =>
  rule.clientId !== null && props.clients !== undefined && clientName(rule.clientId) === null;

// --- Bearbeiten --------------------------------------------------------------------------

const editing = ref<AutomationRule | null>(null);
const isNew = computed(
  () => editing.value !== null && !draft.value.some((rule) => rule.id === editing.value?.id),
);
const canAdd = computed(() => draft.value.length < MAX_AUTOMATION_RULES);
function addRule() {
  editing.value = {
    id: crypto.randomUUID(),
    name: '',
    level: 'target',
    conditions: [],
    action: { type: 'changePercent', field: 'bid', value: '' },
    clientId: null,
    enabled: true,
  };
}
function applyRule(rule: AutomationRule) {
  const index = draft.value.findIndex((existing) => existing.id === rule.id);
  if (index === -1) draft.value.push(rule);
  else draft.value[index] = rule;
  editing.value = null;
}
function move(index: number, step: number) {
  const [rule] = draft.value.splice(index, 1);
  draft.value.splice(index + step, 0, rule!);
}

const saveErrorKey = ref<string | null>(null);
const savedNotice = ref(false);
watch(serialized, () => (savedNotice.value = false));
const save = useMutation({
  mutationFn: () => api.automations.saveRules({ rules: draft.value, version: baseVersion.value }),
});
const canSave = computed(() => dirty.value && !save.isPending.value);
async function submit() {
  if (!canSave.value) return;
  saveErrorKey.value = null;
  try {
    const result = await save.mutateAsync();
    draft.value = clone(result.rules);
    baseVersion.value = result.version;
    queryClient.setQueryData(queryKey.value, result);
    savedNotice.value = true;
  } catch (error) {
    const code = error instanceof ApiError ? error.code : 'UNKNOWN';
    if (code === 'AUTOMATION_RULES_VERSION_CONFLICT') {
      saveErrorKey.value = 'automations.rules.conflict';
      void query.refetch();
    } else {
      saveErrorKey.value = errorMessageKey(code);
    }
  }
}
function discard() {
  if (data.value) {
    draft.value = clone(data.value.rules);
    baseVersion.value = data.value.version;
  }
  saveErrorKey.value = null;
}

// --- Vorschau ----------------------------------------------------------------------------

/** Die Liste, für die die Vorschau gerechnet wurde; nach jeder Änderung gilt sie nicht mehr. */
const previewOf = ref<string | null>(null);
const preview = useMutation({
  mutationFn: (rules: AutomationRule[]) => api.automations.previewRules({ rules }),
});
function runPreview() {
  previewOf.value = serialized.value;
  preview.mutate(clone(draft.value));
}
const previewData = computed(() =>
  previewOf.value === serialized.value ? preview.data.value : undefined,
);
const counts = computed(
  () => new Map(previewData.value?.counts.map((count) => [count.ruleId, count.entities])),
);
const countText = (rule: AutomationRule) =>
  t(
    `automations.rules.preview.${rule.level}`,
    { n: formatNumber(counts.value.get(rule.id) ?? 0, locale.value) },
    counts.value.get(rule.id) ?? 0,
  );
</script>

<template>
  <InlineError
    v-if="query.isError.value && !data"
    :message="t('automations.rules.loadFailed')"
    retryable
    :retrying="query.isFetching.value"
    @retry="query.refetch()"
  />
  <SkeletonBlock v-else-if="!data" shape="tile" height="20rem" />

  <div v-else class="flex flex-col gap-gutter">
    <InlineError v-if="saveErrorKey" :message="t(saveErrorKey)" />
    <p
      v-if="stale"
      role="status"
      class="rounded-tile bg-well p-space-md text-body-md text-warn"
      data-rules-stale
    >
      {{ t('automations.rules.staleDraft') }}
    </p>

    <EmptyState
      v-if="draft.length === 0"
      icon="sliders-h"
      :title="t('automations.rules.empty.title')"
      :text="t('automations.rules.empty.text')"
    >
      <Button
        v-if="canWrite"
        data-rule-add
        icon="pi pi-plus"
        :label="t('automations.rules.add')"
        @click="addRule"
      />
    </EmptyState>

    <section
      v-else
      class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    >
      <div class="flex flex-col gap-space-xs">
        <h2 class="text-headline-sm text-ink">{{ t('automations.rules.title') }}</h2>
        <p class="max-w-prose text-body-sm text-ink-secondary">
          {{ t('automations.rules.text') }}
        </p>
      </div>

      <ol class="flex flex-col">
        <li
          v-for="(rule, index) in draft"
          :key="rule.id"
          :data-rule-row="rule.id"
          class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
        >
          <span
            class="w-6 shrink-0 font-data text-body-sm text-ink-tertiary"
            :aria-label="t('automations.rules.position', { n: index + 1 })"
          >
            {{ index + 1 }}
          </span>
          <div class="flex min-w-0 flex-1 basis-64 flex-col gap-space-xs">
            <span
              :class="['truncate text-body-md', rule.enabled ? 'text-ink' : 'text-ink-secondary']"
            >
              {{ rule.name }}
            </span>
            <span class="font-data text-body-sm text-ink-secondary">
              {{ rule.conditions.map(conditionText).join(t('automations.rules.and')) }}
              → {{ actionText(rule) }}
            </span>
            <span class="text-body-sm text-ink-tertiary">
              {{ t(`automations.rules.level.${rule.level}`) }} ·
              <template v-if="rule.clientId === null">
                {{ t('automations.rules.allClients') }}
              </template>
              <span v-else-if="isUnknownClient(rule)" data-rule-unknown-client class="text-warn">
                {{ t('automations.rules.unknownClient') }}
              </span>
              <template v-else>{{ clientName(rule.clientId) }}</template>
              <template v-if="!canWrite && !rule.enabled">
                · {{ t('automations.rules.disabled') }}
              </template>
            </span>
            <span
              v-if="previewData"
              data-rule-count
              class="font-data text-body-sm text-violet"
              aria-live="polite"
            >
              {{ countText(rule) }}
            </span>
          </div>
          <div v-if="canWrite" class="flex shrink-0 items-center gap-space-xs">
            <label class="flex min-h-11 items-center gap-space-xs text-body-sm text-ink-secondary">
              <input
                v-model="rule.enabled"
                data-rule-enabled
                type="checkbox"
                class="size-4 accent-violet"
                :aria-label="t('automations.rules.enabledLabel', { name: rule.name })"
              />
              {{ t('automations.rules.enabled') }}
            </label>
            <Button
              data-rule-up
              icon="pi pi-arrow-up"
              severity="secondary"
              variant="text"
              size="small"
              :disabled="index === 0"
              :aria-label="t('automations.rules.moveUp', { name: rule.name })"
              @click="move(index, -1)"
            />
            <Button
              data-rule-down
              icon="pi pi-arrow-down"
              severity="secondary"
              variant="text"
              size="small"
              :disabled="index === draft.length - 1"
              :aria-label="t('automations.rules.moveDown', { name: rule.name })"
              @click="move(index, 1)"
            />
            <Button
              data-rule-edit
              icon="pi pi-pencil"
              severity="secondary"
              variant="text"
              size="small"
              :aria-label="t('automations.rules.edit', { name: rule.name })"
              @click="editing = rule"
            />
            <Button
              data-rule-delete
              icon="pi pi-trash"
              severity="secondary"
              variant="text"
              size="small"
              :aria-label="t('automations.rules.delete', { name: rule.name })"
              @click="draft.splice(index, 1)"
            />
          </div>
        </li>
      </ol>

      <p v-if="draft.some(isUnknownClient)" class="text-body-sm text-warn">
        {{ t('automations.rules.unknownClientHint') }}
      </p>

      <div class="flex flex-col gap-space-sm">
        <div class="flex flex-wrap items-center gap-space-sm">
          <Button
            v-if="canWrite"
            data-rule-add
            icon="pi pi-plus"
            severity="secondary"
            :label="t('automations.rules.add')"
            :disabled="!canAdd"
            @click="addRule"
          />
          <Button
            data-rules-preview
            icon="pi pi-eye"
            severity="secondary"
            variant="text"
            :label="t('automations.rules.preview.action')"
            :loading="preview.isPending.value"
            @click="runPreview"
          />
        </div>
        <p v-if="!canAdd" class="text-body-sm text-ink-secondary">
          {{ t('automations.rules.limit', { max: MAX_AUTOMATION_RULES }) }}
        </p>
        <InlineError
          v-if="preview.isError.value && previewOf === serialized"
          :message="t('automations.rules.preview.failed')"
        />
        <p
          v-else-if="previewData"
          data-rules-preview-summary
          class="max-w-prose text-body-sm text-ink-secondary"
        >
          {{
            t('automations.rules.preview.summary', {
              targets: formatNumber(previewData.targets, locale),
              campaigns: formatNumber(previewData.campaigns, locale),
            })
          }}
        </p>
        <p v-else class="max-w-prose text-body-sm text-ink-secondary">
          {{ t('automations.rules.preview.hint') }}
        </p>
      </div>
    </section>

    <div
      v-if="canWrite"
      class="sticky bottom-0 z-10 flex flex-nowrap items-center gap-space-sm bg-canvas/85 py-space-sm backdrop-blur-xl"
    >
      <Button
        data-rules-save
        icon="pi pi-check"
        :label="t('automations.rules.save')"
        :loading="save.isPending.value"
        :disabled="!canSave"
        @click="submit"
      />
      <Button
        data-rules-discard
        severity="secondary"
        variant="text"
        :label="t('automations.rules.discard')"
        :disabled="!dirty || save.isPending.value"
        @click="discard"
      />
      <span v-if="savedNotice" class="text-body-sm text-ink-secondary" aria-live="polite">
        {{ t('automations.rules.saved') }}
      </span>
    </div>

    <RuleDialog
      :rule="editing"
      :is-new="isNew"
      :clients="clients ?? []"
      @apply="applyRule"
      @close="editing = null"
    />
  </div>
</template>
