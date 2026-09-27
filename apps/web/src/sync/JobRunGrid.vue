<script setup lang="ts">
import type { JobRun } from '@profitbash/shared';
import type { ColDef, GetRowIdParams } from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { computed, markRaw, reactive } from 'vue';
import { useI18n } from 'vue-i18n';
import { gridStyleOptions, gridTheme } from '../grid/grid';
import ResultCell from './cells/ResultCell.vue';
import StatusCell from './cells/StatusCell.vue';
import type { JobRunGridContext } from './cells/types';
import { elapsedMs, useJobRunLabels } from './labels';

defineProps<{ runs: JobRun[] }>();

const { t } = useI18n();
const labels = useJobRunLabels();

const context = reactive<JobRunGridContext>({
  expanded: new Set(),
  toggleError(runId) {
    if (!context.expanded.delete(runId)) context.expanded.add(runId);
  },
});

/** Zellen zentrieren ihren Inhalt vertikal (wie in der Profiltabelle). */
const CELL = 'flex items-center leading-normal';
const DATA_CELL = `${CELL} font-data`;

const columnDefs = computed<ColDef<JobRun>[]>(() => [
  {
    colId: 'status',
    headerName: t('sync.column.status'),
    field: 'status',
    cellRenderer: markRaw(StatusCell),
    width: 140,
  },
  {
    colId: 'job',
    headerName: t('sync.column.job'),
    valueGetter: ({ data }) => (data ? labels.job(data.job) : ''),
    width: 140,
  },
  {
    colId: 'connection',
    headerName: t('sync.column.connection'),
    valueGetter: ({ data }) => (data ? labels.connection(data) : ''),
    minWidth: 180,
    flex: 1,
  },
  {
    colId: 'startedAt',
    headerName: t('sync.column.startedAt'),
    // Sortiert nach dem ISO-Zeitstempel, angezeigt formatiert.
    field: 'startedAt',
    valueFormatter: ({ data }) => (data ? labels.startedAt(data) : ''),
    cellClass: DATA_CELL,
    width: 190,
  },
  {
    colId: 'duration',
    headerName: t('sync.column.duration'),
    // Laufende Jobs: Dauer bis jetzt. Der Wert ändert sich bei jeder Abfrage, so zeichnet AG Grid neu.
    valueGetter: ({ data }) => (data ? elapsedMs(data) : null),
    valueFormatter: ({ data }) => (data ? labels.duration(data) : ''),
    cellClass: DATA_CELL,
    width: 140,
  },
  {
    colId: 'result',
    headerName: t('sync.column.result'),
    // Zähler und (aufklappbarer) Fehlertext in einer Spalte: Der Fehler bleibt ohne Scrollen sichtbar.
    valueGetter: ({ data }) => (data ? labels.counters(data) : ''),
    cellRenderer: markRaw(ResultCell),
    // Aufgeklappt wächst die Zeile mit dem Fehlertext.
    autoHeight: true,
    sortable: false,
    minWidth: 300,
    flex: 2,
  },
]);

/** Konstant: Ein neues Objekt je Render setzte die Spalten zurück (z. B. geänderte Breiten). */
const defaultColDef: ColDef<JobRun> = {
  resizable: true,
  sortable: true,
  suppressMovable: true,
  cellClass: CELL,
};

const getRowId = ({ data }: GetRowIdParams<JobRun>) => data.id;
</script>

<template>
  <AgGridVue
    class="w-full"
    :theme="gridTheme"
    :theme-css-layer="gridStyleOptions.themeCssLayer"
    :theme-style-container="gridStyleOptions.themeStyleContainer"
    :row-data="runs"
    :column-defs="columnDefs"
    :context="context"
    :get-row-id="getRowId"
    :row-height="52"
    dom-layout="autoHeight"
    :suppress-column-virtualisation="true"
    :suppress-cell-focus="true"
    :default-col-def="defaultColDef"
  />
</template>
