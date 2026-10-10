import { isPlainDecimal } from './json';
import type { AmazonAdsBiddingStrategy, AmazonAdsWriteState } from './writes';

/**
 * Bulk-Datei für die Amazon-Werbekonsole (`docs/tasks/phase-3.md` 3.2b, F2): der zweite Weg einer Übermittlung,
 * solange es keinen API-Zugang gibt. Hier entstehen nur die **Zeilen** der Blätter (Sponsored Products, Sponsored
 * Brands, Sponsored Display); die Datei schreibt `writeXlsx` aus `@profitbash/sheets`.
 *
 * Grundlage: Amazons Bulksheets-Guides (gelesen am 2026-10-08, Zusammenfassung in `phase-3.md` 3.2b):
 * - Die Datei ist **englisch**: Beim Hochladen nimmt Amazon jede unterstützte Sprache an, unabhängig vom Konto.
 * - Zeilen brauchen `Product`, `Entity`, `Operation` (`Create` | `Update` | `Archive`) und die IDs der Entity.
 * - Ein Kampagnen-Update ohne `Portfolio ID` nimmt die Kampagne aus ihrem Portfolio, ein leeres `End Date` entfernt
 *   das Enddatum: Beide stehen deshalb in jeder Kampagnenzeile. Alle übrigen Felder dürfen leer bleiben („can be left
 *   either unchanged or blank“) und werden nur geschrieben, wenn sie sich ändern (der Stand in der Datenbank kann
 *   älter sein als der in der Werbekonsole).
 * - Je Entity steht höchstens eine Zeile in der Datei: Eine zweite überschriebe beim Hochladen die erste.
 * - Kopfzeilen und Entity-Namen in der Schreibweise der heruntergeladenen englischen Datei (`Campaign ID`,
 *   `Ad Group`); die Doku nutzt daneben `Campaign Id` und `Ad group`.
 * - Ein negatives Produkt-Target auf Kampagnenebene kennt die Doku nicht; es wird übersprungen.
 */

export const SP_BULK_SHEET_NAME = 'Sponsored Products Campaigns';

export const SP_BULK_COLUMNS = [
  'Product',
  'Entity',
  'Operation',
  'Campaign ID',
  'Ad Group ID',
  'Portfolio ID',
  'Ad ID',
  'Keyword ID',
  'Product Targeting ID',
  'Campaign Name',
  'Ad Group Name',
  'Start Date',
  'End Date',
  'Targeting Type',
  'State',
  'Daily Budget',
  'SKU',
  'ASIN',
  'Ad Group Default Bid',
  'Bid',
  'Keyword Text',
  'Match Type',
  'Bidding Strategy',
  'Placement',
  'Percentage',
  'Product Targeting Expression',
  // Nur für Anlagen (4.4): laut Guide „Availability: US“, Werte `Increase reach` | `Limit off-Amazon spend`.
  'Off-Amazon ad serving',
] as const;
export type SpBulkColumn = (typeof SP_BULK_COLUMNS)[number];

/**
 * Blätter für Sponsored Brands und Sponsored Display (`phase-3.md` 3.9). Kopfzeilen aus einer echten englischen
 * Datei der Werbekonsole (2026-10-09, ohne die Spalten „Informational only“ und ohne Kennzahlen), Entities und
 * Werte aus den Bulksheets-Guides für SB (älteres Blatt und „multi-ad group“) und SD.
 *
 * Sponsored Brands hat **zwei Blätter**: das ältere für Kampagnen ohne eigene Ad-Group-Zeilen und das für
 * Kampagnen mit mehreren Ad Groups. Eine Kampagne steht in genau einem; der Aufrufer nennt es je Änderung.
 */
export const SB_BULK_SHEET_NAME = 'Sponsored Brands Campaigns';
export const SB_MULTI_AD_GROUP_BULK_SHEET_NAME = 'SB Multi Ad Group Campaigns';
export const SD_BULK_SHEET_NAME = 'Sponsored Display Campaigns';

export const SB_BULK_COLUMNS = [
  'Product',
  'Entity',
  'Operation',
  'Campaign ID',
  'Draft Campaign ID',
  'Portfolio ID',
  'Ad Group ID',
  'Keyword ID',
  'Product Targeting ID',
  'Campaign Name',
  'Start Date',
  'End Date',
  'State',
  'Budget Type',
  'Budget',
  'Bid Optimization',
  'Bid Multiplier',
  'Bid',
  'Keyword Text',
  'Match Type',
  'Product Targeting Expression',
  'Ad Format',
  'Landing Page URL',
  'Landing Page ASINs',
  'Brand Entity ID',
  'Brand Name',
  'Brand Logo Asset ID',
  'Custom Image Asset ID',
  'Creative Headline',
  'Creative ASINs',
  'Video Media IDs',
  'Creative Type',
] as const;

export const SB_MULTI_AD_GROUP_BULK_COLUMNS = [
  'Product',
  'Entity',
  'Operation',
  'Campaign ID',
  'Portfolio ID',
  'Ad Group ID',
  'Ad ID',
  'Keyword ID',
  'Product Targeting ID',
  'Campaign Name',
  'Ad Group Name',
  'Ad Name',
  'Start Date',
  'End Date',
  'State',
  'Brand Entity ID',
  'Budget Type',
  'Budget',
  'Bid Optimization',
  'Product Location',
  'Bid',
  'Placement',
  'Percentage',
  'Audience ID',
  'Shopper Cohort Percentage',
  'Shopper Cohort Type',
  'Keyword Text',
  'Match Type',
  'Native Language Keyword',
  'Native Language Locale',
  'Product Targeting Expression',
  'Landing Page URL',
  'Landing Page ASINs',
  'Landing Page Type',
  'Brand Name',
  'Consent To Translate',
  'Brand Logo Asset ID',
  'Brand Logo Crop',
  'Custom Images',
  'Creative Headline',
  'Creative ASINs',
  'Video Asset IDs',
  'Subpages',
  'Product Exclusions',
  'Ad Title',
  'Sites',
] as const;

