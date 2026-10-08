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
 * Vergleichsform eines Suchbegriffs: klein, NFC, Leerraum zusammengefasst (die Wörter der N-Gramme, mit einem
 * Leerzeichen verbunden). Dieselbe Form für „schon exakt gebucht“ (`@profitbash/db`) und die Einstufung je Begriff.
 */
export function comparableSearchTerm(term: string): string {
  return tokenizeSearchTerm(term).join(' ');
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

/** Warum ein Begriff nur beobachtet wird (dieselben Werte wie `SEARCH_TERM_WATCH_REASON_KEYS` in `@profitbash/shared`). */
export const SEARCH_TERM_WATCH_REASONS = [
  'protected',
  'alreadyTargeted',
  'acosAboveTarget',
  'noSales',
  'tooFewData',
] as const;
export type SearchTermWatchReason = (typeof SEARCH_TERM_WATCH_REASONS)[number];

export interface SearchTermClassification {
  classification: SearchTermClass;
  /** Nur bei `watch`. */
  reason: SearchTermWatchReason | null;
}

/** Wörter für den Schutz-Abgleich: zusätzlich an Satzzeichen getrennt („nordwind-lampe“ enthält „nordwind“). */
function protectionWords(term: string): string[] {
  return term
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word !== '');
}

/**
 * Prüfer für geschützte Begriffe, einmal je Liste vorbereitet: Enthält der Suchbegriff einen davon als ganze,
 * zusammenhängende Wortfolge? Wortteile zählen nicht („nordwind“ schützt nicht „nordwinde“); Bindestrich,
 * Apostroph und andere Satzzeichen trennen Wörter (anders als bei den N-Grammen).
 */
export function createProtectedTermMatcher(
  protectedTerms: readonly string[],
): (searchTerm: string) => boolean {
  const needles = protectedTerms.map(protectionWords).filter((needle) => needle.length > 0);
  return (searchTerm) => {
    if (needles.length === 0) return false;
    const words = protectionWords(searchTerm);
    return needles.some((needle) => {
      for (let start = 0; start + needle.length <= words.length; start++) {
        if (needle.every((word, offset) => words[start + offset] === word)) return true;
      }
      return false;
    });
  };
}

/** Einzelprüfung; für viele Suchbegriffe `createProtectedTermMatcher`. */
export function isProtectedSearchTerm(
  searchTerm: string,
  protectedTerms: readonly string[],
): boolean {
  return createProtectedTermMatcher(protectedTerms)(searchTerm);
}

/**
 * Einstufung einer Suchbegriff-Zeile. Negieren: genug Klicks, kein Kauf, genug Spend; geschützte Begriffe
 * (`protected`) nie. Harvest: genug Käufe, ACoS höchstens am Ziel und noch kein exaktes Target
 * (`alreadyTargeted`). Sonst Beobachten mit Grund. Grenzwerte zählen mit.
 */
export function classifySearchTerm(
  row: SearchTermSums & { protected: boolean; alreadyTargeted: boolean },
  rules: SearchTermRules,
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
    return row.protected ? watch('protected') : { classification: 'negate', reason: null };
  }

  if (purchases.isZero() || purchases.lt(rules.harvestMinPurchases)) return watch('tooFewData');
  if (row.alreadyTargeted) return watch('alreadyTargeted');
  const sales = parseDecimal(row.sales);
  // Ohne Umsatz gibt es keinen ACoS (Käufe ohne Umsatz kommen in den Blättern vereinzelt vor).
  if (sales.lte(0)) return watch('noSales');
  // ACoS ≤ Ziel ohne Division: Spend ≤ Ziel × Umsatz.
  if (cost.gt(parseDecimal(rules.harvestMaxAcos).times(sales))) return watch('acosAboveTarget');
  return { classification: 'harvest', reason: null };
}

/** Einstufung eines Suchbegriffs über alle seine Zeilen (Targets) mit den Summen, die sie begründen. */
export interface SearchTermAcrossTargets extends SearchTermClassification, SearchTermSums {
  /** Zeilen (Suchbegriff je Target), die in die Summen eingehen. */
  targets: number;
  /** Harvest bzw. Negieren, das keine Zeile des Begriffs allein erreicht (erst die Summe). */
  onlyAcrossTargets: boolean;
}

/**
 * Einstufung je Suchbegriff über alle übergebenen Zeilen (alle Targets und Ad-Typen eines Profils in einem
 * Datei-Zeitraum; den Ausschnitt wählt der Aufrufer): Zeilen desselben Begriffs in Vergleichsform werden summiert,
 * die Summe läuft durch `classifySearchTerm` mit denselben Regeln. `protected` und `alreadyTargeted` gelten für den
 * Begriff, sobald eine Zeile sie meldet. Schlüssel der Map ist `comparableSearchTerm`, Reihenfolge wie die Zeilen.
 */
export function classifySearchTermsAcrossTargets(
  rows: readonly (SearchTermSums & {
    searchTerm: string;
    protected: boolean;
    alreadyTargeted: boolean;
  })[],
  rules: SearchTermRules,
): Map<string, SearchTermAcrossTargets> {
  const groups = new Map<
    string,
    {
      sums: Record<keyof SearchTermSums, Dec>;
      targets: number;
      protected: boolean;
      alreadyTargeted: boolean;
      rowClasses: Set<SearchTermClass>;
    }
  >();
  for (const row of rows) {
    const key = comparableSearchTerm(row.searchTerm);
    let group = groups.get(key);
    if (!group) {
      group = {
        sums: zeroSums(),
        targets: 0,
        protected: false,
        alreadyTargeted: false,
        rowClasses: new Set(),
      };
      groups.set(key, group);
    }
    for (const sumKey of SUM_KEYS) {
      group.sums[sumKey] = group.sums[sumKey].plus(parseDecimal(row[sumKey]));
    }
    group.targets += 1;
    group.protected ||= row.protected;
    group.alreadyTargeted ||= row.alreadyTargeted;
    group.rowClasses.add(classifySearchTerm(row, rules).classification);
  }
  const result = new Map<string, SearchTermAcrossTargets>();
  for (const [key, group] of groups) {
    const sums: SearchTermSums = {
      impressions: formatDecimal(group.sums.impressions),
      clicks: formatDecimal(group.sums.clicks),
      cost: formatDecimal(group.sums.cost),
      sales: formatDecimal(group.sums.sales),
      purchases: formatDecimal(group.sums.purchases),
      units: formatDecimal(group.sums.units),
    };
    const classification = classifySearchTerm(
      { ...sums, protected: group.protected, alreadyTargeted: group.alreadyTargeted },
      rules,
    );
    result.set(key, {
      ...classification,
      targets: group.targets,
      onlyAcrossTargets:
        classification.classification !== 'watch' &&
        !group.rowClasses.has(classification.classification),
      ...sums,
    });
  }
  return result;
}
