import type { ColDef, ICellRendererParams, ValueGetterParams } from 'ag-grid-community';
import { describe, expect, it } from 'vitest';
import type { SearchTermRowData } from '../api/client';
import { i18n } from '../i18n';
import { acrossTargetsLabel, termColumns, totalRow, type TermGridRow } from './columns';

const context = {
  t: i18n.global.t,
  te: i18n.global.te,
  locale: 'de-DE' as const,
  currency: 'EUR',
};

const sums = {
  impressions: '1000',
  clicks: '40',
  cost: '20',
  sales: '100',
  purchases: '4',
  units: '5',
  ctr: '0.04',
  cpc: '0.5',
  cvr: '0.1',
  acos: '0.2',
  roas: '5',
};

const row = (patch: Partial<SearchTermRowData> = {}): SearchTermRowData => ({
  id: '00000000-0000-4000-8000-000000000001',
  adProduct: 'SPONSORED_PRODUCTS',
  searchTerm: 'led lampe',
  amazonCampaignId: 'C1',
  amazonAdGroupId: 'AG1',
  amazonTargetId: 'T1',
  campaignId: null,
  campaignName: null,
  adGroupId: null,
  adGroupName: null,
  targetId: null,
  keywordText: null,
  matchType: null,
  expression: null,
  ...sums,
  classification: 'watch',
  reason: 'tooFewData',
  protected: false,
  harvestMarked: false,
  alreadyTargeted: false,
  termClassification: 'watch',
  termReason: 'tooFewData',
  termTargets: 1,
  termOnlyAcrossTargets: false,
  ...patch,
});

describe('acrossTargetsLabel', () => {
  it('ist leer, wenn die Einstufung über alle Targets der der Zeile gleicht (auch bei anderem Grund)', () => {
    expect(acrossTargetsLabel(row(), context)).toBeNull();
    expect(
      acrossTargetsLabel(row({ termReason: 'acosAboveTarget', termTargets: 2 }), context),
    ).toBeNull();
  });

  it('nennt Einstufung und Anzahl der Zeilen', () => {
    expect(
      acrossTargetsLabel(
        row({ termClassification: 'harvest', termReason: null, termTargets: 3 }),
        context,
      ),
    ).toBe('Über alle Targets: Ernten (3 Zeilen)');
  });

  it('nennt bei „Beobachten“ den Grund wie die Zeile selbst', () => {
    expect(
      acrossTargetsLabel(
        row({
          classification: 'negate',
          reason: null,
          termClassification: 'watch',
          termReason: 'tooFewData',
          termTargets: 2,
        }),
        context,
      ),
    ).toBe('Über alle Targets: Beobachten · Zu wenig Daten (2 Zeilen)');
    expect(
      acrossTargetsLabel(
        row({
          classification: 'harvest',
          reason: null,
          termClassification: 'watch',
          termReason: 'acosAboveTarget',
          termTargets: 2,
        }),
        context,
      ),
    ).toBe('Über alle Targets: Beobachten · ACoS über dem Ziel (2 Zeilen)');
  });

  it('formatiert die Anzahl und bildet Ein- und Mehrzahl', () => {
    const label = (termTargets: number) =>
      acrossTargetsLabel(
        row({ termClassification: 'negate', termReason: null, termTargets }),
        context,
      );
    expect(label(1)).toBe('Über alle Targets: Negieren (1 Zeile)');
    expect(label(1234)).toBe('Über alle Targets: Negieren (1.234 Zeilen)');
  });
});

describe('Spalte „Einstufung“', () => {
  const column = termColumns(context).find((def) => def.colId === 'classification')!;
  const value = (data: TermGridRow) =>
    (column.valueGetter as (params: ValueGetterParams<TermGridRow>) => unknown)({
      data,
    } as ValueGetterParams<TermGridRow>);
  const cell = (data: TermGridRow) =>
    (column.cellRenderer as (params: ICellRendererParams<TermGridRow>) => HTMLElement)({
      data,
      value: value(data),
    } as ICellRendererParams<TermGridRow>);
  const lines = (data: TermGridRow) => [...cell(data).children].map((line) => line.textContent);

  const harvestAcross = row({ termClassification: 'harvest', termReason: null, termTargets: 2 });

  it('trägt beide Zeilen im Wert: Das Grid zeichnet die Zelle nur neu, wenn sich der Wert ändert', () => {
    expect(value(row())).toBe('Beobachten · Zu wenig Daten');
    expect(value(harvestAcross)).not.toBe(value(row()));
    expect(String(value(harvestAcross))).toContain('Beobachten · Zu wenig Daten');
    expect(String(value(harvestAcross))).toContain('Über alle Targets: Ernten (2 Zeilen)');
    // Auch nur die Anzahl der Zeilen ändert den Wert.
    expect(value({ ...harvestAcross, termTargets: 3 })).not.toBe(value(harvestAcross));
  });

  it('zeigt eine Zeile ohne Abweichung und zwei mit, die zweite in der Farbe ihrer Einstufung', () => {
    expect(lines(row())).toEqual(['Beobachten · Zu wenig Daten']);
    expect(lines(harvestAcross)).toEqual([
      'Beobachten · Zu wenig Daten',
      'Über alle Targets: Ernten (2 Zeilen)',
    ]);
    expect(cell(harvestAcross).children[1]?.className).toContain('text-lime-deep');
    const negateAcross = row({ termClassification: 'negate', termReason: null, termTargets: 2 });
    expect(cell(negateAcross).children[1]?.className).toContain('text-loss');
  });

  it('der Textfilter der Spalte findet auch die Einstufung über alle Targets', () => {
    expect((column as ColDef<TermGridRow>).filter).toBe('agTextColumnFilter');
    expect(String(value(harvestAcross))).toContain('Ernten');
    expect(String(value(row()))).not.toContain('Ernten');
  });

  it('die Summenzeile hat keine Einstufung und keine zweite Zeile', () => {
    const total = totalRow(sums);
    expect(value(total)).toBeNull();
    expect(lines(total)).toHaveLength(1);
    expect(cell(total).textContent).not.toContain('Über alle Targets');
  });
});