export const SD_BULK_COLUMNS = [
  'Product',
  'Entity',
  'Operation',
  'Campaign ID',
  'Portfolio ID',
  'Ad Group ID',
  'Ad ID',
  'Targeting ID',
  'Campaign Name',
  'Ad Group Name',
  'Start Date',
  'End Date',
  'State',
  'Tactic',
  'Budget Type',
  'Budget',
  'SKU',
  'Ad Group Default Bid',
  'Bid',
  'Bid Optimization',
  'Cost Type',
  'Targeting Expression',
  // Nur für Anlagen von Vendoren (4.9): Der Guide nennt „ASIN“ für Product Ads, die Datei eines Sellers hat nur
  // „ASIN (Informational only)“. Erscheint nur, wenn eine Zeile sie belegt.
  'ASIN',
] as const;

/** Blatt der Bulk-Datei: SP, SB (älteres Blatt), SB mit mehreren Ad Groups, SD. */
export type BulkFileSheetKind = 'sp' | 'sb' | 'sbMultiAdGroup' | 'sd';

interface SheetSpec {
  sheetName: string;
  product: string;
  columns: readonly string[];
  budgetColumn: string;
  targetIdColumn: string;
  expressionColumn: string;
}

const SHEETS: Record<BulkFileSheetKind, SheetSpec> = {
  sp: {
    sheetName: SP_BULK_SHEET_NAME,
    product: 'Sponsored Products',
    columns: SP_BULK_COLUMNS,
    budgetColumn: 'Daily Budget',
    targetIdColumn: 'Product Targeting ID',
    expressionColumn: 'Product Targeting Expression',
  },
  sb: {
    sheetName: SB_BULK_SHEET_NAME,
    product: 'Sponsored Brands',
    columns: SB_BULK_COLUMNS,
    budgetColumn: 'Budget',
    targetIdColumn: 'Product Targeting ID',
    expressionColumn: 'Product Targeting Expression',
  },
  sbMultiAdGroup: {
    sheetName: SB_MULTI_AD_GROUP_BULK_SHEET_NAME,
    product: 'Sponsored Brands',
    columns: SB_MULTI_AD_GROUP_BULK_COLUMNS,
    budgetColumn: 'Budget',
    targetIdColumn: 'Product Targeting ID',
    expressionColumn: 'Product Targeting Expression',
  },
  sd: {
    sheetName: SD_BULK_SHEET_NAME,
    product: 'Sponsored Display',
    columns: SD_BULK_COLUMNS,
    budgetColumn: 'Budget',
    targetIdColumn: 'Targeting ID',
    expressionColumn: 'Targeting Expression',
  },
};

/** Zelle wie `XlsxWriteCell` in `@profitbash/sheets`: Text, leer oder Zahl als Decimal-String. */
export type BulkFileCell = string | null | { number: string };

/** Was die Kampagnenzeile vom Stand in der Datenbank braucht. */
export interface BulkFileCampaign {
  amazonCampaignId: string;
  amazonPortfolioId: string | null;
  /** `YYYY-MM-DD`. */
  endDate: string | null;
  state: string | null;
}

interface AdGroupIds {
  amazonCampaignId: string;
  amazonAdGroupId: string;
}

/** Targets und Negatives: Im älteren SB-Blatt gibt es keine Ad-Group-Zeilen, die Ad Group darf dort fehlen. */
interface TargetParentIds {
  amazonCampaignId: string;
  amazonAdGroupId: string | null;
}

/** Sponsored Display trennt Targets in zwei Entities; bei SP und SB ohne Bedeutung. */
export type BulkFileSdTargeting = 'contextual' | 'audience';

/** Status einer neuen Entity: Amazon nimmt beim Anlegen nur `enabled` und `paused` an. */
type CreateState = AmazonAdsWriteState;

/**
 * Text-IDs von Kampagne und Ad Group einer Anlage (`phase-4.md` 4.4): Neue Entities tragen in `Campaign ID` bzw.
 * `Ad Group ID` eine **vorläufige Text-ID**, die Kinder nennen dieselbe (oder die echte ID eines schon angelegten
 * Elternteils). Amazon vergibt beim Hochladen die echten
 * IDs; ProfitBash ordnet sie über den Namen zu (nächster Bulk-Import). Eine Text-ID darf nicht nur aus Ziffern
 * bestehen (sonst wäre sie eine echte ID).
 */
interface CreateParents {
  campaignId: string;
  adGroupId: string;
}

/**
 * Anlage einer Entity für Sponsored Products (Guide „How to create Sponsored Products campaigns“) und Sponsored
 * Display (Guide „How to create Sponsored Display campaigns with bulksheets“, 4.9): SD-Kampagnen tragen `sd`
 * (Taktik, Kostenart) statt einer Gebotsstrategie, SD-Ad-Groups die Gebotsoptimierung.
 */
