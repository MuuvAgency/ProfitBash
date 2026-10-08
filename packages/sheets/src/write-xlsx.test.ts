import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { writeXlsx, type XlsxWriteCell } from './write-xlsx';
import { openXlsx } from './xlsx';

/** XLSX-Schreiber (`phase-3.md` 3.2b): schmal wie der Leser, Zahlen ohne Umweg über `number`. */

async function readBack(file: Uint8Array, sheet: string) {
  const workbook = await openXlsx(file);
  const rows: string[][] = [];
  const numeric: number[][] = [];
  await workbook.forEachRow(sheet, (row, _rowNumber, info) => {
    rows.push(row);
    numeric.push([...info.numericColumns].sort((a, b) => a - b));
  });
  return { sheets: workbook.sheets, rows, numeric };
}

describe('writeXlsx', () => {
  it('schreibt Blätter, die der eigene Leser unverändert wieder liest', async () => {
    const rows: XlsxWriteCell[][] = [
      ['Product', 'Campaign Id', 'Bid'],
      ['Sponsored Products', '9007199254740993123', { number: '0.10' }],
      ['Sponsored Products', null, { number: '1234567.89' }],
    ];

    const file = writeXlsx([
      { name: 'Sponsored Products Campaigns', rows },
      { name: 'Zweites Blatt', rows: [['a']] },
    ]);
    const first = await readBack(file, 'Sponsored Products Campaigns');

    expect(first.sheets).toEqual([
      { name: 'Sponsored Products Campaigns', state: 'visible' },
      { name: 'Zweites Blatt', state: 'visible' },
    ]);
    expect(first.rows).toEqual([
      ['Product', 'Campaign Id', 'Bid'],
      ['Sponsored Products', '9007199254740993123', '0.10'],
      ['Sponsored Products', '', '1234567.89'],
    ]);
    // IDs bleiben Text, Beträge sind Zahlzellen mit genau den Ziffern des Decimal-Strings.
    expect(first.numeric).toEqual([[], [2], [2]]);
    expect((await readBack(file, 'Zweites Blatt')).rows).toEqual([['a']]);
  });

  it('enthält die Teile, die Excel und die Werbekonsole für eine gültige Arbeitsmappe brauchen', () => {
    const parts = unzipSync(writeXlsx([{ name: 'Blatt', rows: [['x']] }]));

    expect(Object.keys(parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
    ]);
    expect(strFromU8(parts['[Content_Types].xml']!)).toContain('/xl/worksheets/sheet1.xml');
    expect(strFromU8(parts['_rels/.rels']!)).toContain('xl/workbook.xml');
    expect(strFromU8(parts['xl/worksheets/sheet1.xml']!)).toContain(
      '<c r="A1" t="inlineStr"><is><t xml:space="preserve">x</t></is></c>',
    );
  });

  it('maskiert XML-Zeichen, erhält Leerraum und Umlaute und entfernt Steuerzeichen', async () => {
    const text = ' <b>"R&D"</b> Küche\u0000\u0007 \u{1F600} ';

    const file = writeXlsx([{ name: 'A & B', rows: [[text, '=1+1']] }]);
    const { rows, numeric, sheets } = await readBack(file, 'A & B');

    expect(sheets[0]!.name).toBe('A & B');
    expect(rows).toEqual([[' <b>"R&D"</b> Küche \u{1F600} ', '=1+1']]);
    // Text bleibt Text: Eine Formel wird daraus nie.
    expect(numeric).toEqual([[]]);
  });

  it('lehnt Zahlen ab, die kein einfacher Decimal-String sind', () => {
    for (const number of ['1e3', '1,5', '', 'NaN', ' 1', '<v>']) {
      expect(() => writeXlsx([{ name: 'Blatt', rows: [[{ number }]] }]), number).toThrow(
        /keine einfache Dezimalzahl/,
      );
    }
    expect(() => writeXlsx([{ name: 'Blatt', rows: [[{ number: '-0.5' }]] }])).not.toThrow();
  });

  it('lehnt ungültige und doppelte Blattnamen und eine Mappe ohne Blatt ab', () => {
    expect(() => writeXlsx([])).toThrow(/mindestens ein Blatt/);
    for (const name of ['', 'x'.repeat(32), 'a/b', 'a[b]', "'x"]) {
      expect(() => writeXlsx([{ name, rows: [] }]), name).toThrow(/Blattname/);
    }
    expect(() =>
      writeXlsx([
        { name: 'Blatt', rows: [] },
        { name: 'blatt', rows: [] },
      ]),
    ).toThrow(/doppelt/);
  });

  it('schreibt Spalten jenseits von Z mit der richtigen Adresse', async () => {
    const row = Array.from({ length: 30 }, (_, i) => `c${i}`);

    const { rows } = await readBack(writeXlsx([{ name: 'Blatt', rows: [row] }]), 'Blatt');

    expect(rows).toEqual([row]);
  });
});
