import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';

/**
 * Pacing eines Budget-Caps (`phase-5.md` 5.9a, F2, F5): Ist im Monat, Soll linear, Prognose zum Monatsende, je
 * Kampagne aus der Summe ihres Datenstands. Liegt der Zeitraum ganz im Monat (später: Tageswerte der API, über die
 * Tage des Monats summiert), ist das Ist exakt; sonst wird anteilig nach Tagen geschätzt („≈“).
 *
 * Eigene Annahmen:
 * - **Spanne der Schätzung:** Der Tagesschnitt im kleineren Teil des Zeitraums (im Monat oder außerhalb) weicht
 *   höchstens um `PACING_SPREAD` vom Schnitt des ganzen Zeitraums ab.
 * - **Prognose:** Nach dem Datenstand gibt eine aktive Kampagne je Tag ihren Tagesschnitt aus, höchstens ihr
 *   Tagesbudget; pausierte nichts. Die Spanne der Prognose ist die des Ist.
 */

/** Startwert der Spanne: ± 50 % des kleineren Teils. */
export const PACING_SPREAD = '0.5';

export interface PacingCampaign {
  /** Ausgaben im Zeitraum, Währung des Profils. */
  cost: DecimalString;
  /** Zeitraum der Summe (`YYYY-MM-DD`), beide Tage eingeschlossen. */
  periodStart: string;
  periodEnd: string;
  /** Kampagne aktiv (`ENABLED`): nur dann gibt sie nach dem Datenstand weiter aus. */
  active: boolean;
  /** Tagesbudget, `null` ohne (oder bei Laufzeitbudget). */
  dailyBudget: DecimalString | null;
}

export interface PacingInput {
  /** `YYYY-MM`. */
  month: string;
  cap: DecimalString;
  /** Warnschwellen in Prozent des Caps. */
  warnPercents: readonly number[];
  campaigns: readonly PacingCampaign[];
  spread?: DecimalString;
}

export interface PacingEstimate {
  value: DecimalString;
  low: DecimalString;
  high: DecimalString;
}

export interface Pacing {
  daysInMonth: number;
  /** Tage des Monats bis zum Datenstand. */
  elapsedDays: number;
  /** Letzter Tag des Monats mit Daten, `null` ohne Daten im Monat. */
  dataThrough: string | null;
  /** Ist ohne Schätzung: Daten im Monat, und kein Zeitraum ragt über den Monat hinaus. */
  exact: boolean;
  actual: PacingEstimate;
  /** Soll bis zum Datenstand: Cap × vergangene Tage / Tage des Monats. */
  planned: DecimalString;
  forecast: PacingEstimate;
  /** Höchste Warnschwelle, die das geschätzte Ist erreicht hat. */
  warnLevel: number | null;
  /** Die Prognose liegt über dem Cap. */
  forecastOver: boolean;
}

const DAY_MS = 86_400_000;
const dayNumber = (date: string) => Date.parse(`${date}T00:00:00Z`) / DAY_MS;
const dateOf = (day: number) => new Date(day * DAY_MS).toISOString().slice(0, 10);
const money = (value: Dec) => formatDecimal(value.toDecimalPlaces(2));

/** Der Monat (`YYYY-MM`), der zum Zeitpunkt `now` in der Zeitzone gilt. */
export function monthInTimeZone(now: Date, timeZone: string): string {
  // `en-CA` schreibt das Datum als `YYYY-MM-DD`.
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit' })
    .format(now)
    .slice(0, 7);
}

export function computePacing(input: PacingInput): Pacing {
  const [year, month] = input.month.split('-').map(Number) as [number, number];
  const monthStart = Date.UTC(year, month - 1, 1) / DAY_MS;
  const monthEnd = Date.UTC(year, month, 0) / DAY_MS;
  const daysInMonth = monthEnd - monthStart + 1;
  const spread = parseDecimal(input.spread ?? PACING_SPREAD);
  const cap = parseDecimal(input.cap);

  let actual = new Dec(0);
  let uncertainty = new Dec(0);
  let future = new Dec(0);
  let lastDay: number | null = null;
  let exact = true;
  for (const campaign of input.campaigns) {
    const start = dayNumber(campaign.periodStart);
    const end = dayNumber(campaign.periodEnd);
    const days = end - start + 1;
    if (days <= 0) continue;
    const inMonth = Math.max(0, Math.min(end, monthEnd) - Math.max(start, monthStart) + 1);
    const cost = parseDecimal(campaign.cost);
    const rate = cost.div(days);
    const share = rate.mul(inMonth);
    actual = actual.plus(share);
    if (inMonth > 0) {
      lastDay = Math.max(lastDay ?? 0, Math.min(end, monthEnd));
      if (inMonth < days) {
        exact = false;
        uncertainty = uncertainty.plus(Dec.min(share, cost.minus(share)).mul(spread));
      }
    }
    if (campaign.active) {
      const remaining = Math.max(0, monthEnd - Math.max(end, monthStart - 1));
      const perDay =
        campaign.dailyBudget === null ? rate : Dec.min(rate, parseDecimal(campaign.dailyBudget));
      future = future.plus(perDay.mul(remaining));
    }
  }

  const elapsedDays = lastDay === null ? 0 : lastDay - monthStart + 1;
  const estimate = (base: Dec): PacingEstimate => ({
    value: money(base),
    low: money(base.minus(uncertainty)),
    high: money(base.plus(uncertainty)),
  });
  const reached = input.warnPercents.filter((percent) => actual.gte(cap.mul(percent).div(100)));
  return {
    daysInMonth,
    elapsedDays,
    dataThrough: lastDay === null ? null : dateOf(lastDay),
    exact: exact && lastDay !== null,
    actual: estimate(actual),
    planned: money(cap.mul(elapsedDays).div(daysInMonth)),
    forecast: estimate(actual.plus(future)),
    warnLevel: reached.length > 0 ? Math.max(...reached) : null,
    forecastOver: actual.plus(future).gt(cap),
  };
}
