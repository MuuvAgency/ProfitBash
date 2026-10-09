<script setup lang="ts" generic="Row extends { id: string }">
import type {
  CellKeyDownEvent,
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  RowClassParams,
  RowSelectionOptions,
  SelectionChangedEvent,
  SelectionColumnDef,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { computed, shallowRef } from 'vue';
import { gridCsv } from '../grid/csv';
import { gridLocaleText, gridStyleOptions, gridTheme } from '../grid/grid';
import { activateCellControlOnEnter } from '../grid/keyboard';

/**
 * Grid der Suchbegriff-Analyse (2b.2b): alle geladenen Zeilen im Browser (Sortieren und Filtern ohne Server), erste
 * Spalte fest, optional eine Summenzeile unten. Mit `selectable` lassen sich Zeilen markieren (3.8: Aktionen auf
 * Suchbegriffe, Merkliste).
 */
const props = defineProps<{
  rows: Row[];
  columnDefs: ColDef<Row>[];
  total?: Row | null;
  selectable?: boolean;
}>();

const emit = defineEmits<{ selection: [ids: string[]] }>();

const api = shallowRef<GridApi<Row>>();

/** Wenige Zeilen: Grid wächst mit (kein Leerraum); sonst feste Höhe mit Virtualisierung. */
const AUTO_HEIGHT_MAX_ROWS = 15;
const autoHeight = computed(() => props.rows.length <= AUTO_HEIGHT_MAX_ROWS);

const defaultColDef: ColDef = {
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
  // Die Kopf-Checkbox meint die angezeigten Zeilen, nicht weggefilterte (wie im Explorer, 3.5).
  selectAll: 'filtered',
  enableClickSelection: false,
};
const selectionColumnDef: SelectionColumnDef = { pinned: 'left', lockPinned: true };

const getRowId = ({ data }: GetRowIdParams<Row>) => data.id;
const getRowClass = ({ node }: RowClassParams<Row>) => (node.rowPinned ? 'font-bold' : undefined);

function onGridReady({ api: gridApi }: GridReadyEvent<Row>) {
  api.value = gridApi;
}

function onSelectionChanged({ api: gridApi }: SelectionChangedEvent<Row>) {
  emit(
    'selection',
    gridApi.getSelectedRows().map((row) => row.id),
  );
}

/** Nach einem Filterwechsel gälte die Markierung auch für ausgeblendete Zeilen: aufheben. */
function onFilterChanged() {
  if (props.selectable) api.value?.deselectAll();
}

/** Hebt alle Markierungen auf (nach einer Aktion). */
function clearSelection() {
  api.value?.deselectAll();
}

/** Tastatur: Enter auf einer Zelle mit Link (Kampagne, Ad Group) löst ihn aus. */
function onCellKeyDown({ event }: CellKeyDownEvent<Row>) {
  activateCellControlOnEnter(event);
}

/** CSV der geladenen Zeilen in aktueller Filterung und Sortierung (2b.2e), siehe `gridCsv`. */
function csv(note?: string): string {
  return api.value ? gridCsv(api.value, note) : '';
}

/** Erst mit der Grid-API gibt es etwas zu exportieren (vorher wäre die Datei leer). */
const ready = computed(() => api.value !== undefined);

defineExpose({ csv, ready, clearSelection });
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
    :get-row-id="getRowId"
    :get-row-class="getRowClass"
    :row-selection="props.selectable ? rowSelection : undefined"
    :selection-column-def="props.selectable ? selectionColumnDef : undefined"
    :row-height="44"
    :suppress-multi-sort="true"
    @grid-ready="onGridReady"
    @selection-changed="onSelectionChanged"
    @filter-changed="onFilterChanged"
    @cell-key-down="onCellKeyDown"
  />
</template>
