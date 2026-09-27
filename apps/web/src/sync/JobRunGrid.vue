<script setup lang="ts">
import type { JobRun } from '@profitbash/shared';
import type { ColDef, GetRowIdParams } from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { computed, markRaw, onBeforeUnmount, reactive, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { gridStyleOptions, gridTheme } from '../grid/grid';
import DurationCell from './cells/DurationCell.vue';
import ResultCell from './cells/ResultCell.vue';
import StatusCell from './cells/StatusCell.vue';
import type { JobRunGridContext } from './cells/types';
import { elapsedMs, RUNNING_DURATION_TICK_MS, useJobRunLabels } from './labels';

const props = defineProps<{ runs: JobRun[] }>();

const { t } = useI18n();
const labels = useJobRunLabels();

const context = reactive<JobRunGridContext>({
  expanded: new Set(),
  now: Date.now(),
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
    // Laufende Jobs: Dauer bis jetzt (sortiert zum Stand der Daten, angezeigt mit der Uhr des Kontexts).
    valueGetter: ({ data }) => (data ? elapsedMs(data) : null),
    cellRenderer: markRaw(DurationCell),
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

/**
 * Die Dauer laufender Jobs zählt weiter. Neue Daten zeichnen sie nicht neu: Die Abfrage liefert bei
 * gleichem Stand dieselben Objekte (Structural Sharing), und AG Grid aktualisiert nur geänderte Zeilen.
 * Die Zelle rechnet deshalb mit der Uhr aus dem (reaktiven) Kontext.
 */
let tick: ReturnType<typeof setInterval> | undefined;
watchEffect(() => {
  const running = props.runs.some((run) => run.status === 'running');
  if (running && !tick) {
    context.now = Date.now();
    tick = setInterval(() => (context.now = Date.now()), RUNNING_DURATION_TICK_MS);
  } else if (!running && tick) {
    clearInterval(tick);
    tick = undefined;
  }
});
onBeforeUnmount(() => clearInterval(tick));
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
