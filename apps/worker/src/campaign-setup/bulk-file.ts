import { buildSpBulkSheet, type BulkFileChange, type BulkFileCreate } from '@profitbash/amazon-ads';
import type { CampaignSetupItemRow } from '@profitbash/db';
import { writeXlsx } from '@profitbash/sheets';
import { BULK_FILE_SKIPS } from '../ad-changes/bulk-file';

/**
 * Bulk-Datei einer Setup-Übermittlung (`docs/tasks/phase-4.md` 4.4): je offener Anlage eine `Create`-Zeile im
 * Blatt „Sponsored Products Campaigns“, Kampagne und Ad Group unter ihrem Namen als vorläufige Text-ID. Die Datei
 * entsteht bei jedem Download neu und enthält nur, was noch nicht angelegt ist: Kinder schon angelegter Eltern nennen
 * deren echte ID (ein erneuter Upload legt nichts doppelt an); ist die ID noch nicht zugeordnet, warten sie auf den
 * nächsten Import (`waiting`). Das Startdatum ist der Tag des Downloads in der Zeitzone des Profils (Amazon lehnt
 * vergangene Tage ab).
 *
 * Off-Amazon (F-S7): Die Spalte gibt es laut Guide nur in den USA. Dort schreibt die Datei „Limit off-Amazon spend“,
 * außer der Baustein wurde bewusst freigeschaltet („Increase reach“); sonst bleibt sie leer (Amazons Standard).
 *
 * Negatives in der Quelle eines Harvest-Begriffs (4.6) nennen die echten IDs der bestehenden Kampagne und Ad Group.
 *
 * Was nicht in die Datei passt, scheitert mit Grund (`skipped`); Kinder einer Kampagne oder Ad Group, die nicht in
 * der Datei steht (ungültig oder schon gescheitert), mit `PARENT_NOT_CREATED`.
 */

export interface SetupBulkFileSkip {
  itemId: string;
  code: string;
  message: string;
}

export interface SetupBulkFile {
  content: Uint8Array | null;
  rows: number;
  skipped: SetupBulkFileSkip[];
  /** Offene Zeilen, deren Elternteil angelegt, aber noch keiner echten ID zugeordnet ist (nächster Import). */
  waiting: string[];
}

export const PARENT_NOT_CREATED = {
  code: 'PARENT_NOT_CREATED',
  message: 'Die Kampagne bzw. Ad Group dieser Anlage wird nicht angelegt.',
} as const;

function toCreate(
  row: CampaignSetupItemRow,
  context: { countryCode: string; startDate: string },
  parents: { campaignId: string; adGroupId: string },
): BulkFileCreate {
  const payload = row.payload;
  switch (payload.entity) {
    case 'campaign':
      return {
        type: 'create',
        entity: 'campaign',
        campaignId: row.campaignRef,
        name: payload.name,
        targetingType: payload.targetingType,
        state: payload.state,
        dailyBudget: payload.dailyBudget,
        startDate: context.startDate,
        // Nur SP-Kampagnen kommen hierher; ohne Strategie gilt Amazons Standard „nur senken“.
        biddingStrategy: payload.biddingStrategy ?? 'SALES_DOWN_ONLY',
        amazonPortfolioId: null,
        offAmazon:
          context.countryCode === 'US'
            ? payload.offAmazon
              ? 'increaseReach'
              : 'limitSpend'
            : null,
      };
    case 'placement':
      return {
        type: 'create',
        entity: 'placement',
        campaignId: parents.campaignId,
        placement: payload.placement,
        percentage: String(payload.percentage),
      };
    case 'ad_group':
      return {
        type: 'create',
        entity: 'adGroup',
        ...parents,
        name: payload.name,
        defaultBid: payload.defaultBid,
        state: 'ENABLED',
      };
    case 'product_ad':
      return {
        type: 'create',
        entity: 'productAd',
        ...parents,
        sku: payload.sku,
        asin: null,
        state: 'ENABLED',
      };
    case 'keyword':
      return {
        type: 'create',
        entity: 'keyword',
        ...parents,
        keywordText: payload.text,
        matchType: payload.matchType,
        bid: payload.bid,
        state: 'ENABLED',
      };
    case 'product_target':
      return {
        type: 'create',
        entity: 'productTarget',
        ...parents,
        expression: payload.expression,
        bid: payload.bid,
        state: 'ENABLED',
      };
    case 'negative_keyword':
      return {
        type: 'create',
        entity: 'negativeKeyword',
        ...parents,
        keywordText: payload.text,
        matchType: payload.matchType,
      };
    case 'negative_product_target':
      return { type: 'create', entity: 'negativeProductTarget', ...parents, asin: payload.asin };
    case 'source_negative':
      return payload.negative.type === 'keyword'
        ? {
            type: 'create',
            entity: 'negativeKeyword',
            ...parents,
            keywordText: payload.negative.text,
            matchType: payload.negative.matchType,
          }
        : {
            type: 'create',
            entity: 'negativeProductTarget',
            ...parents,
            asin: payload.negative.asin,
          };
  }
}

