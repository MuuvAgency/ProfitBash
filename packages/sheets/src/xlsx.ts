import { Inflate } from 'fflate';
import { SaxesParser, type SaxesTagPlain } from 'saxes';
import { SheetReadError } from './errors';

export { SheetReadError } from './errors';

/**
 * Schmaler XLSX-Leser (`phase-1.md` 1.11b) für Dateien aus der Amazon-Werbekonsole: Blätter Zeile für Zeile,
 * Zellen als Text. Zahlen bleiben Quelltext (keine Umwandlung über `number`), Datumszellen werden nicht
 * gedeutet (Amazon schreibt Tage als Text). Die Datei liegt ganz im Speicher (Upload); entpackt wird
 * stückweise, damit auch große Blätter nicht als Ganzes im Speicher landen.
 */

export interface SheetInfo {
  name: string;
  state: 'visible' | 'hidden' | 'veryHidden';
}

export interface XlsxOptions {
  /**
   * Höchstens so viele Bytes entpackt, über alle gelesenen Teile der Datei, auch wenn ein Blatt mehrfach
   * gelesen wird (Schutz vor Zip-Bomben).
   */
  maxUncompressedBytes?: number;
  /** Höchstens so viele Zellen je gelesenem Blatt, aufgefüllte Lücken und leere Zeilen mitgezählt. */
  maxCells?: number;
}

/** Zusatzangaben je Zeile. */
export interface RowInfo {
  /**
   * Spalten mit Zahlzellen (Typ `n` bzw. ohne Typ). Excel hält Zahlen als Gleitkommazahl: Kommt eine ID als
   * Zahl, können Stellen jenseits der 15. schon verloren sein. Aufrufer erkennen solche Zellen hier.
   */
  numericColumns: ReadonlySet<number>;
}

export type RowCallback = (row: string[], rowNumber: number, info: RowInfo) => void;

const NO_NUMERIC_COLUMNS: ReadonlySet<number> = new Set();
const EMPTY_ROW_INFO: RowInfo = { numericColumns: NO_NUMERIC_COLUMNS };

export interface XlsxWorkbook {
  sheets: SheetInfo[];
  /**
   * Ruft `callback` je Zeile auf, synchron und in Reihenfolge; fehlende Zeilen kommen als `[]`. Scheitert
   * das Lesen mittendrin, sind die Zeilen davor schon geliefert: Aufrufer schreiben erst nach dem Ende.
   */
  forEachRow(sheetName: string, callback: RowCallback): void;
}

export const DEFAULT_MAX_UNCOMPRESSED_BYTES = 500 * 1024 * 1024;
/** Große Bulk-Dateien haben rund 200 000 Zeilen × 75 Spalten. */
export const DEFAULT_MAX_CELLS = 30_000_000;
/** Grenzen von Excel: 1 048 576 Zeilen, Spalten bis XFD. */
export const MAX_ROWS = 1_048_576;
export const MAX_COLUMNS = 16_384;
/**
 * Eingabe je Schritt beim Entpacken. fflate liefert alles, was ein Schritt ergibt, als ein Stück; Deflate
 * packt höchstens rund 1:1032, ein Stück bleibt so unter etwa 8 MB, bevor das Budget greift.
 */
const CHUNK_BYTES = 8 * 1024;

// --- ZIP ------------------------------------------------------------------------------------------
// Eigenes Zentralverzeichnis statt Streaming über die lokalen Kopfzeilen: Dort stehen verlässliche Größen,
// auch bei Data Descriptors (Bit 3). Zip64 (über 4 GB bzw. 65 535 Einträge) wird nicht gelesen und scheitert
// als beschädigt; Excel-Dateien der Werbekonsole erreichen das nicht.

interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  compressedSize: number;
  localHeaderOffset: number;
}

