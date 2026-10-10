import type { PlannedCampaign, SaveCampaignSetupDraft } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { closeBulkFileSubmission } from './ad-change-actions';
import {
  claimNextAdChangeSubmission,
  confirmBulkFileAdChanges,
  finishAdChangeSubmission,
} from './ad-change-processing';
import { saveCampaignSetupDraft, submitCampaignSetupDraft } from './campaign-setup';
import {
  getCampaignSetupSubmissionItems,
  recordCampaignSetupResults,
} from './campaign-setup-processing';
import {
  adChangeSubmissions,
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProductAds,
  amazonAdsTargets,
  auditEvents,
  campaignSetupDrafts,
  campaignSetupItems,
  searchTermHarvestMarks,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/**
 * Ablauf einer Setup-Übermittlung (`phase-4.md` 4.4): Zeilen für Bulk-Datei und Job lesen, Ergebnisse festhalten,
 * Bestätigung durch den nächsten Bulk-Import (Zuordnung über Namen), Abschließen von Hand.
 */

let testDb: TestDatabase;
let f: AdChangeFixture;
const SP = 'SPONSORED_PRODUCTS';
const NAME = 'SP | EXACT | Flaschen';

const plan: PlannedCampaign = {
  block: 'SP-KW-EXACT',
  adProduct: 'SP',
  targeting: 'keyword',
  name: NAME,
  state: 'ENABLED',
  currencyCode: 'EUR',
  dailyBudget: '25.00',
  biddingStrategy: 'SALES_DOWN_ONLY',
  sdOptimization: null,
  costType: 'cpc',
  offAmazon: false,
  placements: { topOfSearch: 20, productPages: 0, restOfSearch: 0 },
  adGroup: { name: NAME, defaultBid: '0.85' },
  ads: [{ asin: 'B0TEST0001', sku: 'SKU-1' }],
  targets: [
    { type: 'keyword', text: 'Trinkflasche', matchType: 'exact', bid: '0.90' },
    { type: 'product', asin: 'B0FREMD001', match: 'expanded', bid: '0.50' },
    { type: 'category', categoryId: '12345', name: 'Flaschen', bid: '0.40' },
  ],
  negatives: [
    { type: 'keyword', text: 'glas', matchType: 'negativePhrase' },
    { type: 'product', asin: 'B0FREMD002', matchType: 'negativeExact' },
  ],
};

const who = () => ({ userId: f.ada, orgId: f.org });

async function submitted(
  channel: 'api' | 'bulk_file' = 'bulk_file',
  profileId = f.profile,
  name = NAME,
  extra: Partial<SaveCampaignSetupDraft> = {},
) {
  const draft: SaveCampaignSetupDraft = {
    profileId,
    productGroupId: null,
    presetKey: 'muuv-standard',
    name: 'Flaschen',
    campaignState: 'ENABLED',
    inputs: {
      keywords: [],
      brandTerms: [],
      productTargets: [],
      categories: [],
      harvest: [],
      unlocks: {},
    },
    campaigns: [{ ...plan, name, adGroup: { ...plan.adGroup, name } }],
    sourceNegatives: [],
    portfolioId: null,
    ...extra,
  };
  const saved = (await saveCampaignSetupDraft(testDb.db, { ...who(), draft }))!;
  const result = await submitCampaignSetupDraft(testDb.db, {
    ...who(),
    draftId: saved.id,
    version: 1,
    channel,
    enqueue: async () => undefined,
    limitFor: () => null,
  });
  if (result?.status !== 'submitted') throw new Error('nicht übermittelt');
  return result.submission.id;
}

const items = (submissionId: string) =>
  testDb.db
    .select()
    .from(campaignSetupItems)
    .where(eq(campaignSetupItems.submissionId, submissionId))
    .orderBy(campaignSetupItems.position);
const submissionStatus = async (id: string) =>
  (
    await testDb.db
      .select({ status: adChangeSubmissions.status })
      .from(adChangeSubmissions)
      .where(eq(adChangeSubmissions.id, id))
  )[0]!.status;

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db);
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(campaignSetupItems);
  await db.delete(campaignSetupDrafts);
  await db.delete(searchTermHarvestMarks);
  await db.delete(adChangeSubmissions);
  await db.delete(auditEvents);
  await db
    .delete(amazonAdsNegativeTargets)
    .where(eq(amazonAdsNegativeTargets.amazonTargetId, '8801'));
  await db
    .delete(amazonAdsNegativeTargets)
    .where(eq(amazonAdsNegativeTargets.amazonTargetId, '8802'));
  await db
    .delete(amazonAdsNegativeTargets)
    .where(eq(amazonAdsNegativeTargets.amazonTargetId, '8803'));
  for (const id of ['7701', '7702', '7703']) {
    await db.delete(amazonAdsTargets).where(eq(amazonAdsTargets.amazonTargetId, id));
  }
  await db.delete(amazonAdsProductAds).where(eq(amazonAdsProductAds.amazonAdId, '6601'));
  await db.delete(amazonAdsAdGroups).where(eq(amazonAdsAdGroups.amazonAdGroupId, '5501'));
  await db.delete(amazonAdsCampaigns).where(eq(amazonAdsCampaigns.amazonCampaignId, '4401'));
});

