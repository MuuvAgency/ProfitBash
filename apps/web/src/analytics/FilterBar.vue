<script setup lang="ts">
import { ATTRIBUTION_SETTINGS, formatDay, MAX_ANALYTICS_RANGE_DAYS } from '@profitbash/shared';
import DatePicker from 'primevue/datepicker';
import Select from 'primevue/select';
import TreeSelect from 'primevue/treeselect';
import { computed, ref, useId } from 'vue';
import { useI18n } from 'vue-i18n';
import InlineError from '../components/common/InlineError.vue';
import SkeletonBlock from '../components/common/SkeletonBlock.vue';
import { useSessionStore } from '../stores/session';
import {
  clientNodeKey,
  fromTreeSelection,
  profileNodeKey,
  toTreeSelection,
  WITHOUT_CLIENT_NODE_KEY,
  type TreeSelection,
} from './filters';
import {
  COMPARISON_MODES,
  comparisonRange,
  PERIOD_PRESETS,
  rangeDays,
  resolvePeriod,
  todayInBrowser,
  type ComparisonMode,
  type PeriodPreset,
} from './periods';
import type { useAnalyticsFilters } from './useAnalyticsFilters';

/**
 * Filterleiste von Dashboard und Explorer (`phase-2.md` F2–F5). Den Zustand hält `useAnalyticsFilters` der Seite, damit
 * Filterleiste und Widgets dieselbe Auswahl lesen.
 */
const props = defineProps<{
  filters: ReturnType<typeof useAnalyticsFilters>;
  /** Erster Tag mit Kennzahlen (aus `meta.earliestDate`); sperrt „Vorjahr“, solange Daten dafür fehlen. */
  earliestDate?: string | null;
}>();

const { t } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);
const id = useId();
const ids = {
  selection: `${id}-selection`,
  period: `${id}-period`,
  range: `${id}-range`,
  comparison: `${id}-comparison`,
  currency: `${id}-currency`,
  attribution: `${id}-attribution`,
};

const state = computed(() => props.filters.state.value);
const options = computed(() => props.filters.options.data.value);

// --- Clients und Profile ----------------------------------------------------------------

const treeNodes = computed(() => {
  const data = options.value;
  if (!data) return [];
  const leaf = (profile: (typeof data.profiles)[number]) => ({
    key: profileNodeKey(profile.id),
    label: `${profile.accountName} · ${profile.countryCode}`,
  });
  const nodes = data.clients
    .map((client) => ({
      key: clientNodeKey(client.id),
      label: client.name,
      children: data.profiles.filter((p) => p.clientId === client.id).map(leaf),
    }))
    .filter((node) => node.children.length > 0);
  const without = data.profiles.filter((p) => p.clientId === null).map(leaf);
  if (without.length) {
    nodes.push({
      key: WITHOUT_CLIENT_NODE_KEY,
      label: t('analytics.filter.withoutClient'),
      children: without,
    });
  }
  return nodes;
});

const treeSelection = computed(() =>
  options.value ? toTreeSelection(state.value, options.value) : {},
);

function onTreeChange(value: TreeSelection | null | undefined) {
  if (!options.value) return;
  props.filters.update(fromTreeSelection(value ?? {}, options.value));
}

const selectionLabel = computed(() => {
  const data = options.value;
  const s = state.value;
  if (!data || (s.clientIds.length === 0 && !s.withoutClient)) {
    return t('analytics.filter.allProfiles');
  }
  if (s.profileIds) return t('analytics.filter.profileCount', s.profileIds.length);
  const names = data.clients.filter((c) => s.clientIds.includes(c.id)).map((c) => c.name);
  if (s.withoutClient) names.push(t('analytics.filter.withoutClient'));
  return names.join(', ');
});

// --- Zeitraum und Vergleich ------------------------------------------------------------

const periodOptions = computed(() =>
  PERIOD_PRESETS.map((preset) => ({ value: preset, label: t(`analytics.period.${preset}`) })),
);

const range = computed(() => resolvePeriod(state.value.period, props.filters.today.value));
const comparison = computed(() => comparisonRange(range.value, state.value.comparison));

function onPresetChange(preset: PeriodPreset) {
  // „Frei wählen“ startet mit dem bisher gezeigten Zeitraum.
  props.filters.update({
    period: preset === 'custom' ? { preset, range: range.value } : { preset },
  });
}

/** DatePicker arbeitet mit lokalen `Date`-Objekten; Tage bleiben Kalendertage ohne Zeitzone. */
const pickerValue = computed(() =>
  [range.value.from, range.value.to].map((day) => {
    const [year, month, date] = day.split('-').map(Number) as [number, number, number];
    return new Date(year, month - 1, date);
  }),
);

/** Zu langer Zeitraum: Hinweis statt still auf den Standard zurückzufallen (die API nimmt höchstens 400 Tage). */
const rangeError = ref(false);

function onRangeChange(value: unknown) {
  if (!Array.isArray(value)) return;
  const [from, to] = value as (Date | null)[];
  // Erst mit beiden Enden übernehmen, sonst stünde ein halber Zeitraum in der URL.
  if (!(from instanceof Date) || !(to instanceof Date)) return;
  const picked = { from: todayInBrowser(from), to: todayInBrowser(to) };
  rangeError.value = rangeDays(picked) > MAX_ANALYTICS_RANGE_DAYS;
  if (rangeError.value) return;
  props.filters.update({ period: { preset: 'custom', range: picked } });
}

