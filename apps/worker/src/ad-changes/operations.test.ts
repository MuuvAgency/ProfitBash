import { describe, expect, it } from 'vitest';
import { buildWriteOperations, type SubmissionChange } from './operations';

/** Änderungen einer Übermittlung → Schreib-Operationen (`phase-3.md` 3.3, Vorgaben „Für 3.3“ aus 3.2a). */

const SP = 'SPONSORED_PRODUCTS';

let next = 0;
function change(patch: Partial<SubmissionChange>): SubmissionChange {
  next += 1;
  return {
    id: `c${next}`,
    operation: 'update',
    entityType: 'target',
    entityId: 'target-1',
    field: 'bid',
    after: '0.75',
    negative: null,
    adProduct: SP,
    amazonCampaignId: '100',
    amazonAdGroupId: '200',
    amazonEntityId: '300',
    targetType: 'keyword',
    negativeLevel: null,
    entityRemoved: false,
    campaignBiddingStrategy: 'SALES_DOWN_ONLY',
    campaignPlacements: [{ placement: 'PLACEMENT_TOP', percentage: '25' }],
    ...patch,
  };
}

const campaign = (field: SubmissionChange['field'], after: string, patch = {}) =>
  change({
    entityType: 'campaign',
    entityId: 'campaign-1',
    amazonEntityId: '100',
    amazonAdGroupId: null,
    targetType: null,
    field,
    after,
    ...patch,
  });

function build(changes: SubmissionChange[]) {
  const result = buildWriteOperations(changes);
  return {
    ...result,
    operations: result.batches.flatMap((batch) => batch.operations),
  };
}