describe('getCampaignSetupSubmissionItems', () => {
  it('liefert Übermittlung, Profil und Zeilen nur für sichtbare Setup-Übermittlungen', async () => {
    const id = await submitted();
    const found = (await getCampaignSetupSubmissionItems(testDb.db, {
      ...who(),
      submissionId: id,
    }))!;
    expect(found.submission).toMatchObject({ id, kind: 'setup', channel: 'bulk_file' });
    expect(found.profile).toMatchObject({ countryCode: 'DE', timezone: 'Europe/Berlin' });
    expect(found.items.map((item) => item.entityType)).toEqual([
      'campaign',
      'placement',
      'ad_group',
      'product_ad',
      'keyword',
      'product_target',
      'product_target',
      'negative_keyword',
      'negative_product_target',
    ]);
    expect(
      await getCampaignSetupSubmissionItems(testDb.db, {
        userId: f.ada,
        orgId: '00000000-0000-4000-8000-000000000000',
        submissionId: id,
      }),
    ).toBeNull();
  });
});

describe('recordCampaignSetupResults und Abschluss', () => {
  it('hält Ergebnisse je Zeile fest; die Übermittlung ist fertig, wenn nichts mehr offen ist', async () => {
    const id = await submitted();
    const rows = await items(id);
    const now = new Date();
    await recordCampaignSetupResults(testDb.db, {
      organizationId: f.org,
      submissionId: id,
      now,
      results: [
        { itemId: rows[0]!.id, outcome: 'applied', amazonEntityId: '4401' },
        { itemId: rows[1]!.id, outcome: 'failed', code: 'X', message: 'abgelehnt' },
      ],
    });
    expect(
      (await items(id)).slice(0, 2).map((row) => [row.status, row.amazonEntityId, row.errorCode]),
    ).toEqual([
      ['applied', '4401', null],
      ['failed', null, 'X'],
    ]);
    expect(
      (await finishAdChangeSubmission(testDb.db, { organizationId: f.org, submissionId: id, now }))!
        .open,
    ).toBe(7);
    expect(await submissionStatus(id)).toBe('pending');

    const closed = await finishAdChangeSubmission(testDb.db, {
      organizationId: f.org,
      submissionId: id,
      now,
      failRemaining: { code: 'NOT_SENT', message: 'nicht gesendet' },
    });
    expect(closed).toMatchObject({ status: 'failed', open: 0, failed: 7 });
  });

  it('lässt beim Wiederaufnehmen eines unterbrochenen API-Laufs offene Anlagen als unklar scheitern', async () => {
    const id = await submitted('api');
    const claim = () =>
      claimNextAdChangeSubmission(testDb.db, {
        organizationId: f.org,
        connectionId: f.connection,
        jobRunId: null,
        now: new Date(),
      });
    expect((await claim())!.id).toBe(id);
    expect((await claim())!.id).toBe(id);
    const rows = await items(id);
    expect(
      rows.every((row) => row.status === 'failed' && row.errorCode === 'UNKNOWN_OUTCOME'),
    ).toBe(true);
  });
});

