import type {
  AgCartesianChartOptions,
  AgCartesianSeriesOptions,
  AgRangeCrossLineOptions,
} from 'ag-charts-community';
import { addDays } from '../analytics/periods';
import type { DateRange } from '../analytics/periods';
import type { ChartThemeTokens } from './theme';

/**
 * Tagesverlauf für Hero-Kachel (2.7) und Explorer-Chart (2.8). Werte kommen als Decimal-Strings; der Chart braucht
 * für die Position eine Zahl (nur Anzeige, nie zum Rechnen), der Tooltip zeigt den formatierten String.
 */

export interface ChartPoint {
  day: string;
  values: Record<string, string | null>;
}

/**
 * Jeder Tag des Zeitraums. Die API liefert nur Tage mit Kennzahlen: Ein fehlender Tag zwischen erstem Datentag und
 * „Daten bis“ hatte keine Aktivität (0); davor bzw. danach gibt es keine Daten (Lücke statt 0, F5).
 */
export function fillDays(
  days: { date: string; values: Record<string, string | null> }[],
  range: DateRange,
  keys: string[],
  { earliestDate, dataThrough }: { earliestDate: string | null; dataThrough: string | null },
): ChartPoint[] {
  const byDay = new Map(days.map((day) => [day.date, day.values]));
  const points: ChartPoint[] = [];
  for (let day = range.from; day <= range.to; day = addDays(day, 1)) {
    const known = byDay.get(day);
    const covered =
      earliestDate !== null && dataThrough !== null && day >= earliestDate && day <= dataThrough;
    const fallback = covered ? '0' : null;
    points.push({
      day,
      values: Object.fromEntries(keys.map((key) => [key, known ? (known[key] ?? null) : fallback])),
    });
  }
  return points;
}

export interface ChartSeriesDef {
  key: string;
  label: string;
  kind: 'line' | 'bar';
  axis: 'left' | 'right';
  /** Formatiert den Decimal-String für den Tooltip. */
  format: (value: string) => string;
}

export interface TimeSeriesChartInput {
  points: ChartPoint[];
  series: ChartSeriesDef[];
  /** Ab diesem Tag vorläufig (`meta.provisionalFrom`). */
  provisionalFrom: string | null;
  provisionalLabel: string;
  formatDay: (day: string) => string;
  /** Beschriftung der Y-Achse (Tick-Werte des Charts). */
  formatAxisValue: (value: number) => string;
  theme: ChartThemeTokens;
}

/** Kalendertag als lokales Datum (Mitternacht), damit die Zeitachse keinen Tag verschiebt. */
function localDate(day: string): Date {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  return new Date(year, month - 1, date);
}

const rawKey = (key: string) => `raw:${key}`;

export function buildTimeSeriesOptions(input: TimeSeriesChartInput): AgCartesianChartOptions {
  const { points, series, theme } = input;
  const data = points.map((point) => {
    const datum: Record<string, unknown> = { date: localDate(point.day), day: point.day };
    for (const def of series) {
      const value = point.values[def.key];
      datum[rawKey(def.key)] = value;
      if (value !== null && value !== undefined) datum[def.key] = Number(value);
    }
    return datum;
  });

  const colors = [theme.colors.primary, theme.colors.positive];
  const chartSeries = series.map((def, index): AgCartesianSeriesOptions => {
    const color = colors[index % colors.length]!;
    const tooltip = {
      renderer: ({ datum }: { datum: Record<string, unknown> }) => {
        const raw = datum[rawKey(def.key)];
        return {
          heading: input.formatDay(String(datum.day)),
          data: [{ label: def.label, value: typeof raw === 'string' ? def.format(raw) : '–' }],
        };
      },
    };
    const common = {
      xKey: 'date',
      yKey: def.key,
      yName: def.label,
      yKeyAxis: def.axis,
      tooltip,
    };
    return def.kind === 'bar'
      ? { type: 'bar', ...common, fill: color, cornerRadius: 3 }
      : {
          type: 'line',
          ...common,
          stroke: color,
          strokeWidth: 2,
          marker: { enabled: false },
          connectMissingData: false,
        };
  });

  const last = points.at(-1)?.day;
  const crossLines: AgRangeCrossLineOptions[] =
    input.provisionalFrom && last && input.provisionalFrom <= last
      ? [
          {
            type: 'range',
            // Auf der Tagesachse mit Bändern deckt der Bereich die Bänder der Randtage ganz ab.
            range: [
              localDate(
                input.provisionalFrom > points[0]!.day ? input.provisionalFrom : points[0]!.day,
              ),
              localDate(last),
            ],
            fill: theme.colors.provisional,
            fillOpacity: 0.12,
            strokeWidth: 0,
            label: {
              text: input.provisionalLabel,
              color: theme.colors.muted,
              fontSize: 11,
            },
          },
        ]
      : [];

  // Beide Achsen ab 0 (sonst wirkt eine Achse mit anderem Nullpunkt dramatischer); negative Korrekturen: frei.
  const hasNegative = (axis: 'left' | 'right') =>
    series.some(
      (def) =>
        def.axis === axis &&
        points.some((point) => point.values[def.key]?.startsWith('-') === true),
    );
  const zeroBased = (axis: 'left' | 'right') => (hasNegative(axis) ? {} : { min: 0 });

  const axisLabel = { fontFamily: theme.monoFont, fontSize: 11, color: theme.colors.subtle };
  const usesRight = series.some((def) => def.axis === 'right');

  return {
    theme: theme.agTheme,
    data,
    series: chartSeries as AgCartesianChartOptions['series'],
    axes: {
      // Ein Band je Tag: Balken füllen den Tag, die Achse endet am ersten und letzten Tag (ohne Polster).
      x: {
        type: 'unit-time',
        unit: 'day',
        position: 'bottom',
        label: { ...axisLabel, format: '%d.%m.' },
        crossLines,
      },
      left: {
        type: 'number',
        position: 'left',
        ...zeroBased('left'),
        label: {
          ...axisLabel,
          formatter: ({ value }: { value: number }) => input.formatAxisValue(value),
        },
      },
      ...(usesRight && {
        right: {
          type: 'number',
          position: 'right',
          ...zeroBased('right'),
          gridLine: { enabled: false },
          label: {
            ...axisLabel,
            formatter: ({ value }: { value: number }) => input.formatAxisValue(value),
          },
        },
      }),
    },
    legend: {
      enabled: series.length > 1,
      position: 'top',
      item: { label: { color: theme.colors.muted } },
    },
  };
}