export type BulkFileCreate = { type: 'create' } & (
  | {
      entity: 'campaign';
      /** Vorläufige Text-ID (der Guide nimmt den Namen). */
      campaignId: string;
      name: string;
      targetingType: 'auto' | 'manual';
      state: CreateState;
      dailyBudget: string;
      /** `YYYY-MM-DD`; heute oder später (Amazon lehnt vergangene Tage ab). */
      startDate: string;
      /** Nur Sponsored Products (dort Pflicht). */
      biddingStrategy: AmazonAdsBiddingStrategy | null;
      amazonPortfolioId: string | null;
      /** Nur in den USA einstellbar; `null` lässt Amazons Standard. */
      offAmazon: 'increaseReach' | 'limitSpend' | null;
      /** Nur Sponsored Display (dort Pflicht): Taktik und Kostenart. */
      sd?: { tactic: 'contextual' | 'audience'; costType: 'cpc' | 'vcpm' };
    }
  | { entity: 'placement'; campaignId: string; placement: string; percentage: string }
  | {
      entity: 'adGroup';
      campaignId: string;
      adGroupId: string;
      name: string;
      defaultBid: string;
      state: CreateState;
      /** Nur Sponsored Display (dort Pflicht); `reach` gehört zu vCPM. */
      bidOptimization?: 'clicks' | 'conversions' | 'reach';
    }
  | ({
      entity: 'productAd';
      /** Seller: SKU; Vendor: ASIN (genau eins von beiden). */
      sku: string | null;
      asin: string | null;
      state: CreateState;
    } & CreateParents)
  | ({
      entity: 'keyword';
      keywordText: string;
      matchType: 'exact' | 'phrase' | 'broad';
      /** Ohne Gebot gilt das Standardgebot der Ad Group. */
      bid: string | null;
      state: CreateState;
    } & CreateParents)
  | ({
      entity: 'productTarget';
      expression: { type: 'asin' | 'asinExpanded' | 'category'; value: string };
      bid: string | null;
      state: CreateState;
    } & CreateParents)
  | ({
      /** Sponsored Display: wer die beworbenen Produkte angesehen bzw. gekauft hat. */
      entity: 'audienceTarget';
      audience: 'views' | 'purchases';
      /** 7, 14, 30, 60, 90, 180 oder 365 (SD-Spec). */
      lookbackDays: number;
      bid: string | null;
      state: CreateState;
    } & CreateParents)
  | ({
      entity: 'negativeKeyword';
      keywordText: string;
      matchType: 'negativeExact' | 'negativePhrase';
    } & CreateParents)
  | ({ entity: 'negativeProductTarget'; asin: string } & CreateParents)
);

export type BulkFileChange = { ref: string } & (
  | BulkFileCreate
  | {
      type: 'campaign';
      campaign: BulkFileCampaign;
      set: {
        state?: AmazonAdsWriteState;
        dailyBudget?: string;
        biddingStrategy?: AmazonAdsBiddingStrategy;
      };
    }
  | {
      type: 'placement';
      amazonCampaignId: string;
      /**
       * Geltende Gebotsstrategie der Kampagne. Ändert dieselbe Datei die Strategie (Kampagnenzeile), gilt die neue.
       */
      biddingStrategy: string | null;
      /** `PLACEMENT_TOP` | `PLACEMENT_REST_OF_SEARCH` | `PLACEMENT_PRODUCT_PAGE` | `SITE_AMAZON_BUSINESS`. */
      placement: string;
      percentage: string;
    }
  | ({ type: 'adGroup'; state?: AmazonAdsWriteState; defaultBid?: string } & AdGroupIds)
  | ({
      type: 'keyword' | 'productTarget';
      amazonTargetId: string;
      state?: AmazonAdsWriteState;
      bid?: string;
      sdTargeting?: BulkFileSdTargeting;
    } & TargetParentIds)
  | ({ type: 'productAd'; amazonAdId: string; state?: AmazonAdsWriteState } & AdGroupIds)
  | { type: 'archive'; entity: 'campaign'; amazonCampaignId: string }
  | ({ type: 'archive'; entity: 'adGroup' } & AdGroupIds)
  | ({
      type: 'archive';
      entity: 'keyword' | 'productTarget' | 'negativeKeyword' | 'negativeProductTarget';
      amazonId: string;
      sdTargeting?: BulkFileSdTargeting;
    } & TargetParentIds)
  | ({ type: 'archive'; entity: 'productAd'; amazonId: string } & AdGroupIds)
  | {
      type: 'archive';
      entity: 'campaignNegativeKeyword' | 'campaignNegativeProductTarget';
      amazonCampaignId: string;
      amazonId: string;
    }
  | {
      type: 'createNegative';
      amazonCampaignId: string;
      /** `null`: Negative auf Kampagnenebene. */
      amazonAdGroupId: string | null;
      negative:
        | { type: 'keyword'; keywordText: string; matchType: 'EXACT' | 'PHRASE' }
        | { type: 'product'; asin: string };
    }
);

export type BulkFileSkipReason =
  /** Die Kampagne ist archiviert (endgültig). */
  | 'entityArchived'
  /**
   * Das Blatt kennt diese Änderung laut Doku nicht (SP: negative ASIN auf Kampagnenebene; SB: Anzeigen,
   * Standardgebot, Negatives der Kampagne im Blatt mit mehreren Ad Groups; SD: Keywords, Negatives der Kampagne).
   */
  | 'notSupportedInBulkFile'
  /** Für dieselbe Entity steht schon eine Zeile in der Datei. */
  | 'duplicate'
  /** Dieselbe Datei archiviert die Kampagne bzw. Ad Group; Amazon archiviert die Kinder mit. */
  | 'parentArchived'
  | 'invalidValue'
  | 'nothingToChange';

export interface BulkSheet {
  sheetName: string;
  /** Kopfzeile und je Änderung eine Zeile. */
  rows: BulkFileCell[][];
  /** Änderungen, die nicht in der Datei stehen. */
  skipped: { ref: string; reason: BulkFileSkipReason }[];
}
export type SpBulkSheet = BulkSheet;