function readZipDirectory(file: Uint8Array): Map<string, ZipEntry> {
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const minEnd = Math.max(0, file.length - 65_557);
  let end = -1;
  for (let i = file.length - 22; i >= minEnd; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new SheetReadError('NOT_XLSX', 'Die Datei ist kein Excel-Paket (XLSX).');
  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const entries = new Map<string, ZipEntry>();
  for (let i = 0; i < count; i++) {
    if (offset + 46 > file.length || view.getUint32(offset, true) !== 0x02014b50) {
      throw new SheetReadError('NOT_XLSX', 'Das Verzeichnis des Excel-Pakets ist beschädigt.');
    }
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const name = decoder.decode(file.subarray(offset + 46, offset + 46 + nameLength));
    entries.set(name, {
      name,
      flags: view.getUint16(offset + 8, true),
      method: view.getUint16(offset + 10, true),
      compressedSize: view.getUint32(offset + 20, true),
      localHeaderOffset: view.getUint32(offset + 42, true),
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

class Budget {
  private used = 0;
  constructor(private readonly max: number) {}
  take(bytes: number) {
    this.used += bytes;
    if (this.used > this.max) {
      throw new SheetReadError('TOO_LARGE', 'Die Datei ist entpackt zu groß.');
    }
  }
}

/** Entpackt einen Eintrag stückweise und reicht den Text an `onText` weiter (UTF-8, streng). */
function streamEntry(
  file: Uint8Array,
  entry: ZipEntry,
  budget: Budget,
  onText: (text: string) => void,
) {
  if (entry.flags & 0x1)
    throw new SheetReadError('NOT_XLSX', 'Verschlüsselte Dateien werden nicht gelesen.');
  const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
  const header = entry.localHeaderOffset;
  if (header + 30 > file.length || view.getUint32(header, true) !== 0x04034b50) {
    throw new SheetReadError('NOT_XLSX', 'Ein Teil des Excel-Pakets ist beschädigt.');
  }
  const start = header + 30 + view.getUint16(header + 26, true) + view.getUint16(header + 28, true);
  const data = file.subarray(start, start + entry.compressedSize);
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const emit = (chunk: Uint8Array, final: boolean) => {
    budget.take(chunk.length);
    let text: string;
    try {
      text = decoder.decode(chunk, { stream: !final });
    } catch {
      throw new SheetReadError('INVALID_XML', 'Ein Teil der Datei ist kein gültiges UTF-8.');
    }
    if (text) onText(text);
  };
  if (entry.method === 0) {
    for (let i = 0; i < data.length; i += CHUNK_BYTES) {
      emit(data.subarray(i, i + CHUNK_BYTES), i + CHUNK_BYTES >= data.length);
    }
    if (data.length === 0) emit(new Uint8Array(0), true);
    return;
  }
  if (entry.method !== 8) {
    throw new SheetReadError('NOT_XLSX', 'Unbekannte Kompression im Excel-Paket.');
  }
  let pending: Error | null = null;
  const inflate = new Inflate((chunk, final) => {
    if (pending) return;
    try {
      emit(chunk, final);
    } catch (error) {
      pending = error as Error;
    }
  });
  try {
    for (let i = 0; i < data.length && !pending; i += CHUNK_BYTES) {
      inflate.push(data.subarray(i, i + CHUNK_BYTES), i + CHUNK_BYTES >= data.length);
    }
  } catch (error) {
    if (error instanceof SheetReadError || pending) throw pending ?? error;
    throw new SheetReadError('NOT_XLSX', 'Ein Teil des Excel-Pakets lässt sich nicht entpacken.');
  }
  if (pending) throw pending;
}

// --- XML ------------------------------------------------------------------------------------------

const localName = (name: string) => name.slice(name.indexOf(':') + 1);

interface XmlHandlers {
  open?(name: string, attributes: Record<string, string>): void;
  close?(name: string): void;
  text?(text: string): void;
}

type Fail = (reason: string) => never;

/**
 * Fehler mit Teil und Position, ohne Text aus der Datei (Kundendaten) und ohne die englische Meldung von
 * saxes.
 */
function parseXml(
  file: Uint8Array,
  entry: ZipEntry,
  budget: Budget,
  handlers: XmlHandlers | ((fail: Fail) => XmlHandlers),
): void {
  const parser = new SaxesParser({ xmlns: false });
  const fail: Fail = (reason) => {
    throw new SheetReadError(
      'INVALID_XML',
      `${reason} in ${entry.name} (Zeile ${parser.line}, Spalte ${parser.column}).`,
    );
  };
  parser.on('error', () => fail('Ungültiges XML'));
  if (typeof handlers === 'function') handlers = handlers(fail);
  if (handlers.open) {
    const open = handlers.open;
    parser.on('opentag', (tag: SaxesTagPlain) => open(localName(tag.name), tag.attributes));
  }
  if (handlers.close) {
    const close = handlers.close;
    parser.on('closetag', (tag) => close(localName(tag.name)));
  }
  if (handlers.text) {
    const text = handlers.text;
    parser.on('text', text);
    parser.on('cdata', text);
  }
  streamEntry(file, entry, budget, (chunk) => parser.write(chunk));
  parser.close();
}

function attribute(attributes: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(attributes)) {
    if (localName(key) === name) return value;
  }
  return undefined;
}

/** Text von `<si>` bzw. `<is>`: alle `<t>`, ohne phonetische Hilfen (`<rPh>`). */
function richTextCollector() {
  let depthPhonetic = 0;
  let inText = false;
  let value = '';
  return {
    open(name: string) {
      if (name === 'rPh') depthPhonetic++;
      else if (name === 't' && depthPhonetic === 0) inText = true;
    },
    close(name: string) {
      if (name === 'rPh') depthPhonetic--;
      else if (name === 't') inText = false;
    },
    text(text: string) {
      if (inText) value += text;
    },
    take() {
      const result = value;
      value = '';
      return result;
    },
  };
}

/** Spalte aus einer Zelladresse (`AA12` → 26); `null` ohne Buchstaben, `Infinity` jenseits von XFD. */
function columnIndex(ref: string): number | null {
  const match = /^([A-Z]+)\d*$/i.exec(ref);
  if (!match) return null;
  const letters = match[1]!.toUpperCase();
  if (letters.length > 3) return Infinity;
  let index = 0;
  for (const char of letters) index = index * 26 + (char.charCodeAt(0) - 64);
  return index - 1;
}

function resolveTarget(target: string): string {
  const path = target.startsWith('/') ? target.slice(1) : `xl/${target}`;
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  return parts.join('/');
}

// --- Workbook -------------------------------------------------------------------------------------

export function openXlsx(file: Uint8Array, options: XlsxOptions = {}): XlsxWorkbook {
  const budget = new Budget(options.maxUncompressedBytes ?? DEFAULT_MAX_UNCOMPRESSED_BYTES);
  const entries = readZipDirectory(file);
  const workbookEntry = entries.get('xl/workbook.xml');
  if (!workbookEntry)
    throw new SheetReadError('NOT_XLSX', 'Die Datei ist kein Excel-Paket (XLSX).');

  const declared: Array<SheetInfo & { relationId: string | undefined }> = [];
  parseXml(file, workbookEntry, budget, {
    open(name, attributes) {
      if (name !== 'sheet') return;
      const state = attributes.state;
      declared.push({
        name: attributes.name ?? '',
        state: state === 'hidden' || state === 'veryHidden' ? state : 'visible',
        relationId: attribute(attributes, 'id'),
      });
    },
  });

  const targets = new Map<string, string>();
  const relsEntry = entries.get('xl/_rels/workbook.xml.rels');
  if (relsEntry) {
    parseXml(file, relsEntry, budget, {
      open(name, attributes) {
        if (name === 'Relationship' && attributes.Id && attributes.Target) {
          targets.set(attributes.Id, resolveTarget(attributes.Target));
        }
      },
    });
  }

  let sharedStrings: string[] | undefined;
  const loadSharedStrings = (): string[] => {
    if (sharedStrings) return sharedStrings;
    const strings: string[] = [];
    const entry = entries.get('xl/sharedStrings.xml');
    if (entry) {
      const collector = richTextCollector();
      parseXml(file, entry, budget, {
        open: (name) => collector.open(name),
        close(name) {
          if (name === 'si') strings.push(collector.take());
          else collector.close(name);
        },
        text: (text) => collector.text(text),
      });
    }
    sharedStrings = strings;
    return strings;
  };

  return {
    sheets: declared.map(({ name, state }) => ({ name, state })),
    forEachRow(sheetName, callback) {
      const sheet = declared.find((s) => s.name === sheetName);
      const path = sheet?.relationId ? targets.get(sheet.relationId) : undefined;
      const entry = path ? entries.get(path) : undefined;
      if (!sheet || !entry) {
        throw new SheetReadError('SHEET_NOT_FOUND', `Blatt „${sheetName}“ fehlt in der Datei.`);
      }
      const strings = loadSharedStrings();
      const inline = richTextCollector();
      const maxCells = options.maxCells ?? DEFAULT_MAX_CELLS;
      let cells = 0;
      const countCells = (count: number) => {
        cells += count;
        if (cells > maxCells) {
          throw new SheetReadError('TOO_LARGE', `Blatt „${sheetName}“ hat zu viele Zellen.`);
        }
      };

      let row: string[] = [];
      let numericColumns: Set<number> | null = null;
      let rowNumber = 0;
      let emitted = 0;
      let column = -1;
      let cellType: string | undefined;
      let inValue = false;
      let value = '';
      let inInline = false;

      parseXml(file, entry, budget, (fail) => ({
        open(name, attributes) {
          if (name === 'row') {
            if (attributes.r === undefined) {
              rowNumber = emitted + 1;
            } else {
              const declaredNumber = Number(attributes.r);
              if (!Number.isSafeInteger(declaredNumber) || declaredNumber < 1) {
                fail('Ungültige Zeilennummer');
              }
              if (declaredNumber > MAX_ROWS) fail('Zeilennummer jenseits der Grenze von Excel');
              if (declaredNumber <= emitted) fail('Zeilen doppelt oder nicht aufsteigend');
              rowNumber = declaredNumber;
            }
            if (rowNumber > MAX_ROWS) fail('Zu viele Zeilen');
            row = [];
            numericColumns = null;
            column = -1;
          } else if (name === 'c') {
            const index = attributes.r ? columnIndex(attributes.r) : null;
            column = index ?? column + 1;
            if (column >= MAX_COLUMNS) fail('Spalte jenseits der Grenze von Excel');
            cellType = attributes.t;
            value = '';
          } else if (name === 'v') {
            inValue = true;
          } else if (name === 'is') {
            inInline = true;
          } else if (inInline) {
            inline.open(name);
          }
        },
        close(name) {
          if (name === 'v') {
            inValue = false;
          } else if (name === 'is') {
            inInline = false;
            value = inline.take();
          } else if (inInline) {
            inline.close(name);
          } else if (name === 'c') {
            let text = value;
            if (cellType === 's') {
              const index = Number(value);
              const shared = Number.isSafeInteger(index) ? strings[index] : undefined;
              if (shared === undefined) return fail('Verweis auf einen fehlenden gemeinsamen Text');
              text = shared;
            }
            if (column < row.length) fail('Zelle doppelt oder nicht aufsteigend');
            countCells(column + 1 - row.length);
            while (row.length < column) row.push('');
            row[column] = text;
            if (cellType === undefined || cellType === 'n') {
              (numericColumns ??= new Set()).add(column);
            }
          } else if (name === 'row') {
            countCells(Math.max(0, rowNumber - 1 - emitted));
            while (emitted < rowNumber - 1) {
              emitted++;
              callback([], emitted, EMPTY_ROW_INFO);
            }
            emitted = rowNumber;
            callback(
              row,
              rowNumber,
              numericColumns ? { numericColumns } : EMPTY_ROW_INFO,
            );
          }
        },
        text(text) {
          if (inInline) inline.text(text);
          else if (inValue) value += text;
        },
      }));
    },
  };
}
