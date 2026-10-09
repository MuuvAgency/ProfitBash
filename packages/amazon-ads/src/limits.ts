import { Decimal } from 'decimal.js';
import { isPlainDecimal } from './json';

/**
 * Grenzen von Amazon für Schreibaufträge (`docs/tasks/phase-3.md` 3.2a, F6: hart gesperrt wird nur, was Amazon
 * vorgibt). Werte aus der Amazon-Doku „Limits, constraints, and quotas“
 * (`advertising.amazon.com/API/docs/en-us/reference/concepts/limits`), gelesen am 2026-10-08, für die Marktplätze,
 * die ProfitBash anlegt (`AMAZON_MARKETPLACES`). Beträge in der Währung des Marktplatzes, als Decimal-Strings.
 *
 * Sponsored Brands und Sponsored Display (3.2c, gelesen am 2026-10-09) haben Gebotsgrenzen je Kostenart (CPC,
 * vCPM = je 1000 sichtbare Impressionen). Amazon unterscheidet bei SB zusätzlich Bild und Video sowie die Ziele
 * der vCPM-Kampagnen; diese Merkmale kennt ProfitBash nicht. Geprüft wird deshalb gegen die **weiteste** Spanne,
 * die Amazon für Ad-Typ, Kostenart und Marktplatz annimmt: Sie sperrt nie einen gültigen Wert, den Rest
 * entscheidet Amazon (Fehler je Änderung). Für unbekannte Marktplätze und Ad-Typen gibt es keine Prüfung.
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

interface CostTypeLimits {
  cpc: AmazonAdsValueLimit;
  vcpm: AmazonAdsValueLimit;
}

const limits = (cpc: [string, string], vcpm: [string, string]): CostTypeLimits => ({
  cpc: { min: cpc[0], max: cpc[1] },
  vcpm: { min: vcpm[0], max: vcpm[1] },
});

const SD_DEFAULT_BID = limits(['0.02', '1000'], ['1', '1000']);

/** Sponsored Display: Gebot von Targets und Standardgebot der Ad Group je Kostenart. Irland nennt Amazon nicht. */
export const SD_BID_LIMITS: Readonly<Record<string, CostTypeLimits>> = {
  DE: SD_DEFAULT_BID,
  FR: SD_DEFAULT_BID,
  IT: SD_DEFAULT_BID,
  ES: SD_DEFAULT_BID,
  NL: SD_DEFAULT_BID,
  BE: SD_DEFAULT_BID,
  UK: SD_DEFAULT_BID,
  US: SD_DEFAULT_BID,
  CA: SD_DEFAULT_BID,
  SE: limits(['0.18', '1000'], ['1', '1000']),
  PL: SD_DEFAULT_BID,
  TR: limits(['0.05', '2500'], ['1.85', '2500']),
};

const SB_EUR_BID = limits(['0.10', '39'], ['1', '5000']);
const SB_EUR_SMALL_BID = limits(['0.10', '39'], ['1', '1560']);

/**
 * Sponsored Brands: CPC vom Minimum für Bild-Anzeigen (Video liegt höher) bis zum Maximum; vCPM vom kleinsten
 * Minimum bis zum größten Maximum über Bild und Video und beide Ziele.
 */
export const SB_BID_LIMITS: Readonly<Record<string, CostTypeLimits>> = {
  DE: SB_EUR_BID,
  FR: SB_EUR_BID,
  IT: SB_EUR_BID,
  ES: limits(['0.10', '39'], ['2', '5000']),
  NL: SB_EUR_SMALL_BID,
  BE: SB_EUR_SMALL_BID,
  IE: SB_EUR_SMALL_BID,
  UK: limits(['0.10', '31'], ['1', '5000']),
  US: limits(['0.10', '49'], ['1', '5000']),
  CA: limits(['0.10', '49'], ['1', '5000']),
  SE: limits(['0.90', '500'], ['2', '200000']),
  PL: limits(['0.2', '200'], ['1', '80000']),
  TR: limits(['0.2', '200'], ['0.3', '80000']),
};

/** Sponsored Brands: Tagesbudget je Marktplatz (Laufzeitbudgets ändert Phase 3 nicht). */
export const SB_DAILY_BUDGET_LIMITS: Readonly<Record<string, AmazonAdsValueLimit>> = {
  DE: DEFAULT_BUDGET,
  FR: DEFAULT_BUDGET,
  IT: DEFAULT_BUDGET,
  ES: DEFAULT_BUDGET,
  BE: DEFAULT_BUDGET,
  IE: DEFAULT_BUDGET,
  UK: DEFAULT_BUDGET,
  US: DEFAULT_BUDGET,
  CA: DEFAULT_BUDGET,
  NL: { min: '4', max: '3700000' },
  SE: { min: '9', max: '9400000' },
  PL: { min: '2', max: '2400000' },
  TR: { min: '2', max: '2700000' },
};