const STATES = new Map([
  ['ENABLED', 'enabled'],
  ['PAUSED', 'paused'],
]);
const STRATEGIES = new Map([
  ['SALES_DOWN_ONLY', 'Dynamic bids - down only'],
  ['SALES_UP_AND_DOWN', 'Dynamic bids - up and down'],
  ['NONE', 'Fixed bid'],
]);
/** Schreibweise der heruntergeladenen Datei; Amazon nimmt auch `placementTop` usw. und achtet nicht auf Groß/Klein. */
const PLACEMENTS = new Map([
  ['PLACEMENT_TOP', 'Placement Top'],
  ['PLACEMENT_REST_OF_SEARCH', 'Placement Rest Of Search'],
  ['PLACEMENT_PRODUCT_PAGE', 'Placement Product Page'],
  ['SITE_AMAZON_BUSINESS', 'Placement Amazon Business'],
]);
/** Spalten nur für Anlagen je Blatt: erscheinen nur, wenn eine Zeile sie belegt. */
const OPTIONAL_COLUMNS: Partial<Record<BulkFileSheetKind, ReadonlySet<string>>> = {
  sp: new Set(['Off-Amazon ad serving']),
  sd: new Set(['ASIN']),
};
/** Sponsored Display (Guide): Taktik als ID, Kostenart und Gebotsoptimierung in der Schreibweise des Guides. */
const SD_TACTICS = { contextual: 'T00020', audience: 'T00030' } as const;
const SD_COST_TYPES = { cpc: 'CPC', vcpm: 'vCPM' } as const;
const SD_BID_OPTIMIZATIONS = {
  clicks: 'Optimize for page visits',
  conversions: 'Optimize for conversions',
  reach: 'Optimize for viewable impressions',
} as const;
// Wie `SD_LOOKBACK_DAYS` in `@profitbash/shared` (SD-v3-Spec); dieses Paket hängt nicht von `shared` ab.
const SD_LOOKBACK_DAYS: ReadonlySet<number> = new Set([7, 14, 30, 60, 90, 180, 365]);
const OFF_AMAZON = {
  increaseReach: 'Increase reach',
  limitSpend: 'Limit off-Amazon spend',
} as const;
const EXPRESSIONS = { asin: 'asin', asinExpanded: 'asin-expanded', category: 'category' } as const;
const SD_TARGETING_ENTITIES = {
  contextual: 'Contextual Targeting',
  audience: 'Audience Targeting',
} as const;

class Skip extends Error {
  constructor(readonly reason: BulkFileSkipReason) {
    super(reason);
  }
}

const invalid = () => new Skip('invalidValue');

function id(value: string): string {
  if (!/^\d+$/.test(value)) throw invalid();
  return value;
}

/** Betrag größer 0 mit höchstens zwei Nachkommastellen (mehr rundet Amazon). */
function amount(value: string): BulkFileCell {
  if (!isPlainDecimal(value) || /\.\d{3,}$/.test(value) || !/[1-9]/.test(value)) throw invalid();
  return { number: value };
}

function mapped(map: ReadonlyMap<string, string>, value: string | null | undefined): string {
  const result = typeof value === 'string' ? map.get(value.toUpperCase()) : undefined;
  if (result === undefined) throw invalid();
  return result;
}

/** Text ohne Ränder, nicht leer und ohne Steuerzeichen (Namen, Keywords, SKU). */
function text(value: string): string {
  const trimmed = value.trim();
  if (trimmed === '' || /\p{Cc}/u.test(trimmed)) throw invalid();
  return trimmed;
}

/** Vorläufige Text-ID einer neuen Kampagne bzw. Ad Group: Text, aber keine Zahl (sonst eine echte ID). */
function textId(value: string): string {
  const result = text(value);
  if (/^\d+$/.test(result)) throw invalid();
  return result;
}

/** Elternteil einer Anlage: neu (Text-ID) oder schon angelegt (echte ID aus Ziffern). */
const parentId = (value: string) => (/^\d+$/.test(value) ? value : textId(value));

const asinOf = (value: string) => {
  if (!/^[A-Z0-9]{10}$/.test(value)) throw invalid();
  return value;
};

const percentageOf = (value: string): BulkFileCell => {
  if (!/^(0|[1-9]\d{0,2})$/.test(value) || Number(value) > 900) throw invalid();
  return { number: value };
};

/** `YYYY-MM-DD` → `YYYYMMDD`, nur für Tage, die es gibt. */
function date(value: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw invalid();
  const [, year, month, day] = match.map(Number) as [number, number, number, number];
  const parsed = new Date(Date.UTC(year, month - 1, day));
  if (
    parsed.getUTCFullYear() !== year ||
    parsed.getUTCMonth() !== month - 1 ||
    parsed.getUTCDate() !== day
  ) {
    throw invalid();
  }
  return value.replaceAll('-', '');
}

type Row = Record<string, BulkFileCell>;

interface Context {
  kind: BulkFileSheetKind;
  sheet: SheetSpec;
  /** Neue Strategie je Kampagne, wenn dieselbe Datei sie ändert. */
  strategyByCampaign: ReadonlyMap<string, string>;
}

const notSupported = () => new Skip('notSupportedInBulkFile');

/** Ad Group der Zeile; fehlen darf sie nur im älteren SB-Blatt. */
function adGroupCell(kind: BulkFileSheetKind, amazonAdGroupId: string | null): Row {
  if (amazonAdGroupId !== null) return { 'Ad Group ID': id(amazonAdGroupId) };
  if (kind !== 'sb') throw invalid();
  return {};
}

/** Entity-Name eines Produkt-Targets: bei SD je nach Art des Targetings. */
function productTargetEntity(kind: BulkFileSheetKind, sdTargeting?: BulkFileSdTargeting): string {
  if (kind !== 'sd') return 'Product Targeting';
  if (sdTargeting === undefined) throw invalid();
  return SD_TARGETING_ENTITIES[sdTargeting];
}

function campaignRow(
  change: Extract<BulkFileChange, { type: 'campaign' }>,
  { kind, sheet }: Context,
): Row {
  const { campaign, set } = change;
  if (campaign.state?.toUpperCase() === 'ARCHIVED') throw new Skip('entityArchived');
  // Gebotsstrategien gibt es nur bei Sponsored Products.
  if (kind !== 'sp' && set.biddingStrategy !== undefined) throw notSupported();
  return withFields(
    {
      Entity: 'Campaign',
      Operation: 'Update',
      'Campaign ID': id(campaign.amazonCampaignId),
      ...(campaign.amazonPortfolioId !== null && {
        'Portfolio ID': id(campaign.amazonPortfolioId),
      }),
      ...(campaign.endDate !== null && { 'End Date': date(campaign.endDate) }),
    },
    {
      ...stateField(set.state),
      ...(set.dailyBudget !== undefined && { [sheet.budgetColumn]: amount(set.dailyBudget) }),
      ...(set.biddingStrategy !== undefined && {
        'Bidding Strategy': mapped(STRATEGIES, set.biddingStrategy),
      }),
    },
  );
}

