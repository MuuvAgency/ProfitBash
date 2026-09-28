import {
  compareDecimal,
  decimalSign,
  formatCurrency,
  formatNumber,
  formatPercent,
  MISSING_VALUE,
  type ChangeKey,
  type Locale,
} from '@profitbash/shared';

/**
 * Anzeige von Kennzahlen: Formatierung je Art (Betrag, Anteil, Faktor, Zähler) und Farbe der Veränderung nach
 * Bedeutung (Dominik, 2026-09-28): mehr Umsatz ist gut, mehr ACoS schlecht, mehr Spend weder noch.
 */
export type MetricKey = ChangeKey;

type Polarity = 'higherIsBetter' | 'lowerIsBetter' | 'neutral';

export const METRIC_POLARITY: Record<MetricKey, Polarity> = {
  impressions: 'higherIsBetter',
  clicks: 'higherIsBetter',
  cost: 'neutral',
  sales: 'higherIsBetter',
  purchases: 'higherIsBetter',
  units: 'higherIsBetter',
  ctr: 'higherIsBetter',
  cpc: 'lowerIsBetter',
  cvr: 'higherIsBetter',
  acos: 'lowerIsBetter',
  roas: 'higherIsBetter',
  cpm: 'lowerIsBetter',
  vcpm: 'lowerIsBetter',
};

export type ChangeTone = 'positive' | 'negative' | 'neutral';

/** Veränderungen werden mit einer Nachkommastelle in Prozent gezeigt: unter 0,05 % erscheint „0,0 %“. */
const SHOWN_AS_ZERO_BELOW = '0.0005';

/** Die angezeigte Veränderung ist 0 (auch winzige Werte, die auf 0 gerundet werden). */
export function isShownAsNoChange(relative: string): boolean {
  const magnitude = relative.startsWith('-') ? relative.slice(1) : relative;
  return compareDecimal(magnitude, SHOWN_AS_ZERO_BELOW) < 0;
}

/** Farbe der Veränderung; `null` ohne Vergleichswert. Was als 0 erscheint, ist neutral. */
export function changeTone(key: MetricKey, relative: string | null): ChangeTone | null {
  if (relative === null) return null;
  if (isShownAsNoChange(relative)) return 'neutral';
  const sign = decimalSign(relative);
  if (sign === null) return null;
  const polarity = METRIC_POLARITY[key];
  if (sign === 0 || polarity === 'neutral') return 'neutral';
  return sign > 0 === (polarity === 'higherIsBetter') ? 'positive' : 'negative';
}

/** Relative Veränderung (Bruch) als Prozent mit Vorzeichen: `+12,3 %`. */
export function formatChange(relative: string | null, locale: Locale): string {
  if (relative === null) return MISSING_VALUE;
  // Auf 0 gerundete Werte ohne Vorzeichen („+0,0 %“ bzw. „-0,0 %“ wäre irreführend).
  if (isShownAsNoChange(relative)) return formatPercent('0', locale);
  const formatted = formatPercent(relative, locale);
  return decimalSign(relative) === 1 ? `+${formatted}` : formatted;
}

const MONEY = new Set<MetricKey>(['cost', 'sales', 'cpc', 'cpm', 'vcpm']);
const RATIO = new Set<MetricKey>(['ctr', 'cvr', 'acos']);

export function formatMetricValue(
  key: MetricKey,
  value: string | null,
  { currency, locale }: { currency: string; locale: Locale },
): string {
  if (value === null) return MISSING_VALUE;
  if (MONEY.has(key)) return formatCurrency(value, currency, locale);
  if (RATIO.has(key)) return formatPercent(value, locale);
  if (key === 'roas') {
    return formatNumber(value, locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  return formatNumber(value, locale, { maximumFractionDigits: 0 });
}
