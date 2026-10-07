import { Dec, formatDecimal } from '@profitbash/engine';

/**
 * Spalten, Blätter und Werte der Bulk-Datei aus der Werbekonsole (`phase-1.md` 1.11d). Kopfzeilen und
 * Enum-Werte kommen in der Sprache des Werbekontos (Deutsch oder Englisch) und in wechselnder Schreibweise
 * („Campaign Id“/„Campaign ID“, Zusätze wie „(Informational only)“). Abgebildet wird auf die Schreibweise,
 * die der API-Sync speichert (`packages/amazon-ads/src/exports.ts`, Mock-Daten), damit ein späterer
 * API-Sync dieselben Zeilen nahtlos fortführt.
 *
 * Deutsche Namen und Werte aus einer echten Datei (Befund 2026-09-29) sind belegt; mit „ungeprüft“
 * markierte sind Annahmen (Liste in `phase-1.md` 1.11d).
 */

// ---------------------------------------------------------------------------
// Kopfzeilen
// ---------------------------------------------------------------------------

export type BulkColumn =
  | 'entity'
  | 'campaignId'
  | 'adGroupId'
  | 'portfolioId'
  | 'adId'
  | 'keywordId'
  | 'productTargetingId'
  | 'targetingId'
  | 'campaignName'
  | 'adGroupName'
  | 'portfolioName'
  | 'startDate'
  | 'endDate'
  | 'targetingType'
  | 'state'
  | 'dailyBudget'
  | 'budget'
  | 'budgetType'
  | 'sku'
  | 'asin'
  | 'adGroupDefaultBid'
  | 'bid'
  | 'keywordText'
  | 'matchType'
  | 'biddingStrategy'
  | 'placement'
  | 'percentage'
  | 'productTargetingExpression'
  | 'resolvedProductTargetingExpression'
  | 'targetingExpression'
  | 'resolvedTargetingExpression'
  | 'tactic'
  | 'costType'
  | 'budgetAmount'
  | 'budgetCurrencyCode'
  | 'budgetPolicy'
  | 'budgetStartDate'
  | 'budgetEndDate';

/**
 * Aliasse je Spalte (Englisch laut Bulksheets-Doku, Deutsch laut echter Datei). Kennzahlen (Impressions,
 * Klicks, Ausgaben …) fehlen bewusst: Sie sind Summen über den Zeitraum der Datei, keine Tageswerte.
 */
const COLUMN_ALIASES: Record<BulkColumn, readonly string[]> = {
  entity: ['Entity', 'Entität'],
  campaignId: ['Campaign ID', 'Kampagnen-ID'],
  adGroupId: ['Ad Group ID', 'Anzeigengruppen-ID'],
  portfolioId: ['Portfolio ID', 'Portfolio-ID'],
  adId: ['Ad ID', 'Anzeigen-ID'],
  keywordId: ['Keyword ID', 'Keyword-ID'],
  productTargetingId: ['Product Targeting ID', 'Produkt-Targeting-ID'],
  targetingId: ['Targeting ID', 'Targeting-ID'],
  campaignName: ['Campaign Name', 'Kampagnenname'],
  adGroupName: ['Ad Group Name', 'Name der Anzeigengruppe'],
  portfolioName: ['Portfolio Name', 'Portfolioname'],
  startDate: ['Start Date', 'Startdatum'],
  endDate: ['End Date', 'Enddatum'],
  targetingType: ['Targeting Type', 'Targeting-Typ'],
  state: ['State', 'Zustand'],
  dailyBudget: ['Daily Budget', 'Tagesbudget'],
  budget: ['Budget'],
  budgetType: ['Budget Type', 'Budget-Typ', 'Budgettyp'],
  sku: ['SKU'],
  asin: ['ASIN'],
  adGroupDefaultBid: ['Ad Group Default Bid', 'Standardgebot für die Anzeigengruppe'],
  bid: ['Bid', 'Gebot'],
  keywordText: ['Keyword Text', 'Keyword-Text'],
  matchType: ['Match Type', 'Übereinstimmungstyp'],
  biddingStrategy: ['Bidding Strategy', 'Gebotsstrategie'],
  placement: ['Placement', 'Platzierung'],
  percentage: ['Percentage', 'Prozentsatz'],
  productTargetingExpression: ['Product Targeting Expression', 'Ausdruck für Produkt-Targeting'],
  // Deutsch ungeprüft.
  resolvedProductTargetingExpression: [
    'Resolved Product Targeting Expression',
    'Aufgelöster Ausdruck für Produkt-Targeting',
  ],
  targetingExpression: ['Targeting Expression', 'Targeting-Ausdruck'],
  // Deutsch ungeprüft.
  resolvedTargetingExpression: ['Resolved Targeting Expression', 'Aufgelöster Targeting-Ausdruck'],
  tactic: ['Tactic', 'Taktik'],
  costType: ['Cost Type', 'Kostenart'],
  budgetAmount: ['Budget Amount', 'Budget-Betrag'],
  budgetCurrencyCode: ['Budget Currency Code', 'Budget Currency', 'Budgetwährungscode'],
  budgetPolicy: ['Budget Policy', 'Budget-Linie'],
  budgetStartDate: ['Budget Start Date', 'Anfangsdatum des Budgets'],
  budgetEndDate: ['Budget End Date', 'Budget-Enddatum'],
};