/** Struktur, wie sie der nächste Bulk-Import nach dem Upload liefern würde. */
async function importStructure() {
  const { db } = testDb;
  const [campaign] = await db
    .insert(amazonAdsCampaigns)
    .values({
      organizationId: f.org,
      profileId: f.profile,
      amazonCampaignId: '4401',
      adProduct: SP,
      name: NAME.toLowerCase(),
      state: 'ENABLED',
      budgetAmount: '25',
      budgetCurrencyCode: 'EUR',
      budgetType: 'DAILY',
      biddingStrategy: 'SALES_DOWN_ONLY',
      extra: { placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: '20' }] },
    })
    .returning({ id: amazonAdsCampaigns.id });
  const [adGroup] = await db
    .insert(amazonAdsAdGroups)
    .values({
      organizationId: f.org,
      profileId: f.profile,
      campaignId: campaign!.id,
      amazonAdGroupId: '5501',
      adProduct: SP,
      name: NAME,
      state: 'ENABLED',
      defaultBid: '0.85',
      defaultBidCurrencyCode: 'EUR',
    })
    .returning({ id: amazonAdsAdGroups.id });
  const parents = {
    organizationId: f.org,
    profileId: f.profile,
    campaignId: campaign!.id,
    adGroupId: adGroup!.id,
    adProduct: SP,
    state: 'ENABLED',
  };
  await db.insert(amazonAdsProductAds).values({
    ...parents,
    amazonAdId: '6601',
    asin: 'B0TEST0001',
    sku: 'SKU-1',
  });
  await db.insert(amazonAdsTargets).values([
    {
      ...parents,
      amazonTargetId: '7701',
      targetType: 'keyword',
      keywordText: 'trinkflasche',
      matchType: 'EXACT',
      bid: '0.90',
      bidCurrencyCode: 'EUR',
    },
    {
      ...parents,
      amazonTargetId: '7702',
      targetType: 'product',
      expression: { matchType: 'PRODUCT_SIMILAR', asin: 'B0FREMD001' },
    },
    {
      ...parents,
      amazonTargetId: '7703',
      targetType: 'category',
      expression: { productCategoryId: '12345' },
    },
  ]);
  await db.insert(amazonAdsNegativeTargets).values([
    {
      ...parents,
      level: 'ad_group',
      amazonTargetId: '8801',
      targetType: 'keyword',
      keywordText: 'glas',
      matchType: 'PHRASE',
    },
    {
      ...parents,
      level: 'ad_group',
      amazonTargetId: '8802',
      targetType: 'product',
      expression: { asin: 'B0FREMD002' },
    },
  ]);
}
describe('Bestätigung durch den Bulk-Import (Zuordnung über Namen)', () => {
  it('ordnet die angelegten Entities ihrem Entwurf zu und schließt die Übermittlung', async () => {
    const id = await submitted();
    expect(
      await confirmBulkFileAdChanges(testDb.db, {
        organizationId: f.org,
        profileId: f.profile,
        now: new Date(),
      }),
    ).toEqual({ confirmed: 0, finished: 0 });

    await importStructure();
    const result = await confirmBulkFileAdChanges(testDb.db, {
      organizationId: f.org,
      profileId: f.profile,
      now: new Date(),
    });
    expect(result).toEqual({ confirmed: 9, finished: 1 });
    expect(
      (await items(id)).map((row) => [row.entityType, row.status, row.amazonEntityId]),
    ).toEqual([
      ['campaign', 'applied', '4401'],
      ['placement', 'applied', null],
      ['ad_group', 'applied', '5501'],
      ['product_ad', 'applied', '6601'],
      ['keyword', 'applied', '7701'],
      ['product_target', 'applied', '7702'],
      ['product_target', 'applied', '7703'],
      ['negative_keyword', 'applied', '8801'],
      ['negative_product_target', 'applied', '8802'],
    ]);
    expect(await submissionStatus(id)).toBe('finished');
  });

  it('lässt offen, was der Import noch nicht zeigt', async () => {
    const id = await submitted();
    await importStructure();
    await testDb.db.delete(amazonAdsTargets).where(eq(amazonAdsTargets.amazonTargetId, '7701'));
    const result = await confirmBulkFileAdChanges(testDb.db, {
      organizationId: f.org,
      profileId: f.profile,
      now: new Date(),
    });
    expect(result).toEqual({ confirmed: 8, finished: 0 });
    const open = (await items(id)).filter((row) => row.status === 'submitted');
    expect(open.map((row) => row.entityType)).toEqual(['keyword']);
    expect(await submissionStatus(id)).toBe('pending');
  });
});

