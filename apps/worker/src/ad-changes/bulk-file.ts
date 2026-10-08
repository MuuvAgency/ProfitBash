import {
  buildSpBulkSheet,
  type AmazonAdsBiddingStrategy,
  type AmazonAdsWriteState,
  type BulkFileChange,
  type BulkFileSkipReason,
} from '@profitbash/amazon-ads';
import {
  AD_CHANGE_BIDDING_STRATEGIES,
  AD_CHANGE_PLACEMENTS,
  isAdChangePlacementField,
} from '@profitbash/shared';
import { writeXlsx } from '@profitbash/sheets';
import type { RejectedChange, SubmissionChange } from './operations';

/**
 * Änderungen einer Übermittlung → Bulk-Datei für die Werbekonsole (`docs/tasks/phase-3.md` 3.4, Vorgaben aus 3.2b,
 * ohne I/O). Wie beim Weg über die API gehören mehrere Felder einer Entity in **eine** Zeile, `state = ARCHIVED`
 * wird zu `Archive`; anders als dort ist jede Platzierung eine eigene Zeile (`Bidding Adjustment`), und jede Zeile
 * trägt die IDs ihrer Eltern. Bisher nur Sponsored Products (SB und SD mit 3.2c).
 */

const REJECTIONS = {
  AD_PRODUCT_NOT_SUPPORTED: 'Die Bulk-Datei gibt es bisher nur für Sponsored Products.',
  ENTITY_NOT_FOUND: 'Die Entity gibt es bei Amazon nicht mehr oder sie ist unbekannt.',
  ENTITY_ARCHIVED: 'Dieselbe Übermittlung archiviert die Entity; weitere Änderungen entfallen.',
  SUPERSEDED: 'Dieselbe Übermittlung ändert dieses Feld noch einmal; es gilt die spätere Angabe.',
  NOT_SUPPORTED: 'Negatives lassen sich nur archivieren.',
  BIDDING_STRATEGY_NOT_SUPPORTED:
    'Platzierungen lassen sich nur ändern, wenn die Kampagne eine feste oder dynamische Gebotsstrategie trägt.',
} as const;

/** Gründe, aus denen `buildSpBulkSheet` eine Zeile auslässt, als Code und Text der Änderung. */
const SKIPS: Record<BulkFileSkipReason, { code: string; message: string }> = {
  entityArchived: {
    code: 'BULK_FILE_ENTITY_ARCHIVED',
    message: 'Die Kampagne ist archiviert und lässt sich nicht mehr ändern.',
  },
  notSupportedInBulkFile: {
    code: 'BULK_FILE_NOT_SUPPORTED',
    message:
      'Diese Änderung kennt die Bulk-Datei nicht (negative ASIN auf Kampagnenebene); bitte in der Werbekonsole ändern.',
  },
  duplicate: {
    code: 'BULK_FILE_DUPLICATE',
    message: 'Für dieselbe Entity steht schon eine Zeile in der Datei.',
  },
  parentArchived: {
    code: 'BULK_FILE_PARENT_ARCHIVED',
    message:
      'Dieselbe Datei archiviert die Kampagne bzw. Ad Group; Amazon archiviert die Kinder mit.',
  },
  invalidValue: {
    code: 'BULK_FILE_INVALID_VALUE',
    message: 'Die Änderung enthält einen Wert oder eine ID, die die Bulk-Datei nicht annimmt.',
  },
  nothingToChange: {
    code: 'BULK_FILE_NOTHING_TO_CHANGE',
    message: 'Die Änderung nennt kein Feld.',
  },
};

export interface BulkFileChangePlan {
  changes: BulkFileChange[];
  /** `ref` einer Zeile → ihre Änderungen. */
  changeIdsByRef: Map<string, string[]>;
  rejected: RejectedChange[];
}

