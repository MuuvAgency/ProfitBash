import { buildSpBulkSheet, type BulkFileChange, type BulkFileCreate } from '@profitbash/amazon-ads';
import type { CampaignSetupItemRow } from '@profitbash/db';
import { writeXlsx } from '@profitbash/sheets';
import { BULK_FILE_SKIPS } from '../ad-changes/bulk-file';

/**
 * Bulk-Datei einer Setup-Übermittlung (`docs/tasks/phase-4.md` 4.4): je Anlage eine `Create`-Zeile im Blatt
 * „Sponsored Products Campaigns“, Kampagne und Ad Group unter ihrem Namen als vorläufige Text-ID. Die Datei entsteht
 * bei jedem Download neu aus den offenen und angelegten Zeilen (wie bei Änderungen); das Startdatum ist der Tag des
 * Downloads in der Zeitzone des Profils (Amazon lehnt vergangene Tage ab).
 *
 * Off-Amazon (F-S7): Die Spalte gibt es laut Guide nur in den USA. Dort schreibt die Datei „Limit off-Amazon spend“,
 * außer der Baustein wurde bewusst freigeschaltet („Increase reach“); sonst bleibt sie leer (Amazons Standard).
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
}

export const PARENT_NOT_CREATED = {
  code: 'PARENT_NOT_CREATED',
  message: 'Die Kampagne bzw. Ad Group dieser Anlage wird nicht angelegt.',
} as const;

function toCreate(
  row: CampaignSetupItemRow,
  context: { countryCode: string; startDate: string },
): BulkFileCreate {
  const payload = row.payload;
  const parents = { campaignId: row.campaignRef, adGroupId: row.adGroupRef ?? '' };
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
        campaignId: row.campaignRef,
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
  }
}

export function buildSetupBulkFile(
  items: readonly CampaignSetupItemRow[],
  context: { countryCode: string; accountType: string; startDate: string },
): SetupBulkFile {
  const skipped: SetupBulkFileSkip[] = [];
  const lower = (value: string | null) => (value ?? '').toLowerCase();
  /** Eltern, die in der Datei stehen (Kampagne bzw. Kampagne + Ad Group). */
  const written = new Set<string>();
  const changes: BulkFileChange[] = [];
  const byRef = new Map<string, CampaignSetupItemRow>();

  // Erst Eltern einzeln prüfen, damit Kinder wissen, ob es sie in der Datei gibt.
  const parentKey = (row: CampaignSetupItemRow, withAdGroup: boolean) =>
    withAdGroup
      ? `${lower(row.campaignRef)}\u0000${lower(row.adGroupRef)}`
      : lower(row.campaignRef);

  for (const row of items) {
    if (row.status !== 'submitted' && row.status !== 'applied') continue;
    const entity = row.payload.entity;
    const needs =
      entity === 'campaign'
        ? null
        : entity === 'placement' || entity === 'ad_group'
          ? parentKey(row, false)
          : parentKey(row, true);
    if (needs !== null && !written.has(needs)) {
      if (row.status === 'submitted') skipped.push({ itemId: row.id, ...PARENT_NOT_CREATED });
      continue;
    }
    let create = toCreate(row, context);
    // Vendoren bewerben über die ASIN, Seller über die SKU (Guide „Product ad“).
    if (create.entity === 'productAd' && row.payload.entity === 'product_ad') {
      create =
        context.accountType === 'vendor'
          ? { ...create, sku: null, asin: row.payload.asin }
          : { ...create, sku: row.payload.sku, asin: null };
    }
    // Jede Zeile einzeln prüfen: So steht fest, ob ein Elternteil in der Datei landet.
    const ref = row.id;
    const single = buildSpBulkSheet([{ ref, ...create }]);
    if (single.skipped.length > 0) {
      if (row.status === 'submitted') {
        skipped.push({ itemId: row.id, ...BULK_FILE_SKIPS[single.skipped[0]!.reason] });
      }
      continue;
    }
    changes.push({ ref, ...create });
    byRef.set(ref, row);
    if (entity === 'campaign') written.add(parentKey(row, false));
    if (entity === 'ad_group') written.add(parentKey(row, true));
  }

  const sheet = buildSpBulkSheet(changes);
  for (const { ref, reason } of sheet.skipped) {
    const row = byRef.get(ref)!;
    if (row.status === 'submitted') skipped.push({ itemId: row.id, ...BULK_FILE_SKIPS[reason] });
  }
  const count = sheet.rows.length - 1;
  return {
    content: count > 0 ? writeXlsx([{ name: sheet.sheetName, rows: sheet.rows }]) : null,
    rows: count,
    skipped,
  };
}