describe('Sponsored Display (4.9)', () => {
  const SD_NAME = 'SD | RT-VIEW | Flaschen';
  const sdPlan: PlannedCampaign = {
    ...plan,
    block: 'SD-RT-VIEWS',
    adProduct: 'SD',
    targeting: 'audience',
    name: SD_NAME,
    biddingStrategy: null,
    sdOptimization: 'conversions',
    placements: null,
    adGroup: { name: SD_NAME, defaultBid: '0.55' },
    targets: [{ type: 'audience', audience: 'views', lookbackDays: 30, bid: '0.60' }],
    negatives: [],
  };

  it('legt SD-Kampagnen an und bestätigt Zielgruppen über Ereignis und Rückblick', async () => {
    const id = await submitted('bulk_file', f.profile, SD_NAME, { campaigns: [sdPlan] });
    expect((await items(id)).map((row) => [row.entityType, row.status, row.errorCode])).toEqual([
      ['campaign', 'submitted', null],
      ['ad_group', 'submitted', null],
      ['product_ad', 'submitted', null],
      ['audience_target', 'submitted', null],
    ]);

    const { db } = testDb;
    const SD = 'SPONSORED_DISPLAY';
    const [campaign] = await db
      .insert(amazonAdsCampaigns)
      .values({
        organizationId: f.org,
        profileId: f.profile,
        amazonCampaignId: '4401',
        adProduct: SD,
        name: SD_NAME,
        state: 'ENABLED',
      })
      .returning({ id: amazonAdsCampaigns.id });
    const [adGroup] = await db
      .insert(amazonAdsAdGroups)
      .values({
        organizationId: f.org,
        profileId: f.profile,
        campaignId: campaign!.id,
        amazonAdGroupId: '5501',
        adProduct: SD,
        name: SD_NAME,
        state: 'ENABLED',
      })
      .returning({ id: amazonAdsAdGroups.id });
    const parents = {
      organizationId: f.org,
      profileId: f.profile,
      campaignId: campaign!.id,
      adGroupId: adGroup!.id,
      adProduct: SD,
      state: 'ENABLED',
    };
    await db
      .insert(amazonAdsProductAds)
      .values({ ...parents, amazonAdId: '6601', asin: 'B0TEST0001', sku: 'SKU-1' });
    await db.insert(amazonAdsTargets).values([
      // Andere Zielgruppe (Käufe) und anderer Rückblick zählen nicht.
      {
        ...parents,
        amazonTargetId: '7702',
        targetType: 'audience',
        expression: { event: 'PURCHASES', lookback: 30 },
      },
      {
        ...parents,
        amazonTargetId: '7703',
        targetType: 'audience',
        expression: { event: 'VIEWS', lookback: 60 },
      },
      {
        ...parents,
        amazonTargetId: '7701',
        targetType: 'audience',
        expression: { event: 'VIEWS', lookback: 30, bulkExpression: 'views=(exact-product lookback=30)' },
      },
    ]);
    const result = await confirmBulkFileAdChanges(db, {
      organizationId: f.org,
      profileId: f.profile,
      now: new Date(),
    });
    expect(result).toEqual({ confirmed: 4, finished: 1 });
    expect((await items(id)).map((row) => row.amazonEntityId)).toEqual([
      '4401',
      '5501',
      '6601',
      '7701',
    ]);
  });
});

describe('closeBulkFileSubmission für Setups', () => {
  it('schließt offene Anlagen als angewendet bzw. verworfen ab', async () => {
    const applied = await submitted();
    expect(
      await closeBulkFileSubmission(testDb.db, {
        ...who(),
        submissionId: applied,
        outcome: 'applied',
      }),
    ).toEqual({ changes: 9 });
    expect((await items(applied)).every((row) => row.status === 'applied')).toBe(true);
    expect(await submissionStatus(applied)).toBe('finished');

    const discarded = await submitted('bulk_file', f.profile, 'Zweite');
    await closeBulkFileSubmission(testDb.db, {
      ...who(),
      submissionId: discarded,
      outcome: 'discarded',
    });
    expect((await items(discarded)).every((row) => row.status === 'dismissed')).toBe(true);
  });

  it('trägt nach dem Abschließen von Hand die echten IDs beim nächsten Import nach', async () => {
    const id = await submitted();
    await closeBulkFileSubmission(testDb.db, { ...who(), submissionId: id, outcome: 'applied' });
    expect(await submissionStatus(id)).toBe('finished');

    await importStructure();
    const result = await confirmBulkFileAdChanges(testDb.db, {
      organizationId: f.org,
      profileId: f.profile,
      now: new Date(),
    });
    expect(result.finished).toBe(0);
    expect((await items(id)).map((row) => [row.entityType, row.amazonEntityId])).toEqual([
      ['campaign', '4401'],
      ['placement', null],
      ['ad_group', '5501'],
      ['product_ad', '6601'],
      ['keyword', '7701'],
      ['product_target', '7702'],
      ['product_target', '7703'],
      ['negative_keyword', '8801'],
      ['negative_product_target', '8802'],
    ]);
  });
});

