/**
 * Zeiträume und Vergleich der Filterleiste (`phase-2.md` F5). Tage sind Kalendertage `YYYY-MM-DD`; „heute“ ist der Tag
 * in der Zeitzone des Browsers (F5), die Kennzahlen liegen je Profil in dessen Zeitzone.
 *
 * - „Letzte N Tage“ enden gestern (der heutige Tag hat noch keine Kennzahlen).
 * - „Diese Woche“, „Dieser Monat“, „Dieses Jahr bis jetzt“ enden heute (F5: „Dieser Monat“ am 10. = 10 Tage).
 * - Wochen beginnen am Montag; „Letzte 12 Monate“ = die 12 vollen Monate vor dem laufenden.
 */

export const PERIOD_PRESETS = [
  'yesterday',
  'last7',
  'last14',
  'last30',
  'thisWeek',
  'lastWeek',
  'thisMonth',
  'lastMonth',
  'monthBeforeLast',
  'thirdLastMonth',
  'last12Months',
  'yearToDate',
  'lastYear',
  'custom',
] as const;
export type PeriodPreset = (typeof PERIOD_PRESETS)[number];
export const DEFAULT_PERIOD_PRESET: PeriodPreset = 'last30';

export const COMPARISON_MODES = ['previous', 'previousYear', 'off'] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];
export const DEFAULT_COMPARISON_MODE: ComparisonMode = 'previous';

export interface DateRange {
  from: string;
  to: string;
}

export interface PeriodSelection {
  preset: PeriodPreset;
  /** Nur bei `custom`. */
  range?: DateRange;
}

export function isPeriodPreset(value: unknown): value is PeriodPreset {
  return typeof value === 'string' && (PERIOD_PRESETS as readonly string[]).includes(value);
}

export function isComparisonMode(value: unknown): value is ComparisonMode {
  return typeof value === 'string' && (COMPARISON_MODES as readonly string[]).includes(value);
}

const DAY_MS = 86_400_000;

function toUtc(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

function toDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  return toDay(new Date(toUtc(day).getTime() + days * DAY_MS));
}

/** Erster Tag des Monats, `offset` Monate vom Monat von `day` entfernt. */
function monthStart(day: string, offset: number): string {
  const date = toUtc(day);
  return toDay(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1)));
}

function monthEnd(day: string, offset: number): string {
  return addDays(monthStart(day, offset + 1), -1);
}

/** Anzahl Tage inkl. beider Enden. */
export function rangeDays(range: DateRange): number {
  return Math.round((toUtc(range.to).getTime() - toUtc(range.from).getTime()) / DAY_MS) + 1;
}

/** Heutiger Kalendertag in der Zeitzone des Browsers. */
export function todayInBrowser(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function resolvePeriod(selection: PeriodSelection, today: string): DateRange {
  const yesterday = addDays(today, -1);
  const lastDays = (days: number) => ({ from: addDays(yesterday, -(days - 1)), to: yesterday });
  // getUTCDay: 0 = Sonntag; Abstand zum Montag davor.
  const sinceMonday = (toUtc(today).getUTCDay() + 6) % 7;
  const monday = addDays(today, -sinceMonday);
  const year = today.slice(0, 4);

  switch (selection.preset) {
    case 'yesterday':
      return { from: yesterday, to: yesterday };
    case 'last7':
      return lastDays(7);
    case 'last14':
      return lastDays(14);
    case 'last30':
      return lastDays(30);
    case 'thisWeek':
      return { from: monday, to: today };
    case 'lastWeek':
      return { from: addDays(monday, -7), to: addDays(monday, -1) };
    case 'thisMonth':
      return { from: monthStart(today, 0), to: today };
    case 'lastMonth':
      return { from: monthStart(today, -1), to: monthEnd(today, -1) };
    case 'monthBeforeLast':
      return { from: monthStart(today, -2), to: monthEnd(today, -2) };
    case 'thirdLastMonth':
      return { from: monthStart(today, -3), to: monthEnd(today, -3) };
    case 'last12Months':
      return { from: monthStart(today, -12), to: monthEnd(today, -1) };
    case 'yearToDate':
      return { from: `${year}-01-01`, to: today };
    case 'lastYear':
      return { from: `${Number(year) - 1}-01-01`, to: `${Number(year) - 1}-12-31` };
    case 'custom':
      return selection.range ?? lastDays(30);
  }
}

/** Derselbe Tag ein Jahr früher; der 29. Februar wird der 28. */
function previousYearDay(day: string): string {
  const [year, month, date] = day.split('-').map(Number) as [number, number, number];
  const candidate = new Date(Date.UTC(year - 1, month - 1, date));
  // Rollt der 29.02. in den März, gilt der letzte Tag des Februars.
  return candidate.getUTCMonth() === month - 1
    ? toDay(candidate)
    : toDay(new Date(Date.UTC(year - 1, month, 0)));
}

export function comparisonRange(period: DateRange, mode: ComparisonMode): DateRange | null {
  if (mode === 'off') return null;
  if (mode === 'previousYear') {
    return { from: previousYearDay(period.from), to: previousYearDay(period.to) };
  }
  const days = rangeDays(period);
  return { from: addDays(period.from, -days), to: addDays(period.from, -1) };
}
