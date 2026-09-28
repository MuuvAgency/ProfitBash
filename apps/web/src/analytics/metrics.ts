import {
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

/** Farbe der Veränderung; `null` ohne Vergleichswert. */
export function changeTone(key: MetricKey, relative: string | null): ChangeTone | null {
  const sign = decimalSign(relative);
  if (sign === null) return null;
  const polarity = METRIC_POLARITY[key];
  if (sign === 0 || polarity === 'neutral') return 'neutral';
  return sign > 0 === (polarity === 'higherIsBetter') ? 'positive' : 'negative';
}

/** Relative Veränderung (Bruch) als Prozent mit Vorzeichen: `+12,3 %`. */
export function formatChange(relative: string | null, locale: Locale): string {
  if (relative === null) return MISSING_VALUE;
  const formatted = formatPercent(relative, locale);
  // Auf 0 gerundete Werte ohne Vorzeichen („+0,0 %“ wäre irreführend).
  const roundsToZero = formatted === formatPercent('0', locale);
  return decimalSign(relative) === 1 && !roundsToZero ? `+${formatted}` : formatted;
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
