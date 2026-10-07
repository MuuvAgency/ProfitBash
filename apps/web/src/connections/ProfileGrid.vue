<script setup lang="ts">
import {
  formatDay,
  type Client,
  type Locale,
  type Profile,
  type ProfilePatch,
} from '@profitbash/shared';
import type {
  ColDef,
  GetRowIdParams,
  RowClassParams,
  SuppressKeyboardEventParams,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { computed, markRaw, reactive, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { AUTO_HEIGHT_CELL, gridLocaleText, gridStyleOptions, gridTheme } from '../grid/grid';
import { useGridMinWidth } from '../grid/min-width';
import { useSessionStore } from '../stores/session';
import { countryName } from './country';
import AccountCell from './cells/AccountCell.vue';
import ClientCell from './cells/ClientCell.vue';
import CountryCell from './cells/CountryCell.vue';
import FilesCell from './cells/FilesCell.vue';
import HiddenCell from './cells/HiddenCell.vue';
import LastImportCell from './cells/LastImportCell.vue';
import TimezoneCell from './cells/TimezoneCell.vue';
import type { ProfileGridContext } from './cells/types';

const props = defineProps<{
  profiles: Profile[];
  clients: Client[];
  clientsReady: boolean;
  /**
   * Profile ohne Connection: Spalten „Letzter Import“ und „Dateien“ (1.11f) statt Zeitzone und „Daten bis“ (ohne
   * Tagesberichte gibt es keinen Datenstand, `phase-1.md` 1.11e), damit die Tabelle bei 1440 px ohne Scrollen passt.
   */
  fileImports?: boolean;
}>();
const emit = defineEmits<{
  patch: [profile: Profile, patch: ProfilePatch];
  createClient: [profile: Profile];
  openFiles: [profile: Profile];
}>();

const { t, te } = useI18n();
const session = useSessionStore();

const context = reactive<ProfileGridContext>({
  clients: [],
  clientsReady: false,
  patch: (profile, patch) => emit('patch', profile, patch),
  createClient: (profile) => emit('createClient', profile),
  openFiles: (profile) => emit('openFiles', profile),
});
watchEffect(() => {
  context.clients = props.clients;
  context.clientsReady = props.clientsReady;
});

/**
 * Tastatur in Auswahl und Schalter gehört dem Steuerelement, nicht der Grid-Navigation.
 * Tab bleibt beim Grid, damit man die Tabelle weiter verlassen kann.
 */
function suppressControlKeys({ event }: SuppressKeyboardEventParams<Profile>) {
  const target = event.target;
  return (
    event.key !== 'Tab' &&
    target instanceof HTMLElement &&
    target.closest('[role="combobox"],[role="switch"],[role="listbox"]') !== null
  );
}

function accountTypeLabel(type: string | undefined) {
  if (!type) return '';
  const key = `connections.profiles.accountType.${type}`;
  // Neue Amazon-Werte erscheinen unverändert.
  return te(key) ? t(key) : type;
}

/** Zellen zentrieren ihren Inhalt vertikal; Steuerelemente erben sonst die Zeilenhöhe des Grids. */
const CELL = 'flex items-center leading-normal';
const DATA_CELL = `${CELL} font-data`;
/** Spalten mit umbrechendem Text (F14: passt bei 1440 px auch mit klassischer Scrollbar, lesbar ohne Tooltip). */
const WRAPPED = { cellClass: AUTO_HEIGHT_CELL, autoHeight: true } as const;

const columnDefs = computed<ColDef<Profile>[]>(() => {
  const { locale } = session.preferences;
  const columns: ColDef<Profile>[] = [
    {
      colId: 'country',
      headerName: t('connections.profiles.column.country'),
      // Sortiert nach dem angezeigten Namen („Vereinigtes Königreich“, nicht „UK“).
      valueGetter: ({ data }) => (data ? countryName(data.countryCode) : ''),
      cellRenderer: markRaw(CountryCell),
      ...WRAPPED,
      minWidth: 170,
      flex: 1,
    },
    {
      colId: 'accountName',
      headerName: t('connections.profiles.column.accountName'),
      field: 'accountName',
      cellRenderer: markRaw(AccountCell),
      ...WRAPPED,
      minWidth: 140,
      flex: 2,
    },
    {
      colId: 'type',
      headerName: t('connections.profiles.column.type'),
      valueGetter: ({ data }) => accountTypeLabel(data?.accountType),
      width: 90,
    },
    {
      colId: 'currency',
      headerName: t('connections.profiles.column.currency'),
      field: 'currencyCode',
      cellClass: DATA_CELL,
      width: 85,
    },
    ...(props.fileImports
      ? [
          {
            colId: 'lastImport',
            headerName: t('connections.fileProfiles.column.lastImport'),
            field: 'lastBulkImportAt',
            cellRenderer: markRaw(LastImportCell),
            ...WRAPPED,
            width: 170,
          } satisfies ColDef<Profile>,
        ]
      : apiOnlyColumns(locale)),
    {
      colId: 'client',
      headerName: t('connections.profiles.column.client'),
      field: 'clientId',
      cellRenderer: markRaw(ClientCell),
      suppressKeyboardEvent: suppressControlKeys,
      sortable: false,
      minWidth: 180,
      flex: 1,
    },
    {
      colId: 'hidden',
      headerName: t('connections.profiles.column.hidden'),
      field: 'isHidden',
      cellRenderer: markRaw(HiddenCell),
      suppressKeyboardEvent: suppressControlKeys,
      width: 110,
    },
  ];
  if (props.fileImports) {
    columns.push({
      colId: 'files',
      headerName: t('connections.fileProfiles.column.files'),
      cellRenderer: markRaw(FilesCell),
      sortable: false,
      width: 130,
    });
  }
  return columns;
});

/** Zeitzone und „Daten bis“: nur für Profile mit Connection. */
function apiOnlyColumns(locale: Locale): ColDef<Profile>[] {
  return [
    {
      colId: 'timezone',
      headerName: t('connections.profiles.column.timezone'),
      field: 'timezone',
      cellRenderer: markRaw(TimezoneCell),
      ...WRAPPED,
      // „Europe/Stockholm“ passt; längere („America/Los_Angeles“) brechen nach „/“ um.
      minWidth: 165,
      flex: 1,
    },
    {
      // Sortiert nach dem Tag (`YYYY-MM-DD`), angezeigt im Format der Sprache.
      colId: 'metricsImportedThrough',
      headerName: t('connections.profiles.column.metricsImportedThrough'),
      field: 'metricsImportedThrough',
      valueFormatter: ({ value }) => formatDay(value, locale),
      cellClass: DATA_CELL,
      width: 115,
    },
  ];
}

/** Konstant: Ein neues Objekt je Render setzte die Spalten zurück (z. B. geänderte Breiten). */
const defaultColDef: ColDef<Profile> = {
  resizable: true,
  sortable: true,
  suppressMovable: true,
  cellClass: CELL,
};

const getRowId = ({ data }: GetRowIdParams<Profile>) => data.id;

const gridMinWidth = useGridMinWidth();

/**
 * Ausgeblendete und entfernte Profile treten zurück (Sekundärfarbe: bleibt lesbar, AA-Kontrast). Als `rowClassRules`, nicht `getRowClass`:
 * Nur die Regeln wertet AG Grid bei geänderten Zeilendaten neu aus.
 */
const rowClassRules = {
  'text-ink-secondary': ({ data }: RowClassParams<Profile>) =>
    Boolean(data && (data.isHidden || data.removedAt)),
};
</script>

<template>
  <AgGridVue
    class="w-full"
    :style="gridMinWidth.style.value"
    :theme="gridTheme"
    :theme-css-layer="gridStyleOptions.themeCssLayer"
    :theme-style-container="gridStyleOptions.themeStyleContainer"
    :locale-text="gridLocaleText"
    :row-data="profiles"
    :column-defs="columnDefs"
    :context="context"
    :get-row-id="getRowId"
    :row-class-rules="rowClassRules"
    :row-height="52"
    dom-layout="autoHeight"
    :suppress-column-virtualisation="true"
    :suppress-cell-focus="true"
    :default-col-def="defaultColDef"
    @grid-ready="gridMinWidth.onGridReady"
    @column-resized="gridMinWidth.onColumnResized"
  />
</template>
