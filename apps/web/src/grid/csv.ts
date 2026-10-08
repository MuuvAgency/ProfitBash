import { MISSING_VALUE } from '@profitbash/shared';
import type { GridApi, ProcessCellForExportParams } from 'ag-grid-community';
import { csvSafe } from '../explorer/columns';

/**
 * CSV-Export der Grids (Explorer F6/F7, Suchbegriff-Analyse 2b.2e): eine Schreibweise für alle Tabellen. Trennzeichen
 * Komma, Beträge und Zähler als Decimal-String mit Punkt (Spalten mit `useValueFormatterForExport: false`), dazu die
 * Spalte `currency` (auch ausgeblendet).
 */

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
 * (sie gilt für alle Zeilen der Auswahl, nicht für die exportierten). `prependContent` steht vor der Kopfzeile.
 */
export function gridCsv<Row>(gridApi: GridApi<Row>, prependContent?: string): string {
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
      ...(prependContent && { prependContent }),
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