function withFields(row: Row, fields: Row): Row {
  if (Object.keys(fields).length === 0) throw new Skip('nothingToChange');
  return { ...row, ...fields };
}

const stateField = (state: AmazonAdsWriteState | undefined): Row =>
  state === undefined ? {} : { State: mapped(STATES, state) };

function rowFor(change: BulkFileChange, context: Context): Row {
  const { kind, sheet } = context;
  switch (change.type) {
    case 'campaign':
      return campaignRow(change, context);
    case 'placement': {
      if (kind !== 'sp') throw notSupported();
      const percentage = percentageOf(change.percentage);
      return {
        Entity: 'Bidding Adjustment',
        Operation: 'Update',
        'Campaign ID': id(change.amazonCampaignId),
        'Bidding Strategy': mapped(
          STRATEGIES,
          context.strategyByCampaign.get(change.amazonCampaignId) ?? change.biddingStrategy,
        ),
        Placement: mapped(PLACEMENTS, change.placement),
        Percentage: percentage,
      };
    }
    case 'create':
      // Anlagen für Sponsored Products (4.4) und Sponsored Display (4.9); SB folgt mit 4.10 (F1).
      if (kind === 'sd') return sdCreateRow(change);
      if (kind !== 'sp') throw notSupported();
      return createRow(change);
    case 'adGroup':
      // Das ältere SB-Blatt kennt keine Ad-Group-Zeilen, SB-Ad-Groups haben kein Standardgebot.
      if (kind === 'sb' || (kind === 'sbMultiAdGroup' && change.defaultBid !== undefined)) {
        throw notSupported();
      }
      return withFields(
        {
          Entity: 'Ad Group',
          Operation: 'Update',
          'Campaign ID': id(change.amazonCampaignId),
          'Ad Group ID': id(change.amazonAdGroupId),
        },
        {
          ...stateField(change.state),
          ...(change.defaultBid !== undefined && {
            'Ad Group Default Bid': amount(change.defaultBid),
          }),
        },
      );
    case 'keyword':
    case 'productTarget':
      // Sponsored Display hat keine Keywords.
      if (kind === 'sd' && change.type === 'keyword') throw notSupported();
      return withFields(
        {
          Entity:
            change.type === 'keyword' ? 'Keyword' : productTargetEntity(kind, change.sdTargeting),
          Operation: 'Update',
          'Campaign ID': id(change.amazonCampaignId),
          ...adGroupCell(kind, change.amazonAdGroupId),
          [change.type === 'keyword' ? 'Keyword ID' : sheet.targetIdColumn]: id(
            change.amazonTargetId,
          ),
        },
        {
          ...stateField(change.state),
          ...(change.bid !== undefined && { Bid: amount(change.bid) }),
        },
      );
    case 'productAd':
      // SB-Anzeigen heißen im Blatt je Format anders („Store spotlight ad“ …); das Format kennt ProfitBash nicht.
      if (kind === 'sb' || kind === 'sbMultiAdGroup') throw notSupported();
      return withFields(
        {
          Entity: 'Product Ad',
          Operation: 'Update',
          'Campaign ID': id(change.amazonCampaignId),
          'Ad Group ID': id(change.amazonAdGroupId),
          'Ad ID': id(change.amazonAdId),
        },
        stateField(change.state),
      );
    case 'archive':
      return archiveRow(change, context);
    case 'createNegative': {
      const onCampaign = change.amazonAdGroupId === null;
      // Negatives der Kampagne: bei SP eine eigene Entity (nur Keywords), im älteren SB-Blatt der Normalfall
      // (dort gibt es keine Ad-Group-Zeilen), sonst nicht vorhanden.
      if (onCampaign && (kind === 'sbMultiAdGroup' || kind === 'sd')) throw notSupported();
      const parent: Row = {
        Operation: 'Create',
        'Campaign ID': id(change.amazonCampaignId),
        ...(change.amazonAdGroupId !== null && { 'Ad Group ID': id(change.amazonAdGroupId) }),
        State: 'enabled',
      };
      if (change.negative.type === 'keyword') {
        if (kind === 'sd') throw notSupported();
        const keywordText = change.negative.keywordText.trim();
        // eslint-disable-next-line no-control-regex
        if (keywordText === '' || /[\u0000-\u001f\u007f]/.test(keywordText)) throw invalid();
        return {
          Entity: onCampaign && kind === 'sp' ? 'Campaign Negative Keyword' : 'Negative Keyword',
          ...parent,
          'Keyword Text': keywordText,
          'Match Type': change.negative.matchType === 'EXACT' ? 'negativeExact' : 'negativePhrase',
        };
      }
      if (onCampaign && kind === 'sp') throw notSupported();
      if (!/^[A-Z0-9]{10}$/.test(change.negative.asin)) throw invalid();
      return {
        Entity: 'Negative Product Targeting',
        ...parent,
        [sheet.expressionColumn]: `asin="${change.negative.asin}"`,
      };
    }
  }
}

const createParents = (ids: CreateParents): Row => ({
  'Campaign ID': parentId(ids.campaignId),
  'Ad Group ID': parentId(ids.adGroupId),
});
const createState = (value: CreateState) => ({ State: mapped(STATES, value) });