const previousYearAvailable = computed(() => {
  const start = comparisonRange(range.value, 'previousYear')!.from;
  return props.earliestDate !== null && props.earliestDate !== undefined
    ? props.earliestDate <= start
    : false;
});

const comparisonOptions = computed(() =>
  COMPARISON_MODES.map((mode) => ({
    value: mode,
    label: t(`analytics.comparison.${mode}`),
    disabled: mode === 'previousYear' && !previousYearAvailable.value,
  })),
);

// --- Währung und Attribution ------------------------------------------------------------

const currencyOptions = computed(() => [
  { value: 'auto', label: t('analytics.currency.auto') },
  ...(options.value?.currencies ?? []).map((code) => ({ value: code, label: code })),
]);

const attributionOptions = computed(() =>
  ATTRIBUTION_SETTINGS.map((setting) => ({
    value: setting,
    label: t(`analytics.attribution.${setting}`),
  })),
);

const day = (value: string) => formatDay(value, locale.value);
</script>

<template>
  <section
    :aria-label="t('analytics.filter.label')"
    class="flex flex-col gap-space-sm rounded-tile bg-tile p-space-md shadow-tile sm:p-space-lg"
  >
    <InlineError
      v-if="filters.options.isError.value"
      :message="t('analytics.filter.loadFailed')"
      retryable
      :retrying="filters.options.isFetching.value"
      @retry="filters.options.refetch()"
    />
    <div
      v-else-if="!options"
      class="grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-[2fr_1.4fr_1fr_1fr_1.2fr]"
      aria-hidden="true"
    >
      <SkeletonBlock v-for="n in 5" :key="n" height="3.5rem" />
    </div>
    <div
      v-else
      class="grid grid-cols-1 gap-space-md sm:grid-cols-2 xl:grid-cols-[2fr_1.4fr_1fr_1fr_1.2fr]"
    >
      <div class="flex min-w-0 flex-col gap-space-xs sm:col-span-2 xl:col-span-1">
        <label :for="ids.selection" class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('analytics.filter.selection') }}
        </label>
        <TreeSelect
          :input-id="ids.selection"
          :model-value="treeSelection"
          :options="treeNodes"
          selection-mode="checkbox"
          :filter="true"
          :filter-placeholder="t('analytics.filter.searchProfiles')"
          :empty-message="t('analytics.filter.noProfiles')"
          class="w-full"
          @update:model-value="onTreeChange"
        >
          <template #value>
            <span class="truncate">{{ selectionLabel }}</span>
          </template>
        </TreeSelect>
      </div>

      <div class="flex min-w-0 flex-col gap-space-xs">
        <label :for="ids.period" class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('analytics.filter.period') }}
        </label>
        <Select
          :input-id="ids.period"
          :model-value="state.period.preset"
          :options="periodOptions"
          option-label="label"
          option-value="value"
          class="w-full"
          @update:model-value="onPresetChange"
        />
      </div>

      <div class="flex min-w-0 flex-col gap-space-xs">
        <label :for="ids.comparison" class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('analytics.filter.comparison') }}
        </label>
        <Select
          :input-id="ids.comparison"
          :model-value="state.comparison"
          :options="comparisonOptions"
          option-label="label"
          option-value="value"
          option-disabled="disabled"
          class="w-full"
          @update:model-value="(mode: ComparisonMode) => filters.update({ comparison: mode })"
        />
      </div>

      <div class="flex min-w-0 flex-col gap-space-xs">
        <label :for="ids.currency" class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('analytics.filter.currency') }}
        </label>
        <Select
          :input-id="ids.currency"
          :model-value="state.currency"
          :options="currencyOptions"
          option-label="label"
          option-value="value"
          class="w-full"
          @update:model-value="(currency: string) => filters.update({ currency })"
        />
      </div>

      <div class="flex min-w-0 flex-col gap-space-xs">
        <label :for="ids.attribution" class="text-label-eyebrow uppercase text-ink-tertiary">
          {{ t('analytics.filter.attribution') }}
        </label>
        <Select
          :input-id="ids.attribution"
          :model-value="state.attribution"
          :options="attributionOptions"
          option-label="label"
          option-value="value"
          class="w-full"
          @update:model-value="
            (attribution: (typeof ATTRIBUTION_SETTINGS)[number]) => filters.update({ attribution })
          "
        />
      </div>
    </div>

    <InlineError
      v-if="rangeError"
      :message="t('analytics.filter.rangeTooLong', { days: MAX_ANALYTICS_RANGE_DAYS })"
    />
    <div
      v-if="options"
      class="flex flex-wrap items-center gap-x-space-md gap-y-space-xs text-body-sm text-ink-secondary"
    >
      <template v-if="state.period.preset === 'custom'">
        <label :for="ids.range">{{ t('analytics.filter.customRange') }}</label>
        <DatePicker
          :input-id="ids.range"
          :model-value="pickerValue"
          selection-mode="range"
          :manual-input="false"
          :max-date="new Date()"
          date-format="dd.mm.yy"
          size="small"
          @update:model-value="onRangeChange"
        />
      </template>
      <span v-else class="font-data">
        {{ t('analytics.filter.range', { from: day(range.from), to: day(range.to) }) }}
      </span>
      <span v-if="comparison" class="font-data text-ink-tertiary">
        {{
          t('analytics.filter.comparisonRange', {
            from: day(comparison.from),
            to: day(comparison.to),
          })
        }}
      </span>
      <span v-if="state.comparison === 'previousYear' && !previousYearAvailable" class="text-warn">
        {{ t('analytics.filter.previousYearUnavailable') }}
      </span>
    </div>
  </section>
</template>
