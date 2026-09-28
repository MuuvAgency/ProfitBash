import { describe, expect, it } from 'vitest';
import { colorRoles } from '../theme/tokens';
import { chartTheme } from './theme';
import { buildTimeSeriesOptions, fillDays } from './time-series';

describe('fillDays', () => {
  const days = [
    { date: '2026-09-02', values: { cost: '12.50', sales: '40' } },
    { date: '2026-09-04', values: { cost: '3', sales: null } },
  ];

  it('füllt jeden Tag des Zeitraums; Tage ohne Kennzahlen im Datenbereich sind 0', () => {
    const points = fillDays(days, { from: '2026-09-01', to: '2026-09-05' }, ['cost', 'sales'], {
      earliestDate: '2026-09-01',
      dataThrough: '2026-09-05',
    });
    expect(points).toEqual([
      { day: '2026-09-01', values: { cost: '0', sales: '0' } },
      { day: '2026-09-02', values: { cost: '12.50', sales: '40' } },
      { day: '2026-09-03', values: { cost: '0', sales: '0' } },
      // fehlender Wert bleibt fehlend, nie 0
      { day: '2026-09-04', values: { cost: '3', sales: null } },
      { day: '2026-09-05', values: { cost: '0', sales: '0' } },
    ]);
  });

  it('vor dem ersten Datentag und nach „Daten bis“: Lücke statt 0 (F5)', () => {
    const points = fillDays(days, { from: '2026-08-31', to: '2026-09-06' }, ['cost'], {
      earliestDate: '2026-09-02',
      dataThrough: '2026-09-04',
    });
    expect(points.map((p) => p.values.cost)).toEqual([null, null, '12.50', '0', '3', null, null]);
  });

  it('ganz ohne Daten: nur Lücken', () => {
    const points = fillDays([], { from: '2026-09-01', to: '2026-09-02' }, ['cost'], {
      earliestDate: null,
      dataThrough: null,
    });
    expect(points.map((p) => p.values.cost)).toEqual([null, null]);
  });
});

describe('buildTimeSeriesOptions', () => {
  const palette = chartTheme('light');
  const options = buildTimeSeriesOptions({
    points: [
      { day: '2026-09-01', values: { cost: '10.5', sales: '30' } },
      { day: '2026-09-02', values: { cost: null, sales: '31.25' } },
    ],
    series: [
      { key: 'cost', label: 'Spend', kind: 'bar', axis: 'left', format: (v) => `${v} €` },
      { key: 'sales', label: 'Umsatz', kind: 'line', axis: 'right', format: (v) => `${v} €` },
    ],
    provisionalFrom: '2026-09-02',
    provisionalLabel: 'Vorläufig',
    formatDay: (day) => `Tag ${day}`,
    formatAxisValue: (value) => `#${value}`,
    theme: palette,
  });

  it('eine Reihe je Kennzahl, eigene Achse rechts', () => {
    expect(options.series?.map((s) => [s.type, (s as { yKey: string }).yKey])).toEqual([
      ['bar', 'cost'],
      ['line', 'sales'],
    ]);
    expect(Object.keys(options.axes ?? {})).toEqual(['x', 'left', 'right']);
  });

  it('Achsen beginnen bei 0, solange kein Wert negativ ist (sonst wirken Schwankungen größer)', () => {
    expect((options.axes?.left as { min?: number }).min).toBe(0);
    expect((options.axes?.right as { min?: number }).min).toBe(0);
    const negative = buildTimeSeriesOptions({
      points: [{ day: '2026-09-01', values: { cost: '-2' } }],
      series: [{ key: 'cost', label: 'Spend', kind: 'line', axis: 'left', format: String }],
      provisionalFrom: null,
      provisionalLabel: 'Vorläufig',
      formatDay: String,
      formatAxisValue: String,
      theme: palette,
    });
    expect((negative.axes?.left as { min?: number }).min).toBeUndefined();
  });

  it('Werte als Zahl nur für die Position; fehlende Werte bleiben leer', () => {
    const data = options.data as Record<string, unknown>[];
    expect(data[0]).toMatchObject({ day: '2026-09-01', cost: 10.5, sales: 30 });
    expect(data[1]!.cost).toBeUndefined();
  });

  it('Tooltip zeigt den formatierten Decimal-String, nicht die Zahl', () => {
    const renderer = (options.series?.[1] as { tooltip: { renderer: (p: unknown) => unknown } })
      .tooltip.renderer;
    const result = renderer({ datum: (options.data as unknown[])[1] }) as {
      heading: string;
      data: { label: string; value: string }[];
    };
    expect(result.heading).toBe('Tag 2026-09-02');
    expect(result.data).toEqual([{ label: 'Umsatz', value: '31.25 €' }]);
  });

  it('markiert vorläufige Tage als Bereich bis zum letzten Tag', () => {
    const crossLines = (options.axes?.x as { crossLines: unknown[] }).crossLines;
    expect(crossLines).toHaveLength(1);
    expect(crossLines[0]).toMatchObject({
      type: 'range',
      label: { text: 'Vorläufig' },
    });
    // Tagesachse mit Bändern (`unit-time`): Der Bereich deckt die Bänder der Randtage ganz ab.
    expect((options.axes?.x as { type: string; unit: string }).type).toBe('unit-time');
    expect((options.axes?.x as { unit: string }).unit).toBe('day');
    const [start, end] = (crossLines[0] as { range: [Date, Date] }).range;
    expect(start).toEqual(new Date(2026, 8, 2));
    expect(end).toEqual(new Date(2026, 8, 2));
  });

  it('ohne vorläufige Tage im Zeitraum kein Bereich', () => {
    const later = buildTimeSeriesOptions({
      points: [{ day: '2026-09-01', values: { cost: '1' } }],
      series: [{ key: 'cost', label: 'Spend', kind: 'line', axis: 'left', format: String }],
      provisionalFrom: '2026-09-10',
      provisionalLabel: 'Vorläufig',
      formatDay: String,
      formatAxisValue: String,
      theme: palette,
    });
    expect((later.axes?.x as { crossLines: unknown[] }).crossLines).toEqual([]);
  });
});

describe('chartTheme', () => {
  it('nimmt die Farben aus den Tokens, je Farbschema', () => {
    expect(chartTheme('light').colors.primary).toBe(colorRoles.violet.light);
    expect(chartTheme('dark').colors.primary).toBe(colorRoles.violet.dark);
    expect(chartTheme('dark').agTheme.baseTheme).toBe('ag-default-dark');
    expect(chartTheme('light').agTheme.params?.fontFamily).toContain('Space Grotesk');
  });
});
