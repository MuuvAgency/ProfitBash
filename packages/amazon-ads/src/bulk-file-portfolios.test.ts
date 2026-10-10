import { describe, expect, it } from 'vitest';
import { buildPortfolioBulkSheet, PORTFOLIO_BULK_SHEET_NAME } from './bulk-file';

/**
 * Blatt „Portfolios“ für Anlagen (`phase-4.md` 4.7, F9; Guide „Use portfolios with bulksheets“): Pflicht sind Product
 * „Portfolios“, Entity „Portfolio“, Operation „Create“ und der Name; ein Budget braucht Betrag, Währung, Policy und
 * Startdatum.
 */

describe('buildPortfolioBulkSheet', () => {
  it('schreibt je Portfolio eine Create-Zeile, mit und ohne Budget', () => {
    const sheet = buildPortfolioBulkSheet([
      { ref: 'a', name: ' Sommer Sport ', budget: null },
      {
        ref: 'b',
        name: 'Garten',
        budget: {
          amount: '500.00',
          currencyCode: 'EUR',
          policy: 'dateRange',
          startDate: '2026-11-01',
          endDate: '2027-01-31',
        },
      },
      {
        ref: 'c',
        name: 'Monat',
        budget: {
          amount: '125',
          currencyCode: 'EUR',
          policy: 'monthlyRecurring',
          startDate: '2026-11-01',
          endDate: null,
        },
      },
    ]);
    expect(sheet.sheetName).toBe(PORTFOLIO_BULK_SHEET_NAME);
    expect(sheet.skipped).toEqual([]);
    expect(sheet.rows).toEqual([
      [
        'Product',
        'Entity',
        'Operation',
        'Portfolio ID',
        'Portfolio Name',
        'Budget Amount',
        'Budget Currency Code',
        'Budget Policy',
        'Budget Start Date',
        'Budget End Date',
      ],
      ['Portfolios', 'Portfolio', 'Create', null, 'Sommer Sport', null, null, null, null, null],
      [
        'Portfolios',
        'Portfolio',
        'Create',
        null,
        'Garten',
        { number: '500.00' },
        'EUR',
        'dateRange',
        '20261101',
        '20270131',
      ],
      [
        'Portfolios',
        'Portfolio',
        'Create',
        null,
        'Monat',
        { number: '125' },
        'EUR',
        'monthlyRecurring',
        '20261101',
        null,
      ],
    ]);
  });

  it('lässt ungültige Werte und doppelte Namen weg', () => {
    const budget = {
      amount: '10',
      currencyCode: 'EUR',
      policy: 'dateRange',
      startDate: '2026-11-01',
      endDate: null,
    } as const;
    const sheet = buildPortfolioBulkSheet([
      { ref: 'leer', name: '  ', budget: null },
      { ref: 'eins', name: 'Garten', budget: null },
      { ref: 'doppelt', name: 'garten', budget: null },
      { ref: 'betrag', name: 'A', budget: { ...budget, amount: '0' } },
      { ref: 'waehrung', name: 'B', budget: { ...budget, currencyCode: 'eur' } },
      { ref: 'datum', name: 'C', budget: { ...budget, startDate: '2026-02-30' } },
      { ref: 'ende', name: 'D', budget: { ...budget, endDate: '2026-10-31' } },
    ]);
    expect(sheet.skipped).toEqual([
      { ref: 'leer', reason: 'invalidValue' },
      { ref: 'doppelt', reason: 'duplicate' },
      { ref: 'betrag', reason: 'invalidValue' },
      { ref: 'waehrung', reason: 'invalidValue' },
      { ref: 'datum', reason: 'invalidValue' },
      { ref: 'ende', reason: 'invalidValue' },
    ]);
    expect(sheet.rows).toHaveLength(2);
  });
});
