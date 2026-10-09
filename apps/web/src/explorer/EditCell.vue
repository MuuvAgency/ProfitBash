<script setup lang="ts">
import {
  AD_CHANGE_STATES,
  compareDecimal,
  formatCurrency,
  MISSING_VALUE,
  type AdChangeField,
  type ExplorerLevel,
} from '@profitbash/shared';
import type { ICellRendererParams } from 'ag-grid-community';
import { computed, nextTick, ref } from 'vue';
import { useI18n } from 'vue-i18n';
import { useSessionStore } from '../stores/session';
import type { GridRow } from './columns';
import {
  currentFieldValue,
  EDITABLE_COLUMN_FIELDS,
  editIssue,
  fieldCurrency,
  parseMoneyInput,
  type EditableColumn,
  type MoneyField,
  type OpenChange,
  type OpenEntry,
} from './editing';

/** Kontext des Grids für bearbeitbare Zellen (`phase-3.md` 3.5). */
export interface EditCellContext {
  editing: {
    level: () => ExplorerLevel;
    /** Recht `write` im Feature `changes`. */
    canWrite: () => boolean;
    /** Offene Änderungen an dieser Stelle (eigene, fremde, übermittelte; F4). */
    entryFor: (row: GridRow, field: AdChangeField) => OpenEntry | undefined;
    /** Legt den Wert in den Warenkorb. */
    stage: (row: GridRow, field: AdChangeField, value: string) => Promise<void>;
    /** Nimmt die eigene Vormerkung zurück. */
    undo: (change: OpenChange) => Promise<void>;
  };
}

/**
 * Zelle für Status, Budget und Gebote: zeigt den Stand von Amazon bzw. die eigene Vormerkung (mit Markierung und
 * „Zurücknehmen“), dazu Hinweise auf Vormerkungen anderer und auf Übermitteltes ohne Ergebnis. Ein Klick (oder Enter
 * auf der Zelle) öffnet die Eingabe; Enter oder Verlassen legt den Wert sofort in den Warenkorb (Dominik,
 * 2026-10-08), Escape bricht ab.
 */
const props = defineProps<{
  params: ICellRendererParams<GridRow, string | null> & { context: EditCellContext };
}>();

const { t, te } = useI18n();
const session = useSessionStore();
const locale = computed(() => session.preferences.locale);

const editing = props.params.context.editing;
const row = computed(() => props.params.data);
const column = props.params.colDef?.colId as EditableColumn;
const field: AdChangeField = EDITABLE_COLUMN_FIELDS[column];
const isState = field === 'state';
const level = computed(() => editing.level());

const editable = computed(
  () =>
    row.value !== undefined &&
    editing.canWrite() &&
    editIssue(level.value, row.value, field) === null,
);
const entry = computed(() =>
  row.value && !row.value.isTotal ? editing.entryFor(row.value, field) : undefined,
);
const mine = computed(() => entry.value?.mine ?? null);
const current = computed(() => (row.value ? currentFieldValue(row.value, field) : null));
const currency = computed(() =>
  row.value && !isState ? fieldCurrency(row.value, field as MoneyField) : '',
);

function display(value: string | null): string {
  if (value === null) return MISSING_VALUE;
  if (!isState) return formatCurrency(value, currency.value, locale.value);
  const key = `explorer.state.${value}`;
  return te(key) ? t(key) : value;
}
/** Stand von Amazon, wie ihn die Spalte formatiert (bei vCPM mit „je 1000 sichtbare Impr.“). */
const currentText = computed(() => props.params.valueFormatted ?? display(current.value));
const shownText = computed(() => (mine.value ? display(mine.value.after) : currentText.value));
const label = computed(() => t(`explorer.column.${column}`));

const channelText = (change: OpenChange) => t(`changes.channel.${change.channel ?? 'api'}`);
const othersText = computed(() =>
  (entry.value?.others ?? [])
    .map((change: OpenChange) =>
      t('explorer.edit.pendingOther', {
        name: change.userName ?? t('explorer.edit.someone'),
        value: display(change.after),
      }),
    )
    .join(' · '),
);
const submittedText = computed(() =>
  (entry.value?.submitted ?? [])
    .map((change: OpenChange) =>
      t('explorer.edit.submitted', { channel: channelText(change), value: display(change.after) }),
    )
    .join(' · '),
);

// --- Eingabe -------------------------------------------------------------------------------

const open = ref(false);
const busy = ref(false);
const text = ref('');
const invalid = ref(false);
const input = ref<HTMLInputElement | HTMLSelectElement>();

const stateOptions = computed(() => {
  // Negatives lassen sich nur archivieren (F3).
  const states =
    level.value === 'negative'
      ? [...new Set([current.value ?? 'ENABLED', 'ARCHIVED'])]
      : [...AD_CHANGE_STATES];
  const known = current.value && !states.includes(current.value) ? [current.value] : [];
  return [...known, ...states].map((value) => ({ value, label: display(value) }));
});

/** Decimal-String in der Schreibweise der Eingabe (Komma im deutschen Zahlenformat). */
const editText = (value: string | null) =>
  value === null ? '' : locale.value.startsWith('de') ? value.replace('.', ',') : value;

