<script setup lang="ts">
import { formatNumber, GOAL_METRICS, goalValueIssue, type GoalMetric } from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, reactive, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import type { GoalData, GoalsOverviewData, TargetAcosData } from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Seite „Ziele“ (`phase-5.md` 5.3, F4): Ziel-ACoS bzw. -ROAS je Client, Profil und Produktgruppe. Ohne eigenes Ziel
 * gilt das der Ebene darüber (Produktgruppe → Profil → Client). Der Rechner läuft auf dem Server (ADR 003).
 */
const { t } = useI18n();
const id = useId();
const session = useSessionStore();
const orgId = useActiveOrgId();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);
const canWrite = computed(() => session.me?.features.goals.write ?? false);
const number = (value: string) => formatNumber(value, locale.value);

const goalsQuery = useQuery({
  queryKey: computed(() => ['goals', orgId.value] as const),
  queryFn: () => api.goals.overview(),
  enabled: computed(() => orgId.value !== null),
});
const invalidate = () => queryClient.invalidateQueries({ queryKey: ['goals'] });

type Scope = { type: 'client' | 'profile' | 'productGroup'; id: string };
interface Row {
  scope: Scope;
  name: string;
  level: 0 | 1 | 2;
  goal: GoalData | null;
  /** Ziel der Ebene darüber, wenn kein eigenes gesetzt ist. */
  inherited: { goal: GoalData; from: 'client' | 'profile' } | null;
}
type Profile = GoalsOverviewData['unassignedProfiles'][number];

function profileRows(profile: Profile, level: 0 | 1, clientGoal: GoalData | null): Row[] {
  const fromClient = clientGoal && { goal: clientGoal, from: 'client' as const };
  const fromProfile = profile.goal ? { goal: profile.goal, from: 'profile' as const } : fromClient;
  return [
    {
      scope: { type: 'profile', id: profile.id },
      name: `${profile.accountName} · ${profile.countryCode}`,
      level,
      goal: profile.goal,
      inherited: profile.goal ? null : fromClient,
    },
    ...profile.productGroups.map((group): Row => ({
      scope: { type: 'productGroup', id: group.id },
      name: group.name,
      level: level === 0 ? 1 : 2,
      goal: group.goal,
      inherited: group.goal ? null : fromProfile,
    })),
  ];
}

const sections = computed(() => {
  const data = goalsQuery.data.value;
  if (!data) return [];
  const result = data.clients.map((client) => ({
    key: client.id,
    title: client.name,
    rows: [
      {
        scope: { type: 'client', id: client.id },
        name: client.name,
        level: 0,
        goal: client.goal,
        inherited: null,
      } satisfies Row as Row,
      ...client.profiles.flatMap((profile) => profileRows(profile, 1, client.goal)),
    ],
  }));
  if (data.unassignedProfiles.length > 0) {
    result.push({
      key: 'unassigned',
      title: t('goals.unassigned'),
      rows: data.unassignedProfiles.flatMap((profile) => profileRows(profile, 0, null)),
    });
  }
  return result;
});
const INDENT = ['', 'pl-space-md', 'pl-space-xl'] as const;
const goalText = (goal: GoalData) =>
  t('goals.value', { acos: number(goal.acos), roas: number(goal.roas) });

// --- Bearbeiten --------------------------------------------------------------------------

const editing = ref<Row | null>(null);
const metric = ref<GoalMetric>('acos');
const value = ref('');
const errorKey = ref<string | null>(null);

const save = useMutation({
  mutationFn: (input: { scope: Scope; metric: GoalMetric; value: string }) => api.goals.set(input),
  onSettled: invalidate,
});
const remove = useMutation({
  mutationFn: (goalId: string) => api.goals.remove(goalId),
  onSettled: invalidate,
});
const busy = computed(() => save.isPending.value || remove.isPending.value);

function openEdit(row: Row) {
  editing.value = row;
  metric.value = row.goal?.metric ?? 'acos';
  value.value = row.goal?.value.replace('.', ',') ?? '';
  errorKey.value = null;
  calcOpen.value = false;
  calcResult.value = null;
  calcErrorKey.value = null;
  save.reset();
  remove.reset();
}

const cleanValue = computed(() => value.value.trim().replace(',', '.'));
const issue = computed(() =>
  cleanValue.value === '' ? null : goalValueIssue(metric.value, cleanValue.value),
);
const canSave = computed(() => cleanValue.value !== '' && issue.value === null && !busy.value);
/** Vorschau des anderen Werts; nur Anzeige, gespeichert und exakt gerechnet wird auf dem Server. */
const preview = computed(() =>
  cleanValue.value === '' || issue.value !== null
    ? null
    : t(`goals.preview.${metric.value === 'acos' ? 'roas' : 'acos'}`, {
        value: number(String(100 / Number(cleanValue.value))),
      }),
);

