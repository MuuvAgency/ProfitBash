<script setup lang="ts">
import type { ICellRendererParams } from 'ag-grid-community';
import Popover from 'primevue/popover';
import { computed, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink, type RouteLocationRaw } from 'vue-router';
import type { GridRow } from './columns';

/** Kontext des Grids für die Namensspalte. */
export interface NameCellContext {
  /** Ziel des Drill-Downs (nächste Ebene), `null` ohne Drill-Down. */
  linkFor: (row: GridRow) => RouteLocationRaw | null;
}

/**
 * Name einer Zeile: Link in die nächste Ebene (F6), bei SB/SD-Ads mit mehreren ASINs die Liste im Popover (Master/Detail
 * ist AG Grid Enterprise, F6), Kennzeichen „keine Kennzahlen“ (z. B. SB-Preview-Lücke).
 */
const props = defineProps<{
  params: ICellRendererParams<GridRow, string> & { context: NameCellContext };
}>();

const { t } = useI18n();
const popover = ref<InstanceType<typeof Popover>>();
const open = ref(false);

const row = computed(() => props.params.data);
const link = computed(() =>
  row.value && !row.value.isTotal ? props.params.context.linkFor(row.value) : null,
);
const asins = computed(() => {
  const value = row.value?.attributes.asins;
  return Array.isArray(value) && value.length > 1 ? (value as string[]) : [];
});
const withoutMetrics = computed(
  () =>
    row.value !== undefined &&
    !row.value.isTotal &&
    row.value.current !== null &&
    !row.value.hasMetrics,
);
</script>

<template>
  <span class="flex min-w-0 items-center gap-space-xs">
    <RouterLink v-if="link" :to="link" class="truncate font-medium text-violet hover:underline">{{
      params.value
    }}</RouterLink>
    <span v-else :class="['truncate', row?.isTotal ? 'font-bold' : '']">{{ params.value }}</span>
    <button
      v-if="asins.length"
      type="button"
      class="shrink-0 rounded-full bg-violet-wash px-2 text-data-sm text-violet hover:underline"
      aria-haspopup="dialog"
      :aria-expanded="open"
      @click="popover?.toggle($event)"
    >
      {{ t('explorer.sharesAsins', { count: asins.length }) }}
    </button>
    <span
      v-if="withoutMetrics"
      class="shrink-0 rounded-full bg-well px-2 text-data-sm text-ink-tertiary"
      :title="t('explorer.noMetrics')"
    >
      <i class="pi pi-info-circle text-[0.625rem]" aria-hidden="true" />
      <span class="sr-only">{{ t('explorer.noMetrics') }}</span>
    </span>
    <Popover v-if="asins.length" ref="popover" @show="open = true" @hide="open = false">
      <div class="flex flex-col gap-space-xs">
        <p class="text-body-sm font-semibold text-ink">{{ t('explorer.asinList') }}</p>
        <ul class="font-data text-data-sm text-ink-secondary">
          <li v-for="asin in asins" :key="asin">{{ asin }}</li>
        </ul>
      </div>
    </Popover>
  </span>
</template>
