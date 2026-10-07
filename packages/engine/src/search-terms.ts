import { Dec, formatDecimal, parseDecimal, type DecimalString } from './decimal';

/**
 * Suchbegriff-Analyse ohne I/O (`docs/tasks/phase-2b.md` 2b.2): Wortbausteine (N-Gramme) und die Einstufung
 * Harvest / Negieren / Beobachten. Die Schwellen sind Daten des Aufrufers (Regeln je Organisation), nichts
 * davon steht hier fest. Gerechnet wird je Datei-Zeitraum; Summen über mehrere Zeiträume bildet der Aufrufer nie.
 */

/** Summen einer Suchbegriff-Zeile bzw. eines N-Gramms in einer Währung. */
export interface SearchTermSums {
  impressions: DecimalString;
  clicks: DecimalString;
  cost: DecimalString;
  sales: DecimalString;
  purchases: DecimalString;
  units: DecimalString;
}

const SUM_KEYS = ['impressions', 'clicks', 'cost', 'sales', 'purchases', 'units'] as const;

export const NGRAM_SIZES = [1, 2, 3] as const;
export type NgramSize = (typeof NGRAM_SIZES)[number];

export interface Ngram extends SearchTermSums {
  size: NgramSize;
  /** Wörter klein geschrieben, mit einem Leerzeichen verbunden. */
  gram: string;
  /** Anzahl verschiedener Suchbegriffe, in denen der Baustein vorkommt. */
  searchTerms: number;
}

/** Wörter eines Suchbegriffs: klein geschrieben, an Leerraum getrennt; Satzzeichen bleiben im Wort. */
export function tokenizeSearchTerm(term: string): string[] {
  return term
    .normalize('NFC')
    .toLowerCase()
    .split(/\s+/u)
    .filter((word) => word !== '');
}

/**
 * N-Gramme über alle Zeilen. Jede Zeile zählt für einen Baustein höchstens einmal (auch wenn er im Begriff
 * mehrfach steht); derselbe Suchbegriff aus mehreren Targets zählt als ein Begriff, seine Zeilen werden summiert.
 * Sortiert nach Spend absteigend, dann Länge und Text.
 */
export function buildNgrams(
  rows: readonly (SearchTermSums & { searchTerm: string })[],
  sizes: readonly NgramSize[] = NGRAM_SIZES,
): Ngram[] {
  const groups = new Map<
    string,
    { size: NgramSize; gram: string; terms: Set<string>; sums: Record<keyof SearchTermSums, Dec> }
  >();
  for (const row of rows) {
    const words = tokenizeSearchTerm(row.searchTerm);
    const term = words.join(' ');
    const seen = new Set<string>();
    for (const size of sizes) {
      for (let start = 0; start + size <= words.length; start++) {
        const gram = words.slice(start, start + size).join(' ');
        const key = `${size}:${gram}`;
        if (seen.has(key)) continue;
        seen.add(key);
        let group = groups.get(key);
        if (!group) {
          group = { size, gram, terms: new Set(), sums: zeroSums() };
          groups.set(key, group);
        }
        group.terms.add(term);
        for (const sumKey of SUM_KEYS) {
          group.sums[sumKey] = group.sums[sumKey].plus(parseDecimal(row[sumKey]));
        }
      }
    }
  }
  return [...groups.values()]
    .sort(
      (a, b) =>
        b.sums.cost.comparedTo(a.sums.cost) ||
        a.size - b.size ||
        (a.gram < b.gram ? -1 : a.gram > b.gram ? 1 : 0),
    )
    .map(({ size, gram, terms, sums }) => ({
      size,
      gram,
      searchTerms: terms.size,
      impressions: formatDecimal(sums.impressions),
      clicks: formatDecimal(sums.clicks),
      cost: formatDecimal(sums.cost),
      sales: formatDecimal(sums.sales),
      purchases: formatDecimal(sums.purchases),
      units: formatDecimal(sums.units),
    }));
}

