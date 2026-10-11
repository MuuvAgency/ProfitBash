<script setup lang="ts">
import {
  BUDGET_CAP_SCOPES,
  budgetCapInputSchema,
  DEFAULT_CAP_WARN_PERCENTS,
  formatCurrency,
  formatDay,
  type BudgetCapScopeType,
} from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import Dialog from 'primevue/dialog';
import { computed, reactive, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import type { BudgetCapData, BudgetCapInputData, BudgetsOverviewData } from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import PageHeader from '../components/common/PageHeader.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Seite „Budgets“ (`phase-5.md` 5.9a, F5): Caps je Profil und Monat mit Pacing (Ist, Soll linear, Prognose zum
 * Monatsende). Ohne Tageswerte ist das Ist aus dem Zeitraum der Bulk-Datei anteilig geschätzt („≈“ mit Spanne).
 */
const { t, te } = useI18n();
const id = useId();
const session = useSessionStore();
const orgId = useActiveOrgId();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);
const canWrite = computed(() => session.me?.features.budgets.write ?? false);

const query = useQuery({
  queryKey: computed(() => ['budgets', orgId.value] as const),
  queryFn: () => api.budgets.overview(),
  enabled: computed(() => orgId.value !== null),
});
const invalidate = () => queryClient.invalidateQueries({ queryKey: ['budgets'] });

type Profile = BudgetsOverviewData['profiles'][number];
const profiles = computed(() => query.data.value?.profiles);
const tags = computed(() => query.data.value?.tags ?? []);

const money = (value: string, profile: Profile) =>
  formatCurrency(value, profile.currencyCode, locale.value);
