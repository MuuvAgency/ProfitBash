import type {
  AmazonAdsArchiveEntity,
  AmazonAdsBiddingStrategy,
  AmazonAdsPlacementAdjustment,
  AmazonAdsUpdateOperation,
  AmazonAdsWriteOperation,
  AmazonAdsWriteState,
} from '@profitbash/amazon-ads';
import {
  AD_CHANGE_BIDDING_STRATEGIES,
  AD_CHANGE_PLACEMENTS,
  isAdChangePlacementField,
  type AdChangeEntityType,
  type AdChangeField,
  type AdChangeNegative,
} from '@profitbash/shared';

/**
 * Änderungen einer Übermittlung → Schreib-Operationen des Amazon-Clients (`docs/tasks/phase-3.md` 3.3, ohne I/O).
 *
 * - Mehrere Felder einer Entity gehören in **eine** Operation (scheitert sie, scheitern alle ihre Felder).
 * - Zustand `ARCHIVED` wird zu `archive`; weitere Felder derselben Entity entfallen dann mit Grund.
 * - Ein Target mit `targetType = keyword` ist `keyword`, sonst `target`; Negatives je Ebene und Art.
 * - Strategie oder Platzierung geändert: immer `bidding` mit dem vollständigen Stand (Strategie und alle
 *   Platzierungen der Kampagne plus die Änderungen), weil Amazon `dynamicBidding` als Ganzes ersetzt.
 */

/** Eine Änderung der Übermittlung mit dem, was der Job über Entity und Kampagne gelesen hat. */
export interface SubmissionChange {
  id: string;
  operation: 'update' | 'create';
  entityType: AdChangeEntityType;
  entityId: string | null;
  field: AdChangeField | null;
  /** Neuer Wert (Text bzw. Decimal-String); leer beim Anlegen. */
  after: string | null;
  negative: AdChangeNegative | null;
  /** Ad-Typ der Kampagne. */
  adProduct: string;
  amazonCampaignId: string;
  amazonAdGroupId: string | null;
  /** Amazon-ID der geänderten Entity; `null`, wenn es sie nicht (mehr) gibt, und beim Anlegen. */
  amazonEntityId: string | null;
  /** Art des Targets bzw. Negatives (`keyword`, `product` …). */
  targetType: string | null;
  negativeLevel: 'campaign' | 'ad_group' | null;
  entityRemoved: boolean;
  campaignBiddingStrategy: string | null;
  /** `extra.placementBidAdjustments` der Kampagne, ungeprüft. */
  campaignPlacements: unknown;
}

export interface RejectedChange {
  changeId: string;
  code: string;
  message: string;
}

export interface WriteOperationBatch {
  adProduct: string;
  operations: AmazonAdsWriteOperation[];
}

export interface WriteOperationPlan {
  /** Je Ad-Typ ein Aufruf von `applyChanges`. */
  batches: WriteOperationBatch[];
  /** `ref` einer Operation → ihre Änderungen (das Ergebnis der Operation gilt für alle). */
  changeIdsByRef: Map<string, string[]>;
  /** Änderungen, die sich nicht senden lassen. */
  rejected: RejectedChange[];
}

const REJECTIONS = {
  ENTITY_NOT_FOUND: 'Die Entity gibt es bei Amazon nicht mehr oder sie ist unbekannt.',
  ENTITY_ARCHIVED: 'Dieselbe Übermittlung archiviert die Entity; weitere Änderungen entfallen.',
  BIDDING_STRATEGY_NOT_SUPPORTED:
    'Platzierungen lassen sich nur ändern, wenn die Kampagne eine feste oder dynamische Gebotsstrategie trägt.',
} as const;

const isStrategy = (value: string | null): value is AmazonAdsBiddingStrategy =>
  value !== null && (AD_CHANGE_BIDDING_STRATEGIES as readonly string[]).includes(value);

/** Ganze Prozent als Text (`30.0` → `30`); andere Werte unverändert, der Client lehnt sie ab. */
function wholePercent(value: string): string {
  const match = /^0*(\d+?)(\.0+)?$/.exec(value);
  return match ? match[1]! : value;
}

function currentPlacements(raw: unknown): AmazonAdsPlacementAdjustment[] {
  if (!Array.isArray(raw)) return [];
  const placements: AmazonAdsPlacementAdjustment[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) continue;
    const { placement, percentage } = entry as Record<string, unknown>;
    const text = typeof percentage === 'number' ? String(percentage) : percentage;
    if (typeof placement !== 'string' || typeof text !== 'string') continue;
    placements.push({ placement, percentage: wholePercent(text) });
  }
  return placements;
}

function archiveEntity(change: SubmissionChange): AmazonAdsArchiveEntity {
  switch (change.entityType) {
    case 'campaign':
      return 'campaign';
    case 'ad_group':
      return 'adGroup';
    case 'product_ad':
      return 'productAd';
    case 'target':
      return change.targetType === 'keyword' ? 'keyword' : 'target';
    case 'negative_target': {
      const onCampaign = change.negativeLevel === 'campaign';
      if (change.targetType === 'keyword') {
        return onCampaign ? 'campaignNegativeKeyword' : 'negativeKeyword';
      }
      return onCampaign ? 'campaignNegativeTarget' : 'negativeTarget';
    }
  }
}

