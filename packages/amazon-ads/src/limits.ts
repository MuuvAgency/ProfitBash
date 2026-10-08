import { Decimal } from 'decimal.js';

/**
 * Grenzen von Amazon für Schreibaufträge (`docs/tasks/phase-3.md` 3.2a, F6: hart gesperrt wird nur, was Amazon
 * vorgibt). Werte aus der Amazon-Doku „Limits, constraints, and quotas“
 * (`advertising.amazon.com/API/docs/en-us/reference/concepts/limits`), gelesen am 2026-10-08, für die Marktplätze,
 * die ProfitBash anlegt (`AMAZON_MARKETPLACES`). Beträge in der Währung des Marktplatzes, als Decimal-Strings.
 *
 * Nur Sponsored Products: SB und SD haben eigene Grenzen je Kostenart (CPC, vCPM) und kommen mit 3.2c. Für
 * unbekannte Marktplätze und andere Ad-Typen gibt es keine Prüfung; dann entscheidet Amazon (Fehler je Änderung).
 */

export interface AmazonAdsValueLimit {
  min: string;
  max: string;
}

const EUR_BID: AmazonAdsValueLimit = { min: '0.02', max: '1000' };
const DEFAULT_BUDGET: AmazonAdsValueLimit = { min: '1', max: '1000000' };

/** Mindest- und Höchstgebot für Keywords und Targets (auch Standardgebot der Ad Group) je Marktplatz. */
export const SP_BID_LIMITS: Readonly<Record<string, AmazonAdsValueLimit>> = {
  DE: EUR_BID,
  FR: EUR_BID,
  IT: EUR_BID,
  ES: EUR_BID,
  NL: EUR_BID,
  BE: EUR_BID,
  IE: EUR_BID,
  UK: { min: '0.02', max: '1000' },
  US: { min: '0.02', max: '1000' },
  CA: { min: '0.02', max: '1000' },
  SE: { min: '0.18', max: '9300' },
  PL: { min: '0.04', max: '2000' },
  TR: { min: '0.05', max: '2500' },
};

/** Mindest- und Höchstwert des Tagesbudgets einer Kampagne je Marktplatz (Seller und Vendoren). */
export const SP_DAILY_BUDGET_LIMITS: Readonly<Record<string, AmazonAdsValueLimit>> = {
  DE: DEFAULT_BUDGET,
  FR: DEFAULT_BUDGET,
  IT: DEFAULT_BUDGET,
  ES: DEFAULT_BUDGET,
  NL: DEFAULT_BUDGET,
  BE: DEFAULT_BUDGET,
  IE: DEFAULT_BUDGET,
  UK: DEFAULT_BUDGET,
  US: DEFAULT_BUDGET,
  CA: DEFAULT_BUDGET,
  SE: { min: '9', max: '9300000' },
  PL: { min: '2', max: '2000000' },
  TR: { min: '2', max: '2500000' },
};

/** Gebotsanpassung je Platzierung in ganzen Prozent (`placementBidding.percentage`). */
export const PLACEMENT_PERCENTAGE_LIMIT: AmazonAdsValueLimit = { min: '0', max: '900' };

export type AmazonAdsLimitField = 'bid' | 'default_bid' | 'budget' | 'placement';

export interface AmazonAdsValueLimitIssue extends AmazonAdsValueLimit {
  code: 'belowMinimum' | 'aboveMaximum';
}

export interface AmazonAdsValueLimitInput {
  /** `SPONSORED_PRODUCTS` | `SPONSORED_BRANDS` | `SPONSORED_DISPLAY`. */
  adProduct: string;
  /** Land des Profils (`amazon_ads_profiles.country_code`). */
  countryCode: string;
  field: AmazonAdsLimitField;
  /** Betrag bzw. Prozentsatz als Decimal-String. */
  value: string;
}

function limitFor(input: AmazonAdsValueLimitInput): AmazonAdsValueLimit | undefined {
  if (input.adProduct !== 'SPONSORED_PRODUCTS') return undefined;
  if (input.field === 'placement') return PLACEMENT_PERCENTAGE_LIMIT;
  const table = input.field === 'budget' ? SP_DAILY_BUDGET_LIMITS : SP_BID_LIMITS;
  return Object.hasOwn(table, input.countryCode) ? table[input.countryCode] : undefined;
}

/** Prüft einen neuen Wert gegen Amazons Grenze; `null`, wenn er passt oder keine Grenze bekannt ist. */
export function amazonAdsValueLimitIssue(
  input: AmazonAdsValueLimitInput,
): AmazonAdsValueLimitIssue | null {
  const limit = limitFor(input);
  if (!limit) return null;
  const value = new Decimal(input.value);
  if (value.lessThan(limit.min)) return { code: 'belowMinimum', ...limit };
  if (value.greaterThan(limit.max)) return { code: 'aboveMaximum', ...limit };
  return null;
}

export const MAX_KEYWORD_LENGTH = 80;
/** Höchstzahl der Wörter eines negativen Keywords je Match-Typ. */
export const MAX_NEGATIVE_KEYWORD_WORDS = { EXACT: 10, PHRASE: 4 } as const;

export type NegativeKeywordLimitIssue =
  { code: 'tooLong'; max: number } | { code: 'tooManyWords'; max: number };

/** Länge und Wortzahl eines negativen Keywords (gilt für SP, SB und SD). */
export function negativeKeywordLimitIssue(
  keywordText: string,
  matchType: keyof typeof MAX_NEGATIVE_KEYWORD_WORDS,
): NegativeKeywordLimitIssue | null {
  if (keywordText.length > MAX_KEYWORD_LENGTH) return { code: 'tooLong', max: MAX_KEYWORD_LENGTH };
  const max = MAX_NEGATIVE_KEYWORD_WORDS[matchType];
  const words = keywordText.split(/\s+/u).filter(Boolean).length;
  return words > max ? { code: 'tooManyWords', max } : null;
}
