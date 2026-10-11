<script setup lang="ts">
import {
  formatCurrency,
  formatNumber,
  STRUCTURE_PROPOSAL_FILTERS,
  type StructureProposalFilter,
} from '@profitbash/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/vue-query';
import Button from 'primevue/button';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import { api } from '../api';
import type { StructureProposalData } from '../api/client';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useActiveOrgId, useSessionStore } from '../stores/session';
import { useStructureCatalog } from '../tools/queries';

/**
 * Graduation- und Preset-Vorschläge (`phase-5.md` 5.11b) im Tab „Vorschläge“: Annehmen legt den Suchbegriff auf die
 * Harvest-Merkliste bzw. ändert das Preset der Produktgruppe; nichts davon geschieht automatisch.
 */
const props = defineProps<{ canWrite: boolean }>();
const { t } = useI18n();
const id = useId();
const session = useSessionStore();
const orgId = useActiveOrgId();
const queryClient = useQueryClient();
const locale = computed(() => session.preferences.locale);

const status = ref<StructureProposalFilter>('open');
const query = useQuery({
  queryKey: computed(() => ['structure-proposals', orgId.value, status.value] as const),
  queryFn: () => api.automations.structureProposals(status.value),
  enabled: computed(() => orgId.value !== null),
});
const data = computed(() => query.data.value);
const proposals = computed(() => data.value?.proposals ?? []);

// Bezeichnungen aus dem Katalog; ohne das Feature „Tools“ bleiben die Schlüssel stehen.
const catalog = useStructureCatalog();
const blockLabel = (key: unknown) =>
  catalog.data.value?.catalog.blocks.find((block) => block.key === key)?.label ?? String(key);
const presetName = (key: unknown) =>
  catalog.data.value?.catalog.presets.find((preset) => preset.key === key)?.name ?? String(key);

const title = (x: StructureProposalData) =>
  String(
    x.kind === 'graduation'
      ? (x.detail.searchTerm ?? x.subject)
      : (x.detail.productGroupName ?? ''),
  );
const change = (x: StructureProposalData) =>
  x.kind === 'graduation'
    ? `${blockLabel(x.detail.fromBlock ?? x.key)} → ${(Array.isArray(x.detail.toBlocks)
        ? x.detail.toBlocks
        : []
      )
        .map(blockLabel)
        .join(', ')}`
    : `${presetName(x.detail.from)} → ${presetName(x.detail.to ?? x.key)}`;
function metrics(x: StructureProposalData): string[] {
  const { clicks, orders, spend, sales, acos, goalAcos } = x.detail;
  const amount = (raw: unknown) =>
    typeof raw === 'string' ? formatCurrency(raw, x.currencyCode, locale.value) : null;
  const counted = (key: string, n: unknown) =>
    typeof n === 'number'
      ? t(`automations.proposals.metrics.${key}`, { n: formatNumber(n, locale.value) }, n)
      : null;
  const percent = (key: string, raw: unknown) =>
    typeof raw === 'string' ? t(key, { value: formatNumber(raw, locale.value) }) : null;
  return [
    counted('clicks', clicks),
    counted('orders', orders),
    amount(spend) && t('automations.proposals.metrics.spend', { amount: amount(spend) }),
    amount(sales) && t('automations.proposals.metrics.sales', { amount: amount(sales) }),
    percent('automations.structure.acos', acos),
    percent('automations.proposals.metrics.goal', goalAcos),
  ].filter((part): part is string => typeof part === 'string');
}

const canAct = computed(() => props.canWrite && status.value === 'open');
const notice = ref<string | null>(null);
const action = useMutation({
  mutationFn: (input: { kind: 'accept' | 'dismiss'; ids: string[] }) =>
    api.automations.actOnStructureProposals(input.kind, input.ids),
  onMutate: () => (notice.value = null),
  onSuccess: (result, input) => {
    notice.value =
      (result.changed > 0
        ? t(
            `automations.structure.${input.kind === 'accept' ? 'accepted' : 'dismissed'}`,
            { n: result.changed },
            result.changed,
          )
        : '') +
      (result.skipped > 0
        ? t(`automations.structure.${input.kind === 'accept' ? 'notAccepted' : 'skipped'}`, {
            n: result.skipped,
          })
        : '');
  },
  // Merkliste (Suchbegriff-Analyse, Setup) und Produktgruppen zeigen das Angenommene.
  onSettled: () =>
    Promise.all(
      ['structure-proposals', 'search-terms', 'product-groups'].map((key) =>
        queryClient.invalidateQueries({ queryKey: [key] }),
      ),
    ),
});
const act = (kind: 'accept' | 'dismiss', x: StructureProposalData) =>
  !action.isPending.value && action.mutate({ kind, ids: [x.id] });
