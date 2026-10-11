<script setup lang="ts">
import {
  CHECK_FINDING_FILTERS,
  CHECK_KINDS,
  checkSettingsSchema,
  formatCurrency,
  formatDay,
  formatNumber,
  type CheckFindingFilter,
  type CheckKind,
} from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import { computed, reactive, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api, ApiError } from '../api';
import type { CheckFindingData } from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { errorMessageKey } from '../i18n';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Tab „Prüfungen“ (`phase-5.md` 5.10): Befunde des letzten Laufs je Profil (offen oder quittiert), quittieren, und
 * die Einstellungen der Organisation (welche Prüfungen laufen, Schwellen; nur Admins ändern sie). Ein quittierter
 * Befund bleibt es, solange er in jedem Lauf wieder auftritt.
 */
const props = defineProps<{ canWrite: boolean }>();
const { t, te } = useI18n();
const id = useId();
const session = useSessionStore();
const orgId = useActiveOrgId();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);

const status = ref<CheckFindingFilter>('open');
const query = useQuery({
  queryKey: computed(() => ['automation-checks', orgId.value, status.value] as const),
  queryFn: () => api.automations.checks(status.value),
  enabled: computed(() => orgId.value !== null),
});
const data = computed(() => query.data.value);
const findings = computed(() => data.value?.findings ?? []);
const invalidate = () => queryClient.invalidateQueries({ queryKey: ['automation-checks'] });

const day = (iso: string) => formatDay(iso.slice(0, 10), locale.value);
const where = (x: CheckFindingData) =>
  [x.keywordText, x.campaignName, x.accountName].filter(Boolean).join(' · ');
/** Text eines Befunds aus seinen Zahlen; was fehlt (ältere Läufe), bleibt leer. */
function describe(x: CheckFindingData): string {
  const { detail } = x;
  const text = (name: string) => (typeof detail[name] === 'string' ? detail[name] : '');
  const count = (name: string) => (typeof detail[name] === 'number' ? detail[name] : 0);
  const money = (name: string) =>
    text(name) ? formatCurrency(text(name), x.currencyCode, locale.value) : '';
  const number = (name: string) => (text(name) ? formatNumber(text(name), locale.value) : '');
  const placementKey = `changes.setupPlacement.${x.key}`;
  return t(
    `automations.checks.detail.${x.kind === 'placement' && !text('acos') ? 'placementNoSales' : x.kind}`,
    {
      spend: money('spend'),
      clicks: formatNumber(count('clicks'), locale.value),
      placement: te(placementKey) ? t(placementKey) : x.key,
      percent: formatNumber(count('percent'), locale.value),
      acos: number('acos'),
      goal: number('goalAcos'),
      basis: t(
        `automations.checks.basis.${text('basis') === 'placement' ? 'placement' : 'campaign'}`,
      ),
      n: formatNumber(count('campaigns'), locale.value),
    },
    count('campaigns'),
  );
}

const canAct = computed(() => props.canWrite && status.value === 'open');
const acknowledge = useMutation({
  mutationFn: (ids: string[]) => api.automations.acknowledgeFindings(ids),
  onSettled: invalidate,
});
const act = (ids: string[]) =>
  !acknowledge.isPending.value && ids.length > 0 && acknowledge.mutate(ids);

// --- Einstellungen -----------------------------------------------------------------------