function createRow(change: Extract<BulkFileChange, { type: 'create' }>): Row {
  const create = { Operation: 'Create' } as const;
  const state = createState;
  const parents = createParents;
  switch (change.entity) {
    case 'campaign':
      if (change.biddingStrategy === null || change.sd !== undefined) throw invalid();
      return {
        Entity: 'Campaign',
        ...create,
        'Campaign ID': textId(change.campaignId),
        'Campaign Name': text(change.name),
        'Start Date': date(change.startDate),
        'Targeting Type': change.targetingType === 'auto' ? 'Auto' : 'Manual',
        ...state(change.state),
        'Daily Budget': amount(change.dailyBudget),
        'Bidding Strategy': mapped(STRATEGIES, change.biddingStrategy),
        ...(change.amazonPortfolioId !== null && { 'Portfolio ID': id(change.amazonPortfolioId) }),
        ...(change.offAmazon !== null && { 'Off-Amazon ad serving': OFF_AMAZON[change.offAmazon] }),
      };
    case 'placement':
      // Der Guide lässt die Strategie hier leer: Sie steht in der Kampagnenzeile.
      return {
        Entity: 'Bidding Adjustment',
        ...create,
        'Campaign ID': parentId(change.campaignId),
        Placement: mapped(PLACEMENTS, change.placement),
        Percentage: percentageOf(change.percentage),
      };
    case 'adGroup':
      if (change.bidOptimization !== undefined) throw invalid();
      return {
        Entity: 'Ad Group',
        ...create,
        'Campaign ID': parentId(change.campaignId),
        'Ad Group ID': textId(change.adGroupId),
        'Ad Group Name': text(change.name),
        ...state(change.state),
        'Ad Group Default Bid': amount(change.defaultBid),
      };
    case 'audienceTarget':
      // Zielgruppen gibt es nur bei Sponsored Display.
      throw notSupported();
    case 'productAd':
      // Seller nennen die SKU, Vendoren die ASIN (Guide), nie beides.
      if ((change.sku === null) === (change.asin === null)) throw invalid();
      return {
        Entity: 'Product Ad',
        ...create,
        ...parents(change),
        ...state(change.state),
        ...(change.sku !== null ? { SKU: text(change.sku) } : { ASIN: asinOf(change.asin!) }),
      };
    case 'keyword':
      return {
        Entity: 'Keyword',
        ...create,
        ...parents(change),
        ...state(change.state),
        ...(change.bid !== null && { Bid: amount(change.bid) }),
        'Keyword Text': text(change.keywordText),
        'Match Type': change.matchType,
      };
    case 'productTarget': {
      const { type, value } = change.expression;
      if (type === 'category' ? !/^\d+$/.test(value) : asinOf(value) !== value) throw invalid();
      return {
        Entity: 'Product Targeting',
        ...create,
        ...parents(change),
        ...state(change.state),
        ...(change.bid !== null && { Bid: amount(change.bid) }),
        'Product Targeting Expression': `${EXPRESSIONS[type]}="${value}"`,
      };
    }
    case 'negativeKeyword':
      return {
        Entity: 'Negative Keyword',
        ...create,
        ...parents(change),
        State: 'enabled',
        'Keyword Text': text(change.keywordText),
        'Match Type': change.matchType,
      };
    case 'negativeProductTarget':
      return {
        Entity: 'Negative Product Targeting',
        ...create,
        ...parents(change),
        State: 'enabled',
        'Product Targeting Expression': `asin="${asinOf(change.asin)}"`,
      };
  }
}

/** Anlage im Blatt „Sponsored Display Campaigns“ (Guide, 4.9). */
function sdCreateRow(change: Extract<BulkFileChange, { type: 'create' }>): Row {
  const create = { Operation: 'Create' } as const;
  const bid = (value: string | null): Row => (value === null ? {} : { Bid: amount(value) });
  switch (change.entity) {
    case 'campaign': {
      if (change.sd === undefined || change.biddingStrategy !== null) throw invalid();
      // Off-Amazon ist eine Einstellung von SP; SD-Kampagnen kennen die Spalte nicht.
      if (change.offAmazon !== null) throw invalid();
      const { tactic, costType } = change.sd;
      if (!Object.hasOwn(SD_TACTICS, tactic) || !Object.hasOwn(SD_COST_TYPES, costType)) {
        throw invalid();
      }
      return {
        Entity: 'Campaign',
        ...create,
        'Campaign ID': textId(change.campaignId),
        'Campaign Name': text(change.name),
        'Start Date': date(change.startDate),
        ...createState(change.state),
        Tactic: SD_TACTICS[tactic],
        'Budget Type': 'daily',
        Budget: amount(change.dailyBudget),
        'Cost Type': SD_COST_TYPES[costType],
        ...(change.amazonPortfolioId !== null && { 'Portfolio ID': id(change.amazonPortfolioId) }),
      };
    }
    case 'adGroup': {
      const optimization = change.bidOptimization;
      if (optimization === undefined || !Object.hasOwn(SD_BID_OPTIMIZATIONS, optimization)) {
        throw invalid();
      }
      return {
        Entity: 'Ad Group',
        ...create,
        'Campaign ID': parentId(change.campaignId),
        'Ad Group ID': textId(change.adGroupId),
        'Ad Group Name': text(change.name),
        ...createState(change.state),
        'Ad Group Default Bid': amount(change.defaultBid),
        'Bid Optimization': SD_BID_OPTIMIZATIONS[optimization],
      };
    }
    case 'productAd':
      // Seller nennen die SKU, Vendoren die ASIN (Guide), nie beides.
      if ((change.sku === null) === (change.asin === null)) throw invalid();
      return {
        Entity: 'Product Ad',
        ...create,
        ...createParents(change),
        ...createState(change.state),
        ...(change.sku !== null ? { SKU: text(change.sku) } : { ASIN: asinOf(change.asin!) }),
      };
    case 'productTarget': {
      const { type, value } = change.expression;
      // „Ähnlich wie“ (`asin-expanded`) kennt Sponsored Display nicht.
      if (type === 'asinExpanded') throw invalid();
      if (type === 'category' ? !/^\d+$/.test(value) : asinOf(value) !== value) throw invalid();
      return {
        Entity: SD_TARGETING_ENTITIES.contextual,
        ...create,
        ...createParents(change),
        ...createState(change.state),
        ...bid(change.bid),
        'Targeting Expression': `${EXPRESSIONS[type]}="${value}"`,
      };
    }
    case 'audienceTarget':
      if (
        (change.audience !== 'views' && change.audience !== 'purchases') ||
        !SD_LOOKBACK_DAYS.has(change.lookbackDays)
      ) {
        throw invalid();
      }
      return {
        Entity: SD_TARGETING_ENTITIES.audience,
        ...create,
        ...createParents(change),
        ...createState(change.state),
        ...bid(change.bid),
        // Wer die beworbenen Produkte selbst angesehen bzw. gekauft hat (Guide: `exact-product`).
        'Targeting Expression': `${change.audience}=(exact-product lookback=${change.lookbackDays})`,
      };
    case 'negativeProductTarget':
      return {
        Entity: 'Negative Product Targeting',
        ...create,
        ...createParents(change),
        State: 'enabled',
        'Targeting Expression': `asin="${asinOf(change.asin)}"`,
      };
    case 'placement':
    case 'keyword':
    case 'negativeKeyword':
      // Platzierungen und Keywords gibt es bei Sponsored Display nicht.
      throw notSupported();
  }
}

