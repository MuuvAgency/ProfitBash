<script setup lang="ts">
import type { JobRun } from '@profitbash/shared';
import type {
  ColDef,
  GetRowIdParams,
  GridApi,
  GridReadyEvent,
  ModelUpdatedEvent,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { computed, markRaw, onBeforeUnmount, reactive, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { AUTO_HEIGHT_CELL, gridLocaleText, gridStyleOptions, gridTheme } from '../grid/grid';
import { useGridMinWidth } from '../grid/min-width';
import DurationCell from './cells/DurationCell.vue';
import ResultCell from './cells/ResultCell.vue';
import StatusCell from './cells/StatusCell.vue';
import WrappedCell from './cells/WrappedCell.vue';
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

/**
 * Spalten mit kurzem, nie gekürztem Inhalt passen sich ihm an (Locale des Zeitstempels, Minuten in der
 * Dauer, „Fehlgeschlagen“). Den Rest teilen sich Amazon-Konto und Ergebnis, die umbrechen (F14: passt bei 1440 px
 * auch mit klassischer Scrollbar, Reserve für die angepassten Spalten in `SYNC_AUTO_SIZED_WIDTH`).
 */
const AUTO_SIZED = ['status', 'job', 'startedAt', 'duration'];
/** Die Zellen bringen ihr Padding mit; die Voreinstellung (20 px) nähme den gekürzten Spalten Platz. */
const AUTO_SIZE_PADDING = 4;

const gridMinWidth = useGridMinWidth();

function fitContents(api: GridApi<JobRun>) {
  if (api.isDestroyed()) return;
  api.autoSizeColumns(AUTO_SIZED);
  gridMinWidth.update(api);
}

/**
 * Angepasst wird nur nach neuen Zeilen (auch nach einem Filterwechsel), nicht bei jedem `modelUpdated`:
 * Das kommt auch beim Sortieren und wenn aufgeklappte Fehler die Zeilenhöhe ändern und nähme sonst
 * manuell geänderte Breiten zurück. Gemessen wird erst im `modelUpdated` danach, weil
 * `rowDataUpdated` kommt, bevor die Zeilen im DOM stehen. Ohne Zeilen-Virtualisierung sind das alle
 * Zeilen; sonst zeichnet AG Grid sie in Etappen und die Messung sähe nur die ersten.
 */
let fitPending = true;

const onRowDataUpdated = () => {
  fitPending = true;
};

function onModelUpdated({ api }: ModelUpdatedEvent<JobRun>) {
  if (!fitPending) return;
  fitPending = false;
  fitContents(api);
}

/**
 * Gemessen mit der Ersatzschrift wäre der Zeitstempel zu schmal. Die Mono-Schrift lädt der Browser erst,
 * wenn die Tabelle sie braucht (`document.fonts.ready` ist dann meist schon erfüllt): gezielt laden,
 * danach neu anpassen.
 */
function onGridReady({ api }: GridReadyEvent<JobRun>) {
  const mono = getComputedStyle(document.documentElement).getPropertyValue('--font-mono').trim();
  if (!mono || !document.fonts) return;
  void document.fonts.load(`1em ${mono}`).then(() => fitContents(api));
}

const columnDefs = computed<ColDef<JobRun>[]>(() => [
  {
    colId: 'status',
    headerName: t('sync.column.status'),
    field: 'status',
    cellRenderer: markRaw(StatusCell),
  },
  {
    colId: 'job',
    headerName: t('sync.column.job'),
    valueGetter: ({ data }) => (data ? labels.job(data.job) : ''),
  },
  {
    colId: 'connection',
    headerName: t('sync.column.connection'),
    valueGetter: ({ data }) => (data ? labels.connection(data) : ''),
    cellRenderer: markRaw(WrappedCell),
    // Die Zeile wächst mit dem umbrochenen Text.
    cellClass: AUTO_HEIGHT_CELL,
    autoHeight: true,
    // Platz für „amazon-ads-mock@“ in einer Zeile.
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
  },
  {
    colId: 'duration',
    headerName: t('sync.column.duration'),
    // Laufende Jobs: Dauer bis jetzt (sortiert zum Stand der Daten, angezeigt mit der Uhr des Kontexts).
    valueGetter: ({ data }) => (data ? elapsedMs(data) : null),
    cellRenderer: markRaw(DurationCell),
    cellClass: DATA_CELL,
    // Angepasst wird nur nach neuen Zeilen, die Dauer laufender Jobs wächst dazwischen: Platz für „12 Std. 59 Min.“.
    minWidth: 160,
  },
  {
    colId: 'result',
    headerName: t('sync.column.result'),
    // Zähler und (aufklappbarer) Fehlertext in einer Spalte: Der Fehler bleibt ohne Scrollen sichtbar.
    valueGetter: ({ data }) => (data ? labels.counters(data) : ''),
    cellRenderer: markRaw(ResultCell),
    cellClass: AUTO_HEIGHT_CELL,
    // Die Zeile wächst mit umbrochenen Zählern und dem aufgeklappten Fehlertext.
    autoHeight: true,
    sortable: false,
    minWidth: 220,
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
    :style="gridMinWidth.style.value"
    :theme="gridTheme"
    :theme-css-layer="gridStyleOptions.themeCssLayer"
    :theme-style-container="gridStyleOptions.themeStyleContainer"
    :locale-text="gridLocaleText"
    :row-data="runs"
    :column-defs="columnDefs"
    :context="context"
    :get-row-id="getRowId"
    :row-height="52"
    dom-layout="autoHeight"
    :suppress-column-virtualisation="true"
    :suppress-row-virtualisation="true"
    :suppress-cell-focus="true"
    :default-col-def="defaultColDef"
    :auto-size-padding="AUTO_SIZE_PADDING"
    @grid-ready="onGridReady"
    @row-data-updated="onRowDataUpdated"
    @model-updated="onModelUpdated"
    @column-resized="gridMinWidth.onColumnResized"
  />
</template>
