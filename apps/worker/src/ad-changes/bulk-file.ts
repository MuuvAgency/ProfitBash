import {
  buildBulkSheet,
  type AmazonAdsBiddingStrategy,
  type AmazonAdsWriteState,
  type BulkFileChange,
  type BulkFileSdTargeting,
  type BulkFileSheetKind,
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
 * trägt die IDs ihrer Eltern.
 *
 * Je Anzeigentyp entsteht ein eigenes Blatt (3.9): Sponsored Products, Sponsored Display und für Sponsored Brands
 * zwei (das ältere und das für Kampagnen mit mehreren Ad Groups). In welchem der beiden eine SB-Kampagne steht,
 * weiß ProfitBash aus dem Bulk-Import (`campaignMultiAdGroups`); ohne diese Angabe entfällt die Änderung.
 */

const REJECTIONS = {
  AD_PRODUCT_NOT_SUPPORTED:
    'Die Bulk-Datei gibt es nur für Sponsored Products, Sponsored Brands und Sponsored Display.',
  BULK_FILE_SHEET_UNKNOWN:
    'Für diese Sponsored-Brands-Kampagne ist das Blatt der Bulk-Datei unbekannt; bitte zuerst eine aktuelle Bulk-Datei importieren.',
  TARGET_TYPE_NOT_SUPPORTED: 'Diese Art von Target kennt die Bulk-Datei nicht.',
  ENTITY_NOT_FOUND: 'Die Entity gibt es bei Amazon nicht mehr oder sie ist unbekannt.',
  ENTITY_ARCHIVED: 'Dieselbe Übermittlung archiviert die Entity; weitere Änderungen entfallen.',
  SUPERSEDED: 'Dieselbe Übermittlung ändert dieses Feld noch einmal; es gilt die spätere Angabe.',
  NOT_SUPPORTED: 'Negatives lassen sich nur archivieren.',
  BIDDING_STRATEGY_NOT_SUPPORTED:
    'Platzierungen lassen sich nur ändern, wenn die Kampagne eine feste oder dynamische Gebotsstrategie trägt.',
} as const;

/** Blätter in der Reihenfolge der Datei der Werbekonsole. */
const SHEET_POSITION: Record<BulkFileSheetKind, number> = {
  sp: 0,
  sb: 1,
  sbMultiAdGroup: 2,
  sd: 3,
};
// Über `Record` vollständig: Ein neues Blatt ohne Platz fiele beim Typecheck auf, statt in der Datei zu fehlen.
const SHEET_ORDER = (Object.keys(SHEET_POSITION) as BulkFileSheetKind[]).sort(
  (a, b) => SHEET_POSITION[a] - SHEET_POSITION[b],
);

/** Blatt einer Änderung; ein Ablehnungsgrund, wenn es keines gibt. */
function sheetOf(row: SubmissionChange): BulkFileSheetKind | keyof typeof REJECTIONS {
  switch (row.adProduct) {
    case 'SPONSORED_PRODUCTS':
      return 'sp';
    case 'SPONSORED_DISPLAY':
      return 'sd';
    case 'SPONSORED_BRANDS':
      if (row.campaignMultiAdGroups === null) return 'BULK_FILE_SHEET_UNKNOWN';
      return row.campaignMultiAdGroups ? 'sbMultiAdGroup' : 'sb';
    default:
      return 'AD_PRODUCT_NOT_SUPPORTED';
  }
}

const isSheet = (value: string): value is BulkFileSheetKind =>
  (SHEET_ORDER as readonly string[]).includes(value);

/**
 * Art des Targetings eines SD-Targets (eigene Entity je Art im Blatt): Zielgruppen (`audience`,
 * `product_audience` …) bzw. Produkte und Kategorien. `null`: unbekannte Art.
 */
function sdTargeting(targetType: string | null): BulkFileSdTargeting | null {
  if (targetType === null) return null;
  if (targetType.includes('audience')) return 'audience';
  return targetType === 'product' || targetType === 'category' ? 'contextual' : null;
}

/** Gründe, aus denen `buildBulkSheet` eine Zeile auslässt, als Code und Text der Änderung. */
const SKIPS: Record<BulkFileSkipReason, { code: string; message: string }> = {
  entityArchived: {
    code: 'BULK_FILE_ENTITY_ARCHIVED',
    message: 'Die Kampagne ist archiviert und lässt sich nicht mehr ändern.',
  },
  notSupportedInBulkFile: {
    code: 'BULK_FILE_NOT_SUPPORTED',
    message:
      'Diese Änderung kennt die Bulk-Datei für diesen Anzeigentyp nicht; bitte in der Werbekonsole ändern.',
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
  /** `ref` einer Zeile → ihr Blatt. */
  sheetByRef: Map<string, BulkFileSheetKind>;
  rejected: RejectedChange[];
}

export function buildBulkFileChanges(rows: readonly SubmissionChange[]): BulkFileChangePlan {
  const changes: BulkFileChange[] = [];
  const changeIdsByRef = new Map<string, string[]>();
  const sheetByRef = new Map<string, BulkFileSheetKind>();
  const rejected: RejectedChange[] = [];
  const reject = (row: SubmissionChange, code: keyof typeof REJECTIONS) =>
    rejected.push({ changeId: row.id, code, message: REJECTIONS[code] });
  const add = (change: BulkFileChange, sources: readonly SubmissionChange[]) => {
    changes.push(change);
    // `sheetOf` hat für jede Änderung, die hier ankommt, ein Blatt geliefert.
    sheetByRef.set(change.ref, sheetOf(sources[0]!) as BulkFileSheetKind);
    changeIdsByRef.set(
      change.ref,
      sources.map((source) => source.id),
    );
  };

  const groups = new Map<string, SubmissionChange[]>();
  for (const row of rows) {
    const sheet = sheetOf(row);
    if (!isSheet(sheet)) {
      reject(row, sheet);
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
    const sheet = sheetOf(first) as BulkFileSheetKind;
    const onCampaign = first.entityType === 'campaign' || first.negativeLevel === 'campaign';
    const isTarget = first.entityType === 'target' || first.entityType === 'negative_target';
    // Alle Zeilen unterhalb der Kampagne nennen ihre Ad Group; nur das ältere SB-Blatt kennt Targets ohne.
    if (!onCampaign && amazonAdGroupId === null && !(sheet === 'sb' && isTarget)) {
      for (const row of group) reject(row, 'ENTITY_NOT_FOUND');
      continue;
    }
    const ids = { amazonCampaignId, amazonAdGroupId: amazonAdGroupId! };
    const targeting = sheet === 'sd' ? sdTargeting(first.targetType) : null;
    if (
      first.entityType === 'target' &&
      first.targetType !== 'keyword' &&
      ((sheet === 'sd' && targeting === null) ||
        ((sheet === 'sb' || sheet === 'sbMultiAdGroup') && first.targetType === 'theme'))
    ) {
      for (const row of group) reject(row, 'TARGET_TYPE_NOT_SUPPORTED');
      continue;
    }
    const sd = targeting === null ? {} : { sdTargeting: targeting };

    const archive = group.find((row) => row.field === 'state' && row.after === 'ARCHIVED');
    if (archive) {
      for (const row of group) if (row !== archive) reject(row, 'ENTITY_ARCHIVED');
      add(archiveChange(ref, first, amazonId, { amazonCampaignId, amazonAdGroupId }, sd), [
        archive,
      ]);
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
      // Ad Groups von Sponsored Brands haben kein Standardgebot: Nur diese Änderung entfällt, der Zustand geht raus.
      const noDefaultBid = sheet === 'sb' || sheet === 'sbMultiAdGroup';
      const kept = noDefaultBid ? group.filter((row) => row.field !== 'default_bid') : group;
      for (const row of group) {
        if (!kept.includes(row))
          rejected.push({ changeId: row.id, ...SKIPS.notSupportedInBulkFile });
      }
      if (kept.length === 0) continue;
      const defaultBid = noDefaultBid ? undefined : value('default_bid');
      add(
        {
          ref,
          type: 'adGroup',
          ...ids,
          ...(defaultBid !== undefined && { defaultBid }),
          ...(state !== undefined && { state }),
        },
        kept,
      );
    } else if (first.entityType === 'target') {
      const bid = value('bid');
      add(
        {
          ref,
          type: first.targetType === 'keyword' ? 'keyword' : 'productTarget',
          amazonCampaignId,
          amazonAdGroupId,
          amazonTargetId: amazonId,
          ...(bid !== undefined && { bid }),
          ...(state !== undefined && { state }),
          ...(first.targetType !== 'keyword' && sd),
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
  return { changes, changeIdsByRef, sheetByRef, rejected };
}

function archiveChange(
  ref: string,
  row: SubmissionChange,
  amazonId: string,
  parents: { amazonCampaignId: string; amazonAdGroupId: string | null },
  sd: { sdTargeting?: BulkFileSdTargeting },
): BulkFileChange {
  const { amazonCampaignId } = parents;
  // Ad Groups und Product Ads haben immer eine Ad Group (oben geprüft).
  const ids = { amazonCampaignId, amazonAdGroupId: parents.amazonAdGroupId! };
  switch (row.entityType) {
    case 'campaign':
      return { ref, type: 'archive', entity: 'campaign', amazonCampaignId };
    case 'ad_group':
      return { ref, type: 'archive', entity: 'adGroup', ...ids };
    case 'product_ad':
      return { ref, type: 'archive', entity: 'productAd', amazonId, ...ids };
    case 'target':
      return row.targetType === 'keyword'
        ? { ref, type: 'archive', entity: 'keyword', amazonId, ...parents }
        : { ref, type: 'archive', entity: 'productTarget', amazonId, ...parents, ...sd };
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
        ...parents,
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

/** Die Bulk-Datei einer Übermittlung samt der Änderungen, die sie nicht enthält; je Anzeigentyp ein Blatt. */
export function buildSubmissionBulkFile(rows: readonly SubmissionChange[]): SubmissionBulkFile {
  const plan = buildBulkFileChanges(rows);
  const skipped = [...plan.rejected];
  const sheets: { name: string; rows: ReturnType<typeof buildBulkSheet>['rows'] }[] = [];
  let count = 0;
  for (const kind of SHEET_ORDER) {
    const changes = plan.changes.filter((change) => plan.sheetByRef.get(change.ref) === kind);
    if (changes.length === 0) continue;
    const sheet = buildBulkSheet(kind, changes);
    for (const { ref, reason } of sheet.skipped) {
      for (const changeId of plan.changeIdsByRef.get(ref) ?? []) {
        skipped.push({ changeId, ...SKIPS[reason] });
      }
    }
    // Ein Blatt nur mit Kopfzeile bleibt weg.
    if (sheet.rows.length > 1) {
      sheets.push({ name: sheet.sheetName, rows: sheet.rows });
      count += sheet.rows.length - 1;
    }
  }
  return { content: count > 0 ? writeXlsx(sheets) : null, rows: count, skipped };
}
