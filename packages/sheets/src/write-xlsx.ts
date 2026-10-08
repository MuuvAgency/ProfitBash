import { strToU8, zipSync, type Zippable } from 'fflate';

/**
 * Schmaler XLSX-Schreiber (`docs/tasks/phase-3.md` 3.2b) für Dateien, die in der Amazon-Werbekonsole hochgeladen
 * werden. Texte stehen als `inlineStr` in der Zelle (wie in den Dateien der Konsole, nie als Formel deutbar), Zahlen
 * als Zahlzelle mit genau den Ziffern des Decimal-Strings, ohne Umweg über `number`. Keine Formate, keine Formeln.
 */

/** Text, `null` (leere Zelle) oder Zahl als Decimal-String (`{ number: '0.75' }`). */
export type XlsxWriteCell = string | null | { number: string };

export interface XlsxWriteSheet {
  /** 1 bis 31 Zeichen, ohne `[ ] : * ? / \` und ohne Apostroph am Rand. */
  name: string;
  rows: readonly (readonly XlsxWriteCell[])[];
}

const DECIMAL = /^-?(0|[1-9]\d*)(\.\d+)?$/;
const INVALID_SHEET_NAME = /[[\]:*?/\\]|^'|'$/;
const MAX_SHEET_NAME_LENGTH = 31;

/**
 * In XML 1.0 unzulässige Zeichen (Steuerzeichen außer Tab und Zeilenumbruch, einzelne Surrogate, U+FFFE/U+FFFF).
 * Auch der Wagenrücklauf fällt weg: Ein XML-Parser machte daraus ohnehin einen Zeilenumbruch.
 */
const INVALID_XML_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000b-\u001f\ufffe\uffff]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;

function escapeXml(value: string): string {
  return value
    .replace(INVALID_XML_CHARS, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

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

function cellXml(cell: XlsxWriteCell, ref: string): string {
  if (cell === null) return '';
  if (typeof cell === 'string') {
    return `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${escapeXml(cell)}</t></is></c>`;
  }
  if (!DECIMAL.test(cell.number)) {
    throw new TypeError(`writeXlsx: Zelle ${ref} ist keine einfache Dezimalzahl.`);
  }
  return `<c r="${ref}"><v>${cell.number}</v></c>`;
}

function sheetXml(sheet: XlsxWriteSheet): string {
  const rows = sheet.rows
    .map((cells, rowIndex) => {
      const rowNumber = rowIndex + 1;
      const xml = cells
        .map((cell, columnIndex) => cellXml(cell, `${columnName(columnIndex)}${rowNumber}`))
        .join('');
      return `<row r="${rowNumber}">${xml}</row>`;
    })
    .join('');
  return `${XML_HEADER}<worksheet xmlns="${NS_MAIN}"><sheetData>${rows}</sheetData></worksheet>`;
}

const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const NS_MAIN = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_PACKAGE_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const TYPE_WORKBOOK = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml';
const TYPE_SHEET = 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml';

/** Arbeitsmappe als Bytes einer `.xlsx`-Datei. Wirft `TypeError` bei ungültigen Blattnamen oder Zahlen. */
export function writeXlsx(sheets: readonly XlsxWriteSheet[]): Uint8Array {
  if (sheets.length === 0)
    throw new TypeError('writeXlsx: Eine Arbeitsmappe braucht mindestens ein Blatt.');
  const names = new Set<string>();
  for (const { name } of sheets) {
    if (
      name === '' ||
      name.length > MAX_SHEET_NAME_LENGTH ||
      INVALID_SHEET_NAME.test(name) ||
      name.replace(INVALID_XML_CHARS, '') !== name
    ) {
      throw new TypeError('writeXlsx: ungültiger Blattname.');
    }
    // Excel unterscheidet Blattnamen nicht nach Groß- und Kleinschreibung.
    const key = name.toLowerCase();
    if (names.has(key)) throw new TypeError('writeXlsx: Blattname doppelt.');
    names.add(key);
  }

  const files: Zippable = {};
  files['[Content_Types].xml'] = strToU8(
    `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
      '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
      '<Default Extension="xml" ContentType="application/xml"/>' +
      `<Override PartName="/xl/workbook.xml" ContentType="${TYPE_WORKBOOK}"/>` +
      sheets
        .map(
          (_, index) =>
            `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="${TYPE_SHEET}"/>`,
        )
        .join('') +
      '</Types>',
  );
  files['_rels/.rels'] = strToU8(
    `${XML_HEADER}<Relationships xmlns="${NS_PACKAGE_REL}">` +
      `<Relationship Id="rId1" Type="${NS_REL}/officeDocument" Target="xl/workbook.xml"/>` +
      '</Relationships>',
  );
  files['xl/workbook.xml'] = strToU8(
    `${XML_HEADER}<workbook xmlns="${NS_MAIN}" xmlns:r="${NS_REL}"><sheets>` +
      sheets
        .map(
          (sheet, index) =>
            `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`,
        )
        .join('') +
      '</sheets></workbook>',
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `${XML_HEADER}<Relationships xmlns="${NS_PACKAGE_REL}">` +
      sheets
        .map(
          (_, index) =>
            `<Relationship Id="rId${index + 1}" Type="${NS_REL}/worksheet" Target="worksheets/sheet${index + 1}.xml"/>`,
        )
        .join('') +
      '</Relationships>',
  );
  sheets.forEach((sheet, index) => {
    files[`xl/worksheets/sheet${index + 1}.xml`] = strToU8(sheetXml(sheet));
  });
  return zipSync(files);
}
