/** Zeitraum aus ganzen Tagen, beide Grenzen eingeschlossen (`YYYY-MM-DD`). */
export interface DateRange {
  startDate: string;
  endDate: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Tage als Zahl seit 1970 (UTC, damit keine Zeitzone Tage verschiebt). */
const toDay = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const fromDay = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);

/** Die Tage von `range`, die keiner der `covered`-Zeiträume enthält, als sortierte Teilzeiträume. */
export function subtractDateRanges(range: DateRange, covered: readonly DateRange[]): DateRange[] {
  const holes = covered
    .map((c) => ({ start: toDay(c.startDate), end: toDay(c.endDate) }))
    .sort((a, b) => a.start - b.start);
  const result: DateRange[] = [];
  let next = toDay(range.startDate);
  const last = toDay(range.endDate);
  for (const hole of holes) {
    if (next > last) break;
    if (hole.end < next) continue;
    if (hole.start > next) {
      result.push({ startDate: fromDay(next), endDate: fromDay(Math.min(hole.start - 1, last)) });
    }
    next = Math.max(next, hole.end + 1);
  }
  if (next <= last) result.push({ startDate: fromDay(next), endDate: fromDay(last) });
  return result;
}

/** Tag `date` plus `days` Tage (negativ: zurück). */
export function addDays(date: string, days: number): string {
  return fromDay(toDay(date) + days);
}

/** Heutiger Kalendertag in der Zeitzone `timeZone` (IANA). Unbekannte Zeitzonen werfen `RangeError`. */
export function todayIn(timeZone: string, now: Date): string {
  // `en-CA` formatiert als `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

/** Teilt `range` von vorn in Stücke von höchstens `maxDays` Tagen. */
export function splitDateRange(range: DateRange, maxDays: number): DateRange[] {
  const result: DateRange[] = [];
  const last = toDay(range.endDate);
  for (let start = toDay(range.startDate); start <= last; start += maxDays) {
    result.push({
      startDate: fromDay(start),
      endDate: fromDay(Math.min(start + maxDays - 1, last)),
    });
  }
  return result;
}