function archiveRow(
  change: Extract<BulkFileChange, { type: 'archive' }>,
  { kind, sheet }: Context,
): Row {
  const row: Row = { Operation: 'Archive', 'Campaign ID': id(change.amazonCampaignId) };
  switch (change.entity) {
    case 'campaign':
      return { ...row, Entity: 'Campaign' };
    case 'adGroup':
      if (kind === 'sb') throw notSupported();
      return { ...row, Entity: 'Ad Group', 'Ad Group ID': id(change.amazonAdGroupId) };
    case 'productAd':
      if (kind === 'sb' || kind === 'sbMultiAdGroup') throw notSupported();
      return {
        ...row,
        Entity: 'Product Ad',
        'Ad Group ID': id(change.amazonAdGroupId),
        'Ad ID': id(change.amazonId),
      };
    case 'keyword':
    case 'negativeKeyword':
      if (kind === 'sd') throw notSupported();
      return {
        ...row,
        Entity: change.entity === 'keyword' ? 'Keyword' : 'Negative Keyword',
        ...adGroupCell(kind, change.amazonAdGroupId),
        'Keyword ID': id(change.amazonId),
      };
    case 'productTarget':
    case 'negativeProductTarget':
      return {
        ...row,
        Entity:
          change.entity === 'productTarget'
            ? productTargetEntity(kind, change.sdTargeting)
            : 'Negative Product Targeting',
        ...adGroupCell(kind, change.amazonAdGroupId),
        [sheet.targetIdColumn]: id(change.amazonId),
      };
    case 'campaignNegativeKeyword':
      if (kind === 'sbMultiAdGroup' || kind === 'sd') throw notSupported();
      return {
        ...row,
        Entity: kind === 'sp' ? 'Campaign Negative Keyword' : 'Negative Keyword',
        'Keyword ID': id(change.amazonId),
      };
    case 'campaignNegativeProductTarget':
      if (kind !== 'sb') throw notSupported();
      return {
        ...row,
        Entity: 'Negative Product Targeting',
        [sheet.targetIdColumn]: id(change.amazonId),
      };
  }
}

/** Schlüssel der Entity einer Änderung (für „höchstens eine Zeile“); `null` bei Anlagen. */
function entityKey(change: BulkFileChange): string | null {
  switch (change.type) {
    case 'campaign':
      return `campaign:${change.campaign.amazonCampaignId}`;
    case 'placement':
      return `placement:${change.amazonCampaignId}:${change.placement}`;
    case 'adGroup':
      return `adGroup:${change.amazonAdGroupId}`;
    case 'keyword':
    case 'productTarget':
      return `${change.type}:${change.amazonTargetId}`;
    case 'productAd':
      return `productAd:${change.amazonAdId}`;
    case 'archive':
      if (change.entity === 'campaign') return `campaign:${change.amazonCampaignId}`;
      if (change.entity === 'adGroup') return `adGroup:${change.amazonAdGroupId}`;
      return `${change.entity}:${change.amazonId}`;
    case 'createNegative':
      return null;
    case 'create':
      return createKey(change);
  }
}

/** Dieselbe Anlage zweimal ergäbe eine Fehlerzeile bzw. eine doppelte Entity (ohne Groß/Klein wie Amazon). */
function createKey(change: Extract<BulkFileChange, { type: 'create' }>): string {
  const lower = (value: string) => value.trim().toLowerCase();
  switch (change.entity) {
    case 'campaign':
      return `create:campaign:${lower(change.campaignId)}`;
    case 'placement':
      return `create:placement:${lower(change.campaignId)}:${change.placement}`;
    case 'adGroup':
      return `create:adGroup:${lower(change.campaignId)}:${lower(change.adGroupId)}`;
  }
  const parent = `${lower(change.campaignId)}:${lower(change.adGroupId)}`;
  switch (change.entity) {
    case 'productAd':
      return `create:productAd:${parent}:${lower(change.sku ?? change.asin ?? '')}`;
    case 'keyword':
    case 'negativeKeyword':
      return `create:${change.entity}:${parent}:${change.matchType}:${lower(change.keywordText)}`;
    case 'productTarget':
      return `create:productTarget:${parent}:${change.expression.type}:${lower(change.expression.value)}`;
    case 'audienceTarget':
      return `create:audienceTarget:${parent}:${change.audience}:${change.lookbackDays}`;
    case 'negativeProductTarget':
      return `create:negativeProductTarget:${parent}:${lower(change.asin)}`;
  }
}

const campaignIdOf = (change: BulkFileChange) =>
  change.type === 'campaign'
    ? change.campaign.amazonCampaignId
    : change.type === 'create'
      ? change.campaignId
      : change.amazonCampaignId;

/**
 * Zeilen eines Blatts der Bulk-Datei für die Änderungen eines Profils, in der Reihenfolge der Eingabe. Was sich
 * nicht abbilden lässt, steht mit Grund in `skipped` und nicht in der Datei.
 */
