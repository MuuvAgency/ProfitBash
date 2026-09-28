<script setup lang="ts">
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  RowClassParams,
  SelectionChangedEvent,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { markRaw, shallowRef } from 'vue';
import { gridLocaleText, gridStyleOptions, gridTheme } from '../grid/grid';
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

const emit = defineEmits<{ selection: [ids: string[]] }>();

const api = shallowRef<GridApi<GridRow>>();

const defaultColDef: ColDef<GridRow> = {
  resizable: true,
  sortable: true,
  suppressMovable: true,
  minWidth: 96,
  cellClass: 'flex items-center',
};

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

/**
 * CSV der geladenen Zeilen in aktueller Filterung und Sortierung (F6): Beträge als Decimal-String (Spalten mit
 * `useValueFormatterForExport: false`), dazu die Währung; ohne Summenzeile (sie gilt für alle Zeilen der Auswahl).
 */
function csv(prependContent?: string): string {
  const gridApi = api.value;
  if (!gridApi) return '';
  const columnKeys = gridApi
    .getAllGridColumns()
    .filter((column) => column.isVisible() || column.getColId() === 'currency')
    .map((column) => column.getColId())
    .filter((id) => !id.startsWith('ag-Grid-'));
  return (
    gridApi.getDataAsCsv({
      columnKeys,
      skipPinnedBottom: true,
      ...(prependContent && { prependContent }),
    }) ?? ''
  );
}

defineExpose({ csv });

const components = { nameCell: markRaw(NameCell) };
</script>

<template>
  <AgGridVue
    class="h-[34rem] w-full"
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
    :row-selection="{
      mode: 'multiRow',
      checkboxes: true,
      headerCheckbox: true,
      enableClickSelection: false,
    }"
    :row-height="44"
    :suppress-cell-focus="true"
    @grid-ready="onGridReady"
    @selection-changed="onSelectionChanged"
  />
</template>