export function buildBulkFileChanges(rows: readonly SubmissionChange[]): BulkFileChangePlan {
  const changes: BulkFileChange[] = [];
  const changeIdsByRef = new Map<string, string[]>();
  const rejected: RejectedChange[] = [];
  const reject = (row: SubmissionChange, code: keyof typeof REJECTIONS) =>
    rejected.push({ changeId: row.id, code, message: REJECTIONS[code] });
  const add = (change: BulkFileChange, sources: readonly SubmissionChange[]) => {
    changes.push(change);
    changeIdsByRef.set(
      change.ref,
      sources.map((source) => source.id),
    );
  };

  const groups = new Map<string, SubmissionChange[]>();
  for (const row of rows) {
    if (row.adProduct !== 'SPONSORED_PRODUCTS') {
      reject(row, 'AD_PRODUCT_NOT_SUPPORTED');
      continue;
    }
    if (row.operation === 'create') {
      if (row.negative === null) {
        reject(row, 'ENTITY_NOT_FOUND');
        continue;
      }
      add(
        {
          ref: `create:${row.id}`,
          type: 'createNegative',
          amazonCampaignId: row.amazonCampaignId,
          amazonAdGroupId: row.amazonAdGroupId,
          negative: row.negative,
        },
        [row],
      );
      continue;
    }
    if (row.amazonEntityId === null || row.entityRemoved || row.field === null) {
      reject(row, 'ENTITY_NOT_FOUND');
      continue;
    }
    const ref = `${row.entityType}:${row.entityId}`;
    const group = groups.get(ref);
    if (group) group.push(row);
    else groups.set(ref, [row]);
  }

  for (const [ref, all] of groups) {
    const lastByField = new Map(all.map((row) => [row.field, row]));
    const group = all.filter((row) => lastByField.get(row.field) === row);
    for (const row of all) if (!group.includes(row)) reject(row, 'SUPERSEDED');
    const first = group[0]!;
    const amazonId = first.amazonEntityId!;
    const { amazonCampaignId, amazonAdGroupId } = first;
    const onCampaign = first.entityType === 'campaign' || first.negativeLevel === 'campaign';
    // Alle Zeilen unterhalb der Kampagne nennen ihre Ad Group.
    if (!onCampaign && amazonAdGroupId === null) {
      for (const row of group) reject(row, 'ENTITY_NOT_FOUND');
      continue;
    }
    const ids = { amazonCampaignId, amazonAdGroupId: amazonAdGroupId! };

    const archive = group.find((row) => row.field === 'state' && row.after === 'ARCHIVED');
    if (archive) {
      for (const row of group) if (row !== archive) reject(row, 'ENTITY_ARCHIVED');
      add(archiveChange(ref, first, amazonId, ids), [archive]);
      continue;
    }
    if (first.entityType === 'negative_target') {
      for (const row of group) reject(row, 'NOT_SUPPORTED');
      continue;
    }

    const value = (field: SubmissionChange['field']) =>
      group.find((row) => row.field === field)?.after ?? undefined;
    const state = value('state') as AmazonAdsWriteState | undefined;
    const fields = group.filter(
      (row) => row.field === null || !isAdChangePlacementField(row.field),
    );
    if (first.entityType === 'campaign') {
      const dailyBudget = value('budget');
      const biddingStrategy = value('bidding_strategy') as AmazonAdsBiddingStrategy | undefined;
      if (fields.length > 0) {
        add(
          {
            ref,
            type: 'campaign',
            campaign: {
              amazonCampaignId,
              amazonPortfolioId: first.campaignAmazonPortfolioId,
              endDate: first.campaignEndDate,
              state: first.campaignState,
            },
            set: {
              ...(state !== undefined && { state }),
              ...(dailyBudget !== undefined && { dailyBudget }),
              ...(biddingStrategy !== undefined && { biddingStrategy }),
            },
          },
          fields,
        );
      }
      // Die Zeile der Platzierung nennt die geltende Strategie: die neue dieser Übermittlung, sonst die der Kampagne.
      const strategy = biddingStrategy ?? first.campaignBiddingStrategy;
      const settable =
        strategy !== null && (AD_CHANGE_BIDDING_STRATEGIES as readonly string[]).includes(strategy);
      for (const row of group) {
        if (row.field === null || !isAdChangePlacementField(row.field)) continue;
        if (!settable) {
          reject(row, 'BIDDING_STRATEGY_NOT_SUPPORTED');
          continue;
        }
        add(
          {
            ref: `placement:${row.id}`,
            type: 'placement',
            amazonCampaignId,
            biddingStrategy: strategy,
            placement: AD_CHANGE_PLACEMENTS[row.field],
            percentage: row.after!,
          },
          [row],
        );
      }
    } else if (first.entityType === 'ad_group') {
      const defaultBid = value('default_bid');
      add(
        {
          ref,
          type: 'adGroup',
          ...ids,
          ...(defaultBid !== undefined && { defaultBid }),
          ...(state !== undefined && { state }),
        },
        group,
      );
    } else if (first.entityType === 'target') {
      const bid = value('bid');
      add(
        {
          ref,
          type: first.targetType === 'keyword' ? 'keyword' : 'productTarget',
          ...ids,
          amazonTargetId: amazonId,
          ...(bid !== undefined && { bid }),
          ...(state !== undefined && { state }),
        },
        group,
      );
    } else {
      add(
        {
          ref,
          type: 'productAd',
          ...ids,
          amazonAdId: amazonId,
          ...(state !== undefined && { state }),
        },
        group,
      );
    }
  }
  return { changes, changeIdsByRef, rejected };
}

