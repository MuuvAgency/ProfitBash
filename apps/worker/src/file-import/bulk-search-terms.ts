import type { SearchTermPeriodMetric } from '@profitbash/db';
import { Dec, formatDecimal } from '@profitbash/engine';
import type { Logger } from '@profitbash/shared';
import type { RowInfo } from '@profitbash/sheets';
import {
  AMOUNT_SIGNIFICANT_DIGITS,
  normalizeHeader,
  parseBulkAmount,
  parseBulkId,
  type CellResult,
} from './bulk-columns';

/**
 * Suchbegriff-Blätter der Bulk-Datei (`phase-2b.md` 2b.1, F1): „SP Bericht „Suchbegriff““ bzw.
 * „SP Search Term Report“ und die SB-Entsprechung. Die Zeilen sind **Summen über den Download-Zeitraum**
 * (kein Datum je Zeile); der Zeitraum steht nur im Dateinamen der Werbekonsole. Abgeleitete Spalten
 * (Klickrate, Conversion-Rate, ACOS, CPC, ROAS) werden nicht gelesen, sondern später berechnet.
 *
 * Logs nennen nur Blatt, Zeile und Spalte, nie Zellinhalte (Suchbegriffe sind Kundendaten).
 */

export interface BulkPeriod {
  /** Beide Tage eingeschlossen (`YYYY-MM-DD`). */
  startDate: string;
  endDate: string;
}

function isoDay(text: string): string | null {
  const iso = `${text.slice(0, 4)}-${text.slice(4, 6)}-${text.slice(6, 8)}`;
  const date = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === iso ? iso : null;
}

/**
 * Download-Zeitraum aus dem Dateinamen der Werbekonsole (`bulk-<konto>-<von>-<bis>-<zeitstempel>.xlsx`,
 * Tage `YYYYMMDD`); `null`, wenn die Datei umbenannt wurde oder der Zeitraum unmöglich ist.
 */
export function parseBulkPeriod(fileName: string): BulkPeriod | null {
  const match = /^bulk-[^-]+-(\d{8})-(\d{8})-\d+/i.exec(fileName.trim());
  if (!match) return null;
  const startDate = isoDay(match[1]!);
  const endDate = isoDay(match[2]!);
  if (!startDate || !endDate || startDate > endDate) return null;
  return { startDate, endDate };
}

export type SearchTermSheetKind = 'sp' | 'sb';

/** Suchbegriff-Blatt nach seinem Namen (deutsch und englisch), sonst `null`. */
export function searchTermSheetKind(name: string): SearchTermSheetKind | null {
  const text = normalizeHeader(name);
  if (!/suchbegriff|search term/.test(text)) return null;
  if (/^sp\b/.test(text)) return 'sp';
  if (/^sb\b/.test(text)) return 'sb';
  return null;
}

/** Zähler (Impressions, Klicks, Bestellungen, Einheiten) als ganze Zahl ≥ 0, nie über Gleitkomma-Reste. */
export function parseBulkCount(text: string): CellResult<number> {
  const amount = parseBulkAmount(text);
  if (amount === null || amount === 'invalid') return amount;
  const value = new Dec(amount);
  if (value.isNegative() || !value.isInteger() || value.greaterThan(Number.MAX_SAFE_INTEGER)) {
    return 'invalid';
  }
  return value.toNumber();
}

type SearchTermColumn =
  | 'campaignId'
  | 'adGroupId'
  | 'keywordId'
  | 'productTargetingId'
  | 'searchTerm'
  | 'impressions'
  | 'clicks'
  | 'cost'
  | 'sales'
  | 'purchases'
  | 'units';

/** Englisch und Deutsch laut echten Dateien (Befund 2026-10-07 in `phase-2b.md`); der letzte Name dient Meldungen. */
const COLUMN_ALIASES: Record<SearchTermColumn, readonly string[]> = {
  campaignId: ['Campaign ID', 'Kampagnen-ID'],
  adGroupId: ['Ad Group ID', 'Anzeigengruppen-ID'],
  keywordId: ['Keyword ID', 'Keyword-ID'],
  productTargetingId: ['Product Targeting ID', 'Produkt-Targeting-ID'],
  searchTerm: ['Customer Search Term', 'Suchbegriff eines Kunden'],
  impressions: ['Impressions'],
  clicks: ['Clicks', 'Klicks'],
  cost: ['Spend', 'Ausgaben'],
  sales: ['Sales', 'Verkäufe'],
  purchases: ['Orders', 'Bestellungen'],
  units: ['Units', 'Einheiten'],
};

const COLUMN_BY_HEADER: ReadonlyMap<string, SearchTermColumn> = new Map(
  (Object.entries(COLUMN_ALIASES) as Array<[SearchTermColumn, readonly string[]]>).flatMap(
    ([column, aliases]) => aliases.map((alias) => [normalizeHeader(alias), column] as const),
  ),
);

/** Ohne diese Spalten ist das Blatt kein lesbarer Suchbegriff-Bericht (Keyword- oder Produkt-Targeting-ID genügt eine). */
const REQUIRED_COLUMNS: readonly SearchTermColumn[] = [
  'campaignId',
  'adGroupId',
  'searchTerm',
  'impressions',
  'clicks',
  'cost',
  'sales',
  'purchases',
  'units',
];

/** Höchstens so viele ungültige Zeilen einzeln loggen, danach nur die Summe. */
const MAX_INVALID_ROW_LOGS = 20;

class InvalidCell extends Error {
  constructor(
    readonly column: SearchTermColumn,
    readonly reason: string,
  ) {
    super(reason);
  }
}

export interface SearchTermSheetResult {
  kind: SearchTermSheetKind;
  rows: SearchTermPeriodMetric[];
}

