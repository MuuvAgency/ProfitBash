import type { ColDef, ValueFormatterParams, ValueGetterParams } from 'ag-grid-community';
import { describe, expect, it } from 'vitest';
import type { ExplorerRowsData } from '../api/client';
import { i18n } from '../i18n';
import {
  attributionLabel,
  buildColumnDefs,
  defaultVisibleColumns,
  OPTIONAL_COLUMNS,
  totalRow,
  type GridRow,
} from './columns';

type Row = ExplorerRowsData['rows'][number];
const nbsp = ' ';
const t = i18n.global.t;

function period(cost: string, sales: string | null) {
  return {
    sums: {
      impressions: '1000',
      clicks: '20',
      cost,
      sales,
      purchases: '2',
      units: null,
      salesSameSku: null,
      purchasesSameSku: null,
      unitsSameSku: null,
      viewableImpressions: null,
      viewableCost: null,
    },
    derived: {
      ctr: '0.02',
      cpc: '0.5',
      cvr: '0.1',
      acos: sales ? '0.25' : null,
      roas: sales ? '4' : null,
      cpm: '10',
      vcpm: null,
    },
  };
}

function row(patch: Partial<Row> = {}): Row {
  return {
    id: 'r1',
    profileId: 'p1',
    accountName: 'Demo UK',
    countryCode: 'UK',
    currencyCode: 'GBP',
    adProduct: 'SPONSORED_PRODUCTS',
    name: 'Kampagne A',
    state: 'ENABLED',
    removed: false,
    placeholder: false,
    hasMetrics: true,
    attributes: { amazonId: '123' },
    current: period('10', '40'),
    comparison: null,
    change: null,
    attribution: null,
    ...patch,
  } as Row;
}

const ctx = {
  t,
  locale: 'de-DE' as const,
  attribution: 'console' as const,
  accountTypeOf: () => 'seller',
  displayCurrency: 'EUR',
  converted: true,
};

function column(defs: ColDef<GridRow>[], id: string) {
  const def = defs.find((d) => d.colId === id);
  if (!def) throw new Error(`Spalte ${id} fehlt`);
  return def;
}

function display(def: ColDef<GridRow>, data: GridRow): string {
  const value =
    typeof def.valueGetter === 'function'
      ? def.valueGetter({ data } as ValueGetterParams<GridRow>)
      : undefined;
  return typeof def.valueFormatter === 'function'
    ? (def.valueFormatter({ data, value } as ValueFormatterParams<GridRow>) as string)
    : String(value);
}

describe('Explorer-Spalten', () => {
  const all = (level: Parameters<typeof buildColumnDefs>[0]['level']) =>
    buildColumnDefs({ level, visible: new Set(OPTIONAL_COLUMNS.map((c) => c.id)), ...ctx });

  it('Beträge je Zeile in der Originalwährung, Summenzeile in der Anzeigewährung mit „≈“', () => {
    const defs = all('campaign');
    expect(display(column(defs, 'cost'), row())).toBe(`10,00${nbsp}£`);
    const total = totalRow(
      { current: period('100', '400'), comparison: null, change: null },
      'EUR',
    );
    expect(display(column(defs, 'cost'), total)).toBe(`≈ 100,00${nbsp}€`);
  });

  it('fehlende Werte als „–“, nie 0', () => {
    expect(display(column(all('campaign'), 'units'), row())).toBe('–');
  });

  it('CSV: Beträge als Decimal-String, Währung als eigene Spalte', () => {
    const defs = all('campaign');
    expect(column(defs, 'cost').useValueFormatterForExport).toBe(false);
    const currency = column(defs, 'currency');
    expect(display(currency, row())).toBe('GBP');
  });

  it('sortiert Beträge als Decimal-Strings (fehlende am Ende)', () => {
    const comparator = column(all('campaign'), 'cost').comparator as (...args: unknown[]) => number;
    expect(comparator('9', '10', {}, {}, false)).toBeLessThan(0);
    expect(comparator(null, '10', {}, {}, false)).toBeGreaterThan(0);
  });

  it('Attribution je Ad-Typ lesbar (F4)', () => {
    expect(attributionLabel('SPONSORED_PRODUCTS', 'seller', 'console', t)).toBe('7 Tage, Klick');
    expect(attributionLabel('SPONSORED_PRODUCTS', 'vendor', 'console', t)).toBe('14 Tage, Klick');
    expect(attributionLabel('SPONSORED_BRANDS', 'seller', 'console', t)).toBe(
      '14 Tage, Klick + View',
    );
    expect(attributionLabel('SPONSORED_DISPLAY', 'agency', 'clicks14d', t)).toBe('14 Tage, Klick');
  });

  it('Gebote bei vCPM-Kampagnen „je 1000 sichtbare Impressionen“', () => {
    const bid = column(all('target'), 'bid');
    const vcpm = row({
      adProduct: 'SPONSORED_DISPLAY',
      attributes: { bid: '4.5', bidCurrencyCode: 'EUR', costType: 'VCPM' },
    });
    expect(display(bid, vcpm)).toBe(`4,50${nbsp}€ je 1000 sichtbare Impr.`);
    const cpc = row({ attributes: { bid: '0.8', bidCurrencyCode: 'GBP' } });
    expect(display(bid, cpc)).toBe(`0,80${nbsp}£`);
  });

  it('Platzhalter (Name unbekannt) und entfernte Entities sind gekennzeichnet', () => {
    const name = column(all('campaign'), 'name');
    expect(display(name, row({ name: null, placeholder: true }))).toBe('(unbekannt)');
    expect(display(name, row({ removed: true }))).toBe('Kampagne A (entfernt)');
  });

  it('Negatives ohne Kennzahlen-Spalten; Suchbegriffe mit Target', () => {
    const negative = all('negative').map((d) => d.colId);
    expect(negative).not.toContain('cost');
    expect(negative).toContain('matchType');
    expect(all('searchTerm').map((d) => d.colId)).toContain('target');
  });

  it('Standard-Spalten je Ebene; die Namensspalte ist immer da und links fest', () => {
    const visible = defaultVisibleColumns('campaign');
    const defs = buildColumnDefs({ level: 'campaign', visible, ...ctx });
    expect(defs[0]).toMatchObject({ colId: 'name', pinned: 'left' });
    expect(defs.map((d) => d.colId)).toContain('changeCost');
    expect(defs.map((d) => d.colId)).not.toContain('viewableImpressions');
  });
});