function zeroSums(): Record<keyof SearchTermSums, Dec> {
  return {
    impressions: new Dec(0),
    clicks: new Dec(0),
    cost: new Dec(0),
    sales: new Dec(0),
    purchases: new Dec(0),
    units: new Dec(0),
  };
}

/** Regeln der Einstufung (Daten je Organisation). Beträge in der Währung des Profils, ACoS als Bruch (0.25 = 25 %). */
export interface SearchTermRules {
  /** Harvest ab so vielen Käufen … */
  harvestMinPurchases: number;
  /** … und einem ACoS von höchstens diesem Ziel. */
  harvestMaxAcos: DecimalString;
  /** Negieren ab so vielen Klicks ohne Kauf … */
  negateMinClicks: number;
  /** … und mindestens diesem Spend. */
  negateMinCost: DecimalString;
}

export const SEARCH_TERM_CLASSES = ['harvest', 'negate', 'watch'] as const;
export type SearchTermClass = (typeof SEARCH_TERM_CLASSES)[number];

/** Warum ein Begriff nur beobachtet wird. */
export const SEARCH_TERM_WATCH_REASONS = [
  'protected',
  'alreadyTargeted',
  'acosAboveTarget',
  'tooFewData',
] as const;
export type SearchTermWatchReason = (typeof SEARCH_TERM_WATCH_REASONS)[number];

export interface SearchTermClassification {
  classification: SearchTermClass;
  /** Nur bei `watch`. */
  reason: SearchTermWatchReason | null;
}

/**
 * Enthält der Suchbegriff einen geschützten Begriff als ganze, zusammenhängende Wortfolge? Wortteile zählen
 * nicht („nordwind“ schützt nicht „nordwinde“).
 */
export function isProtectedSearchTerm(
  searchTerm: string,
  protectedTerms: readonly string[],
): boolean {
  const words = tokenizeSearchTerm(searchTerm);
  return protectedTerms.some((entry) => {
    const needle = tokenizeSearchTerm(entry);
    if (needle.length === 0) return false;
    for (let start = 0; start + needle.length <= words.length; start++) {
      if (needle.every((word, offset) => words[start + offset] === word)) return true;
    }
    return false;
  });
}

/**
 * Einstufung einer Suchbegriff-Zeile. Negieren: genug Klicks, kein Kauf, genug Spend; geschützte Begriffe nie.
 * Harvest: genug Käufe, ACoS höchstens am Ziel und noch kein exaktes Target (`alreadyTargeted`). Sonst
 * Beobachten mit Grund. Grenzwerte zählen mit.
 */
export function classifySearchTerm(
  row: SearchTermSums & { searchTerm: string; alreadyTargeted: boolean },
  rules: SearchTermRules,
  protectedTerms: readonly string[],
): SearchTermClassification {
  const watch = (reason: SearchTermWatchReason): SearchTermClassification => ({
    classification: 'watch',
    reason,
  });
  const purchases = parseDecimal(row.purchases);
  const cost = parseDecimal(row.cost);

  if (
    purchases.isZero() &&
    parseDecimal(row.clicks).gte(rules.negateMinClicks) &&
    cost.gte(parseDecimal(rules.negateMinCost))
  ) {
    return isProtectedSearchTerm(row.searchTerm, protectedTerms)
      ? watch('protected')
      : { classification: 'negate', reason: null };
  }

  if (purchases.isZero() || purchases.lt(rules.harvestMinPurchases)) return watch('tooFewData');
  if (row.alreadyTargeted) return watch('alreadyTargeted');
  const sales = parseDecimal(row.sales);
  // ACoS ≤ Ziel ohne Division: Spend ≤ Ziel × Umsatz. Ohne Umsatz gibt es keinen ACoS.
  if (sales.lte(0) || cost.gt(parseDecimal(rules.harvestMaxAcos).times(sales))) {
    return watch('acosAboveTarget');
  }
  return { classification: 'harvest', reason: null };
}
