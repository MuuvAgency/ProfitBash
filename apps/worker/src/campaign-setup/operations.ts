import type { AmazonAdsCreateOperation } from '@profitbash/amazon-ads';
import type { CampaignSetupItemRow } from '@profitbash/db';
import { PARENT_NOT_CREATED } from './bulk-file';
import { HARVEST_TARGET_NOT_CREATED, setupTermKey } from './terms';

/**
 * Anlagen einer Setup-Übermittlung → Aufträge für `applyCreates` (`docs/tasks/phase-4.md` 4.4, API-Weg), ohne I/O.
 *
 * - `ref` jedes Auftrags ist die ID der Zeile; Eltern verweisen auf die Zeile ihrer Kampagne bzw. Ad Group.
 * - Gebotsanpassungen gehören bei SP v3 zur Kampagne (`dynamicBidding`): Sie gehen mit ihr raus und teilen ihr
 *   Ergebnis (`followers`).
 * - Angelegte Zeilen mit Amazon-ID stehen in `created` (Fortsetzen nach Drosselung) und werden nicht erneut gesendet.
 * - Kinder einer Kampagne bzw. Ad Group, die nicht angelegt wird (gescheitert, verworfen, ohne ID), scheitern mit
 *   `PARENT_NOT_CREATED`.
 * - Negatives in der Quelle (4.6) hängen an bestehenden Kampagnen: deren echte IDs stehen unter eigenen refs in
 *   `created`. Sie gehen erst raus, wenn ein Ziel mit demselben Begriff angelegt ist (`deferred`, solange es offen
 *   ist; ohne Ziel `HARVEST_TARGET_NOT_CREATED`).
 * - Off-Amazon wie in der Bulk-Datei: nur in den USA einstellbar, dort ohne Freischaltung „Ausgaben begrenzen“.
 * - Sponsored Display (4.9): Kampagne mit Taktik und Kostenart, Ad Group mit Gebotsoptimierung, Anzeigen, Ziele
 *   (Kontext bzw. Zielgruppe) und negative ASINs als SD-Anlagen; was SD nicht kennt („ähnlich wie“, Keywords),
 *   scheitert mit `SD_NOT_SUPPORTED`.
 * - Sponsored Brands (4.10) nur per Bulk-Datei: Kampagnen scheitern mit `SB_BULK_FILE_ONLY`, ihre Kinder mit
 *   `PARENT_NOT_CREATED`.
 */

export interface SetupOperations {
  operations: AmazonAdsCreateOperation[];
  created: Map<string, string>;
  /** Kampagnen-Zeile → Zeilen, die ihr Ergebnis teilen (Gebotsanpassungen). */
  followers: Map<string, string[]>;
  rejected: { itemId: string; code: string; message: string }[];
  /** Negatives in der Quelle, deren neues Ziel noch offen ist: gehen nach dessen Anlage raus (zweiter Aufruf). */
  deferred: string[];
}

/** Sponsored Brands legt ProfitBash in Phase 4 nur per Bulk-Datei an (4.10, entschieden 2026-10-10). */
export const SB_BULK_FILE_ONLY = {
  code: 'SB_BULK_FILE_ONLY',
  message: 'Sponsored Brands wird nur per Bulk-Datei angelegt.',
} as const;

export const SD_NOT_SUPPORTED = {
  code: 'SD_NOT_SUPPORTED',
  message: 'Sponsored Display kennt diese Anlage nicht.',
} as const;
const SD_TACTICS = { contextual: 'T00020', audience: 'T00030' } as const;

const MATCH_TYPES = { exact: 'EXACT', phrase: 'PHRASE', broad: 'BROAD' } as const;
const EXPRESSIONS = {
  asin: 'ASIN_SAME_AS',
  asinExpanded: 'ASIN_EXPANDED_FROM',
  category: 'ASIN_CATEGORY_SAME_AS',
} as const;

