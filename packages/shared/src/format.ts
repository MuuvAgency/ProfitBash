import type { Locale } from './api';

/**
 * Formatierung von Zahlen, Beträgen und Anteilen für die UI.
 * Werte kommen als Decimal-String (Geld nie als Float) und gehen unverändert an `Intl.NumberFormat`,
 * das Strings ohne Umweg über `number` exakt formatiert.
 */

/** Platzhalter für fehlende oder ungültige Werte. */
export const MISSING_VALUE = '–';

export type NumericValue = string | number | bigint | null | undefined;

const DECIMAL = /^-?\d+(\.\d+)?$/;

type IntlNumeric = number | bigint | `${number}`;

function toIntlValue(value: NumericValue): IntlNumeric | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return DECIMAL.test(value) ? (value as `${number}`) : null;
}

function format(value: NumericValue, locale: Locale, options: Intl.NumberFormatOptions): string {
  const intlValue = toIntlValue(value);
  if (intlValue === null) return MISSING_VALUE;
  try {
    // `negative`: Werte, die auf 0 gerundet werden, erscheinen ohne Minuszeichen („-0,00 €“).
    return new Intl.NumberFormat(locale, { ...options, signDisplay: 'negative' }).format(intlValue);
  } catch {
    // z. B. unbekannter Währungscode: ein Widget soll daran nicht scheitern.
    return MISSING_VALUE;
  }
}

export interface NumberFormatOptions {
  minimumFractionDigits?: number;
  maximumFractionDigits?: number;
}

export function formatNumber(
  value: NumericValue,
  locale: Locale,
  { minimumFractionDigits = 0, maximumFractionDigits = 2 }: NumberFormatOptions = {},
): string {
  return format(value, locale, {
    minimumFractionDigits,
    maximumFractionDigits: Math.max(minimumFractionDigits, maximumFractionDigits),
  });
}

/** Betrag in seiner Originalwährung (ISO-4217-Code, z. B. `EUR`), mit den Nachkommastellen der Währung. */
export function formatCurrency(value: NumericValue, currency: string, locale: Locale): string {
  return format(value, locale, { style: 'currency', currency });
}

/** Anteil als Prozent: `0.1234` → `12,3 %`. */
export function formatPercent(
  value: NumericValue,
  locale: Locale,
  { fractionDigits = 1 }: { fractionDigits?: number } = {},
): string {
  return format(value, locale, {
    style: 'percent',
    minimumFractionDigits: fractionDigits,
    maximumFractionDigits: fractionDigits,
  });
}

/** Datum eines Zeitpunkts ohne Uhrzeit, z. B. `26.09.2026`. Ohne `timeZone` in der Zeitzone des Browsers. */
export function formatDate(
  value: string | Date | null | undefined,
  locale: Locale,
  { timeZone }: { timeZone?: string } = {},
): string {
  if (value === null || value === undefined) return MISSING_VALUE;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return MISSING_VALUE;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    ...(timeZone && { timeZone }),
  }).format(date);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * Kalendertag (`YYYY-MM-DD`, z. B. ein Kennzahl-Tag in der Zeitzone des Profils), z. B. `25.09.2026`
 * bzw. `09/25/2026` (en-US). Numerisch mit fester Breite, damit Tabellenspalten in jeder Sprache passen.
 * Anders als `formatDate` ohne Umrechnung: Der Tag bleibt in jeder Zeitzone des Browsers derselbe.
 */
export function formatDay(value: string | null | undefined, locale: Locale): string {
  const match = value ? DAY.exec(value) : null;
  if (!match) return MISSING_VALUE;
  const [year, month, day] = match.slice(1).map(Number) as [number, number, number];
  const date = new Date(0);
  // `setUTCFullYear` statt `Date.UTC`: Das deutete Jahre unter 100 als 19xx.
  date.setUTCFullYear(year, month - 1, day);
  // Ungültige Tage (z. B. 30. Februar) rollen weiter; die zählen nicht als Tag.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return MISSING_VALUE;
  return new Intl.DateTimeFormat(locale, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}

/**
 * Zeitpunkt mit Datum und Uhrzeit (Sekunden), z. B. `26.09.2026, 10:15:03`. Ohne `timeZone` in der
 * Zeitzone des Browsers.
 */
export function formatDateTime(
  value: string | Date | null | undefined,
  locale: Locale,
  { timeZone }: { timeZone?: string } = {},
): string {
  if (value === null || value === undefined) return MISSING_VALUE;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return MISSING_VALUE;
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'medium',
    ...(timeZone && { timeZone }),
  }).format(date);
}

function formatUnit(value: number, unit: 'second' | 'minute' | 'hour', locale: Locale, digits = 0) {
  return new Intl.NumberFormat(locale, {
    style: 'unit',
    unit,
    maximumFractionDigits: digits,
  }).format(value);
}

/** Dauer in Millisekunden mit den Einheiten der Locale: `1,2 Sek.`, `3 Min. 12 Sek.`, `1 Std. 5 Min.` */
export function formatDuration(ms: number | null | undefined, locale: Locale): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms) || ms < 0) return MISSING_VALUE;
  // Auf Zehntel abrunden: 59,94 s erscheint als „59,9 s“, nicht als „60 s“.
  if (ms < 60_000) return formatUnit(Math.floor(ms / 100) / 10, 'second', locale, 1);
  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 3600) {
    return `${formatUnit(Math.floor(totalSeconds / 60), 'minute', locale)} ${formatUnit(totalSeconds % 60, 'second', locale)}`;
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  return `${formatUnit(Math.floor(totalMinutes / 60), 'hour', locale)} ${formatUnit(totalMinutes % 60, 'minute', locale)}`;
}