const monthLabel = (month: string) =>
  new Intl.DateTimeFormat(locale.value, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${month}-01T00:00:00Z`),
  );
const scopeLabel = (cap: BudgetCapData) =>
  cap.scope.type === 'profile'
    ? t('budgets.scope.profile')
    : t(`budgets.scopeWith.${cap.scope.type}`, {
        names: cap.scopeLabels.join(', ') || t('budgets.scope.gone'),
      });
const stateLabel = (state: string | null) =>
  state && te(`budgets.state.${state}`) ? t(`budgets.state.${state}`) : (state ?? '');

/** Breiten des Balkens in Prozent; nur für die Anzeige, gerechnet wird auf dem Server. */
function bar(cap: BudgetCapData) {
  const limit = Number(cap.effectiveAmount);
  const scale = Math.max(limit, Number(cap.pacing.forecast.value), Number(cap.pacing.actual.value));
  const percent = (value: string | number) => `${Math.min(100, (Number(value) / scale) * 100)}%`;
  return {
    actual: percent(cap.pacing.actual.value),
    forecast: percent(cap.pacing.forecast.value),
    planned: percent(cap.pacing.planned),
    cap: percent(limit),
    over: scale > limit,
  };
}
const tone = (cap: BudgetCapData) =>
  cap.pacing.warnLevel === null ? 'bg-violet' : cap.pacing.warnLevel >= 100 ? 'bg-loss' : 'bg-warn';

// --- Bearbeiten --------------------------------------------------------------------------

const editing = ref<{ profile: Profile; cap: BudgetCapData | null } | null>(null);
const form = reactive({
  scopeType: 'profile' as BudgetCapScopeType,
  scopeIds: [] as string[],
  amount: '',
  months: [] as { month: string; amount: string }[],
  warn: '',
});
const issues = ref<string[]>([]);
const errorKey = ref<string | null>(null);
const comma = (value: string) => value.replace('.', ',');

const save = useMutation({
  mutationFn: (input: { id: string | null; body: BudgetCapInputData }) =>
    input.id ? api.budgets.updateCap(input.id, input.body) : api.budgets.createCap(input.body),
  onSettled: invalidate,
});
const remove = useMutation({
  mutationFn: (capId: string) => api.budgets.removeCap(capId),
  onSettled: invalidate,
});
const busy = computed(() => save.isPending.value || remove.isPending.value);

function openEdit(profile: Profile, cap: BudgetCapData | null) {
  editing.value = { profile, cap };
  Object.assign(form, {
    scopeType: cap?.scope.type ?? 'profile',
    scopeIds: [...(cap?.scope.ids ?? [])],
    amount: cap ? comma(cap.amount) : '',
    months: Object.entries(cap?.monthAmounts ?? {}).map(([month, amount]) => ({
      month,
      amount: comma(amount),
    })),
    warn: (cap?.warnPercents ?? DEFAULT_CAP_WARN_PERCENTS).join(', '),
  });
  issues.value = [];
  errorKey.value = null;
}
const scopeOptions = computed(() =>
  form.scopeType === 'portfolios'
    ? (editing.value?.profile.portfolios ?? [])
    : form.scopeType === 'tags'
      ? tags.value
      : [],
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
  const current = editing.value;
  if (!current || busy.value) return;
  const optionIds = new Set(scopeOptions.value.map((option) => option.id));
  const parsed = budgetCapInputSchema.safeParse({
    profileId: current.profile.id,
    scope: { type: form.scopeType, ids: form.scopeIds.filter((scopeId) => optionIds.has(scopeId)) },
    amount: form.amount,
    monthAmounts: Object.fromEntries(
      form.months
        .filter((row) => row.month !== '' || row.amount.trim() !== '')
        .map((row) => [row.month, row.amount]),
    ),
    warnPercents: form.warn
      .split(/[\s,;]+/)
      .filter(Boolean)
      .map(Number),
  });
  issues.value = parsed.success
    ? []
    : [...new Set(parsed.error.issues.map((issue) => String(issue.path[0])))];
  if (!parsed.success) return;
  void attempt(() => save.mutateAsync({ id: current.cap?.id ?? null, body: parsed.data }));
}
function removeCap() {
  const capId = editing.value?.cap?.id;
  if (!capId || busy.value) return;
  void attempt(() => remove.mutateAsync(capId));
}

const INPUT =
  'h-11 min-w-0 rounded-control bg-well px-space-md font-data text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet';
const LABEL = 'text-label-eyebrow uppercase text-ink-tertiary';
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <PageHeader
      :eyebrow="t('explorer.eyebrow')"
      :title="t('budgets.title')"
      :description="t('budgets.description')"
    />

    <InlineError
      v-if="query.isError.value && !profiles"
      :message="t('budgets.loadFailed')"
      retryable
      :retrying="query.isFetching.value"
      @retry="query.refetch()"
    />
    <SkeletonBlock v-else-if="!profiles" shape="tile" height="14rem" />
    <EmptyState
      v-else-if="profiles.length === 0"
      icon="wallet"
      :title="t('budgets.empty.title')"
      :text="t('budgets.empty.text')"
    />

    <template v-else>
      <section
        v-for="profile in profiles"
        :key="profile.id"
        :data-budget-profile="profile.id"
        class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
      >
        <div class="flex flex-wrap items-start justify-between gap-space-sm">
          <div class="flex min-w-0 flex-col gap-space-xs">
            <h2 class="truncate text-headline-sm text-ink">
              {{ profile.accountName }} · {{ profile.countryCode }}
            </h2>
            <p class="text-body-sm text-ink-secondary">
              {{ monthLabel(profile.month) }} ·
              <span v-if="profile.dataState" class="font-data">
                {{
                  t('budgets.dataState', {
                    start: formatDay(profile.dataState.periodStart, locale),
                    end: formatDay(profile.dataState.periodEnd, locale),
                  })
                }}
              </span>
              <span v-else>{{ t('budgets.noData') }}</span>
            </p>
          </div>
          <Button
            v-if="canWrite"
            icon="pi pi-plus"
            severity="secondary"
            size="small"
            :label="t('budgets.add')"
            @click="openEdit(profile, null)"
          />
        </div>

        <p v-if="profile.caps.length === 0" class="text-body-sm text-ink-secondary">
          {{ t('budgets.noCap') }}
        </p>
        <ul v-else class="flex flex-col gap-space-md">
          <li
            v-for="cap in profile.caps"
            :key="cap.id"
            :data-cap="cap.id"
            class="flex flex-col gap-space-sm rounded-control bg-well p-space-md"
          >
            <div class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs">
              <span class="min-w-0 flex-1 basis-48 text-body-md text-ink">
                {{ scopeLabel(cap) }}
              </span>
              <span class="font-data text-body-md text-ink">
                {{ money(cap.effectiveAmount, profile) }}
              </span>
              <Button
                v-if="canWrite"
                icon="pi pi-pencil"
                severity="secondary"
                variant="text"
                size="small"
                :aria-label="t('budgets.edit.action', { name: scopeLabel(cap) })"
                @click="openEdit(profile, cap)"
              />
            </div>
            <p v-if="cap.monthAmounts[profile.month]" class="text-body-sm text-ink-secondary">
              {{ t('budgets.monthOverride', { amount: money(cap.amount, profile) }) }}
            </p>

            <div
              class="relative h-2 overflow-hidden rounded-full bg-tile"
              role="img"
              :aria-label="
                t('budgets.barLabel', {
                  actual: money(cap.pacing.actual.value, profile),
                  cap: money(cap.effectiveAmount, profile),
                })
              "
            >
              <div
                :class="[
                  'absolute inset-y-0 left-0',
                  cap.pacing.forecastOver ? 'bg-loss-wash' : 'bg-violet-wash',
                ]"
                :style="{ width: bar(cap).forecast }"
              />
              <div
                :class="['absolute inset-y-0 left-0', tone(cap)]"
                :style="{ width: bar(cap).actual }"
              />
              <div
                class="absolute inset-y-0 w-0.5 bg-ink-tertiary"
                :style="{ left: bar(cap).planned }"
              />
              <div
                v-if="bar(cap).over"
                class="absolute inset-y-0 w-0.5 bg-loss"
                :style="{ left: bar(cap).cap }"
              />
            </div>

            <dl class="grid grid-cols-1 gap-x-space-lg gap-y-space-xs sm:grid-cols-3">
              <div class="flex flex-col">
                <dt :class="LABEL">{{ t('budgets.actual') }}</dt>
                <dd class="font-data text-body-md text-ink">
                  <span v-if="!cap.pacing.exact && cap.pacing.dataThrough">≈ </span
                  >{{ money(cap.pacing.actual.value, profile) }}
                </dd>
                <dd
                  v-if="!cap.pacing.exact && cap.pacing.dataThrough"
                  class="font-data text-body-sm text-ink-secondary"
                >
                  {{
                    t('budgets.range', {
                      low: money(cap.pacing.actual.low, profile),
                      high: money(cap.pacing.actual.high, profile),
                    })
                  }}
                </dd>
                <dd v-if="!cap.pacing.dataThrough" class="text-body-sm text-ink-secondary">
                  {{ t('budgets.noMonthData') }}
                </dd>
              </div>
              <div class="flex flex-col">
                <dt :class="LABEL">{{ t('budgets.planned') }}</dt>
                <dd class="font-data text-body-md text-ink">
                  {{ money(cap.pacing.planned, profile) }}
                </dd>
                <dd v-if="cap.pacing.dataThrough" class="font-data text-body-sm text-ink-secondary">
                  {{ t('budgets.through', { day: formatDay(cap.pacing.dataThrough, locale) }) }}
                </dd>
              </div>
              <div class="flex flex-col">
                <dt :class="LABEL">{{ t('budgets.forecast') }}</dt>
                <dd class="font-data text-body-md text-ink">
                  ≈ {{ money(cap.pacing.forecast.value, profile) }}
                </dd>
              </div>
            </dl>

            <p
              v-if="cap.pacing.warnLevel !== null || cap.pacing.forecastOver"
              class="flex flex-wrap gap-x-space-md text-body-sm"
            >
              <span
                v-if="cap.pacing.warnLevel !== null"
                :class="cap.pacing.warnLevel >= 100 ? 'text-on-loss-wash' : 'text-warn'"
              >
                {{ t('budgets.warnReached', { percent: cap.pacing.warnLevel }) }}
              </span>
              <span v-if="cap.pacing.forecastOver" class="text-on-loss-wash">
                {{ t('budgets.forecastOver') }}
              </span>
            </p>

            <details class="text-body-sm text-ink-secondary">
              <summary class="min-h-11 cursor-pointer content-center">
                {{ t('budgets.campaigns', { n: cap.campaignCount }, cap.campaignCount) }}
              </summary>
              <ul class="flex flex-col">
                <li
                  v-for="campaign in cap.campaigns"
                  :key="campaign.id"
                  class="flex flex-wrap items-baseline justify-between gap-x-space-md border-b border-line py-space-xs last:border-b-0"
                >
                  <span class="min-w-0 flex-1 basis-48 truncate text-ink">
                    {{ campaign.name ?? t('budgets.unnamed') }}
                  </span>
                  <span>{{ stateLabel(campaign.state) }}</span>
                  <span v-if="campaign.dailyBudget" class="font-data">
                    {{ t('budgets.dailyBudget', { amount: money(campaign.dailyBudget, profile) }) }}
                  </span>
                  <span class="font-data text-ink">
                    <span v-if="!campaign.exact">≈ </span>{{ money(campaign.actual, profile) }}
                  </span>
                </li>
              </ul>
              <p v-if="cap.campaignCount > cap.campaigns.length" class="pt-space-xs">
                {{ t('budgets.campaignsMore', { n: cap.campaignCount - cap.campaigns.length }) }}
              </p>
            </details>
          </li>
        </ul>
      </section>
      <p class="max-w-prose text-body-sm text-ink-secondary">{{ t('budgets.hint') }}</p>
    </template>

    <Dialog
      :visible="editing !== null"
      modal
      :closable="!busy"
      :close-on-escape="!busy"
      :header="
        editing
          ? t(editing.cap ? 'budgets.edit.title' : 'budgets.edit.titleNew', {
              name: editing.profile.accountName,
            })
          : ''
      "
      :style="{ width: 'min(34rem, calc(100vw - 2rem))' }"
      @update:visible="(next) => !next && (editing = null)"
    >
      <form v-if="editing" class="flex flex-col gap-space-lg" novalidate @submit.prevent="submit">
        <InlineError v-if="errorKey" :message="t(errorKey)" />

        <fieldset class="flex flex-col gap-space-xs">
          <legend :class="['mb-space-xs', LABEL]">{{ t('budgets.field.scope') }}</legend>
          <div class="flex flex-wrap gap-x-space-lg">
            <label
              v-for="option in BUDGET_CAP_SCOPES"
              :key="option"
              class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
            >
              <input
                v-model="form.scopeType"
                type="radio"
                name="cap-scope"
                :value="option"
                :data-cap-scope="option"
                class="size-4 accent-violet"
              />
              {{ t(`budgets.scope.${option}`) }}
            </label>
          </div>
          <div v-if="form.scopeType !== 'profile'" class="flex flex-col">
            <label
              v-for="option in scopeOptions"
              :key="option.id"
              class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
            >
              <input
                v-model="form.scopeIds"
                type="checkbox"
                :value="option.id"
                :data-cap-scope-id="option.id"
                class="size-4 accent-violet"
              />
              {{ option.name }}
            </label>
            <p v-if="scopeOptions.length === 0" class="text-body-sm text-ink-secondary">
              {{ t(`budgets.noOptions.${form.scopeType}`) }}
            </p>
          </div>
          <p v-if="issues.includes('scope')" class="text-body-sm text-on-loss-wash">
            {{ t('budgets.issue.scope') }}
          </p>
        </fieldset>

        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-amount`" :class="LABEL">
            {{ t('budgets.field.amount', { currency: editing.profile.currencyCode }) }}
          </label>
          <input
            :id="`${id}-amount`"
            v-model="form.amount"
            data-cap-amount
            type="text"
            inputmode="decimal"
            autocomplete="off"
            :aria-invalid="issues.includes('amount') ? 'true' : undefined"
            :aria-describedby="`${id}-amount-hint`"
            :class="INPUT"
          />
          <p
            :id="`${id}-amount-hint`"
            :class="[
              'text-body-sm',
              issues.includes('amount') ? 'text-on-loss-wash' : 'text-ink-secondary',
            ]"
          >
            {{ t(issues.includes('amount') ? 'budgets.issue.amount' : 'budgets.field.amountHint') }}
          </p>
        </div>

        <fieldset class="flex flex-col gap-space-sm">
          <legend :class="['mb-space-xs', LABEL]">{{ t('budgets.field.months') }}</legend>
          <p class="text-body-sm text-ink-secondary">{{ t('budgets.field.monthsHint') }}</p>
          <div
            v-for="(row, index) in form.months"
            :key="index"
            class="flex flex-wrap items-end gap-space-sm"
          >
            <div class="flex min-w-0 flex-1 flex-col gap-space-xs">
              <label :for="`${id}-month-${index}`" :class="LABEL">
                {{ t('budgets.field.month') }}
              </label>
              <input
                :id="`${id}-month-${index}`"
                v-model="row.month"
                :data-cap-month="index"
                type="month"
                placeholder="JJJJ-MM"
                :class="INPUT"
              />
            </div>
            <div class="flex min-w-0 flex-1 flex-col gap-space-xs">
              <label :for="`${id}-month-amount-${index}`" :class="LABEL">
                {{ t('budgets.field.monthAmount') }}
              </label>
              <input
                :id="`${id}-month-amount-${index}`"
                v-model="row.amount"
                :data-cap-month-amount="index"
                type="text"
                inputmode="decimal"
                autocomplete="off"
                :class="INPUT"
              />
            </div>
            <Button
              type="button"
              icon="pi pi-trash"
              severity="secondary"
              variant="text"
              :aria-label="t('budgets.field.monthRemove')"
              @click="form.months.splice(index, 1)"
            />
          </div>
          <p v-if="issues.includes('monthAmounts')" class="text-body-sm text-on-loss-wash">
            {{ t('budgets.issue.monthAmounts') }}
          </p>
          <Button
            type="button"
            icon="pi pi-plus"
            severity="secondary"
            variant="text"
            class="self-start"
            :label="t('budgets.field.monthAdd')"
            @click="form.months.push({ month: '', amount: '' })"
          />
        </fieldset>

        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-warn`" :class="LABEL">{{ t('budgets.field.warn') }}</label>
          <input
            :id="`${id}-warn`"
            v-model="form.warn"
            data-cap-warn
            type="text"
            inputmode="numeric"
            autocomplete="off"
            :aria-invalid="issues.includes('warnPercents') ? 'true' : undefined"
            :aria-describedby="`${id}-warn-hint`"
            :class="INPUT"
          />
          <p
            :id="`${id}-warn-hint`"
            :class="[
              'text-body-sm',
              issues.includes('warnPercents') ? 'text-on-loss-wash' : 'text-ink-secondary',
            ]"
          >
            {{
              t(
                issues.includes('warnPercents')
                  ? 'budgets.issue.warnPercents'
                  : 'budgets.field.warnHint',
              )
            }}
          </p>
        </div>

        <div class="flex flex-wrap justify-end gap-space-sm">
          <Button
            v-if="editing.cap"
            type="button"
            class="mr-auto"
            severity="danger"
            variant="text"
            :label="t('budgets.edit.remove')"
            :loading="remove.isPending.value"
            :disabled="busy"
            @click="removeCap"
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
            :label="t('common.save')"
            :loading="save.isPending.value"
            :disabled="busy"
          />
        </div>
      </form>
    </Dialog>
  </div>
</template>
