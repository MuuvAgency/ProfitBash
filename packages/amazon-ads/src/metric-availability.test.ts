import {
  AD_PRODUCTS,
  METRIC_AVAILABILITY,
  METRIC_COLUMNS,
  METRICS_LEVELS,
  type AdProduct,
} from '@profitbash/engine';
import { describe, expect, it } from 'vitest';
import { createReportRowSchema, REPORT_DEFINITIONS } from './reports';

/** Die Tabelle im Rechenkern (welche Kennzahl je Ad-Typ und Ebene fehlt) passt zu den angeforderten Report-Spalten. */
describe('METRIC_AVAILABILITY', () => {
  /** Spalten, die das Zeilen-Schema eines Reports füllt, wenn Amazon jede angeforderte Spalte liefert. */
  function filledColumns(reportType: keyof typeof REPORT_DEFINITIONS): string[] {
    const definition = REPORT_DEFINITIONS[reportType];
    const row = Object.fromEntries(
      definition.columns.map((column) => [
        column,
        column === 'date'
          ? '2026-09-01'
          : /(Id|Name|Asin|Sku)$|^searchTerm$/.test(column)
            ? '123'
            : 1,
      ]),
    );
    const parsed = new Map(Object.entries(createReportRowSchema(reportType).parse(row)));
    return METRIC_COLUMNS.filter((column) => parsed.get(column) !== null);
  }

  it.each(Object.keys(REPORT_DEFINITIONS) as (keyof typeof REPORT_DEFINITIONS)[])(
    'stimmt für %s mit den Spalten überein, die der Report füllt',
    (reportType) => {
      const { adProduct, level } = REPORT_DEFINITIONS[reportType];
      const available = METRIC_AVAILABILITY[adProduct as AdProduct][level];
      expect([...(available ?? [])].sort()).toEqual(filledColumns(reportType).sort());
    },
  );

  it('kennt keine Kennzahlen für Ebenen ohne Report (SD-Suchbegriffe)', () => {
    for (const adProduct of AD_PRODUCTS) {
      for (const level of METRICS_LEVELS) {
        const hasReport = Object.values(REPORT_DEFINITIONS).some(
          (definition) => definition.adProduct === adProduct && definition.level === level,
        );
        expect(METRIC_AVAILABILITY[adProduct][level] !== null, `${adProduct} ${level}`).toBe(
          hasReport,
        );
      }
    }
  });

  it('füllt Klick-Spalten nie bei SP (SP ist nur klick-basiert) und sichtbare Impressionen nur bei SD', () => {
    for (const level of METRICS_LEVELS) {
      const sp = METRIC_AVAILABILITY.SPONSORED_PRODUCTS[level] ?? [];
      expect(sp).not.toContain('salesClicks14d');
      expect(sp).not.toContain('purchasesClicks14d');
      expect(sp).not.toContain('unitsClicks14d');
      expect(sp).not.toContain('viewableImpressions');
      expect(METRIC_AVAILABILITY.SPONSORED_BRANDS[level] ?? []).not.toContain(
        'viewableImpressions',
      );
    }
    expect(METRIC_AVAILABILITY.SPONSORED_DISPLAY.campaign).toContain('viewableImpressions');
  });
});