function archiveChange(
  ref: string,
  row: SubmissionChange,
  amazonId: string,
  ids: { amazonCampaignId: string; amazonAdGroupId: string },
): BulkFileChange {
  const { amazonCampaignId } = ids;
  switch (row.entityType) {
    case 'campaign':
      return { ref, type: 'archive', entity: 'campaign', amazonCampaignId };
    case 'ad_group':
      return { ref, type: 'archive', entity: 'adGroup', ...ids };
    case 'product_ad':
      return { ref, type: 'archive', entity: 'productAd', amazonId, ...ids };
    case 'target':
      return {
        ref,
        type: 'archive',
        entity: row.targetType === 'keyword' ? 'keyword' : 'productTarget',
        amazonId,
        ...ids,
      };
    case 'negative_target': {
      const keyword = row.targetType === 'keyword';
      if (row.negativeLevel === 'campaign') {
        return {
          ref,
          type: 'archive',
          entity: keyword ? 'campaignNegativeKeyword' : 'campaignNegativeProductTarget',
          amazonCampaignId,
          amazonId,
        };
      }
      return {
        ref,
        type: 'archive',
        entity: keyword ? 'negativeKeyword' : 'negativeProductTarget',
        amazonId,
        ...ids,
      };
    }
  }
}

export interface SubmissionBulkFile {
  /** Die `.xlsx`-Datei; `null`, wenn keine Änderung in die Datei passt. */
  content: Uint8Array | null;
  /** Zeilen ohne Kopfzeile. */
  rows: number;
  /** Änderungen, die nicht in der Datei stehen: Sie gelten nicht als übermittelt. */
  skipped: RejectedChange[];
}

/** Die Bulk-Datei einer Übermittlung samt der Änderungen, die sie nicht enthält. */
export function buildSubmissionBulkFile(rows: readonly SubmissionChange[]): SubmissionBulkFile {
  const plan = buildBulkFileChanges(rows);
  const sheet = buildSpBulkSheet(plan.changes);
  const skipped = [...plan.rejected];
  for (const { ref, reason } of sheet.skipped) {
    for (const changeId of plan.changeIdsByRef.get(ref) ?? []) {
      skipped.push({ changeId, ...SKIPS[reason] });
    }
  }
  const count = sheet.rows.length - 1;
  return {
    content: count > 0 ? writeXlsx([{ name: sheet.sheetName, rows: sheet.rows }]) : null,
    rows: count,
    skipped,
  };
}
