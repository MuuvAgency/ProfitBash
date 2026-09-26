<script setup lang="ts">
import type { Client, Profile, ProfilePatch } from '@profitbash/shared';
import type {
  ColDef,
  GetRowIdParams,
  RowClassParams,
  SuppressKeyboardEventParams,
} from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { computed, markRaw, reactive, watchEffect } from 'vue';
import { useI18n } from 'vue-i18n';
import { gridStyleOptions, gridTheme } from '../grid/grid';
import { countryName } from './country';
import AccountCell from './cells/AccountCell.vue';
import ClientCell from './cells/ClientCell.vue';
import CountryCell from './cells/CountryCell.vue';
import HiddenCell from './cells/HiddenCell.vue';
import type { ProfileGridContext } from './cells/types';

const props = defineProps<{ profiles: Profile[]; clients: Client[]; clientsReady: boolean }>();
const emit = defineEmits<{
  patch: [profile: Profile, patch: ProfilePatch];
  createClient: [profile: Profile];
}>();

const { t, te } = useI18n();

const context = reactive<ProfileGridContext>({
  clients: [],
  clientsReady: false,
  patch: (profile, patch) => emit('patch', profile, patch),
  createClient: (profile) => emit('createClient', profile),
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

const columnDefs = computed<ColDef<Profile>[]>(() => [
  {
    colId: 'country',
    headerName: t('connections.profiles.column.country'),
    // Sortiert nach dem angezeigten Namen („Vereinigtes Königreich“, nicht „UK“).
    valueGetter: ({ data }) => (data ? countryName(data.countryCode) : ''),
    cellRenderer: markRaw(CountryCell),
    minWidth: 240,
    flex: 1,
  },
  {
    colId: 'accountName',
    headerName: t('connections.profiles.column.accountName'),
    field: 'accountName',
    cellRenderer: markRaw(AccountCell),
    minWidth: 165,
    flex: 2,
  },
  {
    colId: 'type',
    headerName: t('connections.profiles.column.type'),
    valueGetter: ({ data }) => accountTypeLabel(data?.accountType),
    width: 100,
  },
  {
    colId: 'currency',
    headerName: t('connections.profiles.column.currency'),
    field: 'currencyCode',
    cellClass: DATA_CELL,
    width: 100,
  },
  {
    colId: 'timezone',
    headerName: t('connections.profiles.column.timezone'),
    field: 'timezone',
    cellClass: DATA_CELL,
    minWidth: 165,
    flex: 1,
  },
  {
    colId: 'client',
    headerName: t('connections.profiles.column.client'),
    field: 'clientId',
    cellRenderer: markRaw(ClientCell),
    suppressKeyboardEvent: suppressControlKeys,
    sortable: false,
    minWidth: 190,
    flex: 1,
  },
  {
    colId: 'hidden',
    headerName: t('connections.profiles.column.hidden'),
    field: 'isHidden',
    cellRenderer: markRaw(HiddenCell),
    suppressKeyboardEvent: suppressControlKeys,
    width: 130,
  },
]);

/** Konstant: Ein neues Objekt je Render setzte die Spalten zurück (z. B. geänderte Breiten). */
const defaultColDef: ColDef<Profile> = {
  resizable: true,
  sortable: true,
  suppressMovable: true,
  cellClass: CELL,
};

const getRowId = ({ data }: GetRowIdParams<Profile>) => data.id;

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
    :theme="gridTheme"
    :theme-css-layer="gridStyleOptions.themeCssLayer"
    :theme-style-container="gridStyleOptions.themeStyleContainer"
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
  />
</template>