export function buildSetupOperations(
  items: readonly CampaignSetupItemRow[],
  context: { accountType: string; countryCode: string; startDate: string },
): SetupOperations {
  const result: SetupOperations = {
    operations: [],
    created: new Map(),
    followers: new Map(),
    rejected: [],
    deferred: [],
  };
  // Stand der Ziele je Begriff: angelegt bzw. noch offen (Negativ in der Quelle, 4.6).
  const appliedTerms = new Set<string>();
  const openTerms = new Set<string>();
  for (const row of items) {
    if (row.payload.entity !== 'keyword' && row.payload.entity !== 'product_target') continue;
    const term = setupTermKey(row);
    if (term === null) continue;
    if (row.status === 'applied') appliedTerms.add(term);
    if (row.status === 'submitted') openTerms.add(term);
  }
  const lower = (value: string | null) => (value ?? '').toLowerCase();
  const campaignKey = (row: CampaignSetupItemRow) => lower(row.campaignRef);
  const adGroupKey = (row: CampaignSetupItemRow) =>
    `${lower(row.campaignRef)}\u0000${lower(row.adGroupRef)}`;
  const campaigns = new Map<string, CampaignSetupItemRow>();
  const adGroups = new Map<string, CampaignSetupItemRow>();
  for (const row of items) {
    if (row.payload.entity === 'campaign') campaigns.set(campaignKey(row), row);
    if (row.payload.entity === 'ad_group') adGroups.set(adGroupKey(row), row);
  }
  /** Wird das Elternteil angelegt (offen) oder ist es schon da (mit ID)? */
  const usable = (parent: CampaignSetupItemRow | undefined): parent is CampaignSetupItemRow =>
    parent !== undefined &&
    (parent.status === 'submitted' ||
      (parent.status === 'applied' && parent.amazonEntityId !== null));
  const reject = (row: CampaignSetupItemRow) => {
    if (row.status === 'submitted') result.rejected.push({ itemId: row.id, ...PARENT_NOT_CREATED });
  };

  /** Kampagnen, die dieser Lauf nicht sendet (Sponsored Brands); ihre Kinder scheitern. */
  const notSent = new Set<string>();
  for (const row of items) {
    const payload = row.payload;
    if (row.status === 'applied' && row.amazonEntityId !== null) {
      result.created.set(row.id, row.amazonEntityId);
      continue;
    }
    if (row.status !== 'submitted') continue;

    if (payload.entity === 'portfolio') {
      // Portfolios legt ProfitBash nur per Bulk-Datei an (4.7, F9); hierher kommen sie nicht.
      result.rejected.push({
        itemId: row.id,
        code: 'PORTFOLIO_BULK_FILE_ONLY',
        message: 'Portfolios werden nur per Bulk-Datei angelegt.',
      });
      continue;
    }

    if (payload.entity === 'source_negative') {
      // Erst wenn das neue Ziel des Begriffs angelegt ist; ohne Ziel bliebe die Quelle ohne Ersatz.
      const term = setupTermKey(row)!;
      if (!appliedTerms.has(term)) {
        if (openTerms.has(term)) result.deferred.push(row.id);
        else result.rejected.push({ itemId: row.id, ...HARVEST_TARGET_NOT_CREATED });
        continue;
      }
      // Bestehende Kampagne und Ad Group (4.6): ihre echten IDs gelten als schon angelegte Eltern.
      const campaignRef = `amazon-campaign:${payload.amazonCampaignId}`;
      const adGroupRef = `amazon-ad-group:${payload.amazonAdGroupId}`;
      result.created.set(campaignRef, payload.amazonCampaignId);
      result.created.set(adGroupRef, payload.amazonAdGroupId);
      const parents = { campaignRef, adGroupRef };
      result.operations.push(
        payload.negative.type === 'keyword'
          ? {
              ref: row.id,
              entity: 'negativeKeyword',
              ...parents,
              keywordText: payload.negative.text,
              matchType:
                payload.negative.matchType === 'negativeExact'
                  ? 'NEGATIVE_EXACT'
                  : 'NEGATIVE_PHRASE',
            }
          : { ref: row.id, entity: 'negativeTarget', ...parents, asin: payload.negative.asin },
      );
      continue;
    }

    if (payload.entity === 'campaign' && payload.adProduct === 'SB') {
      result.rejected.push({ itemId: row.id, ...SB_BULK_FILE_ONLY });
      notSent.add(row.id);
      continue;
    }

    if (payload.entity === 'campaign' && payload.adProduct === 'SD') {
      result.operations.push({
        ref: row.id,
        entity: 'sdCampaign',
        name: payload.name,
        state: payload.state,
        dailyBudget: payload.dailyBudget,
        startDate: context.startDate,
        tactic: SD_TACTICS[payload.sdTactic ?? 'contextual'],
        costType: payload.costType ?? 'cpc',
        amazonPortfolioId: payload.amazonPortfolioId ?? null,
      });
      continue;
    }

    if (payload.entity === 'campaign') {
      const placements = items.filter(
        (other) => other.payload.entity === 'placement' && campaignKey(other) === campaignKey(row),
      );
      const followers = placements.filter((other) => other.status === 'submitted');
      if (followers.length > 0)
        result.followers.set(
          row.id,
          followers.map((other) => other.id),
        );
      result.operations.push({
        ref: row.id,
        entity: 'campaign',
        name: payload.name,
        targetingType: payload.targetingType === 'auto' ? 'AUTO' : 'MANUAL',
        state: payload.state,
        dailyBudget: payload.dailyBudget,
        startDate: context.startDate,
        biddingStrategy: payload.biddingStrategy ?? 'SALES_DOWN_ONLY',
        placements: placements.flatMap((other) =>
          other.payload.entity === 'placement'
            ? [{ placement: other.payload.placement, percentage: String(other.payload.percentage) }]
            : [],
        ),
        amazonPortfolioId: payload.amazonPortfolioId ?? null,
        offAmazon:
          context.countryCode === 'US'
            ? payload.offAmazon
              ? 'increaseReach'
              : 'limitSpend'
            : null,
      });
      continue;
    }

    const campaign = campaigns.get(campaignKey(row));
    if (!usable(campaign) || notSent.has(campaign.id)) {
      reject(row);
      continue;
    }
    // Gebotsanpassungen gehen mit der Kampagne; ist sie schon angelegt, gibt es hier nichts mehr zu senden.
    if (payload.entity === 'placement') continue;
    const sd = campaign.payload.entity === 'campaign' && campaign.payload.adProduct === 'SD';
    if (sd && payload.entity === 'ad_group') {
      result.operations.push({
        ref: row.id,
        entity: 'sdAdGroup',
        campaignRef: campaign.id,
        name: payload.name,
        defaultBid: payload.defaultBid,
        bidOptimization: payload.bidOptimization ?? 'clicks',
        state: 'ENABLED',
      });
      continue;
    }
    if (payload.entity === 'ad_group') {
      result.operations.push({
        ref: row.id,
        entity: 'adGroup',
        campaignRef: campaign.id,
        name: payload.name,
        defaultBid: payload.defaultBid,
        state: 'ENABLED',
      });
      continue;
    }
    const adGroup = adGroups.get(adGroupKey(row));
    if (!usable(adGroup)) {
      reject(row);
      continue;
    }
    const parents = { campaignRef: campaign.id, adGroupRef: adGroup.id };
    if (sd) {
      const operation = sdChild(row, parents, context);
      if (operation) result.operations.push(operation);
      else result.rejected.push({ itemId: row.id, ...SD_NOT_SUPPORTED });
      continue;
    }
    switch (payload.entity) {
      case 'product_ad':
        result.operations.push({
          ref: row.id,
          entity: 'productAd',
          ...parents,
          // Seller bewerben über die SKU, Vendoren über die ASIN (Spec).
          ...(context.accountType === 'vendor'
            ? { sku: null, asin: payload.asin }
            : { sku: payload.sku, asin: null }),
          state: 'ENABLED',
        });
        break;
      case 'keyword':
        result.operations.push({
          ref: row.id,
          entity: 'keyword',
          ...parents,
          keywordText: payload.text,
          matchType: MATCH_TYPES[payload.matchType],
          bid: payload.bid,
          state: 'ENABLED',
        });
        break;
      case 'product_target':
        result.operations.push({
          ref: row.id,
          entity: 'target',
          ...parents,
          expression: {
            type: EXPRESSIONS[payload.expression.type],
            value: payload.expression.value,
          },
          bid: payload.bid,
          state: 'ENABLED',
        });
        break;
      case 'negative_keyword':
        result.operations.push({
          ref: row.id,
          entity: 'negativeKeyword',
          ...parents,
          keywordText: payload.text,
          matchType: payload.matchType === 'negativeExact' ? 'NEGATIVE_EXACT' : 'NEGATIVE_PHRASE',
        });
        break;
      case 'negative_product_target':
        result.operations.push({
          ref: row.id,
          entity: 'negativeTarget',
          ...parents,
          asin: payload.asin,
        });
        break;
      case 'audience_target':
        // Zielgruppen gibt es nur bei Sponsored Display.
        result.rejected.push({ itemId: row.id, ...SD_NOT_SUPPORTED });
        break;
      case 'sb_ad':
        // Marken-Anzeigen gibt es nur bei Sponsored Brands (nur Bulk-Datei).
        result.rejected.push({ itemId: row.id, ...SB_BULK_FILE_ONLY });
        break;
    }
  }
  return result;
}

