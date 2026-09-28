import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';

/**
 * Summen einer Zeile oder Auswahl in einer Währung. `null` heißt: Amazon liefert den Wert für diesen Ad-Typ
 * oder diese Ebene nicht (Anzeige „–“, nie 0). `sales` und `purchases` stammen aus denselben Zeilen wie
 * `cost`; fehlen sie in einem Teil der Zeilen (`summarizeAttribution`: `partial`), übergibt der Aufrufer
 * `null`, damit ACoS, ROAS und CVR nicht aus ungleichen Mengen entstehen.
 */
export interface MetricTotals {
  impressions: DecimalString;
  clicks: DecimalString;
  cost: DecimalString;
  sales: DecimalString | null;
  purchases: DecimalString | null;
  /** Sichtbare Impressionen (nur SD, Basis für vCPM). */
  viewableImpressions: DecimalString | null;
  /** Kosten nur der Zeilen mit sichtbaren Impressionen (SD), damit vCPM gemischter Summen stimmt. */
  viewableCost: DecimalString | null;
}

/** Abgeleitete Kennzahlen; Anteile als Bruch (0.25 = 25 %), `null` bei fehlendem Wert oder Division durch 0. */
export interface DerivedMetrics {
  ctr: DecimalString | null;
  cpc: DecimalString | null;
  cvr: DecimalString | null;
  acos: DecimalString | null;
  roas: DecimalString | null;
  cpm: DecimalString | null;
  vcpm: DecimalString | null;
}

/** Vollständigkeit einer Summe: alle, einige oder keine Werte vorhanden. */
export type Coverage = 'full' | 'partial' | 'none';

export function sumDecimals(values: readonly DecimalString[]): DecimalString {
  return formatDecimal(values.reduce((sum, value) => sum.plus(parseDecimal(value)), new Dec(0)));
}

/**
 * Summe über Werte, die fehlen können: Fehlende zählen nicht als 0, die Lücke steht in `coverage`. Eine leere
 * Liste ergibt `0` (vollständig); ob es überhaupt Zeilen gibt, zeigt die Oberfläche als Empty-Zustand.
 */
export function sumWithGaps(values: readonly (DecimalString | null)[]): {
  value: DecimalString | null;
  coverage: Coverage;
} {
  const present = values.filter((value): value is DecimalString => value !== null);
  if (present.length === 0 && values.length > 0) return { value: null, coverage: 'none' };
  return {
    value: sumDecimals(present),
    coverage: present.length === values.length ? 'full' : 'partial',
  };
}

function ratio(
  numerator: DecimalString | null,
  denominator: DecimalString | null,
  factor = 1,
): DecimalString | null {
  if (numerator === null || denominator === null) return null;
  const divisor = parseDecimal(denominator);
  if (divisor.isZero()) return null;
  return formatDecimal(parseDecimal(numerator).times(factor).div(divisor));
}

/** Anteil `part` an `total` als Bruch (0.25 = 25 %); `null` ohne Werte oder bei Gesamtwert 0. */
export function share(
  part: DecimalString | null,
  total: DecimalString | null,
): DecimalString | null {
  return ratio(part, total);
}

export function deriveMetrics(totals: MetricTotals): DerivedMetrics {
  const { impressions, clicks, cost, sales, purchases, viewableImpressions, viewableCost } = totals;
  return {
    ctr: ratio(clicks, impressions),
    cpc: ratio(cost, clicks),
    cvr: ratio(purchases, clicks),
    acos: ratio(cost, sales),
    roas: ratio(sales, cost),
    cpm: ratio(cost, impressions, 1000),
    vcpm: ratio(viewableCost, viewableImpressions, 1000),
  };
}

/** Veränderung zum Vergleichszeitraum; relativ bezogen auf den Betrag des Vergleichswerts. */
export function change(
  current: DecimalString | null,
  previous: DecimalString | null,
): { absolute: DecimalString | null; relative: DecimalString | null } {
  if (current === null || previous === null) return { absolute: null, relative: null };
  const difference = parseDecimal(current).minus(parseDecimal(previous));
  const base = parseDecimal(previous).abs();
  return {
    absolute: formatDecimal(difference),
    relative: base.isZero() ? null : formatDecimal(difference.div(base)),
  };
}