describe('Harvest von der Merkliste (4.6)', () => {
  async function harvestMark(searchTerm: string) {
    const [row] = await testDb.db
      .insert(searchTermHarvestMarks)
      .values({
        organizationId: f.org,
        profileId: f.profile,
        searchTerm,
        termKey: searchTerm.toLowerCase(),
        adProduct: SP,
        amazonCampaignId: '1001',
        amazonAdGroupId: '2001',
        amazonTargetId: '3001',
        periodStart: '2026-09-01',
        periodEnd: '2026-09-30',
        sourceRows: 1,
        currencyCode: 'EUR',
        impressions: 100,
        clicks: 10,
        cost: '7.80',
        sales: '30.00',
        purchases: 2,
        units: 2,
        createdBy: f.ada,
      })
      .returning({ id: searchTermHarvestMarks.id });
    return row!.id;
  }
  const remaining = async () =>
    (
      await testDb.db
        .select({ term: searchTermHarvestMarks.searchTerm })
        .from(searchTermHarvestMarks)
    )
      .map((row) => row.term)
      .sort();

  async function harvestSubmission() {
    const used = await harvestMark('trinkflasche');
    const asin = await harvestMark('b0fremd001');
    const notPlanned = await harvestMark('becher');
    await harvestMark('nicht gewählt');
    return submitted('bulk_file', f.profile, NAME, {
      inputs: {
        keywords: [],
        brandTerms: [],
        productTargets: [],
        categories: [],
        harvest: [{ markId: used }, { markId: asin }, { markId: notPlanned }],
        unlocks: {},
      },
      sourceNegatives: [
        {
          markId: used,
          searchTerm: 'trinkflasche',
          amazonCampaignId: '1001',
          amazonAdGroupId: '2001',
          campaignName: 'Kampagne 1001',
          adGroupName: 'AG 2001',
          negative: { type: 'keyword', text: 'trinkflasche', matchType: 'negativeExact' },
          selected: true,
        },
      ],
    });
  }

  it('bestätigt das Negativ in der Quelle über den nächsten Import', async () => {
    const id = await harvestSubmission();
    const [adGroup] = await testDb.db
      .select({ id: amazonAdsAdGroups.id, campaignId: amazonAdsAdGroups.campaignId })
      .from(amazonAdsAdGroups)
      .where(eq(amazonAdsAdGroups.amazonAdGroupId, '2001'));
    await testDb.db.insert(amazonAdsNegativeTargets).values({
      organizationId: f.org,
      profileId: f.profile,
      level: 'ad_group',
      campaignId: adGroup!.campaignId,
      adGroupId: adGroup!.id,
      amazonTargetId: '8803',
      adProduct: SP,
      targetType: 'keyword',
      keywordText: 'Trinkflasche',
      matchType: 'EXACT',
      state: 'ENABLED',
    });
    await confirmBulkFileAdChanges(testDb.db, {
      organizationId: f.org,
      profileId: f.profile,
      now: new Date(),
    });
    const source = (await items(id)).find((row) => row.entityType === 'source_negative');
    expect(source).toMatchObject({ status: 'applied', amazonEntityId: '8803' });
  });

  it('nimmt angelegte Begriffe nach Abschluss von der Merkliste, mit Audit', async () => {
    const id = await harvestSubmission();
    expect(await remaining()).toEqual(['b0fremd001', 'becher', 'nicht gewählt', 'trinkflasche']);
    await closeBulkFileSubmission(testDb.db, { ...who(), submissionId: id, outcome: 'applied' });
    // Angelegt: das Keyword und das Produkt-Ziel; „becher“ legt der Plan nicht an, „nicht gewählt“ gehört nicht dazu.
    expect(await remaining()).toEqual(['becher', 'nicht gewählt']);
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'search_term_harvest.remove'));
    expect(event!.target).toMatchObject({
      id: f.org,
      removed: 2,
      profileIds: [f.profile],
      submissionId: id,
    });
  });

  it('behält Begriffe, deren Keyword Amazon abgelehnt hat (API-Weg)', async () => {
    const id = await harvestSubmission();
    const rows = await items(id);
    await recordCampaignSetupResults(testDb.db, {
      organizationId: f.org,
      submissionId: id,
      now: new Date(),
      results: rows.map((row) =>
        row.entityType === 'keyword' || row.entityType === 'source_negative'
          ? { itemId: row.id, outcome: 'failed', code: 'INVALID_KEYWORD', message: 'abgelehnt' }
          : { itemId: row.id, outcome: 'applied', amazonEntityId: null },
      ),
    });
    await finishAdChangeSubmission(testDb.db, {
      organizationId: f.org,
      submissionId: id,
      now: new Date(),
    });
    expect(await remaining()).toEqual(['becher', 'nicht gewählt', 'trinkflasche']);
  });

  it('lässt die Merkliste stehen, wenn die Übermittlung verworfen wird', async () => {
    const id = await harvestSubmission();
    await closeBulkFileSubmission(testDb.db, { ...who(), submissionId: id, outcome: 'discarded' });
    expect(await remaining()).toHaveLength(4);
  });
});
