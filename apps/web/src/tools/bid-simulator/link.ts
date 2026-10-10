import {
  BID_STACK_STRATEGIES,
  MAX_BID_ADJUSTMENT_PERCENT,
  type BidStackStrategy,
} from '@profitbash/engine';

/**
 * Aufruf des Gebots-Stack-Simulators (`phase-4.md` 4.8, F12): Die Explorer-Zeile einer SP-Kampagne gibt Strategie,
 * Platzierungen, Amazon Business und Währung als wenige Query-Werte mit (keine IDs); die Seite liest sie zurück und
 * nimmt bei ungültigen Werten die Vorgaben.
 */

export const BID_SIMULATOR_PATH = '/ads/tools/bid-simulator';
const DEFAULT_STRATEGY: BidStackStrategy = 'SALES_DOWN_ONLY';

const PLACEMENT_KEYS = {
  PLACEMENT_TOP: 'top',
  PLACEMENT_PRODUCT_PAGE: 'pp',
  PLACEMENT_REST_OF_SEARCH: 'ros',
  SITE_AMAZON_BUSINESS: 'ab',
} as const;

export function simulatorLink(row: { name: string | null; attributes: Record<string, unknown> }): {
  path: string;
  query: Record<string, string>;
} {
  const { biddingStrategy, budgetCurrencyCode, placementBidAdjustments } = row.attributes;
  const placements: Record<string, string> = { top: '0', pp: '0', ros: '0' };
  if (Array.isArray(placementBidAdjustments)) {
    for (const entry of placementBidAdjustments as {
      placement?: unknown;
      percentage?: unknown;
    }[]) {
      const key = PLACEMENT_KEYS[entry.placement as keyof typeof PLACEMENT_KEYS];
      if (key !== undefined && entry.percentage !== undefined)
        placements[key] = String(entry.percentage);
    }
  }
  return {
    path: BID_SIMULATOR_PATH,
    query: {
      ...(row.name && { name: row.name }),
      ...(typeof biddingStrategy === 'string' && { strategy: biddingStrategy }),
      ...(typeof budgetCurrencyCode === 'string' && { currency: budgetCurrencyCode }),
      ...placements,
    },
  };
}

export interface SimulatorState {
  name: string | null;
  bid: string;
  strategy: BidStackStrategy;
  currency: string | null;
  top: number;
  productPages: number;
  restOfSearch: number;
  amazonBusiness: number | null;
}

type QueryValue = string | null | undefined | (string | null)[];
const one = (value: QueryValue) => (Array.isArray(value) ? value[0] : value) ?? undefined;
const percentOf = (value: QueryValue): number | null => {
  const text = one(value);
  if (text === undefined || !/^\d{1,3}$/.test(text)) return null;
  const number = Number(text);
  return number <= MAX_BID_ADJUSTMENT_PERCENT ? number : null;
};

export function simulatorStateFromQuery(query: Record<string, QueryValue>): SimulatorState {
  const strategy = one(query.strategy);
  const currency = one(query.currency);
  const bid = one(query.bid);
  return {
    name: one(query.name) ?? null,
    bid: bid !== undefined && /^\d{1,7}(\.\d{1,2})?$/.test(bid) ? bid : '1.00',
    strategy: BID_STACK_STRATEGIES.includes(strategy as BidStackStrategy)
      ? (strategy as BidStackStrategy)
      : DEFAULT_STRATEGY,
    currency: currency !== undefined && /^[A-Z]{3}$/.test(currency) ? currency : null,
    top: percentOf(query.top) ?? 0,
    productPages: percentOf(query.pp) ?? 0,
    restOfSearch: percentOf(query.ros) ?? 0,
    amazonBusiness: percentOf(query.ab),
  };
}