export function buildBulkSheet(
  kind: BulkFileSheetKind,
  changes: readonly BulkFileChange[],
): BulkSheet {
  const sheet = SHEETS[kind];
  const records: Row[] = [];
  const skipped: BulkSheet['skipped'] = [];

  const strategyByCampaign = new Map<string, string>();
  const archivedCampaigns = new Set<string>();
  const archivedAdGroups = new Set<string>();
  for (const change of changes) {
    if (change.type === 'campaign' && change.set.biddingStrategy !== undefined) {
      if (!strategyByCampaign.has(change.campaign.amazonCampaignId)) {
        strategyByCampaign.set(change.campaign.amazonCampaignId, change.set.biddingStrategy);
      }
    } else if (change.type === 'archive' && change.entity === 'campaign') {
      archivedCampaigns.add(change.amazonCampaignId);
    } else if (change.type === 'archive' && change.entity === 'adGroup') {
      archivedAdGroups.add(change.amazonAdGroupId);
    }
  }

  const seen = new Set<string>();
  for (const change of changes) {
    let row: Row;
    try {
      const isCampaignArchive = change.type === 'archive' && change.entity === 'campaign';
      const isAdGroupArchive = change.type === 'archive' && change.entity === 'adGroup';
      if (
        (!isCampaignArchive && archivedCampaigns.has(campaignIdOf(change))) ||
        (!isAdGroupArchive &&
          !isCampaignArchive &&
          'amazonAdGroupId' in change &&
          change.amazonAdGroupId !== null &&
          archivedAdGroups.has(change.amazonAdGroupId))
      ) {
        throw new Skip('parentArchived');
      }
      const key = entityKey(change);
      if (key !== null && seen.has(key)) throw new Skip('duplicate');
      row = rowFor(change, { kind, sheet, strategyByCampaign });
      if (key !== null) seen.add(key);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped.push({ ref: change.ref, reason: error.reason });
      continue;
    }
    for (const column of Object.keys(row)) {
      if (!sheet.columns.includes(column)) {
        throw new Error(`Bulk-Datei: Das Blatt „${sheet.sheetName}“ hat keine Spalte „${column}“.`);
      }
    }
    records.push(row);
  }
  // Spalten nur für Anlagen erscheinen nur, wenn eine Zeile sie belegt (Off-Amazon gibt es nur in den USA, die
  // ASIN bei SD nur für Vendoren).
  const optional = OPTIONAL_COLUMNS[kind];
  const columns = sheet.columns.filter(
    (column) => !optional?.has(column) || records.some((row) => column in row),
  );
  const rows: BulkFileCell[][] = [
    [...columns],
    ...records.map((row) =>
      columns.map((column) => (column === 'Product' ? sheet.product : (row[column] ?? null))),
    ),
  ];
  return { sheetName: sheet.sheetName, rows, skipped };
}

/** Zeilen des Blatts „Sponsored Products Campaigns“. */
export const buildSpBulkSheet = (changes: readonly BulkFileChange[]): BulkSheet =>
  buildBulkSheet('sp', changes);

// ---------------------------------------------------------------------------
// Portfolios anlegen (`docs/tasks/phase-4.md` 4.7, F9)
// ---------------------------------------------------------------------------

/**
 * Blatt „Portfolios“ (Guide „Use portfolios with bulksheets“): Product „Portfolios“, Entity „Portfolio“, Operation
 * „Create“, Portfolio ID leer, Name Pflicht. Ein Budget braucht Betrag, Währung des Marktplatzes, Policy
 * (`dateRange` | `monthlyRecurring`) und Startdatum; das Enddatum ist optional und später nicht mehr änderbar. Ohne
 * Budget bleiben die Budget-Spalten leer (keine Obergrenze). Kampagnen lassen sich erst nach dem nächsten Import
 * zuordnen: Die neue Portfolio-ID kennt erst die nächste heruntergeladene Datei.
 */
export const PORTFOLIO_BULK_SHEET_NAME = 'Portfolios';
export const PORTFOLIO_BULK_COLUMNS = [
  'Product',
  'Entity',
  'Operation',
  'Portfolio ID',
  'Portfolio Name',
  'Budget Amount',
  'Budget Currency Code',
  'Budget Policy',
  'Budget Start Date',
  'Budget End Date',
] as const;

export type BulkFilePortfolioBudgetPolicy = 'dateRange' | 'monthlyRecurring';

export interface BulkFilePortfolioCreate {
  ref: string;
  name: string;
  budget: {
    amount: string;
    currencyCode: string;
    policy: BulkFilePortfolioBudgetPolicy;
    /** `YYYY-MM-DD`. */
    startDate: string;
    endDate: string | null;
  } | null;
}

export function buildPortfolioBulkSheet(creates: readonly BulkFilePortfolioCreate[]): BulkSheet {
  const rows: BulkFileCell[][] = [[...PORTFOLIO_BULK_COLUMNS]];
  const skipped: BulkSheet['skipped'] = [];
  const seen = new Set<string>();
  for (const create of creates) {
    try {
      const name = text(create.name);
      const key = name.toLowerCase();
      if (seen.has(key)) throw new Skip('duplicate');
      const budget = create.budget;
      let cells: BulkFileCell[] = [null, null, null, null, null];
      if (budget !== null) {
        if (!/^[A-Z]{3}$/.test(budget.currencyCode)) throw invalid();
        if (budget.policy !== 'dateRange' && budget.policy !== 'monthlyRecurring') throw invalid();
        const start = date(budget.startDate);
        const end = budget.endDate === null ? null : date(budget.endDate);
        if (end !== null && end < start) throw invalid();
        cells = [amount(budget.amount), budget.currencyCode, budget.policy, start, end];
      }
      seen.add(key);
      rows.push(['Portfolios', 'Portfolio', 'Create', null, name, ...cells]);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped.push({ ref: create.ref, reason: error.reason });
    }
  }
  return { sheetName: PORTFOLIO_BULK_SHEET_NAME, rows, skipped };
}
