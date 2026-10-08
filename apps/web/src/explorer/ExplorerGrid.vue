<script setup lang="ts">
import type {
  CellKeyDownEvent,
  ColDef,
  RowSelectionOptions,
  SelectionColumnDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  RowClassParams,
  SelectionChangedEvent,
  SortChangedEvent,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { computed, markRaw, shallowRef } from 'vue';
import { gridCsv } from '../grid/csv';
import { gridLocaleText, gridStyleOptions, gridTheme } from '../grid/grid';
import { activateCellControlOnEnter } from '../grid/keyboard';
import type { GridRow } from './columns';
import NameCell, { type NameCellContext } from './NameCell.vue';

/**
 * Grid des Explorers (F6/F7): alle geladenen Zeilen im Browser (Sortieren und Filtern ohne Server), Summenzeile unten
 * angeheftet (gilt für alle Zeilen der Auswahl, auch bei Kürzung), erste Spalte fest, markierte Zeilen für den Chart.
 */
const props = defineProps<{
  rows: GridRow[];
  total: GridRow | null;
  columnDefs: ColDef<GridRow>[];
  context: NameCellContext;
}>();

const emit = defineEmits<{
  selection: [ids: string[]];
  /** Nur Änderungen durch den Nutzer (Klick auf einen Spaltenkopf), eine Spalte. */
  sort: [sort: { column: string; direction: 'asc' | 'desc' } | null];
}>();

const api = shallowRef<GridApi<GridRow>>();

/** Wenige Zeilen: Grid wächst mit (kein Leerraum); sonst feste Höhe mit Virtualisierung. */
const AUTO_HEIGHT_MAX_ROWS = 15;
const autoHeight = computed(() => props.rows.length <= AUTO_HEIGHT_MAX_ROWS);

const defaultColDef: ColDef<GridRow> = {
  resizable: true,
  sortable: true,
  suppressMovable: true,
  minWidth: 96,
  cellClass: 'flex items-center',
};

/** Konstant: Neue Objekte je Render ließen AG Grid die Optionen jedes Mal neu anwenden. */
const rowSelection: RowSelectionOptions = {
  mode: 'multiRow',
  checkboxes: true,
  headerCheckbox: true,
  enableClickSelection: false,
};
const selectionColumnDef: SelectionColumnDef = { pinned: 'left', lockPinned: true };

const getRowId = ({ data }: GetRowIdParams<GridRow>) => data.id;
const getRowClass = ({ data }: RowClassParams<GridRow>) =>
  data?.isTotal ? 'font-bold' : data?.removed ? 'text-ink-tertiary' : undefined;

function onGridReady({ api: gridApi }: GridReadyEvent<GridRow>) {
  api.value = gridApi;
}

function onSelectionChanged({ api: gridApi }: SelectionChangedEvent<GridRow>) {
  emit(
    'selection',
    gridApi.getSelectedRows().map((row) => row.id),
  );
}

/** Tastatur (2.13): Pfeiltasten, Leertaste markiert die Zeile, Enter löst den Link oder Knopf der Zelle aus. */
function onCellKeyDown({ event }: CellKeyDownEvent<GridRow>) {
  activateCellControlOnEnter(event);
}

function onSortChanged({ api: gridApi, source }: SortChangedEvent<GridRow>) {
  if (source !== 'uiColumnSorted') return;
  const sorted = gridApi.getColumnState().find((column) => column.sort);
  emit('sort', sorted?.sort ? { column: sorted.colId, direction: sorted.sort } : null);
}

/**
 * CSV der geladenen Zeilen in aktueller Filterung und Sortierung (F6): Beträge als Decimal-String (Spalten mit
 * `useValueFormatterForExport: false`), dazu die Währung; ohne Summenzeile (sie gilt für alle Zeilen der Auswahl).
 */
function csv(prependContent?: string): string {
  return api.value ? gridCsv(api.value, prependContent) : '';
}

defineExpose({ csv });

const components = { nameCell: markRaw(NameCell) };
</script>

<template>
  <AgGridVue
    :class="['w-full', autoHeight ? '' : 'h-[34rem]']"
    :dom-layout="autoHeight ? 'autoHeight' : 'normal'"
    :theme="gridTheme"
    :theme-css-layer="gridStyleOptions.themeCssLayer"
    :theme-style-container="gridStyleOptions.themeStyleContainer"
    :locale-text="gridLocaleText"
    :row-data="props.rows"
    :pinned-bottom-row-data="props.total ? [props.total] : []"
    :column-defs="props.columnDefs"
    :default-col-def="defaultColDef"
    :context="props.context"
    :components="components"
    :get-row-id="getRowId"
    :get-row-class="getRowClass"
    :row-selection="rowSelection"
    :selection-column-def="selectionColumnDef"
    :row-height="44"
    :suppress-multi-sort="true"
    @grid-ready="onGridReady"
    @selection-changed="onSelectionChanged"
    @cell-key-down="onCellKeyDown"
    @sort-changed="onSortChanged"
  />
</template>
