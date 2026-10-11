<script setup lang="ts">
import {
  AUTOMATION_PROPOSAL_FILTERS,
  formatCurrency,
  formatDay,
  formatNumber,
  MISSING_VALUE,
} from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import { computed, ref, useId, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import type { AutomationProposalData } from '../api/client';
import EmptyState from '../components/common/EmptyState.vue';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { targetLabel } from '../explorer/amazon-labels';
import { useActiveOrgId, useSessionStore } from '../stores/session';

/**
 * Tab „Vorschläge“ (`phase-5.md` 5.8): je Vorschlag Entity, vorher/nachher, Regel bzw. Optimizer, Leitplanke und
 * Kennzahlen des Zeitraums. Mit Schreibrecht einzeln oder markiert „in meinen Warenkorb“ und verwerfen.
 */
const props = defineProps<{ canWrite: boolean }>();
const { t, te } = useI18n();
const id = useId();
const session = useSessionStore();
const orgId = useActiveOrgId();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);

type Status = AutomationProposalData['status'];
const status = ref<Status>('open');
const query = useQuery({
  queryKey: computed(() => ['automation-proposals', orgId.value, status.value] as const),
  queryFn: () => api.automations.proposals(status.value),
  enabled: computed(() => orgId.value !== null),
});
const data = computed(() => query.data.value);
const proposals = computed(() => data.value?.proposals ?? []);

// --- Anzeige -----------------------------------------------------------------------------

const unknown = computed(() => t('explorer.unknownName'));
const name = (x: AutomationProposalData) =>
  x.entityType === 'campaign'
    ? (x.campaignName ?? unknown.value)
    : ((x.target && targetLabel(x.target, { t, te })) ?? unknown.value);
const path = (x: AutomationProposalData) =>
  x.entityType === 'campaign'
    ? null
    : [x.campaignName ?? unknown.value, ...(x.adGroupName ? [x.adGroupName] : [])].join(' › ');
function value(x: AutomationProposalData, raw: string | null) {
  if (raw === null) return MISSING_VALUE;
  if (x.field === 'state') {
    const key = `automations.proposals.state.${raw}`;
    return te(key) ? t(key) : raw;
  }
  return x.currencyCode ? formatCurrency(raw, x.currencyCode, locale.value) : raw;
}
const source = (x: AutomationProposalData) =>
  x.source !== 'rule'
    ? t(`automations.proposals.source.${x.source}`)
    : x.ruleName
      ? t('automations.proposals.source.rule', { name: x.ruleName })
      : t('automations.proposals.source.ruleUnnamed');
const guardrail = (code: string) => {
  const key = `automations.proposals.guardrail.${code}`;
  return te(key) ? t(key) : code;
};
/** Kennzahlen aus der Begründung; was fehlt (ältere Läufe), bleibt weg. */
function metrics(x: AutomationProposalData): string[] {
  const { clicks, orders, spend, sales, goalAcos } = x.detail;
  const amount = (raw: unknown) =>
    typeof raw === 'string' && x.currencyCode
      ? formatCurrency(raw, x.currencyCode, locale.value)
      : null;
  const counted = (key: string, n: unknown) =>
    typeof n === 'number'
      ? t(`automations.proposals.metrics.${key}`, { n: formatNumber(n, locale.value) }, n)
      : null;
  // Enforcer (5.9b): Der Zustand hat keine Währung, deshalb steht die des Caps in der Begründung.
  const { capAmount, capCurrencyCode, actual, forecast, dataThrough } = x.detail;
  const capMoney = (raw: unknown) =>
    typeof raw === 'string' && typeof capCurrencyCode === 'string'
      ? formatCurrency(raw, capCurrencyCode, locale.value)
      : '';
  return [
    typeof capAmount === 'string' &&
      t('automations.proposals.cap', {
        amount: capMoney(capAmount),
        actual: capMoney(actual),
        forecast: capMoney(forecast),
        day: formatDay(typeof dataThrough === 'string' ? dataThrough : null, locale.value),
      }),
    counted('clicks', clicks),
    counted('orders', orders),
    amount(spend) && t('automations.proposals.metrics.spend', { amount: amount(spend) }),
    amount(sales) && t('automations.proposals.metrics.sales', { amount: amount(sales) }),
    typeof goalAcos === 'string' &&
      t('automations.proposals.metrics.goal', { value: formatNumber(goalAcos, locale.value) }),
  ].filter((part): part is string => typeof part === 'string');
}

