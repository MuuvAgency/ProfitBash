import { openXlsx } from '@profitbash/sheets';
import { describe, expect, it } from 'vitest';
import { buildBulkFileChanges, buildSubmissionBulkFile } from './bulk-file';
import type { SubmissionChange } from './operations';

/** Änderungen einer Übermittlung → Zeilen und Datei für die Werbekonsole (`phase-3.md` 3.4, Vorgaben aus 3.2b). */

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
    campaignPlacements: [],
    campaignState: 'ENABLED',
    campaignEndDate: '2026-12-31',
    campaignAmazonPortfolioId: '700',
    ...patch,
  };
}

const campaign = (field: SubmissionChange['field'], after: string) =>
  change({
    entityType: 'campaign',
    entityId: 'campaign-1',
    amazonEntityId: '100',
    amazonAdGroupId: null,
    targetType: null,
    field,
    after,
  });

describe('buildBulkFileChanges', () => {
  it('führt die Felder einer Kampagne in eine Zeile mit Portfolio, Enddatum und Zustand zusammen', () => {
    const budget = campaign('budget', '25');
    const strategy = campaign('bidding_strategy', 'NONE');
    const { changes, changeIdsByRef } = buildBulkFileChanges([budget, strategy]);
    expect(changes).toEqual([
      {
        ref: 'campaign:campaign-1',
        type: 'campaign',
        campaign: {
          amazonCampaignId: '100',
          amazonPortfolioId: '700',
          endDate: '2026-12-31',
          state: 'ENABLED',
        },
        set: { dailyBudget: '25', biddingStrategy: 'NONE' },
      },
    ]);
    expect(changeIdsByRef.get('campaign:campaign-1')).toEqual([budget.id, strategy.id]);
  });

  it('schreibt je Platzierung eine eigene Zeile mit der Strategie der Kampagne', () => {
    const placement = campaign('placement_top', '40');
    const { changes, changeIdsByRef } = buildBulkFileChanges([placement]);
    expect(changes).toEqual([
      {
        ref: `placement:${placement.id}`,
        type: 'placement',
        amazonCampaignId: '100',
        biddingStrategy: 'SALES_DOWN_ONLY',
        placement: 'PLACEMENT_TOP',
        percentage: '40',
      },
    ]);
    expect(changeIdsByRef.get(`placement:${placement.id}`)).toEqual([placement.id]);
  });

  it('nimmt für Platzierungen die neue Strategie derselben Übermittlung und lehnt nicht setzbare ab', () => {
    const strategy = campaign('bidding_strategy', 'NONE');
    const placement = campaign('placement_top', '40');
    const withNew = buildBulkFileChanges([strategy, placement]);
    expect(withNew.rejected).toEqual([]);
    expect(withNew.changes.find((c) => c.type === 'placement')).toMatchObject({
      biddingStrategy: 'NONE',
    });

    const ruleBased = { ...campaign('placement_top', '40'), campaignBiddingStrategy: 'RULE_BASED' };
    const { changes, rejected } = buildBulkFileChanges([ruleBased]);
    expect(changes).toEqual([]);
    expect(rejected).toEqual([
      {
        changeId: ruleBased.id,
        code: 'BIDDING_STRATEGY_NOT_SUPPORTED',
        message: expect.any(String),
      },
    ]);
  });

  it('bildet Ad Group, Keyword, Produkt-Target und Product Ad mit den IDs der Eltern ab', () => {
    const { changes } = buildBulkFileChanges([
      change({
        entityType: 'ad_group',
        entityId: 'g1',
        amazonEntityId: '200',
        targetType: null,
        field: 'default_bid',
        after: '0.40',
      }),
      change({ field: 'state', after: 'PAUSED' }),
      change({ entityId: 't2', amazonEntityId: '301', targetType: 'product', after: '0.90' }),
      change({
        entityType: 'product_ad',
        entityId: 'a1',
        amazonEntityId: '400',
        targetType: null,
        field: 'state',
        after: 'ENABLED',
      }),
    ]);
    const ids = { amazonCampaignId: '100', amazonAdGroupId: '200' };
    expect(changes).toEqual([
      { ref: 'ad_group:g1', type: 'adGroup', ...ids, defaultBid: '0.40' },
      { ref: 'target:target-1', type: 'keyword', ...ids, amazonTargetId: '300', state: 'PAUSED' },
      { ref: 'target:t2', type: 'productTarget', ...ids, amazonTargetId: '301', bid: '0.90' },
      { ref: 'product_ad:a1', type: 'productAd', ...ids, amazonAdId: '400', state: 'ENABLED' },
    ]);
  });

  it('bildet Archivieren je Entity ab, Negatives je Ebene und Art', () => {
    const negative = (
      entityId: string,
      targetType: string,
      negativeLevel: 'campaign' | 'ad_group',
    ) =>
      change({
        entityType: 'negative_target',
        entityId,
        amazonEntityId: `9${entityId}`,
        amazonAdGroupId: negativeLevel === 'campaign' ? null : '200',
        targetType,
        negativeLevel,
        field: 'state',
        after: 'ARCHIVED',
      });
    const { changes } = buildBulkFileChanges([
      campaign('state', 'ARCHIVED'),
      change({ field: 'state', after: 'ARCHIVED' }),
      negative('1', 'keyword', 'ad_group'),
      negative('2', 'keyword', 'campaign'),
      negative('3', 'product', 'ad_group'),
      negative('4', 'product', 'campaign'),
    ]);
    const ids = { amazonCampaignId: '100', amazonAdGroupId: '200' };
    expect(changes).toEqual([
      { ref: 'campaign:campaign-1', type: 'archive', entity: 'campaign', amazonCampaignId: '100' },
      { ref: 'target:target-1', type: 'archive', entity: 'keyword', amazonId: '300', ...ids },
      {
        ref: 'negative_target:1',
        type: 'archive',
        entity: 'negativeKeyword',
        amazonId: '91',
        ...ids,
      },
      {
        ref: 'negative_target:2',
        type: 'archive',
        entity: 'campaignNegativeKeyword',
        amazonCampaignId: '100',
        amazonId: '92',
      },
      {
        ref: 'negative_target:3',
        type: 'archive',
        entity: 'negativeProductTarget',
        amazonId: '93',
        ...ids,
      },
      {
        ref: 'negative_target:4',
        type: 'archive',
        entity: 'campaignNegativeProductTarget',
        amazonCampaignId: '100',
        amazonId: '94',
      },
    ]);
  });

  it('lehnt ab, was sich nicht abbilden lässt: andere Ad-Typen, unbekannte Entities, frühere doppelte Angaben', () => {
    const sb = change({ entityId: 't5', adProduct: 'SPONSORED_BRANDS' });
    const unknown = change({ entityId: 't6', amazonEntityId: null });
    const first = change({ entityId: 't7', amazonEntityId: '307', after: '0.60' });
    const second = change({ entityId: 't7', amazonEntityId: '307', after: '0.90' });
    const { changes, rejected } = buildBulkFileChanges([sb, unknown, first, second]);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ bid: '0.90' });
    expect(rejected.map((r) => [r.changeId, r.code])).toEqual([
      [sb.id, 'AD_PRODUCT_NOT_SUPPORTED'],
      [unknown.id, 'ENTITY_NOT_FOUND'],
      [first.id, 'SUPERSEDED'],
    ]);
  });
});

