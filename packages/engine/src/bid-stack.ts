import { Dec } from './decimal';

/**
 * Gebots-Stack-Simulator (`docs/tasks/phase-4.md` 4.8, F12), ohne I/O: welches Gebot aus Basisgebot, Strategie und
 * Anpassungen je Platzierung höchstens bzw. mindestens entsteht.
 *
 * Regeln (geprüft 2026-10-10 gegen die SP-v3-Spec und den Amazon-Guide „dynamische Gebote“):
 * - **Anpassungen multiplizieren sich** (je 0–900 %): Platzierung (oben in der Suche, Produktseiten, Rest der Suche),
 *   Amazon Business (`SITE_AMAZON_BUSINESS`, nur für Käufer von Amazon Business) und Zielgruppe
 *   (`shopperCohortBidding`, höchstens 10 je Kampagne). Beispiel der Spec: 1,00 × 1,5 (oben) × 2 (Business) = 3,00.
 * - **Strategie** wirkt auf das angepasste Gebot: „dynamisch hoch und runter“ ±100 % auf **allen** Platzierungen
 *   (der Guide nennt nicht mehr +50 % außerhalb von „oben“), „nur senken“ bis −100 %, „fest“ unverändert.
 *   Regelbasierte Gebote beziffert Amazon nicht: Spanne wie „fest“ mit Hinweis.
 * - Beträge als Decimal, Ausgabe auf zwei Nachkommastellen (half-even, ADR 003).
 */

export const BID_STACK_STRATEGIES = [
  'SALES_DOWN_ONLY',
  'SALES_UP_AND_DOWN',
  'NONE',
  'RULE_BASED',
] as const;
export type BidStackStrategy = (typeof BID_STACK_STRATEGIES)[number];
export const BID_STACK_PLACEMENTS = ['top', 'productPages', 'restOfSearch'] as const;
export type BidStackPlacement = (typeof BID_STACK_PLACEMENTS)[number];
export const MAX_BID_ADJUSTMENT_PERCENT = 900;
export const MAX_BID_STACK_AUDIENCES = 10;

export interface BidStackInput {
  /** Basisgebot (Decimal-String, größer 0). */
  bid: string;
  strategy: BidStackStrategy;
  /** Platzierungs-Anpassungen in Prozent (ganzzahlig, 0–900). */
  placements: Record<BidStackPlacement, number>;
  /** Anpassung für Amazon Business in Prozent; `null`: nicht gesetzt. */
  amazonBusiness: number | null;
  /** Zielgruppen-Anpassungen in Prozent. */
  audiences: readonly { label: string; percentage: number }[];
}

export interface BidStackRow {
  placement: BidStackPlacement;
  amazonBusiness: boolean;
  /** Bezeichnung der Zielgruppe; `null`: ohne Zielgruppen-Anpassung. */
  audience: string | null;
  /** Produkt der Anpassungen (vor der Strategie). */
  factor: string;
  min: string;
  max: string;
}

export interface BidStackResult {
  rows: BidStackRow[];
  /** Höchstes mögliches Gebot über alle Zeilen. */
  highest: string;
  hints: 'ruleBasedUnknown'[];
}

const percent = (value: number) => {
  if (!Number.isInteger(value) || value < 0 || value > MAX_BID_ADJUSTMENT_PERCENT) {
    throw new RangeError(`Anpassung ${value} % liegt nicht zwischen 0 und 900.`);
  }
  return new Dec(100 + value).div(100);
};

/** Spanne der Strategie als Faktoren auf das angepasste Gebot. */
const STRATEGY_RANGE: Record<BidStackStrategy, [number, number]> = {
  SALES_UP_AND_DOWN: [0, 2],
  SALES_DOWN_ONLY: [0, 1],
  NONE: [1, 1],
  RULE_BASED: [1, 1],
};

const money = (value: Dec) => value.toDecimalPlaces(2, Dec.ROUND_HALF_EVEN).toFixed(2);

export function simulateBidStack(input: BidStackInput): BidStackResult {
  let bid: Dec;
  try {
    bid = new Dec(input.bid);
  } catch {
    throw new RangeError('Das Basisgebot ist keine Zahl.');
  }
  if (!bid.isFinite() || bid.lte(0)) throw new RangeError('Das Basisgebot muss größer 0 sein.');
  if (input.audiences.length > MAX_BID_STACK_AUDIENCES) {
    throw new RangeError(`Höchstens ${MAX_BID_STACK_AUDIENCES} Zielgruppen je Kampagne.`);
  }
  const business = input.amazonBusiness === null ? null : percent(input.amazonBusiness);
  const audiences = [
    { label: null, factor: new Dec(1) },
    ...input.audiences.map((entry) => ({ label: entry.label, factor: percent(entry.percentage) })),
  ];
  const [low, high] = STRATEGY_RANGE[input.strategy];

  const rows: BidStackRow[] = [];
  let highest = new Dec(0);
  for (const placement of BID_STACK_PLACEMENTS) {
    const placementFactor = percent(input.placements[placement]);
    for (const withBusiness of business === null ? [false] : [false, true]) {
      for (const audience of audiences) {
        let factor = placementFactor.mul(audience.factor);
        if (withBusiness) factor = factor.mul(business!);
        const adjusted = bid.mul(factor);
        const max = adjusted.mul(high);
        if (max.gt(highest)) highest = max;
        rows.push({
          placement,
          amazonBusiness: withBusiness,
          audience: audience.label,
          factor: factor.toFixed(),
          min: money(adjusted.mul(low)),
          max: money(max),
        });
      }
    }
  }
  return {
    rows,
    highest: money(highest),
    hints: input.strategy === 'RULE_BASED' ? ['ruleBasedUnknown'] : [],
  };
}