/** Sammelt die Zeilen der Suchbegriff-Blätter einer Datei; je Target und Suchbegriff eine Zeile (doppelte summiert). */
export class SearchTermCollector {
  invalidRows = 0;
  private loggedInvalid = 0;
  private readonly bySheet = new Map<SearchTermSheetKind, Map<string, SearchTermPeriodMetric>>();

  constructor(private readonly logger: Logger) {}

  /** Liest ein Blatt (Kopfzeile = erste nicht leere Zeile). Fehlen Spalten, wird es mit Log übergangen. */
  readSheet(
    sheet: string,
    kind: SearchTermSheetKind,
    forEachRow: (
      sheet: string,
      callback: (cells: string[], row: number, info: RowInfo) => void,
    ) => void,
  ): void {
    let columns: Map<SearchTermColumn, number> | null = null;
    let skipped = false;
    forEachRow(sheet, (cells, row, info) => {
      if (skipped || cells.every((cell) => cell.trim() === '')) return;
      if (columns === null) {
        columns = new Map();
        cells.forEach((text, index) => {
          const column = COLUMN_BY_HEADER.get(normalizeHeader(text));
          if (column && !columns!.has(column)) columns!.set(column, index);
        });
        const missing = [
          ...REQUIRED_COLUMNS.filter((column) => !columns!.has(column)),
          ...(columns.has('keywordId') || columns.has('productTargetingId')
            ? []
            : (['keywordId'] as const)),
        ];
        if (missing.length > 0) {
          skipped = true;
          this.logger({
            level: 'warn',
            msg: 'bulk_import.search_term_sheet_skipped',
            sheet,
            missingColumns: missing.map((column) => COLUMN_ALIASES[column].at(-1)!),
          });
        }
        return;
      }
      try {
        this.add(kind, this.parseRow(cells, info, columns));
      } catch (error) {
        if (!(error instanceof InvalidCell)) throw error;
        this.invalidRows += 1;
        if (this.loggedInvalid < MAX_INVALID_ROW_LOGS) {
          this.loggedInvalid += 1;
          this.logger({
            level: 'warn',
            msg: 'bulk_import.invalid_search_term_row',
            sheet,
            row,
            column: COLUMN_ALIASES[error.column].at(-1)!,
            reason: error.reason,
          });
        }
      }
    });
  }

  /** Zeilen je Blatt-Art; Blätter ohne Zeilen fehlen. */
  finish(): SearchTermSheetResult[] {
    if (this.invalidRows > 0) {
      this.logger({
        level: 'warn',
        msg: 'bulk_import.invalid_search_term_rows',
        count: this.invalidRows,
      });
    }
    return [...this.bySheet].map(([kind, rows]) => ({ kind, rows: [...rows.values()] }));
  }

  get rowCount(): number {
    let total = 0;
    for (const rows of this.bySheet.values()) total += rows.size;
    return total;
  }

  private parseRow(
    cells: string[],
    info: RowInfo,
    columns: ReadonlyMap<SearchTermColumn, number>,
  ): SearchTermPeriodMetric {
    const text = (column: SearchTermColumn) => {
      const index = columns.get(column);
      return index === undefined ? '' : (cells[index] ?? '').trim();
    };
    const required = <T>(column: SearchTermColumn, result: CellResult<T>, reason: string): T => {
      if (result === 'invalid') throw new InvalidCell(column, reason);
      if (result === null) throw new InvalidCell(column, 'fehlt');
      return result;
    };
    const id = (column: SearchTermColumn) => {
      const index = columns.get(column);
      const numeric = index !== undefined && info.numericColumns.has(index);
      return parseBulkId(text(column), numeric);
    };
    const count = (column: SearchTermColumn) =>
      required(column, parseBulkCount(text(column)), 'keine ganze Zahl');
    const amount = (column: SearchTermColumn) =>
      required(column, parseBulkAmount(text(column)), 'kein lesbarer Betrag');

    const keywordId = id('keywordId');
    const productTargetingId = id('productTargetingId');
    if (keywordId === 'invalid') throw new InvalidCell('keywordId', 'keine gültige ID');
    if (productTargetingId === 'invalid') {
      throw new InvalidCell('productTargetingId', 'keine gültige ID');
    }
    const amazonTargetId = keywordId ?? productTargetingId;
    if (amazonTargetId === null) throw new InvalidCell('keywordId', 'fehlt');
    const searchTerm = text('searchTerm');
    if (searchTerm === '') throw new InvalidCell('searchTerm', 'fehlt');

    return {
      amazonCampaignId: required('campaignId', id('campaignId'), 'keine gültige ID'),
      amazonAdGroupId: required('adGroupId', id('adGroupId'), 'keine gültige ID'),
      amazonTargetId,
      searchTerm,
      impressions: count('impressions'),
      clicks: count('clicks'),
      cost: amount('cost'),
      sales: amount('sales'),
      purchases: count('purchases'),
      units: count('units'),
    };
  }

  private add(kind: SearchTermSheetKind, row: SearchTermPeriodMetric): void {
    let rows = this.bySheet.get(kind);
    if (!rows) this.bySheet.set(kind, (rows = new Map()));
    const key = `${row.amazonTargetId}\u0000${row.searchTerm}`;
    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, row);
      return;
    }
    const sum = (a: string, b: string) =>
      formatDecimal(new Dec(a).plus(b).toSignificantDigits(AMOUNT_SIGNIFICANT_DIGITS));
    existing.impressions += row.impressions;
    existing.clicks += row.clicks;
    existing.cost = sum(existing.cost, row.cost);
    existing.sales = sum(existing.sales, row.sales);
    existing.purchases += row.purchases;
    existing.units += row.units;
  }
}