describe('buildSubmissionBulkFile', () => {
  it('erzeugt eine lesbare Arbeitsmappe und nennt übersprungene Änderungen mit Grund', async () => {
    const bid = change({});
    const create = change({
      operation: 'create',
      entityType: 'negative_target',
      entityId: null,
      amazonEntityId: null,
      field: null,
      after: null,
      targetType: null,
      negative: { type: 'keyword', keywordText: 'gratis', matchType: 'EXACT' },
    });
    // Negative ASIN auf Kampagnenebene kennt die Bulk-Datei nicht.
    const campaignAsin = change({
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
    const sb = change({ entityId: 't5', adProduct: 'SPONSORED_BRANDS' });

    const file = buildSubmissionBulkFile([bid, create, campaignAsin, sb]);

    expect(file.rows).toBe(2);
    expect(file.skipped).toEqual([
      { changeId: sb.id, code: 'AD_PRODUCT_NOT_SUPPORTED', message: expect.any(String) },
      { changeId: campaignAsin.id, code: 'BULK_FILE_NOT_SUPPORTED', message: expect.any(String) },
    ]);
    const workbook = await openXlsx(file.content!);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Sponsored Products Campaigns']);
    const rows: string[][] = [];
    workbook.forEachRow('Sponsored Products Campaigns', (row) => {
      rows.push(row.map((cell) => String(cell ?? '')));
    });
    expect(rows).toHaveLength(3);
    const rowWith = (entity: string) => rows.find((row) => row[1] === entity);
    expect(rowWith('Keyword')).toEqual(
      expect.arrayContaining(['Update', '100', '200', '300', '0.75']),
    );
    expect(rowWith('Negative Keyword')).toEqual(expect.arrayContaining(['Create', 'gratis']));
  });

  it('liefert keine Datei, wenn keine Zeile übrig bleibt', () => {
    const sb = change({ adProduct: 'SPONSORED_BRANDS' });
    const file = buildSubmissionBulkFile([sb]);
    expect(file.content).toBeNull();
    expect(file.rows).toBe(0);
    expect(file.skipped).toHaveLength(1);
  });
});
