import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';
import { applyBudgetGuardrail, type GuardrailReason } from './guardrails';
import { campaignPacing, computePacing, type PacingCampaign } from './pacing';

/**
 * Enforcer eines Budget-Caps (`phase-5.md` 5.9b, F6): Liegt die Prognose über dem Cap, sollen die aktiven Kampagnen
 * im Umfang nach dem Datenstand zusammen nur noch ausgeben, was vom Cap übrig ist. Jede bekommt denselben Anteil
 * ihres erwarteten Tagesschnitts als neues Tagesbudget, begrenzt durch die Budget-Leitplanke und Amazons Grenzen.
 * Liegt schon die untere Schätzung des Ist über dem Cap, schlägt er vor, die aktiven Kampagnen zu pausieren.
 */

export interface CapCampaign extends PacingCampaign {
  id: string;
  /** Amazons Grenzen fürs Tagesbudget. */
  limit: { min: DecimalString; max: DecimalString } | null;
}

export type CapAction =
  | { id: string; field: 'state' }
  | {
      id: string;
      field: 'budget';
      before: DecimalString;
      after: DecimalString;
      /** Budget, mit dem die Prognose den Cap träfe (vor den Leitplanken). */
      desired: DecimalString;
      limitedBy: GuardrailReason[];
    };

export function enforceCap(input: {
  /** `YYYY-MM`. */
  month: string;
  cap: DecimalString;
  campaigns: readonly CapCampaign[];
  maxBudgetDecreasePercent: number;
}): CapAction[] {
  const pacing = computePacing({ ...input, warnPercents: [] });
  const cap = parseDecimal(input.cap);
  const active = input.campaigns.filter((campaign) => campaign.active);
  if (parseDecimal(pacing.actual.low).gt(cap)) {
    return active.map(({ id }) => ({ id, field: 'state' }));
  }
  if (!pacing.forecastOver) return [];

  const future = parseDecimal(pacing.forecast.value).minus(parseDecimal(pacing.actual.value));
  const left = Dec.max(0, cap.minus(parseDecimal(pacing.actual.value)));
  const factor = left.div(future);
  return active.flatMap((campaign): CapAction[] => {
    const perDay = campaignPacing(input.month, campaign)?.perDay;
    if (campaign.dailyBudget === null || !perDay || perDay.isZero()) return [];
    const desired = formatDecimal(perDay.mul(factor).toDecimalPlaces(2));
    const result = applyBudgetGuardrail({
      proposed: desired,
      base: campaign.dailyBudget,
      maxDecreasePercent: input.maxBudgetDecreasePercent,
      limit: campaign.limit,
    });
    const before = parseDecimal(campaign.dailyBudget);
    if (!parseDecimal(result.value).lt(before)) return [];
    return [
      {
        id: campaign.id,
        field: 'budget',
        before: formatDecimal(before),
        after: result.value,
        desired,
        limitedBy: result.limitedBy,
      },
    ];
  });
}
