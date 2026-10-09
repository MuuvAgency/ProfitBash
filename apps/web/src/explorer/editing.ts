import {
  AD_CHANGE_FIELDS_BY_ENTITY,
  AD_CHANGE_PLACEMENTS,
  adChangeValueIssue,
  isAdChangePlacementField,
  type AdChangeEntityType,
  type AdChangeField,
  type AdChangeInput,
  type AdChangeRejection,
  type ExplorerLevel,
} from '@profitbash/shared';
import type { OpenAdChangesData } from '../api/client';
import { parseDecimalInput } from '../search-terms/decimal-input';
import type { GridRow } from './columns';

/**
 * Bearbeiten im Explorer (`phase-3.md` 3.5), ohne I/O: welche Zeile sich an welchem Feld ändern lässt, offene
 * Änderungen je Stelle, Eingaben prüfen, Eingaben der Bulk-Dialoge bauen. Gerechnet wird hier nie: Prozent und
 * Beträge gehen als Anpassung an den Server.
 */

export type OpenChange = OpenAdChangesData['changes'][number];

const ENTITY_TYPE_BY_LEVEL: Partial<Record<ExplorerLevel, AdChangeEntityType>> = {
  campaign: 'campaign',
  adGroup: 'ad_group',
  target: 'target',
  productAd: 'product_ad',
  negative: 'negative_target',
};

export function entityTypeOf(level: ExplorerLevel): AdChangeEntityType | null {
  return ENTITY_TYPE_BY_LEVEL[level] ?? null;
}

/** Spalten des Grids, die sich in der Zelle bearbeiten lassen. */
export const EDITABLE_COLUMN_FIELDS = {
  state: 'state',
  budget: 'budget',
  defaultBid: 'default_bid',
  bid: 'bid',
} as const satisfies Record<string, AdChangeField>;
export type EditableColumn = keyof typeof EDITABLE_COLUMN_FIELDS;

export type EditIssue =
  | 'notEditable'
  | Extract<
      AdChangeRejection,
      'entityRemoved' | 'entityArchived' | 'budgetNotDaily' | 'adProductNotSupported'
    >;

/** Warum sich das Feld dieser Zeile nicht ändern lässt (wie die Ablehnungen des Servers); `null`, wenn es geht. */
export function editIssue(
  level: ExplorerLevel,
  row: GridRow,
  field: AdChangeField,
): EditIssue | null {
  const entityType = entityTypeOf(level);
  if (!entityType || !AD_CHANGE_FIELDS_BY_ENTITY[entityType].includes(field)) return 'notEditable';
  if (row.isTotal || row.placeholder) return 'notEditable';
  if (row.removed) return 'entityRemoved';
  if (row.state?.toUpperCase() === 'ARCHIVED') return 'entityArchived';
  if (field === 'budget' && row.attributes.budgetType !== 'DAILY') return 'budgetNotDaily';
  if (
    (field === 'bidding_strategy' || isAdChangePlacementField(field)) &&
    row.adProduct !== 'SPONSORED_PRODUCTS'
  ) {
    return 'adProductNotSupported';
  }
  return null;
}

/** Gebotsanpassung einer Platzierung aus `placementBidAdjustments` der Kampagne; ohne Eintrag gilt 0 %. */
export function placementPercent(adjustments: unknown, placement: string): string {
  if (!Array.isArray(adjustments)) return '0';
  for (const entry of adjustments as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { placement: name, percentage } = entry as Record<string, unknown>;
    if (name !== placement) continue;
    const text = typeof percentage === 'number' ? String(percentage) : percentage;
    return typeof text === 'string' && /^\d+$/.test(text) ? text : '0';
  }
  return '0';
}

const ATTRIBUTE_BY_FIELD: Partial<Record<AdChangeField, string>> = {
  budget: 'budgetAmount',
  default_bid: 'defaultBid',
  bid: 'bid',
  bidding_strategy: 'biddingStrategy',
};

/** Stand eines Felds laut Zeile (Decimal-String bzw. Text). */
export function currentFieldValue(row: GridRow, field: AdChangeField): string | null {
  if (field === 'state') return row.state;
  if (isAdChangePlacementField(field)) {
    return placementPercent(row.attributes.placementBidAdjustments, AD_CHANGE_PLACEMENTS[field]);
  }
  const value = row.attributes[ATTRIBUTE_BY_FIELD[field]!];
  return typeof value === 'string' && value !== '' ? value : null;
}

// ---------------------------------------------------------------------------
// Offene Änderungen je Stelle (F4)
// ---------------------------------------------------------------------------

export interface OpenEntry {
  /** Die eigene Vormerkung im Warenkorb. */
  mine: OpenChange | null;
  /** Vormerkungen anderer Nutzer. */
  others: OpenChange[];
  /** Übermittelt, noch ohne Ergebnis (eigene und fremde). */
  submitted: OpenChange[];
}
export type OpenIndex = Map<string, OpenEntry>;

