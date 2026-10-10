import type { AutomationRule } from '@profitbash/shared/automation-rules';
import { formatDecimal, parseDecimal, type DecimalString } from './decimal';
import { applyBidGuardrails, applyBudgetGuardrail, type GuardrailReason } from './guardrails';
import { suggestBid, type BidSuggestionInput } from './optimizer';
import { firstMatchingRule, ruleProposal, type RuleSubject } from './rules';

/**
 * Pipeline je Entity (`docs/tasks/phase-5.md` 5.7), ohne I/O: erste passende Regel, sonst (nur Targets) der
 * Optimizer, danach die Leitplanken. Das Ergebnis ist ein Vorschlag oder der Grund, warum es keinen gibt.
 */

export type Decision =
  | {
      kind: 'proposal';
      /** `state`: pausieren (`before`/`after` sind Zustände), sonst Beträge in der Währung des Profils. */
      field: 'bid' | 'budget' | 'state';
      before: string;
      after: string;
      source: 'rule' | 'optimizer';
      ruleId: string | null;
      limitedBy: GuardrailReason[];
      /** Gewünschter Wert vor den Leitplanken (Regel: ihr Ergebnis; Optimizer: Zielgebot). */
      desired?: DecimalString;
      /** Nur Optimizer: geglätteter Wert je Klick. */
      valuePerClick?: DecimalString;
    }
  | {
      kind: 'none';
      reason:
        | 'inactive'
        | 'vcpm'
        | 'noGoal'
        | 'noBase'
        | 'insufficientData'
        | 'unchanged'
        | 'protectedTerm'
        | 'noRule';
      /** Die Regel, die gegriffen hätte. */
      ruleId: string | null;
      /** Bei `unchanged`: die Leitplanken, die den Vorschlag aufgehalten haben. */
      limitedBy?: GuardrailReason[];
    };

const ACTIVE = 'ENABLED';
const none = (
  reason: Extract<Decision, { kind: 'none' }>['reason'],
  ruleId: string | null = null,
): Decision => ({ kind: 'none', reason, ruleId });
const pause = (rule: AutomationRule): Decision => ({
  kind: 'proposal',
  field: 'state',
  before: ACTIVE,
  after: 'PAUSED',
  source: 'rule',
  ruleId: rule.id,
  limitedBy: [],
});
/** Vorschlag aus dem begrenzten Wert; gleicht er der Basis, hat eine Leitplanke ihn aufgehalten. */
function limited(
  field: 'bid' | 'budget',
  rule: AutomationRule,
  base: DecimalString,
  desired: DecimalString,
  result: { value: DecimalString; limitedBy: GuardrailReason[] },
): Decision {
  if (parseDecimal(result.value).equals(parseDecimal(base))) {
    return { ...none('unchanged', rule.id), limitedBy: result.limitedBy };
  }
  return {
    kind: 'proposal',
    field,
    before: formatDecimal(parseDecimal(base)),
    after: result.value,
    source: 'rule',
    ruleId: rule.id,
    limitedBy: result.limitedBy,
    desired,
  };
}

export interface TargetDecisionInput extends BidSuggestionInput {
  rules: readonly AutomationRule[];
  /** Client des Profils; `null` ohne Client. */
  clientId: string | null;
  /** Summen des Targets, die der Optimizer nicht braucht. */
  impressions: number;
  orders: number;
  /** Ein Euro in der Währung des Profils. */
  eurRate: DecimalString;
  /** Geschützter Begriff des Clients: Regeln mit „pausieren“ oder „setzen“ gelten für ihn nicht. */
  protectedTerm: boolean;
}

export function decideTarget(input: TargetDecisionInput): Decision {
  const { target, adGroup, campaign } = input;
  if ([target, adGroup, campaign].some((entity) => entity.state !== ACTIVE))
    return none('inactive');
  // vCPM-Gebote gelten je 1000 Impressions (`plan.md` §5): weder Regeln noch Optimizer.
  if (campaign.costType?.toLowerCase() === 'vcpm') return none('vcpm');

  const rule = firstMatchingRule(input.rules, {
    level: 'target',
    clientId: input.clientId,
    metrics: { ...target.metrics, impressions: input.impressions, orders: input.orders },
    goalAcos: input.goalAcos,
    eurRate: input.eurRate,
  });
  if (rule === null) {
    const suggestion = suggestBid(input);
    if (suggestion.kind === 'none') return none(suggestion.reason);
    return {
      kind: 'proposal',
      field: 'bid',
      before: suggestion.base,
      after: suggestion.bid,
      source: 'optimizer',
      ruleId: null,
      limitedBy: suggestion.limitedBy,
      desired: suggestion.targetBid,
      valuePerClick: suggestion.valuePerClick,
    };
  }

  const { action } = rule;
  if (input.protectedTerm && (action.type === 'pause' || action.type === 'set')) {
    return none('protectedTerm', rule.id);
  }
  if (action.type === 'pause') return pause(rule);
  const base = input.base ?? target.bid ?? adGroup.defaultBid;
  if (base === null) return none('noBase', rule.id);
  const desired = (ruleProposal(action, base, input.eurRate) as { value: DecimalString }).value;
  const { clicks, spend } = target.metrics;
  return limited(
    'bid',
    rule,
    base,
    desired,
    applyBidGuardrails({
      proposed: desired,
      base,
      windowStart: input.windowStart ?? base,
      cpc: clicks > 0 ? formatDecimal(parseDecimal(spend).div(clicks)) : null,
      guardrails: input.guardrails,
      limit: input.limit,
    }),
  );
}

export interface CampaignDecisionInput {
  state: string;
  /** Tagesbudget bzw. der neueste Wert aus offenen Änderungen; `null` ohne Tagesbudget. */
  budget: DecimalString | null;
  metrics: RuleSubject['metrics'];
  goalAcos: DecimalString | null;
  maxBudgetDecreasePercent: number;
  limit: { min: DecimalString; max: DecimalString } | null;
  rules: readonly AutomationRule[];
  clientId: string | null;
  eurRate: DecimalString;
}

/** Kampagnen ändert nur eine Regel (Budget, pausieren); einen Optimizer für Budgets gibt es nicht. */
export function decideCampaign(input: CampaignDecisionInput): Decision {
  if (input.state !== ACTIVE) return none('inactive');
  const rule = firstMatchingRule(input.rules, {
    level: 'campaign',
    clientId: input.clientId,
    metrics: input.metrics,
    goalAcos: input.goalAcos,
    eurRate: input.eurRate,
  });
  if (rule === null) return none('noRule');
  if (rule.action.type === 'pause') return pause(rule);
  if (input.budget === null) return none('noBase', rule.id);
  const desired = (ruleProposal(rule.action, input.budget, input.eurRate) as { value: string })
    .value;
  return limited(
    'budget',
    rule,
    input.budget,
    desired,
    applyBudgetGuardrail({
      proposed: desired,
      base: input.budget,
      maxDecreasePercent: input.maxBudgetDecreasePercent,
      limit: input.limit,
    }),
  );
}