export function buildWriteOperations(changes: readonly SubmissionChange[]): WriteOperationPlan {
  const rejected: RejectedChange[] = [];
  const changeIdsByRef = new Map<string, string[]>();
  const batches = new Map<string, AmazonAdsWriteOperation[]>();
  const reject = (change: SubmissionChange, code: keyof typeof REJECTIONS) =>
    rejected.push({ changeId: change.id, code, message: REJECTIONS[code] });
  const add = (
    adProduct: string,
    operation: AmazonAdsWriteOperation,
    sources: SubmissionChange[],
  ) => {
    const list = batches.get(adProduct) ?? [];
    list.push(operation);
    batches.set(adProduct, list);
    changeIdsByRef.set(
      operation.ref,
      sources.map((source) => source.id),
    );
  };

  // Feldänderungen je Entity, in der Reihenfolge des ersten Auftretens.
  const groups = new Map<string, SubmissionChange[]>();
  for (const change of changes) {
    if (change.operation === 'create') {
      if (change.negative === null) {
        reject(change, 'ENTITY_NOT_FOUND');
        continue;
      }
      add(
        change.adProduct,
        {
          ref: `create:${change.id}`,
          type: 'createNegative',
          amazonCampaignId: change.amazonCampaignId,
          amazonAdGroupId: change.amazonAdGroupId,
          negative: change.negative,
        },
        [change],
      );
      continue;
    }
    if (change.amazonEntityId === null || change.entityRemoved || change.field === null) {
      reject(change, 'ENTITY_NOT_FOUND');
      continue;
    }
    const ref = `${change.entityType}:${change.entityId}`;
    const group = groups.get(ref);
    if (group) group.push(change);
    else {
      groups.set(ref, [change]);
      // Platz in der Reihenfolge der Eingabe; gefüllt wird unten.
      changeIdsByRef.set(ref, []);
    }
  }

  for (const [ref, group] of groups) {
    const first = group[0]!;
    const amazonId = first.amazonEntityId!;
    const archive = group.find((change) => change.field === 'state' && change.after === 'ARCHIVED');
    if (archive) {
      for (const change of group) if (change !== archive) reject(change, 'ENTITY_ARCHIVED');
      add(first.adProduct, { ref, type: 'archive', entity: archiveEntity(first), amazonId }, [
        archive,
      ]);
      continue;
    }

    const sources: SubmissionChange[] = [];
    const value = (field: AdChangeField) => {
      const change = group.findLast((candidate) => candidate.field === field);
      if (change) sources.push(change);
      return change?.after ?? undefined;
    };
    const state = value('state') as AmazonAdsWriteState | undefined;
    let operation: AmazonAdsUpdateOperation;
    if (first.entityType === 'campaign') {
      const dailyBudget = value('budget');
      const bidding = campaignBidding(group, sources, (change) =>
        reject(change, 'BIDDING_STRATEGY_NOT_SUPPORTED'),
      );
      operation = {
        ref,
        type: 'update',
        entity: 'campaign',
        amazonId,
        ...(state !== undefined && { state }),
        ...(dailyBudget !== undefined && { dailyBudget }),
        ...(bidding && { bidding }),
      };
    } else if (first.entityType === 'ad_group') {
      const defaultBid = value('default_bid');
      operation = {
        ref,
        type: 'update',
        entity: 'adGroup',
        amazonId,
        ...(defaultBid !== undefined && { defaultBid }),
        ...(state !== undefined && { state }),
      };
    } else if (first.entityType === 'target') {
      const bid = value('bid');
      operation = {
        ref,
        type: 'update',
        entity: first.targetType === 'keyword' ? 'keyword' : 'target',
        amazonId,
        ...(bid !== undefined && { bid }),
        ...(state !== undefined && { state }),
      };
    } else {
      operation = {
        ref,
        type: 'update',
        entity: 'productAd',
        amazonId,
        ...(state !== undefined && { state }),
      };
    }
    if (sources.length === 0) {
      changeIdsByRef.delete(ref);
      continue;
    }
    // In der Reihenfolge der Übermittlung.
    add(
      first.adProduct,
      operation,
      group.filter((change) => sources.includes(change)),
    );
  }

  for (const [ref, ids] of changeIdsByRef) if (ids.length === 0) changeIdsByRef.delete(ref);
  return {
    batches: [...batches].map(([adProduct, operations]) => ({ adProduct, operations })),
    changeIdsByRef,
    rejected,
  };
}

/** `bidding` der Kampagne, wenn Strategie oder eine Platzierung geändert wird. */
function campaignBidding(
  group: readonly SubmissionChange[],
  sources: SubmissionChange[],
  rejectChange: (change: SubmissionChange) => void,
): { strategy: AmazonAdsBiddingStrategy; placements: AmazonAdsPlacementAdjustment[] } | null {
  const first = group[0]!;
  const strategyChange = group.findLast((change) => change.field === 'bidding_strategy');
  const placementChanges = group.filter(
    (change) => change.field !== null && isAdChangePlacementField(change.field),
  );
  if (!strategyChange && placementChanges.length === 0) return null;
  const strategy = strategyChange?.after ?? first.campaignBiddingStrategy;
  if (!isStrategy(strategy)) {
    for (const change of placementChanges) rejectChange(change);
    return null;
  }
  const placements = currentPlacements(first.campaignPlacements);
  for (const change of placementChanges) {
    if (change.field === null || !isAdChangePlacementField(change.field)) continue;
    const placement = AD_CHANGE_PLACEMENTS[change.field];
    const entry = { placement, percentage: change.after! };
    const index = placements.findIndex((existing) => existing.placement === placement);
    if (index === -1) placements.push(entry);
    else placements[index] = entry;
  }
  if (strategyChange) sources.push(strategyChange);
  sources.push(...placementChanges);
  return { strategy, placements };
}
