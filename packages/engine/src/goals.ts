import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';

/**
 * Ziele (`docs/tasks/phase-5.md` 5.3, F4): Ziel-ACoS bzw. -ROAS je Client, Profil oder Produktgruppe. ACoS in
 * Prozent, ROAS als Faktor; das eine folgt aus dem anderen (ROAS = 100 / ACoS). Ohne I/O.
 */

export type GoalMetric = 'acos' | 'roas';
export type GoalScope = 'client' | 'profile' | 'productGroup';

export interface GoalSetting {
  scope: GoalScope;
  scopeId: string;
  metric: GoalMetric;
  /** ACoS in Prozent (`25` = 25 %) bzw. ROAS als Faktor. */
  value: DecimalString;
}

/** Stellen der umgerechneten Anzeige; der gesetzte Wert bleibt exakt. */
const DERIVED_PLACES = 2;
const HUNDRED = new Dec(100);

const round = (value: InstanceType<typeof Dec>) =>
  formatDecimal(value.toDecimalPlaces(DERIVED_PLACES, Dec.ROUND_HALF_EVEN));

function exactAcos(metric: GoalMetric, value: DecimalString) {
  const parsed = parseDecimal(value);
  return metric === 'acos' ? parsed : HUNDRED.div(parsed);
}

/** ACoS und ROAS eines Ziels: der gesetzte Wert exakt, der andere auf zwei Stellen. */
export function goalValues(
  metric: GoalMetric,
  value: DecimalString,
): { acos: DecimalString; roas: DecimalString } {
  const parsed = parseDecimal(value);
  return metric === 'acos'
    ? { acos: formatDecimal(parsed), roas: round(HUNDRED.div(parsed)) }
    : { acos: round(HUNDRED.div(parsed)), roas: formatDecimal(parsed) };
}

export interface EffectiveGoal extends GoalSetting {
  source: GoalScope;
  acos: DecimalString;
  roas: DecimalString;
}

/**
 * Wirksames Ziel eines Targets bzw. einer Kampagne: Produktgruppe vor Profil vor Client. Gehört das Beworbene zu
 * mehreren Produktgruppen mit Ziel, gilt das strengste (niedrigster ACoS). SB und SD ohne eindeutige ASIN geben keine
 * Produktgruppen an und nehmen so das Ziel des Profils bzw. Clients.
 */
export function effectiveGoal(
  goals: readonly GoalSetting[],
  target: { clientId: string | null; profileId: string; productGroupIds: readonly string[] },
): EffectiveGoal | null {
  const groupIds = new Set(target.productGroupIds);
  const groupGoals = goals.filter((g) => g.scope === 'productGroup' && groupIds.has(g.scopeId));
  let chosen: GoalSetting | undefined = groupGoals.reduce<GoalSetting | undefined>(
    (best, goal) =>
      best === undefined ||
      exactAcos(goal.metric, goal.value).lt(exactAcos(best.metric, best.value))
        ? goal
        : best,
    undefined,
  );
  chosen ??= goals.find((g) => g.scope === 'profile' && g.scopeId === target.profileId);
  if (!chosen && target.clientId !== null) {
    chosen = goals.find((g) => g.scope === 'client' && g.scopeId === target.clientId);
  }
  if (!chosen) return null;
  return { ...chosen, source: chosen.scope, ...goalValues(chosen.metric, chosen.value) };
}

export interface TargetAcosInput {
  /** Verkaufspreis je Einheit (brutto wie bei Amazon angezeigt, ohne Umsatzsteuer nach Wahl des Nutzers). */
  price: DecimalString;
  /** Kosten je Einheit (Einkauf, Versand zum Lager). */
  unitCost: DecimalString;
  /** Amazon-Gebühren je Einheit (Verkaufs- und Versandgebühr). */
  fees: DecimalString;
  /** Gewünschte Marge nach Werbung in Prozentpunkten vom Preis. */
  margin: DecimalString;
}

/**
 * Rechner Ziel-ACoS (5.3): Break-even-ACoS = (Preis − Kosten − Gebühren) / Preis; Ziel-ACoS = Break-even − Marge.
 * Bleibt kein positiver Ziel-ACoS, ist das Ziel `null` (Werbung kann sich bei diesen Zahlen nicht tragen).
 */
export function calculateTargetAcos(input: TargetAcosInput): {
  breakEvenAcos: DecimalString;
  targetAcos: DecimalString | null;
  targetRoas: DecimalString | null;
} {
  const price = parseDecimal(input.price);
  if (!price.gt(0)) throw new RangeError('Der Preis muss größer als 0 sein.');
  const breakEven = price
    .minus(parseDecimal(input.unitCost))
    .minus(parseDecimal(input.fees))
    .div(price)
    .times(HUNDRED);
  const target = breakEven.minus(parseDecimal(input.margin));
  const roundedTarget = target.toDecimalPlaces(DERIVED_PLACES, Dec.ROUND_HALF_EVEN);
  return {
    breakEvenAcos: round(breakEven),
    targetAcos: roundedTarget.gt(0) ? formatDecimal(roundedTarget) : null,
    targetRoas: roundedTarget.gt(0) ? round(HUNDRED.div(target)) : null,
  };
}