const form = reactive({
  enabled: {} as Record<CheckKind, boolean>,
  placementMinPercent: '',
  spendNoOrdersMinEur: '',
});
const settingsError = ref<string | null>(null);
const saved = ref(false);
// Der Stand des Servers füllt das Formular, solange niemand darin tippt (jede Antwort nach dem Speichern auch).
watch(
  () => data.value?.settings,
  (settings) => {
    if (!settings) return;
    Object.assign(form, {
      enabled: { ...settings.enabled },
      placementMinPercent: String(settings.placementMinPercent),
      spendNoOrdersMinEur: settings.spendNoOrdersMinEur.replace('.', ','),
    });
  },
  { immediate: true },
);
const save = useMutation({
  mutationFn: (settings: Parameters<typeof api.automations.saveCheckSettings>[0]) =>
    api.automations.saveCheckSettings(settings),
  onSuccess: () => (saved.value = true),
  onError: (error) =>
    (settingsError.value = errorMessageKey(error instanceof ApiError ? error.code : 'UNKNOWN')),
  onSettled: invalidate,
});
function submit() {
  if (save.isPending.value) return;
  saved.value = false;
  const parsed = checkSettingsSchema.safeParse({
    enabled: form.enabled,
    placementMinPercent: Number(form.placementMinPercent.trim() || NaN),
    spendNoOrdersMinEur: form.spendNoOrdersMinEur,
  });
  settingsError.value = parsed.success ? null : 'automations.checks.settings.invalid';
  if (parsed.success) save.mutate(parsed.data);
}

const INPUT =
  'h-11 w-full min-w-0 rounded-control bg-well px-space-md font-data text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet disabled:opacity-60';
