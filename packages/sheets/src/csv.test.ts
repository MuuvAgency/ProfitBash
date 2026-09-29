import { describe, expect, it } from 'vitest';
import { forEachCsvRow } from './csv';

function rowsOf(input: string | Uint8Array, options?: Parameters<typeof forEachCsvRow>[2]) {
  const rows: string[][] = [];
  const result = forEachCsvRow(input, (row) => rows.push(row), options);
  return { rows, ...result };
}

describe('forEachCsvRow', () => {
  it('liest Komma-getrennte Zeilen mit Anführungszeichen, doppelten Quotes und Zeilenumbrüchen', () => {
    const text =
      'Datum,Kampagnen-ID,Name\r\n2026-09-01,"123456789012345","Mit, Komma"\r\n2026-09-02,1,"Sagt ""Hallo""\nzweite Zeile"\r\n';
    expect(rowsOf(text)).toEqual({
      rows: [
        ['Datum', 'Kampagnen-ID', 'Name'],
        ['2026-09-01', '123456789012345', 'Mit, Komma'],
        ['2026-09-02', '1', 'Sagt "Hallo"\nzweite Zeile'],
      ],
      delimiter: ',',
    });
  });

  it('erkennt Semikolon und Tabulator an der Kopfzeile (deutsches Excel)', () => {
    expect(rowsOf('a;b;"c;d"\n1;2,5;3').rows).toEqual([
      ['a', 'b', 'c;d'],
      ['1', '2,5', '3'],
    ]);
    expect(rowsOf('a\tb\n1\t2').delimiter).toBe('\t');
  });

  it('entfernt die BOM und dekodiert UTF-8 aus Bytes', () => {
    const bytes = new TextEncoder().encode('﻿Übereinstimmungstyp,Ausgaben\nGenau Passend,1.5');
    expect(rowsOf(bytes).rows).toEqual([
      ['Übereinstimmungstyp', 'Ausgaben'],
      ['Genau Passend', '1.5'],
    ]);
  });

  it('übergeht leere Zeilen am Ende, behält leere Felder', () => {
    expect(rowsOf('a,b,c\n1,,3\n\n').rows).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
  });

  it('meldet ein offenes Anführungszeichen und ungültiges UTF-8 als INVALID_CSV', () => {
    expect(() => rowsOf('a,b\n1,"offen')).toThrow(expect.objectContaining({ code: 'INVALID_CSV' }));
    expect(() => rowsOf(new Uint8Array([0x61, 0xff, 0x62]))).toThrow(
      expect.objectContaining({ code: 'INVALID_CSV' }),
    );
  });

  it('bricht bei zu großen Dateien ab', () => {
    expect(() => rowsOf('a\n'.repeat(1000), { maxBytes: 100 })).toThrow(
      expect.objectContaining({ code: 'TOO_LARGE' }),
    );
  });

  it('zählt Zeilennummern ab 1 wie in Excel', () => {
    const numbers: number[] = [];
    forEachCsvRow('a\n"x\ny"\nb', (_row, rowNumber) => numbers.push(rowNumber));
    expect(numbers).toEqual([1, 2, 3]);
  });
});