async function start() {
  if (!editable.value || busy.value) return;
  const value = mine.value?.after ?? current.value;
  text.value = isState ? (value ?? '') : editText(value);
  invalid.value = false;
  open.value = true;
  await nextTick();
  input.value?.focus();
  if (input.value instanceof HTMLInputElement) input.value.select();
}

function cancel() {
  open.value = false;
  invalid.value = false;
}

async function commit(raw: string, { fromBlur = false } = {}) {
  if (!open.value || !row.value) return;
  const value = isState ? raw : parseMoneyInput(raw);
  if (value === null || value === '') {
    // Beim Verlassen mit ungültiger Eingabe bleibt der alte Wert (kein Feld, das den Fokus festhält).
    if (fromBlur) cancel();
    else invalid.value = true;
    return;
  }
  const shown = mine.value?.after ?? current.value;
  const same = shown !== null && (isState ? shown === value : compareDecimal(shown, value) === 0);
  open.value = false;
  if (same) return;
  busy.value = true;
  try {
    await editing.stage(row.value, field, value);
  } finally {
    busy.value = false;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter') {
    event.preventDefault();
    void commit((event.target as HTMLInputElement).value);
  } else if (event.key === 'Escape') {
    event.preventDefault();
    cancel();
  }
}

async function undo() {
  if (!mine.value || busy.value) return;
  busy.value = true;
  try {
    await editing.undo(mine.value);
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <span
    :class="[
      'relative flex min-w-0 flex-1 items-center gap-space-xs',
      isState ? '' : 'justify-end',
    ]"
  >
    <template v-if="open">
      <select
        v-if="isState"
        ref="input"
        data-edit-input
        :aria-label="label"
        :value="text"
        class="h-8 w-full min-w-0 rounded-control bg-tile px-space-xs text-body-sm text-ink outline-none ring-2 ring-violet"
        @change="commit(($event.target as HTMLSelectElement).value)"
        @blur="cancel"
        @keydown.escape.prevent="cancel"
      >
        <option v-for="option in stateOptions" :key="option.value" :value="option.value">
          {{ option.label }}
        </option>
      </select>
      <template v-else>
        <input
          ref="input"
          v-model="text"
          data-edit-input
          type="text"
          inputmode="decimal"
          autocomplete="off"
          :aria-label="t('explorer.edit.inputLabel', { label, currency })"
          :aria-invalid="invalid ? 'true' : undefined"
          :class="[
            'h-8 w-full min-w-0 rounded-control bg-tile px-space-xs text-right font-data text-ink outline-none ring-2',
            invalid ? 'ring-loss' : 'ring-violet',
          ]"
          @input="invalid = false"
          @keydown="onKeydown"
          @blur="commit(($event.target as HTMLInputElement).value, { fromBlur: true })"
        />
        <span
          v-if="invalid"
          role="alert"
          class="absolute right-0 top-full z-10 mt-1 w-56 rounded-control bg-loss-wash px-space-sm py-space-xs text-left font-sans text-body-sm text-on-loss-wash shadow-tile"
        >
          {{ t('explorer.edit.invalidMoney') }}
        </span>
      </template>
    </template>

    <template v-else>
      <span
        v-if="submittedText"
        data-pending="submitted"
        class="shrink-0 text-ink-tertiary"
        :title="submittedText"
      >
        <i class="pi pi-send text-[0.75rem]" aria-hidden="true" />
        <span class="sr-only">{{ submittedText }}</span>
      </span>
      <span v-if="othersText" data-pending="others" class="shrink-0 text-warn" :title="othersText">
        <i class="pi pi-users text-[0.75rem]" aria-hidden="true" />
        <span class="sr-only">{{ othersText }}</span>
      </span>
      <span
        v-if="mine"
        data-pending="mine"
        class="size-2 shrink-0 rounded-full bg-violet"
        :title="t('explorer.edit.pendingMine', { value: currentText })"
      >
        <span class="sr-only">{{ t('explorer.edit.pendingMine', { value: currentText }) }}</span>
      </span>

      <button
        v-if="editable"
        type="button"
        data-edit
        :disabled="busy"
        :aria-label="t('explorer.edit.start', { label, value: shownText })"
        :class="[
          '-mx-space-xs min-w-0 truncate rounded-control px-space-xs py-0.5 outline-none hover:bg-violet-wash focus-visible:ring-2 focus-visible:ring-violet',
          mine ? 'font-semibold text-violet' : '',
          busy ? 'opacity-60' : '',
        ]"
        @click="start"
      >
        {{ shownText }}
      </button>
      <span v-else :class="['min-w-0 truncate', mine ? 'font-semibold text-violet' : '']">{{
        shownText
      }}</span>

      <button
        v-if="mine && editing.canWrite()"
        type="button"
        data-edit-undo
        :disabled="busy"
        :aria-label="t('explorer.edit.undo', { label })"
        :title="t('explorer.edit.undo', { label })"
        class="flex size-6 shrink-0 items-center justify-center rounded-control text-ink-tertiary outline-none hover:bg-violet-wash hover:text-violet focus-visible:ring-2 focus-visible:ring-violet"
        @click="undo"
      >
        <i class="pi pi-undo text-[0.75rem]" aria-hidden="true" />
      </button>
    </template>
  </span>
</template>
