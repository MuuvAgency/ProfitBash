import { MISSING_VALUE } from '@profitbash/shared';
import type { GridApi, ProcessCellForExportParams } from 'ag-grid-community';

/**
 * CSV-Export der Grids (Explorer F6/F7, Suchbegriff-Analyse 2b.2e): eine Schreibweise für alle Tabellen. Trennzeichen
 * Komma, Beträge und Zähler als Decimal-String mit Punkt (Spalten mit `useValueFormatterForExport: false`), dazu die
 * Spalte `currency` (auch ausgeblendet).
 */

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;
/**
 * Text für den CSV-Export ohne Formel-Wirkung in Tabellenkalkulationen: Werte, die mit `=`, `+`, `-`, `@`, Tab oder
 * Zeilenumbruch beginnen, bekommen ein `'` vorangestellt (Suchbegriffe stammen von beliebigen Käufern). Decimal-Strings
 * wie `-0.1` bleiben.
 */
export function csvSafe(value: string): string {
  if (DECIMAL_STRING.test(value)) return value;
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

/**
 * Zellen im CSV: Beträge und Zähler roh (Decimal-String), Texte formatiert und gegen Formeln entschärft; fehlende Werte
 * leer (nicht „–“).
 */
function processCell<Row>(params: ProcessCellForExportParams<Row>): string {
  const colDef = params.column.getColDef();
  if (colDef.useValueFormatterForExport === false) return params.value ?? '';
  const formatted = params.formatValue(params.value) as unknown;
  const text = formatted === null || formatted === undefined ? '' : String(formatted);
  return text === MISSING_VALUE ? '' : csvSafe(text);
}

/**
 * CSV der geladenen Zeilen in aktueller Filterung und Sortierung: sichtbare Spalten und die Währung, ohne Summenzeile
 * (sie gilt für alle Zeilen der Auswahl, nicht für die exportierten). `note` (z. B. der Hinweis auf gekürzte Zeilen)
 * steht als eigene Zeile vor der Kopfzeile, als ein Feld in Anführungszeichen: Kommas oder Anführungszeichen im Text
 * trennen so keine Spalten ab.
 */
export function gridCsv<Row>(gridApi: GridApi<Row>, note?: string): string {
  const columnKeys = gridApi
    .getAllGridColumns()
    .filter((column) => column.isVisible() || column.getColId() === 'currency')
    .map((column) => column.getColId())
    .filter((id) => !id.startsWith('ag-Grid-'));
  return (
    gridApi.getDataAsCsv({
      columnKeys,
      skipPinnedBottom: true,
      processCellCallback: processCell,
      ...(note && { prependContent: `"${note.replaceAll('"', '""')}"` }),
    }) ?? ''
  );
}

/** Lädt `csv` als Datei herunter. */
export function downloadCsv(fileName: string, csv: string) {
  // BOM, damit Excel die Datei als UTF-8 liest (Umlaute). Trennzeichen Komma, Beträge mit Punkt (F7).
  const content = `\uFEFF${csv}`;
  const url = URL.createObjectURL(new Blob([content], { type: 'text/csv;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = fileName;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  // Später freigeben: Manche Browser brechen den Download sonst ab.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** Teil eines Dateinamens aus freiem Text (Kontoname): klein, ohne Akzente, alles andere wird zu `-`. */
export function fileNamePart(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
