import { describe, expect, it } from 'vitest';
import { parseBulkCount, searchTermSheetKind } from './bulk-search-terms';

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
    // Kein Runden auf 15 Stellen: Ein Zähler ist in der Datei eine ganze Zahl oder ungültig.
    for (const text of ['1.5', '-3', 'viele', '1e400', '0.9999999999999999']) {
      expect(parseBulkCount(text)).toBe('invalid');
    }
  });
});
