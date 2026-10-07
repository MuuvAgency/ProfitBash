import { describe, expect, it } from 'vitest';
import { parseBulkCount, parseBulkPeriod, searchTermSheetKind } from './bulk-search-terms';

describe('parseBulkPeriod', () => {
  it('liest den Zeitraum aus dem Dateinamen der Werbekonsole', () => {
    expect(parseBulkPeriod('bulk-a1b2c3d4e5-20260922-20261007-1791399063312.xlsx')).toEqual({
      startDate: '2026-09-22',
      endDate: '2026-10-07',
    });
    // Vom Browser nummerierte Kopie.
    expect(parseBulkPeriod('bulk-a1b2c3-20260901-20260930-1 (2).xlsx')).toEqual({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });
  });

  it('liefert null bei umbenannten Dateien, unmöglichen Tagen und verdrehtem Zeitraum', () => {
    expect(parseBulkPeriod('bulk-test.xlsx')).toBeNull();
    expect(parseBulkPeriod('kunde-oktober.xlsx')).toBeNull();
    expect(parseBulkPeriod('bulk-a1-20260231-20260301-1.xlsx')).toBeNull();
    expect(parseBulkPeriod('bulk-a1-20261007-20260922-1.xlsx')).toBeNull();
  });
});

describe('searchTermSheetKind', () => {
  it('erkennt die Suchbegriff-Blätter von SP und SB, deutsch und englisch', () => {
    expect(searchTermSheetKind('SP Bericht „Suchbegriff“')).toBe('sp');
    expect(searchTermSheetKind('SB Bericht „Suchbegriff“')).toBe('sb');
    expect(searchTermSheetKind('SP Search Term Report')).toBe('sp');
    expect(searchTermSheetKind('SB Search Term Report')).toBe('sb');
  });

  it('übergeht alle anderen Blätter', () => {
    for (const name of ['Sponsored Products-Kampagnen', 'Portfolios', 'Budgetregeln', 'Config']) {
      expect(searchTermSheetKind(name)).toBeNull();
    }
  });
});

describe('parseBulkCount', () => {
  it('liest Zähler als ganze Zahl, auch in Gleitkomma-Schreibweise der Datei', () => {
    expect(parseBulkCount('0')).toBe(0);
    expect(parseBulkCount('1234')).toBe(1234);
    expect(parseBulkCount('12.0')).toBe(12);
    expect(parseBulkCount('')).toBeNull();
  });

  it('lehnt Brüche, negative und unlesbare Werte ab', () => {
    for (const text of ['1.5', '-3', 'viele', '1e400']) {
      expect(parseBulkCount(text)).toBe('invalid');
    }
  });
});