</script>

<template>
  <section
    class="flex min-w-0 flex-col gap-space-md rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <div class="flex flex-wrap items-end justify-between gap-space-md">
      <div class="flex min-w-0 flex-col gap-space-xs">
        <h2 class="text-headline-sm text-ink">{{ t('automations.structure.title') }}</h2>
        <p class="max-w-prose text-body-sm text-ink-secondary">
          {{ t('automations.structure.text') }}
        </p>
      </div>
      <div class="flex flex-col gap-space-xs">
        <label :for="`${id}-status`" class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('automations.proposals.statusLabel') }}
        </label>
        <select
          :id="`${id}-status`"
          v-model="status"
          data-structure-status
          class="h-11 rounded-control bg-well px-space-md text-ink outline-none focus-visible:ring-2 focus-visible:ring-violet"
        >
          <option v-for="option in STRUCTURE_PROPOSAL_FILTERS" :key="option" :value="option">
            {{ t(`automations.proposals.status.${option}`) }}
          </option>
        </select>
      </div>
    </div>

    <InlineError v-if="action.isError.value" :message="t('automations.proposals.actionFailed')" />
    <p v-if="notice" role="status" class="text-body-sm text-ink-secondary">{{ notice }}</p>

    <InlineError
      v-if="query.isError.value && !data"
      data-structure-error
      :message="t('automations.structure.loadFailed')"
      retryable
      :retrying="query.isFetching.value"
      @retry="query.refetch()"
    />
    <SkeletonBlock v-else-if="!data" shape="tile" height="6rem" />
    <p v-else-if="proposals.length === 0" class="text-body-md text-ink-secondary">
      {{ t(`automations.structure.empty.${status}`) }}
    </p>
    <template v-else>
      <span v-if="data.total > proposals.length" class="font-data text-body-sm text-ink-secondary">
        {{
          t('automations.proposals.shown', {
            shown: formatNumber(proposals.length, locale),
            total: formatNumber(data.total, locale),
          })
        }}
      </span>
      <ul class="flex flex-col">
        <li
          v-for="x in proposals"
          :key="x.id"
          :data-structure-row="x.id"
          class="flex flex-wrap items-start gap-x-space-md gap-y-space-xs border-b border-line py-space-sm last:border-b-0"
        >
          <div class="flex min-w-0 flex-1 basis-64 flex-col gap-space-xs">
            <span class="break-words text-body-md text-ink">{{ title(x) }}</span>
            <span class="text-body-sm text-ink-tertiary">
              {{ t(`automations.structure.kind.${x.kind}`) }} · {{ x.accountName }}
            </span>
            <span class="font-data text-body-sm text-ink-secondary">
              {{ metrics(x).join(' · ') }}
            </span>
          </div>
          <span class="min-w-0 flex-1 basis-56 text-body-md text-ink">{{ change(x) }}</span>
          <div v-if="canAct" class="flex shrink-0 items-center gap-space-xs">
            <Button
              data-structure-accept
              severity="secondary"
              size="small"
              :label="t(`automations.structure.accept.${x.kind}`)"
              :aria-label="
                t(`automations.structure.acceptOne.${x.kind}`, {
                  name: title(x),
                  change: change(x),
                })
              "
              :disabled="action.isPending.value"
              @click="act('accept', x)"
            />
            <Button
              data-structure-dismiss
              icon="pi pi-times"
              severity="secondary"
              variant="text"
              size="small"
              :disabled="action.isPending.value"
              :aria-label="t('automations.proposals.dismissOne', { name: title(x) })"
              @click="act('dismiss', x)"
            />
          </div>
        </li>
      </ul>
    </template>
  </section>
</template>
