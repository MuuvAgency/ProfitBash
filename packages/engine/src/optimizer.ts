import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';
import {
  applyBidGuardrails,
  hasMinimumData,
  type BidGuardrails,
  type GuardrailReason,
} from './guardrails';

/**
 * Optimizer (`docs/tasks/phase-5.md` 5.5), ohne I/O: Gebotsvorschlag je Target aus den Zeitraumsummen der
 * Bulk-Datei und dem wirksamen Ziel.
 *
 *   Wert je Klick  = (Umsatz + k × Wert je Klick der Ebene darüber) / (Klicks + k)
 *   Zielgebot      = Wert je Klick × Ziel-ACoS
 *
 * Die Ebene darüber ist die Ad Group, die ihrerseits gegen die Kampagne geglättet wird; die Kampagne zählt roh.
 * `k` (`priorClicks`) ist das Gewicht der Ebene darüber in Klicks: Ein Target mit wenigen Klicks folgt seiner
 * Ad Group, eines mit vielen seinen eigenen Zahlen. Ohne Bestellung sinkt der Wert je Klick so mit jedem weiteren
 * Klick, statt sofort auf null zu fallen. Danach begrenzen die Leitplanken (`guardrails.ts`).
 */

/** Eigener Startwert für `k`. */
export const OPTIMIZER_PRIOR_CLICKS = 12;

export interface PeriodSums {
  clicks: number;
  spend: DecimalString;
  sales: DecimalString;
}

export interface BidSuggestionInput {
  /** `bid`: eigenes Gebot; `null` bei Targets ohne eigenes Gebot (auch Auto-Targets). */
  target: { state: string; bid: DecimalString | null; metrics: PeriodSums };
  adGroup: { state: string; defaultBid: DecimalString | null; metrics: PeriodSums | null };
  /** `costType`: `extra.costType` der Kampagne; vCPM-Gebote gelten je 1000 Impressions und bleiben außen vor. */
  campaign: { state: string; costType: string | null; metrics: PeriodSums | null };
  /** Wirksames Ziel in Prozent (`effectiveGoal().acos`); `null` ohne Ziel. */
  goalAcos: DecimalString | null;
  /** Leitplanken in der Währung des Profils. */
  guardrails: BidGuardrails & { minClicks: number; minSpend: DecimalString };
  limit: { min: DecimalString; max: DecimalString } | null;
  /** Ausgangsgebot, wenn Änderungen offen oder unterwegs sind; sonst Gebot des Targets bzw. Standardgebot. */
  base?: DecimalString;
  /** Gebot zu Beginn der letzten 7 Tage; ohne Änderungen im Fenster das Ausgangsgebot. */
  windowStart?: DecimalString;
  priorClicks?: number;
}

export type BidSuggestion =
  | {
      kind: 'suggestion';
      /** Vorgeschlagenes Gebot nach den Leitplanken. */
      bid: DecimalString;
      base: DecimalString;
      /** `false`: Das Target hatte kein eigenes Gebot, der Vorschlag setzt eines. */
      hasOwnBid: boolean;
      /** Geglätteter Wert je Klick und Zielgebot vor den Leitplanken, vier Stellen (fürs Protokoll). */
      valuePerClick: DecimalString;
      targetBid: DecimalString;
      limitedBy: GuardrailReason[];
    }
  | {
      kind: 'none';
      reason: 'inactive' | 'vcpm' | 'noGoal' | 'noBase' | 'insufficientData' | 'unchanged';
    };

const ACTIVE = 'ENABLED';
const none = (reason: Extract<BidSuggestion, { kind: 'none' }>['reason']): BidSuggestion => ({
  kind: 'none',
  reason,
});
const places4 = (value: Dec) => formatDecimal(value.toDecimalPlaces(4));

/** Wert je Klick einer Ebene, geglättet gegen die darüber (`prior`); `null` ohne Klicks und ohne Ebene darüber. */
function valuePerClick(
  sums: PeriodSums | null,
  prior: Dec | null,
  priorClicks: number,
): Dec | null {
  if (sums === null) return prior;
  const weight = prior === null ? 0 : priorClicks;
  const clicks = sums.clicks + weight;
  if (clicks === 0) return null;
  return parseDecimal(sums.sales)
    .plus((prior ?? new Dec(0)).times(weight))
    .div(clicks);
}

export function suggestBid(input: BidSuggestionInput): BidSuggestion {
  const { target, adGroup, campaign, guardrails } = input;
  if ([target, adGroup, campaign].some((entity) => entity.state !== ACTIVE))
    return none('inactive');
  if (campaign.costType?.toLowerCase() === 'vcpm') return none('vcpm');
  if (input.goalAcos === null) return none('noGoal');
  const base = input.base ?? target.bid ?? adGroup.defaultBid;
  if (base === null) return none('noBase');
  if (!hasMinimumData(target.metrics, guardrails)) return none('insufficientData');

  const k = input.priorClicks ?? OPTIMIZER_PRIOR_CLICKS;
  const value = valuePerClick(
    target.metrics,
    valuePerClick(adGroup.metrics, valuePerClick(campaign.metrics, null, k), k),
    k,
  );
  if (value === null) return none('insufficientData');
  const targetBid = value.times(parseDecimal(input.goalAcos)).div(100);
  const { clicks, spend } = target.metrics;
  const limited = applyBidGuardrails({
    proposed: formatDecimal(targetBid),
    base,
    windowStart: input.windowStart ?? base,
    cpc: clicks > 0 ? formatDecimal(parseDecimal(spend).div(clicks)) : null,
    guardrails,
    limit: input.limit,
  });
  if (parseDecimal(limited.value).equals(base)) return none('unchanged');
  return {
    kind: 'suggestion',
    bid: limited.value,
    base: formatDecimal(parseDecimal(base)),
    hasOwnBid: target.bid !== null,
    valuePerClick: places4(value),
    targetBid: places4(targetBid),
    limitedBy: limited.limitedBy,
  };
}
