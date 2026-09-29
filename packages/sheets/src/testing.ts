import { strToU8, zipSync, type Zippable } from 'fflate';

/**
 * Erzeugt synthetische XLSX-Dateien für Tests (nur Tests; echte Dateien aus der Werbekonsole kommen nie
 * ins Repo). Deckt ab, was Amazon-Dateien nutzen: Texte als `inlineStr` oder über `sharedStrings`, Zahlen
 * als `n`, lückenhafte Zeilen mit `r`-Adressen, versteckte Blätter.
 */

export type TestCell =
  string | number | null | { shared: string } | { raw: string; type?: string } | { rich: string[] };

export interface TestSheet {
  name: string;
  rows: TestCell[][];
  state?: 'visible' | 'hidden' | 'veryHidden';
}

export interface BuildXlsxOptions {
  /** Pfad der Blätter im Paket; Amazon nutzt relative Ziele (`worksheets/sheetN.xml`). */
  absoluteTargets?: boolean;
  /** Zellen ohne `r`-Attribut schreiben (Position aus der Reihenfolge). */
  withoutCellRefs?: boolean;
  /** Zusätzliche Dateien im Paket (z. B. für Größentests). */
  extraFiles?: Record<string, Uint8Array>;
}

const escape = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rest = (n - 1) % 26;
    name = String.fromCharCode(65 + rest) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

export function buildXlsx(sheets: TestSheet[], options: BuildXlsxOptions = {}): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = (text: string) => {
    const found = shared.indexOf(text);
    if (found >= 0) return found;
    shared.push(text);
    return shared.length - 1;
  };

  const sheetXml = (sheet: TestSheet) => {
    const rows = sheet.rows
      .map((cells, rowIndex) => {
        const rowNumber = rowIndex + 1;
        const xml = cells
          .map((cell, columnIndex) => {
            if (cell === null) return '';
            const ref = options.withoutCellRefs
              ? ''
              : ` r="${columnName(columnIndex)}${rowNumber}"`;
            if (typeof cell === 'number') return `<c${ref} t="n"><v>${cell}</v></c>`;
            if (typeof cell === 'string') {
              return `<c${ref} t="inlineStr"><is><t xml:space="preserve">${escape(cell)}</t></is></c>`;
            }
            if ('shared' in cell) return `<c${ref} t="s"><v>${sharedIndex(cell.shared)}</v></c>`;
            if ('rich' in cell) {
              const runs = cell.rich.map((text) => `<r><t>${escape(text)}</t></r>`).join('');
              return `<c${ref} t="inlineStr"><is>${runs}<rPh><t>ignoriert</t></rPh></is></c>`;
            }
            const type = cell.type ? ` t="${cell.type}"` : '';
            return `<c${ref}${type}><v>${escape(cell.raw)}</v></c>`;
          })
          .join('');
        return `<row r="${rowNumber}">${xml}</row>`;
      })
      .join('');
    return `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  };

  const files: Zippable = {};
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet));
  });
  const sheetEntries = sheets
    .map((sheet, index) => {
      const state = sheet.state && sheet.state !== 'visible' ? ` state="${sheet.state}"` : '';
      return `<sheet name="${escape(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 10}"${state}/>`;
    })
    .join('');
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheetEntries}</sheets></workbook>`,
  );
  const rels = sheets
    .map((_, index) => {
      const target = options.absoluteTargets
        ? `/xl/worksheets/sheet${index + 1}.xml`
        : `worksheets/sheet${index + 1}.xml`;
      return `<Relationship Id="rId${index + 10}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="${target}"/>`;
    })
    .join('');
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels}</Relationships>`,
  );
  // sharedStrings erst nach den Blättern anlegen: Der Leser darf sich nicht auf die Reihenfolge verlassen.
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
      .map((text) => `<si><t xml:space="preserve">${escape(text)}</t></si>`)
      .join('')}</sst>`,
  );
  Object.assign(files, options.extraFiles ?? {});
  return zipSync(files);
}
