import { SheetReadError } from './errors';

/**
 * CSV nach RFC 4180 (`phase-1.md` 1.11b), für Berichte aus der Werbekonsole: Felder als Text, Trennzeichen
 * `,`, `;` oder Tabulator (erkannt an der Kopfzeile außerhalb von Anführungszeichen), BOM und CRLF.
 */

export interface CsvOptions {
  /** Höchstens so viele Bytes bzw. Zeichen. */
  maxBytes?: number;
}

export type CsvDelimiter = ',' | ';' | '\t';

/** Als Text im Speicher (UTF-16 doppelt so groß); echte Berichte sind deutlich kleiner. */
export const DEFAULT_MAX_CSV_BYTES = 200 * 1024 * 1024;

function decode(input: string | Uint8Array): string {
  if (typeof input === 'string') return input;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new SheetReadError('INVALID_CSV', 'Die Datei ist kein gültiges UTF-8.');
  }
}

function detectDelimiter(text: string): CsvDelimiter {
  const counts: Record<CsvDelimiter, number> = { ',': 0, ';': 0, '\t': 0 };
  let quoted = false;
  for (const char of text) {
    if (char === '"') quoted = !quoted;
    else if (!quoted && (char === '\n' || char === '\r')) break;
    else if (!quoted && char in counts) counts[char as CsvDelimiter]++;
  }
  const [best] = (Object.entries(counts) as [CsvDelimiter, number][]).sort((a, b) => b[1] - a[1]);
  return best && best[1] > 0 ? best[0] : ',';
}

export function forEachCsvRow(
  input: string | Uint8Array,
  callback: (row: string[], rowNumber: number) => void,
  options: CsvOptions = {},
): { delimiter: CsvDelimiter } {
  const size = typeof input === 'string' ? input.length : input.byteLength;
  if (size > (options.maxBytes ?? DEFAULT_MAX_CSV_BYTES)) {
    throw new SheetReadError('TOO_LARGE', 'Die Datei ist zu groß.');
  }
  let text = decode(input);
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const delimiter = detectDelimiter(text);

  let row: string[] = [];
  let field = '';
  let rowNumber = 0;
  let i = 0;
  const endRow = () => {
    row.push(field);
    field = '';
    // Leere Zeilen tragen keine Daten, zählen aber mit (Zeilennummern wie in Excel).
    rowNumber++;
    if (!(row.length === 1 && row[0] === '')) callback(row, rowNumber);
    row = [];
  };

  while (i < text.length) {
    const char = text[i]!;
    if (char === '"' && field === '') {
      // Feld in Anführungszeichen: bis zum schließenden Quote, `""` steht für ein Quote.
      let end = i + 1;
      let value = '';
      for (;;) {
        const next = text.indexOf('"', end);
        if (next < 0)
          throw new SheetReadError('INVALID_CSV', 'Ein Anführungszeichen ist nicht geschlossen.');
        value += text.slice(end, next);
        if (text[next + 1] === '"') {
          value += '"';
          end = next + 2;
        } else {
          end = next + 1;
          break;
        }
      }
      field = value;
      i = end;
      const after = text[i];
      if (after !== undefined && after !== delimiter && after !== '\r' && after !== '\n') {
        throw new SheetReadError(
          'INVALID_CSV',
          `Zeile ${rowNumber + 1}: Text nach einem schließenden Anführungszeichen.`,
        );
      }
    } else if (char === delimiter) {
      row.push(field);
      field = '';
      i++;
    } else if (char === '\r' || char === '\n') {
      endRow();
      i += char === '\r' && text[i + 1] === '\n' ? 2 : 1;
    } else {
      field += char;
      i++;
    }
  }
  if (field !== '' || row.length > 0) endRow();
  return { delimiter };
}