/** Kind einer SD-Kampagne (4.9); `null`, wenn Sponsored Display die Anlage nicht kennt. */
function sdChild(
  row: CampaignSetupItemRow,
  parents: { campaignRef: string; adGroupRef: string },
  context: { accountType: string },
): AmazonAdsCreateOperation | null {
  const payload = row.payload;
  switch (payload.entity) {
    case 'product_ad':
      return {
        ref: row.id,
        entity: 'sdProductAd',
        ...parents,
        ...(context.accountType === 'vendor'
          ? { sku: null, asin: payload.asin }
          : { sku: payload.sku, asin: null }),
        state: 'ENABLED',
      };
    case 'audience_target':
      return {
        ref: row.id,
        entity: 'sdTarget',
        ...parents,
        expression: { type: payload.audience, lookbackDays: payload.lookbackDays },
        bid: payload.bid,
        state: 'ENABLED',
      };
    case 'product_target': {
      const { type, value } = payload.expression;
      if (type === 'asinExpanded') return null;
      return {
        ref: row.id,
        entity: 'sdTarget',
        ...parents,
        expression: { type: type === 'asin' ? 'asinSameAs' : 'asinCategorySameAs', value },
        bid: payload.bid,
        state: 'ENABLED',
      };
    }
    case 'negative_product_target':
      return { ref: row.id, entity: 'sdNegativeTarget', ...parents, asin: payload.asin };
    default:
      return null;
  }
}