const LABEL = 'text-label-eyebrow uppercase text-ink-tertiary';
const TILE =
  'flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg';
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <section :class="TILE">
      <div class="flex flex-wrap items-end justify-between gap-space-md">
        <div class="flex min-w-0 flex-col gap-space-xs">
          <h2 class="text-headline-sm text-ink">{{ t('automations.checks.title') }}</h2>
          <p class="max-w-prose text-body-sm text-ink-secondary">
            {{ t('automations.checks.text') }}
          </p>
        </div>
        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-status`" :class="LABEL">
            {{ t('automations.checks.statusLabel') }}
          </label>
          <select
            :id="`${id}-status`"
            v-model="status"
            data-findings-status
            class="h-11 rounded-control bg-well px-space-md text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet"
          >
            <option v-for="option in CHECK_FINDING_FILTERS" :key="option" :value="option">
              {{ t(`automations.checks.status.${option}`) }}
            </option>
          </select>
        </div>
      </div>

      <InlineError
        v-if="acknowledge.isError.value"
        :message="t('automations.checks.acknowledgeFailed')"
      />
      <InlineError
        v-if="query.isError.value && !data"
        :message="t('automations.checks.loadFailed')"
        retryable
        :retrying="query.isFetching.value"
        @retry="query.refetch()"
      />
      <SkeletonBlock v-else-if="!data" shape="tile" height="16rem" />
      <EmptyState
        v-else-if="findings.length === 0"
        icon="check-circle"
        :title="t(`automations.checks.empty.${status}.title`)"
        :text="t(`automations.checks.empty.${status}.text`)"
      />

      <template v-else>
        <div class="flex flex-wrap items-center justify-between gap-space-sm">
          <span class="font-data text-body-sm text-ink-secondary">
            {{
              t('automations.checks.shown', {
                shown: formatNumber(findings.length, locale),
                total: formatNumber(data.total, locale),
              })
            }}
          </span>
          <Button
            v-if="canAct"
            severity="secondary"
            size="small"
            :label="t('automations.checks.acknowledgeAll')"
            :disabled="acknowledge.isPending.value"
            @click="act(findings.map((x) => x.id))"
          />
        </div>
        <ul class="flex flex-col">
          <li
            v-for="x in findings"
            :key="x.id"
            :data-finding-row="x.id"
            class="flex flex-wrap items-start gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
          >
            <div class="flex min-w-0 flex-1 basis-64 flex-col gap-space-xs">
              <span class="flex flex-wrap items-center gap-x-space-sm text-body-md text-ink">
                <span
                  :class="[
                    'size-2 shrink-0 rounded-full',
                    x.severity === 'warning' ? 'bg-warn' : 'bg-violet',
                  ]"
                  aria-hidden="true"
                />
                {{ t(`automations.checks.kind.${x.kind}`) }}
                <span class="text-body-sm text-ink-tertiary">
                  {{ t(`automations.checks.severity.${x.severity}`) }}
                </span>
              </span>
              <span class="break-words text-body-sm text-ink-tertiary">{{ where(x) }}</span>
              <span class="font-data text-body-sm text-ink-secondary">{{ describe(x) }}</span>
            </div>
            <div class="flex flex-col items-end gap-space-xs">
              <span class="font-data text-body-sm text-ink-tertiary">
                {{
                  x.acknowledgedAt
                    ? t('automations.checks.acknowledgedAt', { day: day(x.acknowledgedAt) })
                    : t('automations.checks.since', { day: day(x.firstSeenAt) })
                }}
              </span>
              <Button
                v-if="canAct"
                severity="secondary"
                variant="text"
                size="small"
                :label="t('automations.checks.acknowledge')"
                :disabled="acknowledge.isPending.value"
                @click="act([x.id])"
              />
            </div>
          </li>
        </ul>
      </template>
    </section>

    <section v-if="data" :class="TILE">
      <div class="flex flex-col gap-space-xs">
        <h2 class="text-headline-sm text-ink">{{ t('automations.checks.settings.title') }}</h2>
        <p class="max-w-prose text-body-sm text-ink-secondary">
          {{
            t(
              data.canEditSettings
                ? 'automations.checks.settings.text'
                : 'automations.checks.settings.readOnly',
            )
          }}
        </p>
      </div>
      <form class="flex flex-col gap-space-md" novalidate @submit.prevent="submit">
        <fieldset class="flex flex-col">
          <legend :class="['mb-space-xs', LABEL]">
            {{ t('automations.checks.settings.enabled') }}
          </legend>
          <label
            v-for="kind in CHECK_KINDS"
            :key="kind"
            class="flex min-h-11 items-center gap-space-sm text-body-md text-ink"
          >
            <input
              v-model="form.enabled[kind]"
              type="checkbox"
              :data-check-enabled="kind"
              :disabled="!data.canEditSettings"
              class="size-4 accent-violet"
            />
            {{ t(`automations.checks.kind.${kind}`) }}
          </label>
        </fieldset>
        <div class="grid grid-cols-1 gap-space-md sm:grid-cols-2">
          <div class="flex flex-col gap-space-xs">
            <label :for="`${id}-placement`" :class="LABEL">
              {{ t('automations.checks.settings.placementMinPercent') }}
            </label>
            <input
              :id="`${id}-placement`"
              v-model="form.placementMinPercent"
              data-check-placement
              type="text"
              inputmode="numeric"
              autocomplete="off"
              :disabled="!data.canEditSettings"
              :class="INPUT"
            />
          </div>
          <div class="flex flex-col gap-space-xs">
            <label :for="`${id}-spend`" :class="LABEL">
              {{ t('automations.checks.settings.spendNoOrdersMinEur') }}
            </label>
            <input
              :id="`${id}-spend`"
              v-model="form.spendNoOrdersMinEur"
              data-check-spend
              type="text"
              inputmode="decimal"
              autocomplete="off"
              :disabled="!data.canEditSettings"
              :class="INPUT"
            />
          </div>
        </div>
        <InlineError v-if="settingsError" :message="t(settingsError)" />
        <div v-if="data.canEditSettings" class="flex flex-wrap items-center gap-space-md">
          <Button
            type="submit"
            :label="t('automations.checks.settings.save')"
            :loading="save.isPending.value"
          />
          <span v-if="saved" role="status" class="text-body-sm text-ink-secondary">
            {{ t('automations.checks.settings.saved') }}
          </span>
        </div>
      </form>
    </section>

    <section :class="TILE">
      <h2 class="text-headline-sm text-ink">{{ t('automations.checks.manual.title') }}</h2>
      <p class="max-w-prose text-body-sm text-ink-secondary">
        {{ t('automations.checks.manual.text') }}
      </p>
      <ul class="flex list-disc flex-col gap-space-xs pl-space-lg text-body-sm text-ink">
        <li v-for="item in ['prompts', 'sbVcpm', 'offAmazon']" :key="item">
          {{ t(`automations.checks.manual.${item}`) }}
        </li>
      </ul>
    </section>
  </div>
</template>
