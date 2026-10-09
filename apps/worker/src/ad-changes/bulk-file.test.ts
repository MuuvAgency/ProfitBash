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
    campaignMultiAdGroups: null,
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
    const sb = change({ entityId: 't5', adProduct: 'SPONSORED_TV' });
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

describe('buildBulkFileChanges für Sponsored Brands und Sponsored Display (3.9)', () => {
  const SB = 'SPONSORED_BRANDS';
  const SD = 'SPONSORED_DISPLAY';

  it('ordnet jede Änderung dem Blatt ihres Anzeigentyps zu, SB nach der Art der Kampagne', () => {
    const sp = change({ entityId: 'sp' });
    const legacy = change({ entityId: 'sb1', adProduct: SB, campaignMultiAdGroups: false });
    const multi = change({ entityId: 'sb2', adProduct: SB, campaignMultiAdGroups: true });
    const sd = change({ entityId: 'sd', adProduct: SD, targetType: 'product' });

    const plan = buildBulkFileChanges([sp, legacy, multi, sd]);

    expect(plan.rejected).toEqual([]);
    expect(plan.changes.map((c) => plan.sheetByRef.get(c.ref))).toEqual([
      'sp',
      'sb',
      'sbMultiAdGroup',
      'sd',
    ]);
  });

  it('lehnt SB-Kampagnen ab, deren Blatt unbekannt ist (noch kein Bulk-Import)', () => {
    const unknown = change({ adProduct: SB, campaignMultiAdGroups: null });
    const { changes, rejected } = buildBulkFileChanges([unknown]);
    expect(changes).toEqual([]);
    expect(rejected).toEqual([
      { changeId: unknown.id, code: 'BULK_FILE_SHEET_UNKNOWN', message: expect.any(String) },
    ]);
  });

  it('SB, älteres Blatt: Targets und Negatives dürfen ohne Ad Group sein', () => {
    const base = { adProduct: SB, campaignMultiAdGroups: false, amazonAdGroupId: null };
    const keyword = change({ ...base, entityId: 'k' });
    const archive = change({
      ...base,
      entityType: 'negative_target',
      entityId: 'n',
      amazonEntityId: '95',
      targetType: 'keyword',
      negativeLevel: 'campaign',
      field: 'state',
      after: 'ARCHIVED',
    });

    const { changes, rejected } = buildBulkFileChanges([keyword, archive]);

    expect(rejected).toEqual([]);
    expect(changes).toEqual([
      {
        ref: 'target:k',
        type: 'keyword',
        amazonCampaignId: '100',
        amazonAdGroupId: null,
        amazonTargetId: '300',
        bid: '0.75',
      },
      {
        ref: 'negative_target:n',
        type: 'archive',
        entity: 'campaignNegativeKeyword',
        amazonCampaignId: '100',
        amazonId: '95',
      },
    ]);
  });

  it('SB, Blatt mit mehreren Ad Groups: ein Target ohne Ad Group ist unbekannt', () => {
    const keyword = change({ adProduct: SB, campaignMultiAdGroups: true, amazonAdGroupId: null });
    expect(buildBulkFileChanges([keyword]).rejected.map((r) => r.code)).toEqual([
      'ENTITY_NOT_FOUND',
    ]);
  });

  it('SD: nennt je Target die Art des Targetings, auch beim Archivieren', () => {
    const contextual = change({ adProduct: SD, entityId: 'a', targetType: 'category' });
    const audience = change({
      adProduct: SD,
      entityId: 'b',
      amazonEntityId: '301',
      targetType: 'audience',
      field: 'state',
      after: 'ARCHIVED',
    });

    const { changes, rejected } = buildBulkFileChanges([contextual, audience]);

    expect(rejected).toEqual([]);
    expect(changes).toEqual([
      {
        ref: 'target:a',
        type: 'productTarget',
        amazonCampaignId: '100',
        amazonAdGroupId: '200',
        amazonTargetId: '300',
        bid: '0.75',
        sdTargeting: 'contextual',
      },
      {
        ref: 'target:b',
        type: 'archive',
        entity: 'productTarget',
        amazonCampaignId: '100',
        amazonAdGroupId: '200',
        amazonId: '301',
        sdTargeting: 'audience',
      },
    ]);
  });

  it('lehnt Targets ab, deren Art das Blatt nicht kennt (SB-Themen, unbekannte SD-Targets)', () => {
    const theme = change({ adProduct: SB, campaignMultiAdGroups: true, targetType: 'theme' });
    const odd = change({ adProduct: SD, entityId: 'x', targetType: 'content_category' });
    expect(buildBulkFileChanges([theme, odd]).rejected.map((r) => [r.changeId, r.code])).toEqual([
      [theme.id, 'TARGET_TYPE_NOT_SUPPORTED'],
      [odd.id, 'TARGET_TYPE_NOT_SUPPORTED'],
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
    const sb = change({ entityId: 't5', adProduct: 'SPONSORED_TV' });

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
    const sb = change({ adProduct: 'SPONSORED_TV' });
    const file = buildSubmissionBulkFile([sb]);
    expect(file.content).toBeNull();
    expect(file.rows).toBe(0);
    expect(file.skipped).toHaveLength(1);
  });

  it('schreibt je Anzeigentyp ein eigenes Blatt und überspringt, was ein Blatt nicht kennt', async () => {
    const sp = change({ entityId: 'sp' });
    const sbBudget = change({
      adProduct: 'SPONSORED_BRANDS',
      campaignMultiAdGroups: true,
      entityType: 'campaign',
      entityId: 'sbc',
      amazonCampaignId: '110',
      amazonEntityId: '110',
      amazonAdGroupId: null,
      targetType: null,
      field: 'budget',
      after: '120.00',
    });
    const sbLegacy = change({
      adProduct: 'SPONSORED_BRANDS',
      campaignMultiAdGroups: false,
      entityId: 'sbk',
      amazonCampaignId: '120',
      amazonAdGroupId: null,
      amazonEntityId: '320',
    });
    const sdBid = change({
      adProduct: 'SPONSORED_DISPLAY',
      entityId: 'sdt',
      amazonCampaignId: '130',
      amazonAdGroupId: '230',
      amazonEntityId: '330',
      targetType: 'audience',
      after: '1.10',
    });
    // Das Standardgebot einer SB-Ad-Group gibt es nicht.
    const sbDefaultBid = change({
      adProduct: 'SPONSORED_BRANDS',
      campaignMultiAdGroups: true,
      entityType: 'ad_group',
      entityId: 'sbg',
      amazonCampaignId: '110',
      amazonAdGroupId: '210',
      amazonEntityId: '210',
      targetType: null,
      field: 'default_bid',
      after: '0.50',
    });

    const file = buildSubmissionBulkFile([sp, sbBudget, sbLegacy, sdBid, sbDefaultBid]);

    expect(file.rows).toBe(4);
    expect(file.skipped).toEqual([
      { changeId: sbDefaultBid.id, code: 'BULK_FILE_NOT_SUPPORTED', message: expect.any(String) },
    ]);
    const workbook = await openXlsx(file.content!);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual([
      'Sponsored Products Campaigns',
      'Sponsored Brands Campaigns',
      'SB Multi Ad Group Campaigns',
      'Sponsored Display Campaigns',
    ]);
    const dataRows = (name: string) => {
      const rows: string[][] = [];
      workbook.forEachRow(name, (row) => rows.push(row.map((cell) => String(cell ?? ''))));
      return rows.slice(1);
    };
    expect(dataRows('Sponsored Brands Campaigns')).toEqual([
      expect.arrayContaining(['Sponsored Brands', 'Keyword', 'Update', '120', '320', '0.75']),
    ]);
    expect(dataRows('SB Multi Ad Group Campaigns')).toEqual([
      expect.arrayContaining(['Sponsored Brands', 'Campaign', 'Update', '110', '120.00']),
    ]);
    expect(dataRows('Sponsored Display Campaigns')).toEqual([
      expect.arrayContaining([
        'Sponsored Display',
        'Audience Targeting',
        'Update',
        '130',
        '230',
        '330',
        '1.10',
      ]),
    ]);
  });

  it('lässt Blätter ohne Zeile weg', async () => {
    const sd = change({ adProduct: 'SPONSORED_DISPLAY', targetType: 'product' });
    const workbook = await openXlsx(buildSubmissionBulkFile([sd]).content!);
    expect(workbook.sheets.map((sheet) => sheet.name)).toEqual(['Sponsored Display Campaigns']);
  });
});