// --- Aktionen ----------------------------------------------------------------------------

const canAct = computed(() => props.canWrite && status.value !== 'dismissed');
const selected = ref(new Set<string>());
// Markierungen gelten für die geladene Liste.
watch([status, proposals], () => {
  const known = new Set(proposals.value.map((x) => x.id));
  selected.value = new Set([...selected.value].filter((x) => known.has(x)));
});
const allSelected = computed(
  () => proposals.value.length > 0 && selected.value.size === proposals.value.length,
);
function toggleAll() {
  selected.value = allSelected.value ? new Set() : new Set(proposals.value.map((x) => x.id));
}
function toggle(proposalId: string) {
  const next = new Set(selected.value);
  if (!next.delete(proposalId)) next.add(proposalId);
  selected.value = next;
}

const notice = ref<string | null>(null);
const action = useMutation({
  mutationFn: (input: { kind: 'stage' | 'dismiss'; ids: string[] }) =>
    input.kind === 'stage'
      ? api.automations.stageProposals(input.ids)
      : api.automations.dismissProposals(input.ids),
  onMutate: () => (notice.value = null),
  onSuccess: (result, input) => {
    notice.value =
      t(
        `automations.proposals.${input.kind === 'stage' ? 'staged' : 'dismissed'}`,
        { n: result.changed },
        result.changed,
      ) + (result.skipped > 0 ? t('automations.proposals.skipped', { n: result.skipped }) : '');
    selected.value = new Set();
  },
  // Liste und Warenkorb (Zähler in der Navigation) neu laden.
  onSettled: () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['automation-proposals'] }),
      queryClient.invalidateQueries({ queryKey: ['ad-changes'] }),
    ]),
});
const act = (kind: 'stage' | 'dismiss', ids: string[]) =>
  !action.isPending.value && ids.length > 0 && action.mutate({ kind, ids });
</script>