/** Deutscher Anzeigename je Spalte für Meldungen (nie Zellinhalte). */
export function columnLabel(column: BulkColumn): string {
  return COLUMN_ALIASES[column].at(-1)!;
}

/**
 * Vergleichsform einer Kopfzeile: klein, geschützte Leerzeichen und Bindestriche als Leerzeichen,
 * Leerraum zusammengefasst, Zusätze in Klammern am Ende entfernt („(Informational only)“, „(Read only)“,
 * „(Nur zu Informationszwecken)“).
 */
export function normalizeHeader(text: string): string {
  let result = text.replace(/[   ]/g, ' ').trim();
  for (;;) {
    const stripped = result.replace(/\s*\([^()]*\)\s*$/, '');
    if (stripped === result) break;
    result = stripped;
  }
  return result
    .toLowerCase()
    .replace(/[-_‐-―]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const COLUMN_BY_HEADER: ReadonlyMap<string, BulkColumn> = new Map(
  (Object.entries(COLUMN_ALIASES) as Array<[BulkColumn, readonly string[]]>).flatMap(
    ([column, aliases]) => aliases.map((alias) => [normalizeHeader(alias), column] as const),
  ),
);

/** Spaltenindex je bekannter Spalte; bei doppelten Kopfzeilen gilt die erste. */
export function mapHeader(header: readonly string[]): Map<BulkColumn, number> {
  const result = new Map<BulkColumn, number>();
  header.forEach((text, index) => {
    const column = COLUMN_BY_HEADER.get(normalizeHeader(text));
    if (column && !result.has(column)) result.set(column, index);
  });
  return result;
}

// ---------------------------------------------------------------------------
// Blätter
// ---------------------------------------------------------------------------

export type BulkSheetKind = 'portfolios' | 'sp' | 'sb' | 'sd';

export const AD_PRODUCT_OF_SHEET: Readonly<Record<Exclude<BulkSheetKind, 'portfolios'>, string>> =
  {
    sp: 'SPONSORED_PRODUCTS',
    sb: 'SPONSORED_BRANDS',
    sd: 'SPONSORED_DISPLAY',
  };

/**
 * Art eines Blatts nach seinem Namen, `null` für alle anderen (Suchbegriff-Berichte, „Config“, Hilfsblätter).
 * SB: das ältere Blatt („Sponsored Brands Campaigns“) und das mit mehreren Ad Groups („SB Multi Ad Group
 * Campaigns“, „SB Anzeigengruppe Kampagnen“) gehören beide zu Sponsored Brands.
 */
export function classifySheet(name: string): BulkSheetKind | null {
  const text = normalizeHeader(name);
  if (/bericht|report|suchbegriff|search term/.test(text)) return null;
  if (/^portfolios?$/.test(text)) return 'portfolios';
  if (text.includes('sponsored products')) return 'sp';
  if (text.includes('sponsored display')) return 'sd';
  if (text.includes('sponsored brands') || /^sb\b.*(kampagne|campaign)/.test(text)) return 'sb';
  return null;
}

// ---------------------------------------------------------------------------
// Werte
// ---------------------------------------------------------------------------

/** Vergleichsform eines Enum-Werts: klein, Leerraum zusammengefasst, Gedankenstriche als `-`. */
export function normalizeValue(text: string): string {
  return text
    .replace(/[   ]/g, ' ')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export type ValueMap = ReadonlyMap<string, string>;

function valueMap(spellings: Record<string, readonly string[]>): ValueMap {
  return new Map(
    Object.entries(spellings).flatMap(([value, names]) =>
      names.map((name) => [normalizeValue(name), value] as const),
    ),
  );
}

/** Zustände wie im Export (`ENABLED` …). */
export const STATES = valueMap({
  ENABLED: ['enabled', 'Aktiviert'],
  PAUSED: ['paused', 'Angehalten'],
  // Deutsch ungeprüft (die Datei des Befunds enthielt keine archivierten Entities).
  ARCHIVED: ['archived', 'Archiviert'],
});

/** SP-Targeting wie `targetingSettings` im Export. */
export const TARGETING_TYPES = valueMap({
  MANUAL: ['Manual', 'Manuell'],
  AUTO: ['Auto', 'Automatic', 'Automatisch'],
});

/**
 * Match-Typen wie `targetDetails.matchType` im Export. Negatives tragen dort denselben Match-Typ (die
 * Negation steckt in der Tabelle), deshalb ohne Präfix.
 */
export const MATCH_TYPES = valueMap({
  // „Weitgehend“ und „Negative …“ auf Englisch sind ungeprüft.
  EXACT: ['exact', 'Genau Passend', 'negativeExact', 'Negative Exact', 'Negativ Genau Passend'],
  PHRASE: ['phrase', 'Wortgruppe', 'negativePhrase', 'Negative Phrase', 'Negative Wortgruppe'],
  BROAD: ['broad', 'Weitgehend', 'Weitgehend Passend'],
});

/**
 * Gebotsstrategien wie `optimization.bidStrategy` im Export (Werte wie in den Labels des Explorers).
 * Ungeprüft: „erhöhen und senken“ auf Deutsch, `NONE` für feste Gebote, regelbasierte Gebote.
 */
export const BIDDING_STRATEGIES = valueMap({
  SALES_DOWN_ONLY: ['Dynamic bids - down only', 'Dynamische Gebote - nur senken'],
  SALES_UP_AND_DOWN: ['Dynamic bids - up and down', 'Dynamische Gebote - erhöhen und senken'],
  NONE: ['Fixed bid', 'Fixed bids', 'Feste Gebote', 'Fester Gebotsbetrag'],
  RULE_BASED: ['Rule based bidding', 'Regelbasierte Gebote'],
});

/** Platzierungen der Gebotsanpassungen (Export: `placementBidAdjustments[].placement`). */
export const PLACEMENTS = valueMap({
  PLACEMENT_TOP: ['Placement Top', 'Top-Platzierung'],
  PLACEMENT_REST_OF_SEARCH: ['Placement Rest Of Search', 'Platzierung Rest der Suche'],
  PLACEMENT_PRODUCT_PAGE: ['Placement Product Page', 'Platzierung Produktseite'],
  // API-Schreibweise ungeprüft.
  SITE_AMAZON_BUSINESS: ['Placement Amazon Business', 'Platzierung für Amazon Business'],
});

/** Wiederholung des Budgets (Export: `recurrenceTimePeriod`). Deutsch ungeprüft. */
export const BUDGET_TYPES = valueMap({
  DAILY: ['daily', 'Täglich'],
  LIFETIME: ['lifetime', 'Laufzeit', 'Gesamtlaufzeit'],
});

/** Kostenart von SB/SD (Export: `costType`). */
export const COST_TYPES = valueMap({ CPC: ['cpc'], VCPM: ['vcpm'] });

/** Budget-Linie der Portfolios (Portfolios-API: `budget.policy`). Deutsch bis auf „Keine Obergrenze“ ungeprüft. */
export const BUDGET_POLICIES = valueMap({
  NO_CAP: ['No Cap', 'Keine Obergrenze'],
  MONTHLY_RECURRING: ['Monthly Recurring', 'Monatlich wiederkehrend'],
  DATE_RANGE: ['Date Range', 'Datumsbereich'],
});

export interface MappedValue {
  value: string;
  /** `false`: unbekannt, unverändert durchgereicht (der Aufrufer loggt es einmal). */
  known: boolean;
}

export function mapValue(map: ValueMap, raw: string): MappedValue {
  const value = map.get(normalizeValue(raw));
  return value === undefined ? { value: raw.trim(), known: false } : { value, known: true };
}

// ---------------------------------------------------------------------------
// Entity-Typen
// ---------------------------------------------------------------------------

export type EntityKind =
  | 'portfolio'
  | 'campaign'
  | 'adGroup'
  | 'productAd'
  | 'keyword'
  | 'negativeKeyword'
  | 'campaignNegativeKeyword'
  | 'productTargeting'
  | 'negativeProductTargeting'
  | 'campaignNegativeProductTargeting'
  | 'audienceTargeting'
  | 'contextualTargeting'
  | 'biddingAdjustment'
  /** Bekannt, aber (noch) nicht übernommen, z. B. SB-Ads (1.9). */
  | 'unsupported';

const ENTITY_KINDS = valueMap({
  portfolio: ['Portfolio'],
  campaign: ['Campaign', 'Kampagne'],
  adGroup: ['Ad Group', 'Anzeigengruppe'],
  productAd: ['Product Ad', 'Produktanzeige'],
  keyword: ['Keyword'],
  negativeKeyword: ['Negative Keyword', 'Negatives Keyword'],
  // Deutsch ungeprüft.
  campaignNegativeKeyword: [
    'Campaign Negative Keyword',
    'Negatives Keyword auf Kampagnenebene',
    'Kampagnen-Negatives Keyword',
    'Negatives Kampagnen-Keyword',
  ],
  productTargeting: ['Product Targeting', 'Produkt-Targeting'],
  negativeProductTargeting: ['Negative Product Targeting', 'Negatives Produkt-Targeting'],
  // Deutsch ungeprüft.
  campaignNegativeProductTargeting: [
    'Campaign Negative Product Targeting',
    'Negatives Produkt-Targeting auf Kampagnenebene',
  ],
  // SD; Deutsch ungeprüft.
  audienceTargeting: ['Audience Targeting', 'Zielgruppen-Targeting'],
  contextualTargeting: ['Contextual Targeting', 'Kontextbezogenes Targeting'],
  biddingAdjustment: ['Bidding Adjustment', 'Gebotsanpassung'],
  // SB-Ads und SD-Negatives auf Zielgruppen: kommen mit 1.9 bzw. nach Sichtung echter Dateien.
  unsupported: [
    'Ad',
    'Product Collection Ad',
    'Video Ad',
    'Brand Video Ad',
    'Store Spotlight Ad',
    'Negative Audience Targeting',
    'Theme',
    'Draft Campaign',
  ],
});

export function entityKind(raw: string): EntityKind | null {
  return (ENTITY_KINDS.get(normalizeValue(raw)) as EntityKind | undefined) ?? null;
}

// ---------------------------------------------------------------------------
// Zellen
// ---------------------------------------------------------------------------

/** Ergebnis einer Zelle: Wert, `null` (leer) oder `'invalid'`. */
export type CellResult<T> = T | null | 'invalid';

const DECIMAL_SOURCE = /^-?\d+(\.\d+)?([eE][+-]?\d{1,4})?$/;
/** Wie `amazonDecimalSchema`: größere Exponenten ergäben riesige Texte oder still `0`. */
const MAX_DECIMAL_EXPONENT = 40;
/** Excel hält Zahlen als Gleitkommazahl; mehr Stellen als 15 sind Rundungsreste (`123.45000000000002`). */
export const AMOUNT_SIGNIFICANT_DIGITS = 15;

/** Betrag als Decimal-String, auf 15 signifikante Stellen normalisiert (nie über `number`). */
export function parseBulkAmount(text: string): CellResult<string> {
  const source = text.trim();
  if (source === '') return null;
  if (!DECIMAL_SOURCE.test(source)) return 'invalid';
  const value = new Dec(source);
  if (!value.isFinite() || (!value.isZero() && Math.abs(value.e) > MAX_DECIMAL_EXPONENT)) {
    return 'invalid';
  }
  return formatDecimal(value.toSignificantDigits(AMOUNT_SIGNIFICANT_DIGITS));
}

/** Tag `YYYYMMDD` → `YYYY-MM-DD`. */
export function parseBulkDate(text: string): CellResult<string> {
  const source = text.trim();
  if (source === '') return null;
  const match = /^(\d{4})(\d{2})(\d{2})$/.exec(source);
  if (!match) return 'invalid';
  const [, year, month, day] = match;
  const date = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
  const iso = `${year}-${month}-${day}`;
  return date.toISOString().slice(0, 10) === iso ? iso : 'invalid';
}

/**
 * Amazon-ID als Text aus Ziffern. Amazon schreibt IDs als Text; eine Zahlzelle hieße, dass die Datei
 * bearbeitet wurde und Excel die ID als Gleitkommazahl hält: Ab 16 Stellen wären Ziffern schon verloren,
 * und eine falsche ID träfe still eine andere Entity. Deshalb lieber die Zeile ablehnen.
 */
export function parseBulkId(text: string, numericCell: boolean): CellResult<string> {
  const source = text.trim();
  if (source === '') return null;
  if (numericCell || !/^\d{1,20}$/.test(source)) return 'invalid';
  return source;
}

// ---------------------------------------------------------------------------
// Ausdrücke (Produkt-Targeting, SD-Targeting)
// ---------------------------------------------------------------------------

export interface ParsedTarget {
  /** `false`: unbekannte Form, als Text in `expression.bulkExpression` (der Aufrufer loggt es einmal). */
  known: boolean;
  targetType: string;
  matchType: string | null;
  expression: Record<string, unknown>;
}

/** Auto-Targeting (SP) → Match-Typ wie im Export. */
const AUTO_EXPRESSIONS: Readonly<Record<string, string>> = {
  'close-match': 'SEARCH_CLOSE_MATCH',
  'loose-match': 'SEARCH_LOOSE_MATCH',
  substitutes: 'ASIN_SUBSTITUTE_RELATED',
  complements: 'ASIN_ACCESSORY_RELATED',
};

/** `key="value"`-Paare; `null`, wenn der Text noch anderes enthält. */
function parsePairs(text: string): Array<[string, string]> | null {
  const pairs: Array<[string, string]> = [];
  const pattern = /\s*([a-z][a-z-]*)\s*=\s*"([^"]*)"\s*/giy;
  let consumed = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    pairs.push([match[1]!.toLowerCase(), match[2]!]);
    consumed = pattern.lastIndex;
  }
  return pairs.length > 0 && consumed === text.length ? pairs : null;
}

