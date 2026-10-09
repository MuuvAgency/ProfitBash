<script setup lang="ts">
import type { ICellRendererParams } from 'ag-grid-community';
import { computed } from 'vue';
import type { SearchTermRowData } from '../api/client';
import type { TermGridRow } from './columns';

/** Über `cellRendererParams`: Aktionen je Zeile; ohne Funktion fehlt der Knopf (kein Recht). */
export interface RowActionsCellParams {
  onNegative?: (row: SearchTermRowData) => void;
  onHarvest?: (row: SearchTermRowData) => void;
  label: (action: 'negative' | 'harvest', row: SearchTermRowData) => string;
}

/**
 * Aktionen einer Suchbegriff-Zeile (`phase-3.md` 3.8): „Negativ anlegen“ (öffnet den Dialog für diese Zeile) und
 * „Harvest vormerken“. Für mehrere Zeilen gibt es dieselben Aktionen über die Markierung.
 */
const props = defineProps<{ params: ICellRendererParams<TermGridRow> & RowActionsCellParams }>();

const row = computed(() => {
  const data = props.params.data;
  return data && !data.isTotal ? data : null;
});
const BUTTON =
  'flex size-9 items-center justify-center rounded-control text-ink-secondary transition-colors hover:bg-violet-wash hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet';
</script>

<template>
  <span v-if="row" class="flex items-center gap-space-xs">
    <button
      v-if="params.onNegative"
      type="button"
      :class="BUTTON"
      :aria-label="params.label('negative', row)"
      :title="params.label('negative', row)"
      @click="params.onNegative(row)"
    >
      <i class="pi pi-ban" aria-hidden="true" />
    </button>
    <button
      v-if="params.onHarvest"
      type="button"
      :class="BUTTON"
      :aria-label="params.label('harvest', row)"
      :title="params.label('harvest', row)"
      @click="params.onHarvest(row)"
    >
      <i :class="row.harvestMarked ? 'pi pi-bookmark-fill' : 'pi pi-bookmark'" aria-hidden="true" />
    </button>
  </span>
</template>
