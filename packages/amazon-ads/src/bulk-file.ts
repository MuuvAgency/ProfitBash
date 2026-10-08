import { isPlainDecimal } from './json';
import type { AmazonAdsBiddingStrategy, AmazonAdsWriteState } from './writes';

/**
 * Bulk-Datei für die Amazon-Werbekonsole (`docs/tasks/phase-3.md` 3.2b, F2): der zweite Weg einer Übermittlung,
 * solange es keinen API-Zugang gibt. Hier entstehen nur die **Zeilen** des Blatts für Sponsored Products; die Datei
 * schreibt `writeXlsx` aus `@profitbash/sheets`.
 *
 * Grundlage: Amazons Bulksheets-Guides (gelesen am 2026-10-08, Zusammenfassung in `phase-3.md` 3.2b):
 * - Die Datei ist **englisch**: Beim Hochladen nimmt Amazon jede unterstützte Sprache an, unabhängig vom Konto.
 * - Zeilen brauchen `Product`, `Entity`, `Operation` (`Create` | `Update` | `Archive`) und die IDs der Entity.
 * - Ein Kampagnen-Update ohne `Portfolio Id` nimmt die Kampagne aus ihrem Portfolio, ein leeres `End Date` entfernt
 *   das Enddatum: Die Kampagnenzeile trägt deshalb immer den vollständigen Stand.
 * - Ein negatives Produkt-Target auf Kampagnenebene kennt die Doku nicht; es wird übersprungen.
 */

export const SP_BULK_SHEET_NAME = 'Sponsored Products Campaigns';

export const SP_BULK_COLUMNS = [
  'Product',
  'Entity',
  'Operation',
  'Campaign Id',
  'Ad Group Id',
  'Portfolio Id',
  'Ad Id',
  'Keyword Id',
  'Product Targeting Id',
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
] as const;
export type SpBulkColumn = (typeof SP_BULK_COLUMNS)[number];

/** Zelle wie `XlsxWriteCell` in `@profitbash/sheets`: Text, leer oder Zahl als Decimal-String. */
export type BulkFileCell = string | null | { number: string };

/** Stand der Kampagne laut Datenbank (Werte wie der Export bzw. der Bulk-Import sie speichert). */
export interface BulkFileCampaign {
  amazonCampaignId: string;
  amazonPortfolioId: string | null;
  name: string | null;
  /** `YYYY-MM-DD`. */
  startDate: string | null;
  endDate: string | null;
  /** `MANUAL` | `AUTO`. */
  targetingType: string | null;
  state: string | null;
  dailyBudget: string | null;
  biddingStrategy: string | null;
}

interface AdGroupIds {
  amazonCampaignId: string;
  amazonAdGroupId: string;
}

