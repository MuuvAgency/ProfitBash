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
  return new Intl.NumberFormat(locale, options).format(intlValue);
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
