<script setup lang="ts">
import { formatCurrency, formatNumber } from '@profitbash/shared';
import { computed, ref, toRef, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import type { PlanSetupInput } from '../../api/client';
import InlineError from '../../components/common/InlineError.vue';
import SkeletonBlock from '../../components/common/SkeletonBlock.vue';
import { useSessionStore } from '../../stores/session';
import { inputClass, labelClass } from '../catalog/draft';
import { useSetupHarvest } from '../queries';

/**
 * Harvest-Merkliste eines Profils als Eingang des Setups (`phase-4.md` 4.6, F7/F8): Begriffe wählen, Gebot (sonst
 * CPC der Merkliste) und „eigene Kampagne“ je Begriff. Die eigene Profil-Auswahl des Assistenten macht die Merkliste
 * jedes Profils erreichbar, unabhängig vom Datei-Zeitraum der Suchbegriff-Analyse (offener Punkt aus 3.8).
 */
type Selection = PlanSetupInput['inputs']['harvest'][number];

const props = defineProps<{ profileId: string; disabled: boolean }>();
const selection = defineModel<Selection[]>({ required: true });

const { t } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const harvest = useSetupHarvest(toRef(props, 'profileId'));
const marks = computed(() => harvest.data.value?.marks ?? []);
/**
 * Lokale Kopie der Auswahl: Das Modell kommt erst nach dem nächsten Rendern des Assistenten zurück; mehrere Klicks
 * davor (oder ein Klick und eine Eingabe) bauen so aufeinander auf statt sich zu überschreiben.
 */
const current = ref<Selection[]>([...selection.value]);
watch(selection, (next) => (current.value = [...next]));
function commit(next: Selection[]) {
  current.value = next;
  selection.value = next;
}
const byId = computed(() => new Map(current.value.map((entry) => [entry.markId, entry])));
// Einträge eines Entwurfs, die nicht mehr auf der Merkliste stehen (entfernt, schon geerntet), fallen aus der Auswahl.
watch(
  () => harvest.data.value,
  (data) => {
    if (!data || data.truncated) return;
    const known = new Set(data.marks.map((mark) => mark.id));
    if (current.value.some((entry) => !known.has(entry.markId))) {
      commit(current.value.filter((entry) => known.has(entry.markId)));
    }
  },
  { immediate: true },
);

function toggle(markId: string, checked: boolean) {
  commit(
    checked
      ? [...current.value, { markId }]
      : current.value.filter((entry) => entry.markId !== markId),
  );
}
function patch(markId: string, change: Partial<Selection>) {
  commit(
    current.value.map((entry) => {
      if (entry.markId !== markId) return entry;
      const next: Selection = { ...entry, ...change };
      if (!next.bid) delete next.bid;
      if (!next.single) delete next.single;
      return next;
    }),
  );
}
const MONEY = /^\d{1,7}(\.\d{1,2})?$/;
const bidInvalid = (markId: string) => {
  const bid = byId.value.get(markId)?.bid;
  return bid !== undefined && !MONEY.test(bid);
};
const anyBidInvalid = computed(() => current.value.some((entry) => bidInvalid(entry.markId)));
const amount = (value: string, currency: string) => formatCurrency(value, currency, locale.value);
const count = (value: number) => formatNumber(String(value), locale.value);
</script>

<template>
  <div data-harvest class="flex min-w-0 flex-col gap-space-xs">
    <span :class="labelClass">
      {{ t('setup.harvest.title') }}
      <template v-if="selection.length">
        · {{ t('setup.harvest.selected', { count: count(selection.length) }) }}
      </template>
    </span>
    <p class="text-body-sm text-ink-secondary">{{ t('setup.harvest.hint') }}</p>
    <InlineError
      v-if="harvest.isError.value"
      data-harvest-error
      :message="t('setup.harvest.loadFailed')"
      retryable
      :retrying="harvest.isFetching.value"
      @retry="harvest.refetch()"
    />
    <SkeletonBlock v-else-if="harvest.isPending.value" height="4rem" />
    <p
      v-else-if="marks.length === 0"
      data-harvest-empty
      class="rounded-control bg-well px-space-md py-space-sm text-body-sm text-ink-secondary"
    >
      {{ t('setup.harvest.empty') }}
    </p>
    <template v-else>
      <!-- `relative`: Absolut positionierte Inhalte bleiben im Scroll-Bereich (Handy). -->
      <div class="relative max-h-80 min-w-0 overflow-auto">
        <table class="w-full min-w-[44rem] text-left text-body-sm">
          <thead class="text-label-eyebrow uppercase text-ink-tertiary">
            <tr>
              <th class="py-space-xs pr-space-sm"><span class="sr-only">✓</span></th>
              <th class="py-space-xs pr-space-md">{{ t('setup.harvest.term') }}</th>
              <th class="py-space-xs pr-space-md">{{ t('setup.harvest.source') }}</th>
              <th class="py-space-xs pr-space-md text-right">{{ t('setup.harvest.clicks') }}</th>
              <th class="py-space-xs pr-space-md text-right">{{ t('setup.harvest.cost') }}</th>
              <th class="py-space-xs pr-space-md text-right">{{ t('setup.harvest.cpc') }}</th>
              <th class="py-space-xs pr-space-md text-right">{{ t('setup.harvest.bid') }}</th>
              <th class="py-space-xs">{{ t('setup.harvest.single') }}</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="mark in marks"
              :key="mark.id"
              :data-harvest-mark="mark.id"
              class="border-t border-line align-middle"
            >
              <td class="py-space-xs pr-space-sm">
                <input
                  data-harvest-pick
                  type="checkbox"
                  :checked="byId.has(mark.id)"
                  :disabled="disabled"
                  :aria-label="t('setup.harvest.pickLabel', { term: mark.searchTerm })"
                  @change="toggle(mark.id, ($event.target as HTMLInputElement).checked)"
                />
              </td>
              <td class="py-space-xs pr-space-md font-data text-ink">{{ mark.searchTerm }}</td>
              <td class="py-space-xs pr-space-md text-ink-secondary">
                <template v-if="mark.campaignName">
                  {{ mark.campaignName
                  }}<template v-if="mark.adGroupName"> · {{ mark.adGroupName }}</template>
                </template>
                <template v-else>{{ t('setup.harvest.sourceMissing') }}</template>
              </td>
              <td class="py-space-xs pr-space-md text-right font-data tabular-nums">
                {{ count(mark.clicks) }}
              </td>
              <td class="py-space-xs pr-space-md text-right font-data tabular-nums">
                {{ amount(mark.cost, mark.currencyCode) }}
              </td>
              <td class="py-space-xs pr-space-md text-right font-data tabular-nums">
                {{ mark.cpc ? amount(mark.cpc, mark.currencyCode) : '—' }}
              </td>
              <td class="py-space-xs pr-space-md text-right">
                <input
                  data-harvest-bid
                  inputmode="decimal"
                  :value="byId.get(mark.id)?.bid ?? ''"
                  :placeholder="mark.cpc ?? ''"
                  :disabled="disabled || !byId.has(mark.id)"
                  :aria-label="t('setup.harvest.bidLabel', { term: mark.searchTerm })"
                  :aria-invalid="bidInvalid(mark.id)"
                  :class="[inputClass, 'h-9 w-24 text-right font-data tabular-nums']"
                  @input="patch(mark.id, { bid: ($event.target as HTMLInputElement).value.trim() })"
                />
              </td>
              <td class="py-space-xs">
                <input
                  data-harvest-single
                  type="checkbox"
                  :checked="byId.get(mark.id)?.single ?? false"
                  :disabled="disabled || !byId.has(mark.id)"
                  :aria-label="t('setup.harvest.singleLabel', { term: mark.searchTerm })"
                  @change="patch(mark.id, { single: ($event.target as HTMLInputElement).checked })"
                />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p
        v-if="anyBidInvalid"
        data-harvest-invalid
        role="alert"
        class="text-body-sm text-on-loss-wash"
      >
        {{ t('setup.harvest.invalidBid') }}
      </p>
      <p v-if="harvest.data.value?.truncated" class="text-body-sm text-ink-secondary">
        {{ t('setup.harvest.truncated', { count: count(marks.length) }) }}
      </p>
    </template>
  </div>
</template>