describe('buildWriteOperations', () => {
  it('führt mehrere Felder einer Entity in eine Operation zusammen', () => {
    const bid = change({ field: 'bid', after: '0.75' });
    const state = change({ field: 'state', after: 'PAUSED' });
    const { operations, changeIdsByRef, rejected } = build([bid, state]);
    expect(operations).toEqual([
      {
        ref: 'target:target-1',
        type: 'update',
        entity: 'keyword',
        amazonId: '300',
        bid: '0.75',
        state: 'PAUSED',
      },
    ]);
    expect(changeIdsByRef.get('target:target-1')).toEqual([bid.id, state.id]);
    expect(rejected).toEqual([]);
  });

  it('unterscheidet Keyword und Target nach dem Typ des Targets', () => {
    const { operations } = build([
      change({ entityId: 't1', amazonEntityId: '301', targetType: 'keyword' }),
      change({ entityId: 't2', amazonEntityId: '302', targetType: 'product' }),
      change({ entityId: 't3', amazonEntityId: '303', targetType: 'auto' }),
    ]);
    expect(operations.map((op) => op.type === 'update' && op.entity)).toEqual([
      'keyword',
      'target',
      'target',
    ]);
  });

  it('bildet Zustand ARCHIVED auf archive ab', () => {
    const { operations } = build([
      change({ field: 'state', after: 'ARCHIVED' }),
      campaign('state', 'ARCHIVED'),
      change({
        entityType: 'ad_group',
        entityId: 'g1',
        amazonEntityId: '200',
        targetType: null,
        field: 'state',
        after: 'ARCHIVED',
      }),
      change({
        entityType: 'product_ad',
        entityId: 'a1',
        amazonEntityId: '400',
        targetType: null,
        field: 'state',
        after: 'ARCHIVED',
      }),
    ]);
    expect(operations).toEqual([
      { ref: 'target:target-1', type: 'archive', entity: 'keyword', amazonId: '300' },
      { ref: 'campaign:campaign-1', type: 'archive', entity: 'campaign', amazonId: '100' },
      { ref: 'ad_group:g1', type: 'archive', entity: 'adGroup', amazonId: '200' },
      { ref: 'product_ad:a1', type: 'archive', entity: 'productAd', amazonId: '400' },
    ]);
  });

  it('lehnt weitere Felder einer Entity ab, die dieselbe Übermittlung archiviert', () => {
    const archive = change({ field: 'state', after: 'ARCHIVED' });
    const bid = change({ field: 'bid', after: '0.75' });
    const { operations, changeIdsByRef, rejected } = build([bid, archive]);
    expect(operations).toHaveLength(1);
    expect(changeIdsByRef.get('target:target-1')).toEqual([archive.id]);
    expect(rejected).toEqual([
      { changeId: bid.id, code: 'ENTITY_ARCHIVED', message: expect.any(String) },
    ]);
  });

  it('archiviert Negatives je Ebene und Art über die vier Entities', () => {
    const negative = (
      entityId: string,
      targetType: string,
      negativeLevel: 'campaign' | 'ad_group',
    ) =>
      change({
        entityType: 'negative_target',
        entityId,
        amazonEntityId: `9${entityId}`,
        targetType,
        negativeLevel,
        field: 'state',
        after: 'ARCHIVED',
      });
    const { operations } = build([
      negative('1', 'keyword', 'ad_group'),
      negative('2', 'keyword', 'campaign'),
      negative('3', 'product', 'ad_group'),
      negative('4', 'product', 'campaign'),
    ]);
    expect(operations.map((op) => op.type === 'archive' && op.entity)).toEqual([
      'negativeKeyword',
      'campaignNegativeKeyword',
      'negativeTarget',
      'campaignNegativeTarget',
    ]);
  });

  it('schickt Zustand und Tagesbudget der Kampagne ohne bidding', () => {
    const { operations } = build([campaign('state', 'PAUSED'), campaign('budget', '25.00')]);
    expect(operations).toEqual([
      {
        ref: 'campaign:campaign-1',
        type: 'update',
        entity: 'campaign',
        amazonId: '100',
        state: 'PAUSED',
        dailyBudget: '25.00',
      },
    ]);
  });

  it('schickt bei einer Platzierung immer Strategie und alle Platzierungen', () => {
    const { operations } = build([campaign('placement_product_page', '40')]);
    expect(operations).toEqual([
      {
        ref: 'campaign:campaign-1',
        type: 'update',
        entity: 'campaign',
        amazonId: '100',
        bidding: {
          strategy: 'SALES_DOWN_ONLY',
          placements: [
            { placement: 'PLACEMENT_TOP', percentage: '25' },
            { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: '40' },
          ],
        },
      },
    ]);
  });

  it('nimmt die neue Strategie und überschreibt vorhandene Platzierungen', () => {
    const { operations } = build([
      campaign('bidding_strategy', 'NONE'),
      campaign('placement_top', '0'),
    ]);
    expect(operations[0]).toMatchObject({
      bidding: {
        strategy: 'NONE',
        placements: [{ placement: 'PLACEMENT_TOP', percentage: '0' }],
      },
    });
  });

  it('liest Platzierungen aus dem Stand der Kampagne als Zahl oder Text', () => {
    const { operations } = build([
      campaign('placement_top', '10', {
        campaignPlacements: [
          { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: 15 },
          { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: '30.0' },
          { placement: 'KAPUTT' },
          'unsinn',
        ],
      }),
    ]);
    expect(operations[0]).toMatchObject({
      bidding: {
        placements: [
          { placement: 'PLACEMENT_REST_OF_SEARCH', percentage: '15' },
          { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: '30' },
          { placement: 'PLACEMENT_TOP', percentage: '10' },
        ],
      },
    });
  });

  it('lehnt Platzierungen ab, wenn die Kampagne keine der drei Strategien trägt', () => {
    const placement = campaign('placement_top', '10', { campaignBiddingStrategy: 'RULE_BASED' });
    const budget = campaign('budget', '30', { campaignBiddingStrategy: 'RULE_BASED' });
    const { operations, rejected } = build([placement, budget]);
    expect(operations).toEqual([
      {
        ref: 'campaign:campaign-1',
        type: 'update',
        entity: 'campaign',
        amazonId: '100',
        dailyBudget: '30',
      },
    ]);
    expect(rejected).toEqual([
      {
        changeId: placement.id,
        code: 'BIDDING_STRATEGY_NOT_SUPPORTED',
        message: expect.any(String),
      },
    ]);
  });

  it('erlaubt Platzierungen ohne bisherige Strategie, wenn die Übermittlung eine setzt', () => {
    const { operations, rejected } = build([
      campaign('placement_top', '10', { campaignBiddingStrategy: null }),
      campaign('bidding_strategy', 'SALES_UP_AND_DOWN', { campaignBiddingStrategy: null }),
    ]);
    expect(rejected).toEqual([]);
    expect(operations[0]).toMatchObject({ bidding: { strategy: 'SALES_UP_AND_DOWN' } });
  });

  it('bildet Standardgebot und Zustand der Ad Group und den Zustand der Product Ad ab', () => {
    const { operations } = build([
      change({
        entityType: 'ad_group',
        entityId: 'g1',
        amazonEntityId: '200',
        targetType: null,
        field: 'default_bid',
        after: '0.40',
      }),
      change({
        entityType: 'product_ad',
        entityId: 'a1',
        amazonEntityId: '400',
        targetType: null,
        field: 'state',
        after: 'ENABLED',
      }),
    ]);
    expect(operations).toEqual([
      {
        ref: 'ad_group:g1',
        type: 'update',
        entity: 'adGroup',
        amazonId: '200',
        defaultBid: '0.40',
      },
      {
        ref: 'product_ad:a1',
        type: 'update',
        entity: 'productAd',
        amazonId: '400',
        state: 'ENABLED',
      },
    ]);
  });

  it('legt Negatives in Ad Group oder Kampagne an, je Änderung eine Operation', () => {
    const inAdGroup = change({
      operation: 'create',
      entityType: 'negative_target',
      entityId: null,
      amazonEntityId: null,
      field: null,
      after: null,
      targetType: null,
      negative: { type: 'keyword', keywordText: 'gratis', matchType: 'EXACT' },
    });
    const inCampaign = change({
      operation: 'create',
      entityType: 'negative_target',
      entityId: null,
      amazonEntityId: null,
      amazonAdGroupId: null,
      field: null,
      after: null,
      targetType: null,
      negative: { type: 'product', asin: 'B000000001' },
    });
    const { operations, changeIdsByRef } = build([inAdGroup, inCampaign]);
    expect(operations).toEqual([
      {
        ref: `create:${inAdGroup.id}`,
        type: 'createNegative',
        amazonCampaignId: '100',
        amazonAdGroupId: '200',
        negative: { type: 'keyword', keywordText: 'gratis', matchType: 'EXACT' },
      },
      {
        ref: `create:${inCampaign.id}`,
        type: 'createNegative',
        amazonCampaignId: '100',
        amazonAdGroupId: null,
        negative: { type: 'product', asin: 'B000000001' },
      },
    ]);
    expect(changeIdsByRef.get(`create:${inCampaign.id}`)).toEqual([inCampaign.id]);
  });

  it('lehnt Änderungen an entfernten oder unbekannten Entities ab', () => {
    const removed = change({ entityRemoved: true });
    const unknown = change({ entityId: 't9', amazonEntityId: null });
    const { operations, rejected } = build([removed, unknown]);
    expect(operations).toEqual([]);
    expect(rejected.map((r) => [r.changeId, r.code])).toEqual([
      [removed.id, 'ENTITY_NOT_FOUND'],
      [unknown.id, 'ENTITY_NOT_FOUND'],
    ]);
  });

  it('trennt die Operationen nach Ad-Typ', () => {
    const { batches } = buildWriteOperations([
      change({ entityId: 't1', amazonEntityId: '301' }),
      change({ entityId: 't2', amazonEntityId: '302', adProduct: 'SPONSORED_BRANDS' }),
      change({ entityId: 't3', amazonEntityId: '303' }),
    ]);
    expect(batches.map((b) => [b.adProduct, b.operations.length])).toEqual([
      [SP, 2],
      ['SPONSORED_BRANDS', 1],
    ]);
  });
});