export type BulkFileChange = { ref: string } & (
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
      /** Geltende Gebotsstrategie der Kampagne (nach den Änderungen dieser Datei). */
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
    } & AdGroupIds)
  | ({ type: 'productAd'; amazonAdId: string; state?: AmazonAdsWriteState } & AdGroupIds)
  | { type: 'archive'; entity: 'campaign'; amazonCampaignId: string }
  | ({ type: 'archive'; entity: 'adGroup' } & AdGroupIds)
  | ({
      type: 'archive';
      entity:
        'keyword' | 'productTarget' | 'productAd' | 'negativeKeyword' | 'negativeProductTarget';
      amazonId: string;
    } & AdGroupIds)
  | {
      type: 'archive';
      entity: 'campaignNegativeKeyword';
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
  /** Der Stand der Kampagne reicht nicht für eine vollständige Zeile (Platzhalter, archiviert, fremde Strategie). */
  | 'campaignIncomplete'
  /** Die Bulk-Datei kennt diese Änderung laut Doku nicht (negative ASIN auf Kampagnenebene). */
  | 'notSupportedInBulkFile'
  | 'invalidValue'
  | 'nothingToChange';

export interface SpBulkSheet {
  sheetName: string;
  /** Kopfzeile und je Änderung eine Zeile. */
  rows: BulkFileCell[][];
  /** Änderungen, die nicht in der Datei stehen. */
  skipped: { ref: string; reason: BulkFileSkipReason }[];
}

const PRODUCT = 'Sponsored Products';
const STATES: Readonly<Record<string, string>> = { ENABLED: 'enabled', PAUSED: 'paused' };
const TARGETING_TYPES: Readonly<Record<string, string>> = { MANUAL: 'Manual', AUTO: 'Auto' };
const STRATEGIES: Readonly<Record<string, string>> = {
  SALES_DOWN_ONLY: 'Dynamic bids - down only',
  SALES_UP_AND_DOWN: 'Dynamic bids - up and down',
  NONE: 'Fixed bid',
};
/** Schreibweise der heruntergeladenen Datei; Amazon nimmt auch `placementTop` usw. und achtet nicht auf Groß/Klein. */
const PLACEMENTS: Readonly<Record<string, string>> = {
  PLACEMENT_TOP: 'Placement Top',
  PLACEMENT_REST_OF_SEARCH: 'Placement Rest Of Search',
  PLACEMENT_PRODUCT_PAGE: 'Placement Product Page',
  SITE_AMAZON_BUSINESS: 'Placement Amazon Business',
};
const ARCHIVE_ENTITIES = {
  campaign: 'Campaign',
  adGroup: 'Ad group',
  keyword: 'Keyword',
  productTarget: 'Product targeting',
  productAd: 'Product ad',
  negativeKeyword: 'Negative keyword',
  campaignNegativeKeyword: 'Campaign negative keyword',
  negativeProductTarget: 'Negative product targeting',
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

/** Betrag: höchstens zwei Nachkommastellen (mehr rundet Amazon). */
function amount(value: string): BulkFileCell {
  if (!isPlainDecimal(value) || /\.\d{3,}$/.test(value)) throw invalid();
  return { number: value };
}

function mapped(map: Readonly<Record<string, string>>, value: string | null | undefined): string {
  const result = value === null || value === undefined ? undefined : map[value.toUpperCase()];
  if (result === undefined) throw invalid();
  return result;
}

/** `YYYY-MM-DD` → `YYYYMMDD`. */
function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid();
  return value.replaceAll('-', '');
}

type Row = Partial<Record<SpBulkColumn, BulkFileCell>>;

function campaignRow(change: Extract<BulkFileChange, { type: 'campaign' }>): Row {
  const { campaign, set } = change;
  if (Object.values(set).every((value) => value === undefined)) throw new Skip('nothingToChange');
  const state = set.state ?? campaign.state;
  const strategy = set.biddingStrategy ?? campaign.biddingStrategy;
  const budget = set.dailyBudget ?? campaign.dailyBudget;
  if (
    campaign.name === null ||
    campaign.name === '' ||
    campaign.startDate === null ||
    budget === null ||
    state === null ||
    !Object.hasOwn(STATES, state.toUpperCase()) ||
    strategy === null ||
    !Object.hasOwn(STRATEGIES, strategy) ||
    campaign.targetingType === null ||
    !Object.hasOwn(TARGETING_TYPES, campaign.targetingType.toUpperCase())
  ) {
    throw new Skip('campaignIncomplete');
  }
  return {
    Entity: 'Campaign',
    Operation: 'Update',
    'Campaign Id': id(campaign.amazonCampaignId),
    ...(campaign.amazonPortfolioId !== null && { 'Portfolio Id': id(campaign.amazonPortfolioId) }),
    'Campaign Name': campaign.name,
    'Start Date': date(campaign.startDate),
    ...(campaign.endDate !== null && { 'End Date': date(campaign.endDate) }),
    'Targeting Type': mapped(TARGETING_TYPES, campaign.targetingType),
    State: mapped(STATES, state),
    'Daily Budget': amount(budget),
    'Bidding Strategy': mapped(STRATEGIES, strategy),
  };
}

function withFields(row: Row, fields: Row): Row {
  if (Object.keys(fields).length === 0) throw new Skip('nothingToChange');
  return { ...row, ...fields };
}

const stateField = (state: AmazonAdsWriteState | undefined): Row =>
  state === undefined ? {} : { State: mapped(STATES, state) };

function rowFor(change: BulkFileChange): Row {
  switch (change.type) {
    case 'campaign':
      return campaignRow(change);
    case 'placement': {
      if (!/^(0|[1-9]\d{0,2})$/.test(change.percentage) || Number(change.percentage) > 900) {
        throw invalid();
      }
      return {
        Entity: 'Bidding adjustment',
        Operation: 'Update',
        'Campaign Id': id(change.amazonCampaignId),
        'Bidding Strategy': mapped(STRATEGIES, change.biddingStrategy),
        Placement: mapped(PLACEMENTS, change.placement),
        Percentage: { number: change.percentage },
      };
    }
    case 'adGroup':
      return withFields(
        {
          Entity: 'Ad group',
          Operation: 'Update',
          'Campaign Id': id(change.amazonCampaignId),
          'Ad Group Id': id(change.amazonAdGroupId),
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
      return withFields(
        {
          Entity: change.type === 'keyword' ? 'Keyword' : 'Product targeting',
          Operation: 'Update',
          'Campaign Id': id(change.amazonCampaignId),
          'Ad Group Id': id(change.amazonAdGroupId),
          [change.type === 'keyword' ? 'Keyword Id' : 'Product Targeting Id']: id(
            change.amazonTargetId,
          ),
        },
        {
          ...stateField(change.state),
          ...(change.bid !== undefined && { Bid: amount(change.bid) }),
        },
      );
    case 'productAd':
      return withFields(
        {
          Entity: 'Product ad',
          Operation: 'Update',
          'Campaign Id': id(change.amazonCampaignId),
          'Ad Group Id': id(change.amazonAdGroupId),
          'Ad Id': id(change.amazonAdId),
        },
        stateField(change.state),
      );
    case 'archive': {
      const row: Row = {
        Entity: ARCHIVE_ENTITIES[change.entity],
        Operation: 'Archive',
        'Campaign Id': id(change.amazonCampaignId),
      };
      if ('amazonAdGroupId' in change) row['Ad Group Id'] = id(change.amazonAdGroupId);
      if (change.entity === 'productAd') row['Ad Id'] = id(change.amazonId);
      else if (change.entity === 'keyword' || change.entity === 'negativeKeyword') {
        row['Keyword Id'] = id(change.amazonId);
      } else if (change.entity === 'campaignNegativeKeyword') {
        row['Keyword Id'] = id(change.amazonId);
      } else if (change.entity === 'productTarget' || change.entity === 'negativeProductTarget') {
        row['Product Targeting Id'] = id(change.amazonId);
      }
      return row;
    }
    case 'createNegative': {
      const onCampaign = change.amazonAdGroupId === null;
      const parent: Row = {
        Operation: 'Create',
        'Campaign Id': id(change.amazonCampaignId),
        ...(change.amazonAdGroupId !== null && { 'Ad Group Id': id(change.amazonAdGroupId) }),
        State: 'enabled',
      };
      if (change.negative.type === 'keyword') {
        if (change.negative.keywordText.trim() === '') throw invalid();
        return {
          Entity: onCampaign ? 'Campaign negative keyword' : 'Negative keyword',
          ...parent,
          'Keyword Text': change.negative.keywordText,
          'Match Type': change.negative.matchType === 'EXACT' ? 'negativeExact' : 'negativePhrase',
        };
      }
      if (onCampaign) throw new Skip('notSupportedInBulkFile');
      if (!/^[A-Z0-9]{10}$/.test(change.negative.asin)) throw invalid();
      return {
        Entity: 'Negative product targeting',
        ...parent,
        'Product Targeting Expression': `asin="${change.negative.asin}"`,
      };
    }
  }
}

/**
 * Zeilen des Blatts „Sponsored Products Campaigns“ für die Änderungen eines Profils, in der Reihenfolge der Eingabe.
 * Was sich nicht abbilden lässt, steht mit Grund in `skipped` und nicht in der Datei.
 */
export function buildSpBulkSheet(changes: readonly BulkFileChange[]): SpBulkSheet {
  const rows: BulkFileCell[][] = [[...SP_BULK_COLUMNS]];
  const skipped: SpBulkSheet['skipped'] = [];
  for (const change of changes) {
    let row: Row;
    try {
      row = rowFor(change);
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      skipped.push({ ref: change.ref, reason: error.reason });
      continue;
    }
    rows.push(
      SP_BULK_COLUMNS.map((column) => (column === 'Product' ? PRODUCT : (row[column] ?? null))),
    );
  }
  return { sheetName: SP_BULK_SHEET_NAME, rows, skipped };
}
