import type {
  AutomationRule,
  RuleAction,
  RuleComparator,
  RuleCondition,
  RuleLevel,
} from '@profitbash/shared/automation-rules';
import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';

// Aus `@profitbash/shared/automation-rules` (eigener Einstiegspunkt): Die Wurzel zöge Browser- und Node-Typen herein.

/**
 * Regeln der Automatik (`docs/tasks/phase-5.md` 5.6a), ohne I/O: Je Target bzw. Kampagne gewinnt die erste
 * passende Regel der Liste. Ihre Aktion ergibt den gewünschten Wert; die Leitplanken (`guardrails.ts`) begrenzen ihn
 * danach wie jeden Vorschlag.
 */

export interface RuleSubject {
  level: RuleLevel;
  /** Client des Profils; `null` ohne Client. */
  clientId: string | null;
  /** Summen des Zeitraums, Beträge in der Währung des Profils. */
  metrics: {
    impressions: number;
    clicks: number;
    orders: number;
    spend: DecimalString;
    sales: DecimalString;
  };
  /** Wirksames Ziel in Prozent; `null` ohne Ziel. */
  goalAcos: DecimalString | null;
  /** Ein Euro in der Währung des Profils: Beträge der Regeln sind in EUR. */
  eurRate: DecimalString;
}

const COMPARE: Record<RuleComparator, (actual: Dec, threshold: Dec) => boolean> = {
  gt: (a, b) => a.greaterThan(b),
  gte: (a, b) => a.greaterThanOrEqualTo(b),
  lt: (a, b) => a.lessThan(b),
  lte: (a, b) => a.lessThanOrEqualTo(b),
};
const AMOUNTS: ReadonlySet<string> = new Set(['spend', 'sales', 'cpc']);

/** Wert der Kennzahl; `null`, wenn es keinen gibt (ACoS ohne Ausgaben, CPC ohne Klicks). */
function metricValue(metric: RuleCondition['metric'], { metrics }: RuleSubject): Dec | null {
  const spend = parseDecimal(metrics.spend);
  switch (metric) {
    case 'spend':
      return spend;
    case 'sales':
      return parseDecimal(metrics.sales);
    case 'acos': {
      const sales = parseDecimal(metrics.sales);
      if (!sales.isZero()) return spend.div(sales).times(100);
      // Ausgaben ohne Umsatz: über jeder Schwelle.
      return spend.isZero() ? null : new Dec(Infinity);
    }
    case 'cpc':
      return metrics.clicks === 0 ? null : spend.div(metrics.clicks);
    default:
      return new Dec(metrics[metric]);
  }
}

function conditionHolds(condition: RuleCondition, subject: RuleSubject): boolean {
  const actual = metricValue(condition.metric, subject);
  if (actual === null) return false;
  let threshold = parseDecimal(condition.value);
  if (condition.relativeToGoal) {
    if (subject.goalAcos === null) return false;
    threshold = threshold.times(parseDecimal(subject.goalAcos)).div(100);
  } else if (AMOUNTS.has(condition.metric)) {
    threshold = threshold.times(parseDecimal(subject.eurRate));
  }
  return COMPARE[condition.comparator](actual, threshold);
}

export function firstMatchingRule(
  rules: readonly AutomationRule[],
  subject: RuleSubject,
): AutomationRule | null {
  return (
    rules.find(
      (rule) =>
        rule.enabled &&
        rule.level === subject.level &&
        (rule.clientId === null || rule.clientId === subject.clientId) &&
        rule.conditions.every((condition) => conditionHolds(condition, subject)),
    ) ?? null
  );
}

/** Gewünschter Wert (Gebot bzw. Budget in der Währung des Profils, ungerundet, nie unter 0) oder „pausieren“. */
export function ruleProposal(
  action: RuleAction,
  current: DecimalString,
  eurRate: DecimalString,
): { value: DecimalString } | { pause: true } {
  if (action.type === 'pause') return { pause: true };
  const before = parseDecimal(current);
  const amount = parseDecimal(action.value);
  const rate = parseDecimal(eurRate);
  const after =
    action.type === 'changePercent'
      ? before.times(amount.plus(100)).div(100)
      : action.type === 'changeAbsolute'
        ? before.plus(amount.times(rate))
        : amount.times(rate);
  return { value: formatDecimal(Dec.max(after, 0)) };
}
