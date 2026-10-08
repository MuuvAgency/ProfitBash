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
] as const;
export type SpBulkColumn = (typeof SP_BULK_COLUMNS)[number];

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
  /** Die Bulk-Datei kennt diese Änderung laut Doku nicht (negative ASIN auf Kampagnenebene). */
  | 'notSupportedInBulkFile'
  /** Für dieselbe Entity steht schon eine Zeile in der Datei. */
  | 'duplicate'
  /** Dieselbe Datei archiviert die Kampagne bzw. Ad Group; Amazon archiviert die Kinder mit. */
  | 'parentArchived'
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
const ARCHIVE_ENTITIES = {
  campaign: 'Campaign',
  adGroup: 'Ad Group',
  keyword: 'Keyword',
  productTarget: 'Product Targeting',
  productAd: 'Product Ad',
  negativeKeyword: 'Negative Keyword',
  campaignNegativeKeyword: 'Campaign Negative Keyword',
  negativeProductTarget: 'Negative Product Targeting',
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

type Row = Partial<Record<SpBulkColumn, BulkFileCell>>;

interface Context {
  /** Neue Strategie je Kampagne, wenn dieselbe Datei sie ändert. */
  strategyByCampaign: ReadonlyMap<string, string>;
}

function campaignRow(change: Extract<BulkFileChange, { type: 'campaign' }>): Row {
  const { campaign, set } = change;
  if (campaign.state?.toUpperCase() === 'ARCHIVED') throw new Skip('entityArchived');
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
      ...(set.dailyBudget !== undefined && { 'Daily Budget': amount(set.dailyBudget) }),
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
  switch (change.type) {
    case 'campaign':
      return campaignRow(change);
    case 'placement': {
      if (!/^(0|[1-9]\d{0,2})$/.test(change.percentage) || Number(change.percentage) > 900) {
        throw invalid();
      }
      return {
        Entity: 'Bidding Adjustment',
        Operation: 'Update',
        'Campaign ID': id(change.amazonCampaignId),
        'Bidding Strategy': mapped(
          STRATEGIES,
          context.strategyByCampaign.get(change.amazonCampaignId) ?? change.biddingStrategy,
        ),
        Placement: mapped(PLACEMENTS, change.placement),
        Percentage: { number: change.percentage },
      };
    }
    case 'adGroup':
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
      return withFields(
        {
          Entity: change.type === 'keyword' ? 'Keyword' : 'Product Targeting',
          Operation: 'Update',
          'Campaign ID': id(change.amazonCampaignId),
          'Ad Group ID': id(change.amazonAdGroupId),
          [change.type === 'keyword' ? 'Keyword ID' : 'Product Targeting ID']: id(
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
          Entity: 'Product Ad',
          Operation: 'Update',
          'Campaign ID': id(change.amazonCampaignId),
          'Ad Group ID': id(change.amazonAdGroupId),
          'Ad ID': id(change.amazonAdId),
        },
        stateField(change.state),
      );
    case 'archive': {
      if (change.entity === 'campaignNegativeProductTarget')
        throw new Skip('notSupportedInBulkFile');
      const row: Row = {
        Entity: ARCHIVE_ENTITIES[change.entity],
        Operation: 'Archive',
        'Campaign ID': id(change.amazonCampaignId),
      };
      if ('amazonAdGroupId' in change) row['Ad Group ID'] = id(change.amazonAdGroupId);
      if (change.entity === 'productAd') row['Ad ID'] = id(change.amazonId);
      else if (
        change.entity === 'keyword' ||
        change.entity === 'negativeKeyword' ||
        change.entity === 'campaignNegativeKeyword'
      ) {
        row['Keyword ID'] = id(change.amazonId);
      } else if (change.entity === 'productTarget' || change.entity === 'negativeProductTarget') {
        row['Product Targeting ID'] = id(change.amazonId);
      }
      return row;
    }
    case 'createNegative': {
      const onCampaign = change.amazonAdGroupId === null;
      const parent: Row = {
        Operation: 'Create',
        'Campaign ID': id(change.amazonCampaignId),
        ...(change.amazonAdGroupId !== null && { 'Ad Group ID': id(change.amazonAdGroupId) }),
        State: 'enabled',
      };
      if (change.negative.type === 'keyword') {
        const keywordText = change.negative.keywordText.trim();
        // eslint-disable-next-line no-control-regex
        if (keywordText === '' || /[\u0000-\u001f\u007f]/.test(keywordText)) throw invalid();
        return {
          Entity: onCampaign ? 'Campaign Negative Keyword' : 'Negative Keyword',
          ...parent,
          'Keyword Text': keywordText,
          'Match Type': change.negative.matchType === 'EXACT' ? 'negativeExact' : 'negativePhrase',
        };
      }
      if (onCampaign) throw new Skip('notSupportedInBulkFile');
      if (!/^[A-Z0-9]{10}$/.test(change.negative.asin)) throw invalid();
      return {
        Entity: 'Negative Product Targeting',
        ...parent,
        'Product Targeting Expression': `asin="${change.negative.asin}"`,
      };
    }
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
  }
}

const campaignIdOf = (change: BulkFileChange) =>
  change.type === 'campaign' ? change.campaign.amazonCampaignId : change.amazonCampaignId;

/**
 * Zeilen des Blatts „Sponsored Products Campaigns“ für die Änderungen eines Profils, in der Reihenfolge der Eingabe.
 * Was sich nicht abbilden lässt, steht mit Grund in `skipped` und nicht in der Datei.
 */
export function buildSpBulkSheet(changes: readonly BulkFileChange[]): SpBulkSheet {
  const rows: BulkFileCell[][] = [[...SP_BULK_COLUMNS]];
  const skipped: SpBulkSheet['skipped'] = [];

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
      row = rowFor(change, { strategyByCampaign });
      if (key !== null) seen.add(key);
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