export function buildSetupBulkFile(
  items: readonly CampaignSetupItemRow[],
  context: { countryCode: string; accountType: string; startDate: string },
): SetupBulkFile {
  const skipped: SetupBulkFileSkip[] = [];
  const waiting: string[] = [];
  const lower = (value: string | null) => (value ?? '').toLowerCase();
  const campaignKey = (row: CampaignSetupItemRow) => lower(row.campaignRef);
  const adGroupKey = (row: CampaignSetupItemRow) =>
    `${lower(row.campaignRef)}\u0000${lower(row.adGroupRef)}`;
  /**
   * Eltern je Schlüssel: ID für die Kinder (Text-ID, wenn die Zeile in der Datei steht; echte ID, wenn sie schon
   * angelegt ist) oder `waiting` (angelegt, ID noch unbekannt). Fehlt der Schlüssel, wird das Elternteil nicht angelegt.
   */
  const parents = new Map<string, string | 'waiting'>();
  const changes: BulkFileChange[] = [];

  // Die Zeilen sind nach Position sortiert: Eltern stehen vor ihren Kindern.
  for (const row of items) {
    const entity = row.payload.entity;
    const ownKey =
      entity === 'campaign' ? campaignKey(row) : entity === 'ad_group' ? adGroupKey(row) : null;
    if (row.status === 'applied') {
      // Schon angelegt: steht nicht mehr in der Datei, Kinder nennen die echte ID.
      if (ownKey !== null) parents.set(ownKey, row.amazonEntityId ?? 'waiting');
      continue;
    }
    if (row.status !== 'submitted') continue;

    // Negatives in der Quelle (4.6) gehören zu bestehenden Kampagnen: echte IDs aus der Zeile.
    const source = row.payload.entity === 'source_negative' ? row.payload : null;
    const campaignId = source
      ? source.amazonCampaignId
      : entity === 'campaign'
        ? row.campaignRef
        : parents.get(campaignKey(row));
    const adGroupId = source
      ? source.amazonAdGroupId
      : entity === 'campaign' || entity === 'placement' || entity === 'ad_group'
        ? (row.adGroupRef ?? '')
        : parents.get(adGroupKey(row));
    if (campaignId === undefined || adGroupId === undefined) {
      skipped.push({ itemId: row.id, ...PARENT_NOT_CREATED });
      continue;
    }
    if (campaignId === 'waiting' || adGroupId === 'waiting') {
      waiting.push(row.id);
      continue;
    }
    let create = toCreate(row, context, { campaignId, adGroupId });
    // Vendoren bewerben über die ASIN, Seller über die SKU (Guide „Product ad“).
    if (create.entity === 'productAd' && row.payload.entity === 'product_ad') {
      create =
        context.accountType === 'vendor'
          ? { ...create, sku: null, asin: row.payload.asin }
          : { ...create, sku: row.payload.sku, asin: null };
    }
    const change: BulkFileChange = { ref: row.id, ...create };
    // Jede Zeile einzeln prüfen: So steht fest, ob ein Elternteil in der Datei landet (Dubletten prüft der
    // Durchlauf unten; doppelte Kampagnen schließt schon die Prüfung beim Übermitteln aus).
    const single = buildSpBulkSheet([change]).skipped[0];
    if (single) {
      skipped.push({ itemId: row.id, ...BULK_FILE_SKIPS[single.reason] });
      continue;
    }
    changes.push(change);
    if (ownKey !== null)
      parents.set(ownKey, entity === 'campaign' ? row.campaignRef : row.adGroupRef!);
  }

  const sheet = buildSpBulkSheet(changes);
  for (const { ref, reason } of sheet.skipped)
    skipped.push({ itemId: ref, ...BULK_FILE_SKIPS[reason] });
  const count = sheet.rows.length - 1;
  return {
    content: count > 0 ? writeXlsx([{ name: sheet.sheetName, rows: sheet.rows }]) : null,
    rows: count,
    skipped,
    waiting,
  };
}
