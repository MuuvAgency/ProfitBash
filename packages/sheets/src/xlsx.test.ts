import { strToU8, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { buildXlsx } from './testing';
import { openXlsx, SheetReadError } from './xlsx';

function rowsOf(file: Uint8Array, sheet: string, options?: Parameters<typeof openXlsx>[1]) {
  const workbook = openXlsx(file, options);
  const rows: string[][] = [];
  workbook.forEachRow(sheet, (row) => rows.push(row));
  return rows;
}

describe('openXlsx', () => {
  it('nennt die Blätter in Reihenfolge mit Sichtbarkeit', () => {
    const file = buildXlsx([
      { name: 'Portfolios', rows: [] },
      { name: 'Config', rows: [], state: 'veryHidden' },
      { name: 'SP Bericht „Suchbegriff“', rows: [] },
    ]);
    expect(openXlsx(file).sheets).toEqual([
      { name: 'Portfolios', state: 'visible' },
      { name: 'Config', state: 'veryHidden' },
      { name: 'SP Bericht „Suchbegriff“', state: 'visible' },
    ]);
  });

  it('liest Texte aus inlineStr und sharedStrings, auch in Rich-Text-Läufen', () => {
    const file = buildXlsx([
      {
        name: 'Blatt',
        rows: [
          ['Kampagnen-ID', { shared: 'Zustand' }, { rich: ['Dynamische Gebote', ' – nur senken'] }],
          [' führend & <spitz> ', { shared: 'Aktiviert' }, { shared: 'Zustand' }],
        ],
      },
    ]);
    expect(rowsOf(file, 'Blatt')).toEqual([
      ['Kampagnen-ID', 'Zustand', 'Dynamische Gebote – nur senken'],
      [' führend & <spitz> ', 'Aktiviert', 'Zustand'],
    ]);
  });

  it('liefert Zahlen als Quelltext, ohne Umweg über number', () => {
    const file = buildXlsx([
      {
        name: 'Zahlen',
        rows: [
          [
            { raw: '123.45000000000002', type: 'n' },
            { raw: '0.1' },
            { raw: '1234567.89' },
            { raw: '9007199254740993' },
            { raw: '1E-3' },
          ],
        ],
      },
    ]);
    expect(rowsOf(file, 'Zahlen')).toEqual([
      ['123.45000000000002', '0.1', '1234567.89', '9007199254740993', '1E-3'],
    ]);
  });

  it('nennt je Zeile die Spalten mit Zahlzellen (IDs als Zahl verlören Stellen)', () => {
    const file = buildXlsx([
      {
        name: 'Typen',
        rows: [
          ['Text', 12, { raw: '1.5' }, { shared: '7' }, { raw: '1', type: 'b' }, null, 3],
          ['nur Text'],
        ],
      },
    ]);
    const numeric: number[][] = [];
    openXlsx(file).forEachRow('Typen', (_row, _rowNumber, info) => {
      numeric.push([...info.numericColumns].sort((a, b) => a - b));
    });
    expect(numeric).toEqual([[1, 2, 6], []]);
  });

  it('setzt Zellen nach ihrer Adresse und füllt Lücken mit leeren Texten', () => {
    const file = buildXlsx([{ name: 'Lücken', rows: [['A', null, null, 'D'], [null, 'B'], []] }]);
    expect(rowsOf(file, 'Lücken')).toEqual([['A', '', '', 'D'], ['', 'B'], []]);
  });

  it('kommt ohne Zelladressen aus (Position aus der Reihenfolge)', () => {
    const file = buildXlsx([{ name: 'Ohne', rows: [['a', 'b', 'c']] }], { withoutCellRefs: true });
    expect(rowsOf(file, 'Ohne')).toEqual([['a', 'b', 'c']]);
  });

  it('liefert fehlende Zeilen als leere Zeilen, damit Zeilennummern stimmen', () => {
    const file = zipSync({
      'xl/workbook.xml': strToU8(
        '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8(
        '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
      ),
      'xl/worksheets/sheet1.xml': strToU8(
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>x</t></is></c></row><row r="3"><c r="B3" t="inlineStr"><is><t>y</t></is></c></row></sheetData></worksheet>',
      ),
    });
    const numbers: number[] = [];
    const rows: string[][] = [];
    openXlsx(file).forEachRow('S', (row, rowNumber) => {
      rows.push(row);
      numbers.push(rowNumber);
    });
    expect(rows).toEqual([['x'], [], ['', 'y']]);
    expect(numbers).toEqual([1, 2, 3]);
  });

  it('liest Wahrheitswerte, Formel-Texte und Fehler als Text', () => {
    const file = buildXlsx([
      {
        name: 'Typen',
        rows: [
          [
            { raw: '1', type: 'b' },
            { raw: 'Summe', type: 'str' },
            { raw: '#DIV/0!', type: 'e' },
          ],
        ],
      },
    ]);
    expect(rowsOf(file, 'Typen')).toEqual([['1', 'Summe', '#DIV/0!']]);
  });

  it('findet Blätter auch bei absoluten Zielen in den Beziehungen', () => {
    const file = buildXlsx([{ name: 'A', rows: [['x']] }], { absoluteTargets: true });
    expect(rowsOf(file, 'A')).toEqual([['x']]);
  });

  it('meldet unbekannte Blätter, fehlende Teile und kaputte Dateien als SheetReadError', () => {
    const file = buildXlsx([{ name: 'A', rows: [] }]);
    expect(() => openXlsx(file).forEachRow('B', () => {})).toThrow(
      expect.objectContaining({ code: 'SHEET_NOT_FOUND' }),
    );
    expect(() => openXlsx(strToU8('keine zip-datei'))).toThrow(SheetReadError);
    expect(() => openXlsx(zipSync({ 'a.txt': strToU8('x') }))).toThrow(
      expect.objectContaining({ code: 'NOT_XLSX' }),
    );
    const brokenXml = zipSync({
      'xl/workbook.xml': strToU8('<workbook><sheets><sheet name="A" r:id="rId1"'),
    });
    expect(() => openXlsx(brokenXml)).toThrow(expect.objectContaining({ code: 'INVALID_XML' }));
  });

  it('bricht ab, wenn entpackt mehr als erlaubt herauskäme (Schutz vor Zip-Bomben)', () => {
    const big = 'x'.repeat(200_000);
    const file = buildXlsx([{ name: 'Groß', rows: [[big], [big], [big]] }]);
    expect(() => rowsOf(file, 'Groß', { maxUncompressedBytes: 300_000 })).toThrow(
      expect.objectContaining({ code: 'TOO_LARGE' }),
    );
    expect(rowsOf(file, 'Groß', { maxUncompressedBytes: 2_000_000 })).toHaveLength(3);
  });

  it('lässt keine eigenen Entities im XML zu (keine Entity-Expansion)', () => {
    const file = zipSync({
      'xl/workbook.xml': strToU8(
        '<!DOCTYPE w [<!ENTITY a "aaaaaaaaaa">]><workbook><sheets><sheet name="&a;" r:id="rId1"/></sheets></workbook>',
      ),
      'xl/_rels/workbook.xml.rels': strToU8('<Relationships/>'),
    });
    expect(() => openXlsx(file)).toThrow(SheetReadError);
  });

  it('bricht das Lesen ab, wenn der Rückruf wirft, ohne weitere Zeilen zu liefern', () => {
    const file = buildXlsx([{ name: 'A', rows: [['1'], ['2'], ['3']] }]);
    const seen: string[] = [];
    expect(() =>
      openXlsx(file).forEachRow('A', (row) => {
        seen.push(row[0]!);
        if (row[0] === '2') throw new Error('Abbruch');
      }),
    ).toThrow('Abbruch');
    expect(seen).toEqual(['1', '2']);
  });

  describe('Grenzen und Unstimmigkeiten (Review 1.11b)', () => {
    const sheetFile = (sheetXml: string) =>
      zipSync({
        'xl/workbook.xml': strToU8(
          '<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="S" sheetId="1" r:id="rId1"/></sheets></workbook>',
        ),
        'xl/_rels/workbook.xml.rels': strToU8(
          '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
        ),
        'xl/worksheets/sheet1.xml': strToU8(
          `<worksheet><sheetData>${sheetXml}</sheetData></worksheet>`,
        ),
      });
    const read = (sheetXml: string, options?: Parameters<typeof openXlsx>[1]) =>
      rowsOf(sheetFile(sheetXml), 'S', options);

    it('lehnt Zeilennummern jenseits von Excel ab, ohne Millionen leerer Zeilen zu liefern', () => {
      let calls = 0;
      expect(() =>
        openXlsx(sheetFile('<row r="30000000"><c r="A30000000"><v>1</v></c></row>')).forEachRow(
          'S',
          () => calls++,
        ),
      ).toThrow(expect.objectContaining({ code: 'INVALID_XML' }));
      expect(calls).toBe(0);
    });

    it('lehnt Spalten jenseits von XFD ab', () => {
      expect(() => read('<row r="1"><c r="ZZZZZZ1"><v>1</v></c></row>')).toThrow(
        expect.objectContaining({ code: 'INVALID_XML' }),
      );
      expect(read('<row r="1"><c r="XFD1"><v>1</v></c></row>')[0]).toHaveLength(16384);
    });

    it('begrenzt die Zahl der Zellen samt aufgefüllter Lücken', () => {
      const rows = Array.from(
        { length: 20 },
        (_, i) => `<row r="${i + 1}"><c r="XFD${i + 1}"><v>1</v></c></row>`,
      ).join('');
      expect(() => read(rows, { maxCells: 100_000 })).toThrow(
        expect.objectContaining({ code: 'TOO_LARGE' }),
      );
    });

    it('lehnt doppelte oder rückwärts laufende Zeilennummern ab', () => {
      expect(() =>
        read('<row r="2"><c r="A2"><v>b</v></c></row><row r="1"><c r="A1"><v>a</v></c></row>'),
      ).toThrow(expect.objectContaining({ code: 'INVALID_XML' }));
      expect(() =>
        read('<row r="1"><c r="A1"><v>a</v></c></row><row r="1"><c r="A1"><v>b</v></c></row>'),
      ).toThrow(expect.objectContaining({ code: 'INVALID_XML' }));
    });

    it('lehnt Verweise auf fehlende gemeinsame Texte ab, statt sie leer zu liefern', () => {
      expect(() => read('<row r="1"><c r="A1" t="s"><v>99</v></c></row>')).toThrow(
        expect.objectContaining({ code: 'INVALID_XML' }),
      );
      expect(() => read('<row r="1"><c r="A1" t="s"><v>abc</v></c></row>')).toThrow(
        expect.objectContaining({ code: 'INVALID_XML' }),
      );
    });

    it('liest unkomprimierte Teile, auch mit Umlauten über Stückgrenzen hinweg', () => {
      const text = 'ä'.repeat(70_000);
      const file = buildXlsx([{ name: 'A', rows: [[text], ['Ende']] }], { stored: true });
      expect(rowsOf(file, 'A')).toEqual([[text], ['Ende']]);
    });

    it('nennt im Fehler nur Teil und Position, keinen Inhalt', () => {
      try {
        read('<row r="1"><c r="A1" t="inlineStr"><is><t>Geheimer Kampagnenname</is></c></row>');
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SheetReadError);
        const message = (error as Error).message;
        expect(message).toContain('xl/worksheets/sheet1.xml');
        expect(message).not.toContain('Geheim');
        expect(message).toMatch(/Zeile \d+, Spalte \d+/);
      }
    });
  });
});