const entryKey = (entityType: string, entityId: string, field: string) =>
  `${entityType}:${entityId}:${field}`;

export function indexOpenChanges(changes: readonly OpenChange[]): OpenIndex {
  const index: OpenIndex = new Map();
  for (const change of changes) {
    if (change.operation !== 'update' || !change.entityId || !change.field) continue;
    const key = entryKey(change.entityType, change.entityId, change.field);
    const entry = index.get(key) ?? { mine: null, others: [], submitted: [] };
    if (change.status === 'submitted') entry.submitted.push(change);
    else if (change.mine) entry.mine = change;
    else entry.others.push(change);
    index.set(key, entry);
  }
  return index;
}

export function openEntry(
  index: OpenIndex,
  level: ExplorerLevel,
  entityId: string,
  field: AdChangeField,
): OpenEntry | undefined {
  const entityType = entityTypeOf(level);
  return entityType ? index.get(entryKey(entityType, entityId, field)) : undefined;
}

// ---------------------------------------------------------------------------
// Eingaben
// ---------------------------------------------------------------------------

/** Betrag mit Komma oder Punkt → Decimal-String (größer 0, höchstens zwei Nachkommastellen); sonst `null`. */
export function parseMoneyInput(text: string): string | null {
  const value = parseDecimalInput(text);
  return value !== null && adChangeValueIssue('target', 'bid', value) === null ? value : null;
}

/** Gebotsanpassung einer Platzierung: ganze Prozent von 0 bis 900; sonst `null`. */
export function parsePercentInput(text: string): string | null {
  const value = text.trim();
  return adChangeValueIssue('campaign', 'placement_top', value) === null ? value : null;
}

export type MoneyField = 'budget' | 'default_bid' | 'bid';

export type BulkEdit =
  | { field: 'state'; value: string }
  /** Fester Wert je Währung der Zeile. */
  | { field: MoneyField; mode: 'fixed'; values: Record<string, string> }
  | { field: MoneyField; mode: 'percent'; direction: 'increase' | 'decrease'; value: string }
  /** Betrag je Währung der Zeile. */
  | {
      field: MoneyField;
      mode: 'amount';
      direction: 'increase' | 'decrease';
      values: Record<string, string>;
    };

export interface BulkInputs {
  inputs: AdChangeInput[];
  /** Zeilen, die sich nicht ändern lassen bzw. für deren Währung kein Wert angegeben ist. */
  skipped: { id: string; reason: EditIssue | 'noValue' }[];
}

/** Währung, in der ein Betrag der Zeile gilt (Budget und Gebote tragen ihre eigene, sonst die des Profils). */
export function fieldCurrency(row: GridRow, field: MoneyField): string {
  const key =
    field === 'budget'
      ? 'budgetCurrencyCode'
      : field === 'bid'
        ? 'bidCurrencyCode'
        : 'defaultBidCurrencyCode';
  const value = row.attributes[key];
  return typeof value === 'string' && value !== '' ? value : row.currencyCode;
}

/** Eingaben für `POST /api/ads/changes/pending` aus einem Bulk-Dialog über die markierten Zeilen. */
export function bulkInputs(
  level: ExplorerLevel,
  rows: readonly GridRow[],
  edit: BulkEdit,
): BulkInputs {
  const result: BulkInputs = { inputs: [], skipped: [] };
  const entityType = entityTypeOf(level);
  for (const row of rows) {
    const issue = editIssue(level, row, edit.field);
    if (issue || !entityType) {
      result.skipped.push({ id: row.id, reason: issue ?? 'notEditable' });
      continue;
    }
    const target = { entityType, entityId: row.id };
    if (edit.field === 'state') {
      result.inputs.push({ operation: 'update', ...target, field: 'state', value: edit.value });
      continue;
    }
    if (edit.mode === 'percent') {
      const sign = edit.direction === 'decrease' ? '-' : '';
      result.inputs.push({
        operation: 'adjust',
        ...target,
        field: edit.field,
        mode: 'percent',
        value: `${sign}${edit.value}`,
      });
      continue;
    }
    const value = edit.values[fieldCurrency(row, edit.field)];
    if (value === undefined) {
      result.skipped.push({ id: row.id, reason: 'noValue' });
    } else if (edit.mode === 'fixed') {
      result.inputs.push({ operation: 'update', ...target, field: edit.field, value });
    } else {
      const sign = edit.direction === 'decrease' ? '-' : '';
      result.inputs.push({
        operation: 'adjust',
        ...target,
        field: edit.field,
        mode: 'amount',
        value: `${sign}${value}`,
      });
    }
  }
  return result;
}