async function attempt(action: () => Promise<unknown>) {
  errorKey.value = null;
  try {
    await action();
    editing.value = null;
  } catch (error) {
    errorKey.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  }
}
function submit() {
  const row = editing.value;
  if (!row || !canSave.value) return;
  void attempt(() =>
    save.mutateAsync({ scope: row.scope, metric: metric.value, value: cleanValue.value }),
  );
}
function removeGoal() {
  const goalId = editing.value?.goal?.id;
  if (!goalId || busy.value) return;
  void attempt(() => remove.mutateAsync(goalId));
}

// --- Rechner -----------------------------------------------------------------------------

const CALC_FIELDS = ['price', 'unitCost', 'fees', 'margin'] as const;
const calc = reactive({ price: '', unitCost: '', fees: '', margin: '' });
const calcOpen = ref(false);
const calcResult = ref<TargetAcosData | null>(null);
const calcErrorKey = ref<string | null>(null);
const calcPending = ref(false);
const canCalculate = computed(
  () => CALC_FIELDS.every((field) => calc[field].trim() !== '') && !calcPending.value,
);

async function calculate() {
  if (!canCalculate.value) return;
  calcPending.value = true;
  calcErrorKey.value = null;
  calcResult.value = null;
  try {
    calcResult.value = await api.goals.calculate({ ...calc });
  } catch (error) {
    // 400 heißt hier immer: Eingabe passt nicht (Zahl, Preis über 0, Marge bis 100 %).
    calcErrorKey.value =
      error instanceof ApiError && error.status === 400
        ? 'goals.calc.invalid'
        : errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN');
  } finally {
    calcPending.value = false;
  }
}
function applyCalc() {
  if (!calcResult.value?.targetAcos) return;
  metric.value = 'acos';
  value.value = calcResult.value.targetAcos.replace('.', ',');
}
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('explorer.eyebrow')"
      :title="t('goals.title')"
      :description="t('goals.description')"
    />

    <InlineError
      v-if="goalsQuery.isError.value"
      :message="t('goals.loadFailed')"
      retryable
      :retrying="goalsQuery.isFetching.value"
      @retry="goalsQuery.refetch()"
    />
    <SkeletonBlock v-else-if="!goalsQuery.data.value" shape="tile" height="14rem" />
    <EmptyState
      v-else-if="sections.length === 0"
      icon="flag"
      :title="t('goals.empty.title')"
      :text="t('goals.empty.text')"
    />

    <template v-else>
      <section
        v-for="section in sections"
        :key="section.key"
        class="flex min-w-0 flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <h2 class="text-headline-sm text-ink">{{ section.title }}</h2>
        <ul class="flex flex-col">
          <li
            v-for="row in section.rows"
            :key="row.scope.id"
            :data-goal-row="row.scope.id"
            class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
          >
            <span :class="['min-w-0 flex-1 basis-48 text-body-md text-ink', INDENT[row.level]]">
              <span class="text-label-eyebrow uppercase text-ink-tertiary">
                {{ t(`goals.scope.${row.scope.type}`) }}
              </span>
              <span class="block truncate">{{ row.name }}</span>
            </span>
            <span v-if="row.goal" class="font-data text-body-md text-ink">
              {{ goalText(row.goal) }}
            </span>
            <span v-else-if="row.inherited" class="text-body-sm text-ink-secondary">
              <span class="font-data">{{ goalText(row.inherited.goal) }}</span>
              · {{ t(`goals.inherited.${row.inherited.from}`) }}
            </span>
            <span v-else class="text-body-sm text-ink-secondary">{{ t('goals.none') }}</span>
            <Button
              v-if="canWrite"
              icon="pi pi-pencil"
              severity="secondary"
              variant="text"
              size="small"
              :aria-label="t('goals.edit.action', { name: row.name })"
              @click="openEdit(row)"
            />
          </li>
        </ul>
      </section>
      <p class="max-w-prose text-body-sm text-ink-secondary">{{ t('goals.later') }}</p>
    </template>

    <Dialog
      :visible="editing !== null"
      modal
      :closable="!busy"
      :close-on-escape="!busy"
      :header="editing ? t('goals.edit.title', { name: editing.name }) : ''"
      :style="{ width: 'min(32rem, calc(100vw - 2rem))' }"
      @update:visible="(next) => !next && (editing = null)"
    >
      <form v-if="editing" class="flex flex-col gap-space-lg" @submit.prevent="submit">
        <InlineError v-if="errorKey" :message="t(errorKey)" />
        <fieldset class="flex flex-col gap-space-xs">
          <legend class="mb-space-xs text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('goals.field.metric') }}
          </legend>
          <div class="flex flex-wrap gap-x-space-lg">
            <label
              v-for="option in GOAL_METRICS"
              :key="option"
              class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
            >
              <input
                v-model="metric"
                type="radio"
                name="goal-metric"
                :value="option"
                class="size-4 accent-violet"
              />
              {{ t(`goals.metric.${option}`) }}
            </label>
          </div>
        </fieldset>
        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-value`" class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t(`goals.field.value.${metric}`) }}
          </label>
          <input
            :id="`${id}-value`"
            v-model="value"
            data-goal-value
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :aria-invalid="issue ? 'true' : undefined"
            :aria-describedby="`${id}-value-hint`"
            :class="[
              'h-11 rounded-control bg-well px-space-md font-data text-ink outline-none focus-visible:ring-2',
              issue ? 'ring-2 ring-loss' : 'focus-visible:ring-violet',
            ]"
          />
          <p
            :id="`${id}-value-hint`"
            data-goal-preview
            :class="['text-body-sm', issue ? 'text-on-loss-wash' : 'text-ink-secondary']"
          >
            {{ issue ? t(`goals.issue.${issue}.${metric}`) : (preview ?? '') }}
          </p>
        </div>

        <div class="flex flex-col gap-space-md">
          <Button
            type="button"
            icon="pi pi-calculator"
            severity="secondary"
            variant="text"
            class="self-start"
            :label="t('goals.calc.toggle')"
            :aria-expanded="calcOpen"
            @click="calcOpen = !calcOpen"
          />
          <div
            v-if="calcOpen"
            class="flex flex-col gap-space-md rounded-control bg-well p-space-md"
          >
            <p class="text-body-sm text-ink-secondary">{{ t('goals.calc.hint') }}</p>
            <div class="grid grid-cols-2 gap-space-md">
              <div v-for="field in CALC_FIELDS" :key="field" class="flex flex-col gap-space-xs">
                <label
                  :for="`${id}-calc-${field}`"
                  class="text-label-eyebrow uppercase text-ink-tertiary"
                >
                  {{ t(`goals.calc.field.${field}`) }}
                </label>
                <input
                  :id="`${id}-calc-${field}`"
                  v-model="calc[field]"
                  :data-calc="field"
                  type="text"
                  inputmode="decimal"
                  autocomplete="off"
                  class="h-11 min-w-0 rounded-control bg-tile px-space-md font-data text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet"
                />
              </div>
            </div>
            <InlineError v-if="calcErrorKey" :message="t(calcErrorKey)" />
            <p v-if="calcResult" data-calc-result class="text-body-md text-ink" aria-live="polite">
              {{ t('goals.calc.breakEven') }}
              <span class="font-data">{{ number(calcResult.breakEvenAcos) }} %</span>
              <template v-if="calcResult.targetAcos">
                · {{ t('goals.calc.target') }}
                <span class="font-data">{{ number(calcResult.targetAcos) }} %</span>
              </template>
              <template v-else> · {{ t('goals.calc.noTarget') }}</template>
            </p>
            <div class="flex flex-wrap gap-space-sm">
              <Button
                type="button"
                data-calc-run
                severity="secondary"
                :label="t('goals.calc.run')"
                :loading="calcPending"
                :disabled="!canCalculate"
                @click="calculate"
              />
              <Button
                v-if="calcResult?.targetAcos"
                type="button"
                data-calc-apply
                severity="secondary"
                variant="text"
                :label="t('goals.calc.apply')"
                @click="applyCalc"
              />
            </div>
          </div>
        </div>

        <div class="flex flex-wrap justify-end gap-space-sm">
          <Button
            v-if="editing.goal"
            type="button"
            data-goal-delete
            class="mr-auto"
            severity="danger"
            variant="text"
            :label="t('goals.edit.remove')"
            :loading="remove.isPending.value"
            :disabled="busy"
            @click="removeGoal"
          />
          <Button
            type="button"
            :label="t('common.cancel')"
            severity="secondary"
            variant="text"
            :disabled="busy"
            @click="editing = null"
          />
          <Button
            type="submit"
            data-goal-save
            :label="t('common.save')"
            :loading="save.isPending.value"
            :disabled="!canSave"
          />
        </div>
      </form>
    </Dialog>
  </div>
</template>