/**
 * Sponsored Display: Tagesbudget je Marktplatz für Seller. Für Vendoren nennt Amazon in einigen Marktplätzen ein
 * kleineres Maximum (50 000); den Kontotyp kennt die Prüfung nicht, dort entscheidet Amazon.
 */
export const SD_DAILY_BUDGET_LIMITS: Readonly<Record<string, AmazonAdsValueLimit>> = {
  DE: DEFAULT_BUDGET,
  FR: DEFAULT_BUDGET,
  IT: DEFAULT_BUDGET,
  ES: DEFAULT_BUDGET,
  NL: DEFAULT_BUDGET,
  BE: DEFAULT_BUDGET,
  UK: DEFAULT_BUDGET,
  US: DEFAULT_BUDGET,
  CA: DEFAULT_BUDGET,
  SE: DEFAULT_BUDGET,
  PL: DEFAULT_BUDGET,
  TR: { min: '2', max: '2700000' },
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
  /**
   * Kostenart der Kampagne (`extra.costType`: `cpc` | `vcpm`, Groß/Klein egal), für Gebote bei SB und SD. Ohne
   * Angabe gilt die weiteste Spanne über beide Kostenarten.
   */
  costType?: string | null | undefined;
}

const own = <T>(table: Readonly<Record<string, T>>, key: string): T | undefined =>
  Object.hasOwn(table, key) ? table[key] : undefined;

function bidLimit(
  table: Readonly<Record<string, CostTypeLimits>>,
  input: Pick<AmazonAdsValueLimitInput, 'countryCode' | 'costType'>,
): AmazonAdsValueLimit | undefined {
  const entry = own(table, input.countryCode);
  if (!entry) return undefined;
  const costType = input.costType?.toLowerCase();
  if (costType === 'cpc' || costType === 'vcpm') return entry[costType];
  // Kostenart unbekannt: nur sperren, was für beide ausgeschlossen ist.
  const { cpc, vcpm } = entry;
  return {
    min: new Decimal(cpc.min).lessThan(vcpm.min) ? cpc.min : vcpm.min,
    max: new Decimal(cpc.max).greaterThan(vcpm.max) ? cpc.max : vcpm.max,
  };
}

/** Grenze von Amazon für Ad-Typ, Marktplatz, Feld und Kostenart; `undefined`, wenn keine bekannt ist. */
export function amazonAdsValueLimit(
  input: Omit<AmazonAdsValueLimitInput, 'value'>,
): AmazonAdsValueLimit | undefined {
  const budget = input.field === 'budget';
  switch (input.adProduct) {
    case 'SPONSORED_PRODUCTS':
      if (input.field === 'placement') return PLACEMENT_PERCENTAGE_LIMIT;
      return own(budget ? SP_DAILY_BUDGET_LIMITS : SP_BID_LIMITS, input.countryCode);
    case 'SPONSORED_BRANDS':
      // Platzierungen von SB ändert ProfitBash nicht (anderes Modell als SP).
      if (input.field === 'placement') return undefined;
      return budget
        ? own(SB_DAILY_BUDGET_LIMITS, input.countryCode)
        : bidLimit(SB_BID_LIMITS, input);
    case 'SPONSORED_DISPLAY':
      if (input.field === 'placement') return undefined;
      return budget
        ? own(SD_DAILY_BUDGET_LIMITS, input.countryCode)
        : bidLimit(SD_BID_LIMITS, input);
    default:
      return undefined;
  }
}

/**
 * Prüft einen neuen Wert gegen Amazons Grenze; `null`, wenn er passt oder keine Grenze bekannt ist. Wirft `TypeError`
 * bei Werten, die keine einfache Dezimalzahl sind (die Form prüft `adChangeValueIssue` in `@profitbash/shared` vorher).
 */
export function amazonAdsValueLimitIssue(
  input: AmazonAdsValueLimitInput,
): AmazonAdsValueLimitIssue | null {
  // Auch ohne bekannte Grenze: `new Decimal` nähme sonst `NaN`, Hex- und Exponentialschreibweise an.
  if (!isPlainDecimal(input.value)) {
    throw new TypeError('amazonAdsValueLimitIssue: Wert ist keine einfache Dezimalzahl.');
  }
  const limit = amazonAdsValueLimit(input);
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
