import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';

/**
 * Leitplanken der Automatik (`docs/tasks/phase-5.md` 5.4, F-S6), ohne I/O: Sie begrenzen jeden Vorschlag, egal ob er
 * vom Optimizer, aus einer Regel oder vom Budget-Enforcer kommt, und nennen, was begrenzt hat. Beträge in der
 * Währung des Profils (die EUR-Werte der Einstellungen rechnet der Lauf vorher um). Eine Leitplanke hält einen
 * Vorschlag auf, sie dreht aber nie einen bestehenden Wert zurück; nur Amazons Grenzen gelten in jedem Fall.
 */

export interface BidGuardrails {
  /** Höchste Änderung je 7 Tage in Prozent des Werts zu Beginn des Fensters, beide Richtungen. */
  maxBidChangePercent: number;
  /** Boden als Anteil des realisierten CPC in Prozent. */
  bidFloorCpcPercent: number;
  /** Absoluter Boden bzw. Höchstgebot; `null` = keiner. */
  bidFloor: DecimalString | null;
  maxBid: DecimalString | null;
}

export type GuardrailReason =
  'weeklyChange' | 'bidFloor' | 'maxBid' | 'budgetDecrease' | 'amazonMin' | 'amazonMax';

export interface GuardrailResult {
  value: DecimalString;
  /** Leitplanken, die den Wert verändert haben, in der Reihenfolge der Anwendung. */
  limitedBy: GuardrailReason[];
}

interface AmazonLimit {
  min: DecimalString;
  max: DecimalString;
}

// shortcut: zwei Nachkommastellen für alle Währungen; für JPY (keine) die Stellen je Währung hereinreichen.
const PLACES = 2;

function clampToAmazon(value: Dec, limit: AmazonLimit | null, limitedBy: GuardrailReason[]): Dec {
  if (limit && value.lessThan(limit.min)) {
    limitedBy.push('amazonMin');
    return parseDecimal(limit.min);
  }
  if (limit && value.greaterThan(limit.max)) {
    limitedBy.push('amazonMax');
    return parseDecimal(limit.max);
  }
  return value;
}

export function applyBidGuardrails(input: {
  proposed: DecimalString;
  /** Ausgangsgebot: neuester Wert aus offenen, übermittelten und angewendeten Änderungen, sonst der der Entity. */
  base: DecimalString;
  /** Gebot zu Beginn der letzten 7 Tage (Wert vor der ältesten Änderung im Fenster), ohne Änderung gleich `base`. */
  windowStart: DecimalString;
  /** Realisierter CPC im Zeitraum; `null` ohne Klicks. */
  cpc: DecimalString | null;
  guardrails: BidGuardrails;
  /** Amazons Grenze (`limitFor`); `null`, wenn keine bekannt ist. */
  limit: AmazonLimit | null;
}): GuardrailResult {
  const { guardrails } = input;
  const base = parseDecimal(input.base);
  const windowStart = parseDecimal(input.windowStart);
  const raise = parseDecimal(input.proposed).greaterThan(base);
  const limitedBy: GuardrailReason[] = [];
  let value = parseDecimal(input.proposed);

  /** Hält `value` an `bound` auf, aber nie hinter der Basis. */
  const hold = (bound: Dec, reason: GuardrailReason) => {
    const held = raise ? Dec.max(base, Dec.min(value, bound)) : Dec.min(base, Dec.max(value, bound));
    if (!held.equals(value)) limitedBy.push(reason);
    value = held;
  };

  const share = new Dec(guardrails.maxBidChangePercent).div(100);
  hold(windowStart.times(raise ? share.plus(1) : new Dec(1).minus(share)), 'weeklyChange');
  if (raise) {
    if (guardrails.maxBid !== null) hold(parseDecimal(guardrails.maxBid), 'maxBid');
  } else {
    const floors = [
      ...(input.cpc === null
        ? []
        : [parseDecimal(input.cpc).times(guardrails.bidFloorCpcPercent).div(100)]),
      ...(guardrails.bidFloor === null ? [] : [parseDecimal(guardrails.bidFloor)]),
    ];
    if (floors.length > 0) hold(Dec.max(...floors), 'bidFloor');
  }
  // Zur Basis hin runden: so überschreitet der gerundete Wert keine Leitplanke.
  value = value.toDecimalPlaces(PLACES, raise ? Dec.ROUND_DOWN : Dec.ROUND_UP);
  return { value: formatDecimal(clampToAmazon(value, input.limit, limitedBy)), limitedBy };
}

/** Budget: Senkung je Lauf höchstens `maxDecreasePercent` der Basis; Erhöhungen begrenzt nur Amazon. */
export function applyBudgetGuardrail(input: {
  proposed: DecimalString;
  base: DecimalString;
  maxDecreasePercent: number;
  limit: AmazonLimit | null;
}): GuardrailResult {
  const limitedBy: GuardrailReason[] = [];
  let value = parseDecimal(input.proposed);
  const lowest = parseDecimal(input.base)
    .times(new Dec(100).minus(input.maxDecreasePercent))
    .div(100)
    .toDecimalPlaces(PLACES, Dec.ROUND_UP);
  if (value.lessThan(lowest)) {
    limitedBy.push('budgetDecrease');
    value = lowest;
  }
  return { value: formatDecimal(clampToAmazon(value, input.limit, limitedBy)), limitedBy };
}

/** Mindestdaten für einen Vorschlag: genug Klicks **oder** genug Ausgaben (auch Ausgaben ohne Bestellung sagen etwas). */
export function hasMinimumData(
  metrics: { clicks: number; spend: DecimalString },
  minimum: { minClicks: number; minSpend: DecimalString },
): boolean {
  return (
    metrics.clicks >= minimum.minClicks ||
    parseDecimal(metrics.spend).greaterThanOrEqualTo(minimum.minSpend)
  );
}