<template>
  <div class="flex flex-col gap-gutter">
    <section
      class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
    >
      <div class="flex flex-wrap items-end justify-between gap-space-md">
        <div class="flex min-w-0 flex-col gap-space-xs">
          <h2 class="text-headline-sm text-ink">{{ t('automations.proposals.title') }}</h2>
          <p class="max-w-prose text-body-sm text-ink-secondary">
            {{ t('automations.proposals.text') }}
          </p>
        </div>
        <div class="flex flex-col gap-space-xs">
          <label :for="`${id}-status`" class="text-label-eyebrow uppercase text-ink-tertiary">
            {{ t('automations.proposals.statusLabel') }}
          </label>
          <select
            :id="`${id}-status`"
            v-model="status"
            data-proposals-status
            class="h-11 rounded-control bg-well px-space-md text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet"
          >
            <option v-for="option in AUTOMATION_PROPOSAL_FILTERS" :key="option" :value="option">
              {{ t(`automations.proposals.status.${option}`) }}
            </option>
          </select>
        </div>
      </div>

      <InlineError v-if="action.isError.value" :message="t('automations.proposals.actionFailed')" />
      <p v-if="notice" role="status" class="text-body-sm text-ink-secondary">{{ notice }}</p>

      <InlineError
        v-if="query.isError.value && !data"
        :message="t('automations.proposals.loadFailed')"
        retryable
        :retrying="query.isFetching.value"
        @retry="query.refetch()"
      />
      <SkeletonBlock v-else-if="!data" shape="tile" height="16rem" />
      <EmptyState
        v-else-if="proposals.length === 0"
        icon="inbox"
        :title="t(`automations.proposals.empty.${status}.title`)"
        :text="t(`automations.proposals.empty.${status}.text`)"
      />

      <template v-else>
        <div class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs">
          <label
            v-if="canAct"
            class="flex min-h-11 items-center gap-space-sm text-body-sm text-ink-secondary"
          >
            <input
              data-proposals-select-all
              type="checkbox"
              class="size-4 accent-violet"
              :checked="allSelected"
              @change="toggleAll"
            />
            {{ t('automations.proposals.selectAll') }}
          </label>
          <span
            v-if="data.total > proposals.length"
            class="font-data text-body-sm text-ink-secondary"
          >
            {{
              t('automations.proposals.shown', {
                shown: formatNumber(proposals.length, locale),
                total: formatNumber(data.total, locale),
              })
            }}
          </span>
        </div>

        <ul class="flex flex-col">
          <li
            v-for="x in proposals"
            :key="x.id"
            :data-proposal-row="x.id"
            class="flex flex-wrap items-start gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
          >
            <input
              v-if="canAct"
              data-proposal-select
              type="checkbox"
              class="mt-1 size-4 shrink-0 accent-violet"
              :checked="selected.has(x.id)"
              :aria-label="t('automations.proposals.select', { name: name(x) })"
              @change="toggle(x.id)"
            />
            <div class="flex min-w-0 flex-1 basis-64 flex-col gap-space-xs">
              <span class="break-words text-body-md text-ink">{{ name(x) }}</span>
              <span class="text-body-sm text-ink-tertiary">
                {{ t(`automations.proposals.entity.${x.entityType}`) }}
                <template v-if="path(x)"> · {{ path(x) }}</template>
                · {{ x.accountName }}
              </span>
              <span class="font-data text-body-sm text-ink-secondary">
                {{ metrics(x).join(' · ') }}
              </span>
            </div>
            <div class="flex min-w-0 flex-1 basis-56 flex-col gap-space-xs">
              <span class="text-body-md text-ink">
                {{ t(`automations.proposals.field.${x.field}`) }}
                <span class="font-data">{{ value(x, x.before) }} → {{ value(x, x.after) }}</span>
                <span v-if="x.detail.hasOwnBid === false" class="text-body-sm text-ink-secondary">
                  ({{ t('automations.proposals.noOwnBid') }})
                </span>
              </span>
              <span class="text-body-sm text-ink-secondary">{{ source(x) }}</span>
              <span v-if="x.limitedBy.length > 0" class="text-body-sm text-warn">
                {{
                  t('automations.proposals.limitedBy', {
                    reasons: x.limitedBy.map(guardrail).join(', '),
                  })
                }}
              </span>
            </div>
            <div v-if="canAct" class="flex shrink-0 items-center gap-space-xs">
              <Button
                v-if="x.status === 'open'"
                data-proposal-stage
                icon="pi pi-shopping-cart"
                severity="secondary"
                variant="text"
                size="small"
                :disabled="action.isPending.value"
                :aria-label="t('automations.proposals.stageOne', { name: name(x) })"
                @click="act('stage', [x.id])"
              />
              <Button
                data-proposal-dismiss
                icon="pi pi-times"
                severity="secondary"
                variant="text"
                size="small"
                :disabled="action.isPending.value"
                :aria-label="t('automations.proposals.dismissOne', { name: name(x) })"
                @click="act('dismiss', [x.id])"
              />
            </div>
          </li>
        </ul>
      </template>
    </section>

    <div
      v-if="canAct && selected.size > 0"
      data-proposals-bulk
      class="sticky bottom-0 z-10 flex flex-wrap items-center gap-space-sm bg-canvas/85 py-space-sm backdrop-blur-xl"
    >
      <span class="font-data text-body-sm text-ink-secondary">
        {{ t('automations.proposals.selected', { n: formatNumber(selected.size, locale) }) }}
      </span>
      <Button
        v-if="status === 'open'"
        data-proposals-bulk-stage
        icon="pi pi-shopping-cart"
        :label="t('automations.proposals.stage')"
        :loading="action.isPending.value"
        @click="act('stage', [...selected])"
      />
      <Button
        data-proposals-bulk-dismiss
        severity="secondary"
        variant="text"
        :label="t('automations.proposals.dismiss')"
        :disabled="action.isPending.value"
        @click="act('dismiss', [...selected])"
      />
    </div>
  </div>
</template>