/** `price-less-than` → `productPriceLessThan` (Verfeinerungen einer Kategorie, Form ungeprüft). */
function refinementKey(key: string): string {
  return `product${key
    .split('-')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('')}`;
}

/**
 * Ausdruck eines Produkt- bzw. SD-Targets in der Form des Exports (`targetDetails`):
 * - `asin="…"` → `product` mit `{ matchType: 'PRODUCT_EXACT', asin }` (`asin-expanded` → `PRODUCT_SIMILAR`).
 * - `close-match` … → `auto` mit `{ matchType }`.
 * - `category="…"` samt Verfeinerungen → `category` mit `productCategoryId`, Name aus dem aufgelösten
 *   Ausdruck (`productCategoryResolved`) und Verfeinerungen als `product<Name>`; `brand="…"` allein ebenso.
 * - SD `views=(…)`/`purchases=(…)` → `audience` mit `event`, `lookback` und dem Text; `audience="…"` →
 *   `audience` mit `audienceId`.
 * Alles andere bleibt als Text in `bulkExpression` (`known: false`).
 */
export function parseTargetExpression(text: string, resolved: string): ParsedTarget {
  const source = text.trim();
  const auto = AUTO_EXPRESSIONS[source.toLowerCase()];
  if (auto) {
    return { known: true, targetType: 'auto', matchType: auto, expression: { matchType: auto } };
  }

  const audience = /^(views|purchases)\s*=\s*\((.*)\)$/i.exec(source);
  if (audience) {
    const lookback = /lookback\s*=\s*"?(\d{1,4})"?/i.exec(audience[2]!);
    return {
      known: true,
      targetType: 'audience',
      matchType: null,
      expression: {
        event: audience[1]!.toUpperCase(),
        ...(lookback && { lookback: Number(lookback[1]) }),
        bulkExpression: source,
      },
    };
  }

  const pairs = parsePairs(source);
  const [first] = pairs ?? [];
  if (pairs && first) {
    const [key, value] = first;
    if ((key === 'asin' || key === 'asin-expanded') && pairs.length === 1) {
      const matchType = key === 'asin' ? 'PRODUCT_EXACT' : 'PRODUCT_SIMILAR';
      return {
        known: true,
        targetType: 'product',
        matchType,
        expression: { matchType, asin: value },
      };
    }
    if (key === 'audience' && pairs.length === 1) {
      return {
        known: true,
        targetType: 'audience',
        matchType: null,
        expression: { audienceId: value },
      };
    }
    if (key === 'category' || key === 'brand') {
      const names = new Map(parsePairs(resolved.trim()) ?? []);
      const expression: Record<string, unknown> = {};
      for (const [pairKey, pairValue] of pairs) {
        const field = pairKey === 'category' ? 'productCategoryId' : refinementKey(pairKey);
        expression[field] = pairValue;
        const name = names.get(pairKey);
        if ((pairKey === 'category' || pairKey === 'brand') && name !== undefined) {
          expression[pairKey === 'category' ? 'productCategoryResolved' : 'productBrandResolved'] =
            name;
        }
      }
      return { known: true, targetType: 'category', matchType: null, expression };
    }
  }

  return {
    known: false,
    targetType: 'product',
    matchType: null,
    expression: { bulkExpression: source },
  };
}
