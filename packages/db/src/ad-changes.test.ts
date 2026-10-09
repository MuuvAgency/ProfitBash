import type { AdChangeInput } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  AdChangeError,
  discardPendingAdChanges,
  getAdChangeSubmission,
  listAdChangeSubmissions,
  listPendingAdChanges,
  stageAdChanges,
  submitAdChanges,
} from './ad-changes';
import {
  adChangeSubmissions,
  adChanges,
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsTargets,
  auditEvents,
  members,
  organizations,
  users,
} from './schema';
import { createTestConnection, createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Schreibschicht für Änderungen (`phase-3.md` 3.1): Warenkorb je Nutzer, Übermittlung je Profil, alles über den Access-Layer. */

let testDb: TestDatabase;
const ids = {
  org: '',
  otherOrg: '',
  ada: '',
  emil: '',
  otto: '',
  stranger: '',
  de: '',
  file: '',
  hidden: '',
  foreign: '',
  campaign: '',
  sbCampaign: '',
  archivedCampaign: '',
  removedCampaign: '',
  hiddenCampaign: '',
  foreignCampaign: '',
  fileCampaign: '',
  adGroup: '',
  sbAdGroup: '',
  target: '',
  targetWithoutBid: '',
  fileTarget: '',
  productAd: '',
  negative: '',
};

const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const as = (userId: string, orgId = ids.org) => ({ userId, orgId });
const noEnqueue = async () => {};

const update = (
  entityType: Extract<AdChangeInput, { operation: 'update' }>['entityType'],
  entityId: string,
  field: Extract<AdChangeInput, { operation: 'update' }>['field'],
  value: string,
): AdChangeInput => ({ operation: 'update', entityType, entityId, field, value });

const negativeKeyword = (
  keywordText: string,
  patch: { campaignId?: string; adGroupId?: string | null; matchType?: 'EXACT' | 'PHRASE' } = {},
): AdChangeInput => ({
  operation: 'create_negative',
  campaignId: patch.campaignId ?? ids.campaign,
  adGroupId: patch.adGroupId === undefined ? ids.adGroup : patch.adGroupId,
  negative: { type: 'keyword', keywordText, matchType: patch.matchType ?? 'EXACT' },
});

async function stage(userId: string, changes: AdChangeInput[], orgId = ids.org) {
  const result = await stageAdChanges(testDb.db, { userId, orgId, origin: 'explorer', changes });
  if (!result) throw new Error('kein Mitglied');
  return result;
}

async function auditActions() {
  const rows = await testDb.db
    .select({ action: auditEvents.action, target: auditEvents.target })
    .from(auditEvents)
    .orderBy(auditEvents.createdAt);
  return rows;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const created = await db
    .insert(users)
    .values([
      { name: 'Ada', email: 'ada@muuv.test' },
      { name: 'Emil', email: 'emil@muuv.test' },
      { name: 'Otto', email: 'otto@andere.test' },
      { name: 'Niemand', email: 'niemand@nirgends.test' },
    ])
    .returning({ id: users.id });
  [ids.ada, ids.emil, ids.otto, ids.stranger] = created.map((u) => u.id) as [
    string,
    string,
    string,
    string,
  ];
  await db.insert(members).values([
    { organizationId: ids.org, userId: ids.ada, role: 'admin', createdAt: new Date() },
    { organizationId: ids.org, userId: ids.emil, role: 'editor', createdAt: new Date() },
    { organizationId: ids.otherOrg, userId: ids.otto, role: 'admin', createdAt: new Date() },
  ]);

  const connection = await createTestConnection(db, ids.org, 'amzn1.account.MUUV');
  const otherConnection = await createTestConnection(db, ids.otherOrg, 'amzn1.account.OTHER');
  const profile = (
    organizationId: string,
    connectionId: string | null,
    amazonProfileId: string | null,
    accountName: string,
  ) => ({
    organizationId,
    connectionId,
    amazonProfileId,
    accountName,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
  });
  const profiles = await db
    .insert(amazonAdsProfiles)
    .values([
      profile(ids.org, connection, '1', 'Nordwind DE'),
      profile(ids.org, null, null, 'Datei-Konto'),
      { ...profile(ids.org, connection, '2', 'Versteckt'), isHidden: true },
      profile(ids.otherOrg, otherConnection, '3', 'Fremd'),
    ])
    .returning({ id: amazonAdsProfiles.id });
  [ids.de, ids.file, ids.hidden, ids.foreign] = profiles.map((p) => p.id) as [
    string,
    string,
    string,
    string,
  ];

  const campaign = (
    organizationId: string,
    profileId: string,
    amazonCampaignId: string,
    patch: Partial<typeof amazonAdsCampaigns.$inferInsert> = {},
  ) => ({
    organizationId,
    profileId,
    amazonCampaignId,
    adProduct: SP,
    name: `Kampagne ${amazonCampaignId}`,
    state: 'ENABLED',
    budgetAmount: '20',
    budgetCurrencyCode: 'EUR',
    budgetType: 'DAILY',
    biddingStrategy: 'SALES_DOWN_ONLY',
    ...patch,
  });
  const campaigns = await db
    .insert(amazonAdsCampaigns)
    .values([
      campaign(ids.org, ids.de, 'C1', {
        extra: { placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: '50' }] },
      }),
      campaign(ids.org, ids.de, 'CSB', { adProduct: SB, budgetType: 'LIFETIME' }),
      campaign(ids.org, ids.de, 'CARCH', { state: 'ARCHIVED' }),
      campaign(ids.org, ids.de, 'CGONE', { removedAt: new Date('2026-10-01T00:00:00Z') }),
      campaign(ids.org, ids.hidden, 'CH'),
      campaign(ids.otherOrg, ids.foreign, 'CF'),
      campaign(ids.org, ids.file, 'FC'),
    ])
    .returning({ id: amazonAdsCampaigns.id });
  [
    ids.campaign,
    ids.sbCampaign,
    ids.archivedCampaign,
    ids.removedCampaign,
    ids.hiddenCampaign,
    ids.foreignCampaign,
    ids.fileCampaign,
  ] = campaigns.map((c) => c.id) as [string, string, string, string, string, string, string];

  const adGroups = await db
    .insert(amazonAdsAdGroups)
    .values([
      {
        organizationId: ids.org,
        profileId: ids.de,
        campaignId: ids.campaign,
        amazonAdGroupId: 'AG1',
        adProduct: SP,
        name: 'AG Lampen',
        state: 'ENABLED',
        defaultBid: '0.40',
        defaultBidCurrencyCode: 'EUR',
      },
      {
        organizationId: ids.org,
        profileId: ids.de,
        campaignId: ids.sbCampaign,
        amazonAdGroupId: 'AG2',
        adProduct: SB,
        name: 'AG Marke',
        state: 'ENABLED',
      },
      {
        organizationId: ids.org,
        profileId: ids.file,
        campaignId: ids.fileCampaign,
        amazonAdGroupId: 'FAG',
        adProduct: SP,
        name: 'AG Datei',
        state: 'ENABLED',
      },
    ])
    .returning({ id: amazonAdsAdGroups.id });
  const fileAdGroup = adGroups[2]!.id;
  ids.adGroup = adGroups[0]!.id;
  ids.sbAdGroup = adGroups[1]!.id;

  const target = (
    profileId: string,
    campaignId: string,
    adGroupId: string,
    amazonTargetId: string,
    bid: string | null,
  ) => ({
    organizationId: ids.org,
    profileId,
    campaignId,
    adGroupId,
    amazonTargetId,
    adProduct: SP,
    targetType: 'keyword',
    keywordText: `kw ${amazonTargetId}`,
    matchType: 'BROAD',
    state: 'ENABLED',
    bid,
    bidCurrencyCode: bid === null ? null : 'EUR',
  });
  const targets = await db
    .insert(amazonAdsTargets)
    .values([
      target(ids.de, ids.campaign, ids.adGroup, 'T1', '0.50'),
      target(ids.de, ids.campaign, ids.adGroup, 'T2', null),
      target(ids.file, ids.fileCampaign, fileAdGroup, 'FT', '1.10'),
    ])
    .returning({ id: amazonAdsTargets.id });
  [ids.target, ids.targetWithoutBid, ids.fileTarget] = targets.map((t) => t.id) as [
    string,
    string,
    string,
  ];

  const [productAd] = await db
    .insert(amazonAdsProductAds)
    .values({
      organizationId: ids.org,
      profileId: ids.de,
      campaignId: ids.campaign,
      adGroupId: ids.adGroup,
      amazonAdId: 'AD1',
      adProduct: SP,
      asin: 'B0TEST0001',
      sku: 'SKU-1',
      state: 'ENABLED',
    })
    .returning({ id: amazonAdsProductAds.id });
  ids.productAd = productAd!.id;

  const negative = (amazonTargetId: string, keywordText: string, state: string) => ({
    organizationId: ids.org,
    profileId: ids.de,
    level: 'ad_group',
    campaignId: ids.campaign,
    adGroupId: ids.adGroup,
    amazonTargetId,
    adProduct: SP,
    targetType: 'keyword',
    keywordText,
    matchType: 'EXACT',
    state,
  });
  const negatives = await db
    .insert(amazonAdsNegativeTargets)
    .values([negative('N1', 'Gebraucht  Lampe', 'ENABLED'), negative('N2', 'alt', 'ARCHIVED')])
    .returning({ id: amazonAdsNegativeTargets.id });
  ids.negative = negatives[0]!.id;
});

beforeEach(async () => {
  await testDb.db.delete(adChanges);
  await testDb.db.delete(adChangeSubmissions);
  await testDb.db.delete(auditEvents);
});

afterAll(async () => {
  await testDb?.close();
});

describe('stageAdChanges: Feldänderungen', () => {
  it('legt eine Änderung in den Warenkorb und liest „vorher“ und die Währung aus der Entity', async () => {
    const result = await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);

    expect(result.counts).toEqual({
      created: 1,
      updated: 0,
      removed: 0,
      unchanged: 0,
      rejected: 0,
    });
    expect(result.results[0]).toMatchObject({ outcome: 'created', otherUsers: 0 });
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart).toHaveLength(1);
    expect(cart![0]).toMatchObject({
      status: 'pending',
      origin: 'explorer',
      operation: 'update',
      profileId: ids.de,
      entityType: 'target',
      entityId: ids.target,
      campaignId: ids.campaign,
      adGroupId: ids.adGroup,
      field: 'bid',
      before: '0.50',
      after: '0.75',
      currencyCode: 'EUR',
      negative: null,
      submissionId: null,
      createdBy: ids.ada,
    });
  });

  it('schreibt ein Audit-Event mit Herkunft und Zählern', async () => {
    await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('campaign', ids.campaign, 'state', 'PAUSED'),
    ]);

    expect(await auditActions()).toEqual([
      {
        action: 'ad_changes.stage',
        target: expect.objectContaining({
          type: 'ad_changes',
          id: ids.org,
          origin: 'explorer',
          created: 2,
          updated: 0,
          removed: 0,
          profileIds: [ids.de],
        }),
      },
    ]);
  });

  it('liefert `null` für Nicht-Mitglieder und schreibt nichts', async () => {
    const result = await stageAdChanges(testDb.db, {
      ...as(ids.stranger),
      origin: 'explorer',
      changes: [update('target', ids.target, 'bid', '0.75')],
    });

    expect(result).toBeNull();
    expect(await testDb.db.select().from(adChanges)).toHaveLength(0);
  });

  it('ersetzt den neuen Wert, wenn dieselbe Stelle noch einmal geändert wird', async () => {
    const first = await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);
    const second = await stage(ids.ada, [update('target', ids.target, 'bid', '0.90')]);

    expect(second.results[0]).toMatchObject({ outcome: 'updated' });
    expect(second.results[0]).toHaveProperty(
      'changeId',
      (first.results[0] as { changeId: string }).changeId,
    );
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart!.map((c) => [c.before, c.after])).toEqual([['0.50', '0.90']]);
  });

  it('meldet `unchanged`, wenn derselbe Wert schon im Warenkorb liegt, ohne Audit-Event', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);
    await testDb.db.delete(auditEvents);

    const again = await stage(ids.ada, [update('target', ids.target, 'bid', '0.750')]);

    expect(again.counts).toMatchObject({ unchanged: 1, updated: 0 });
    expect(await auditActions()).toEqual([]);
  });

  it('nimmt die Änderung aus dem Warenkorb, wenn der neue Wert dem Stand der Entity entspricht', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);

    const back = await stage(ids.ada, [update('target', ids.target, 'bid', '0.5')]);

    expect(back.results[0]).toEqual({ outcome: 'removed' });
    expect(await listPendingAdChanges(testDb.db, as(ids.ada))).toEqual([]);
  });

  it('meldet `unchanged`, wenn der Wert dem Stand der Entity entspricht und nichts vorgemerkt ist', async () => {
    const result = await stage(ids.ada, [update('campaign', ids.campaign, 'state', 'ENABLED')]);

    expect(result.results[0]).toEqual({ outcome: 'unchanged' });
    expect(await testDb.db.select().from(adChanges)).toHaveLength(0);
  });

  it('lässt bei mehreren Angaben zur selben Stelle in einer Anfrage die letzte gelten', async () => {
    const result = await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.60'),
      update('target', ids.target, 'bid', '0.80'),
    ]);

    expect(result.results.map((r) => r.outcome)).toEqual(['unchanged', 'created']);
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart!.map((c) => c.after)).toEqual(['0.80']);
  });

  it('merkt ein Gebot auch ohne bisheriges Gebot vor (Währung des Profils)', async () => {
    await stage(ids.ada, [update('target', ids.targetWithoutBid, 'bid', '0.30')]);

    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart![0]).toMatchObject({ before: null, after: '0.30', currencyCode: 'EUR' });
  });

  it('nennt für ein Gebot ohne bisheriges Gebot das Standardgebot der Ad Group als Vergleichswert', async () => {
    await stage(ids.ada, [
      update('target', ids.targetWithoutBid, 'bid', '0.30'),
      update('target', ids.target, 'bid', '0.90'),
    ]);

    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart!.map((c) => [c.entityId, c.before, c.comparisonBefore])).toEqual([
      [ids.targetWithoutBid, null, '0.40'],
      [ids.target, expect.any(String), null],
    ]);

    let reviewed: unknown[] = [];
    await submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'bulk_file',
      enqueue: noEnqueue,
      review: (rows) => {
        reviewed = rows.map((row) => [row.before, row.comparisonBefore]);
        return 'abgelehnt';
      },
    });
    expect(reviewed).toEqual([
      [null, '0.40'],
      [expect.any(String), null],
    ]);
  });

  it('liest Zustand, Budget, Strategie und Standardgebot als „vorher“', async () => {
    await stage(ids.ada, [
      update('campaign', ids.campaign, 'state', 'PAUSED'),
      update('campaign', ids.campaign, 'budget', '35.50'),
      update('campaign', ids.campaign, 'bidding_strategy', 'NONE'),
      update('ad_group', ids.adGroup, 'default_bid', '0.45'),
      update('product_ad', ids.productAd, 'state', 'PAUSED'),
      update('negative_target', ids.negative, 'state', 'ARCHIVED'),
    ]);

    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    const byField = Object.fromEntries(
      cart!.map((c) => [`${c.entityType}.${c.field}`, [c.before, c.after, c.currencyCode]]),
    );
    expect(byField).toEqual({
      'campaign.state': ['ENABLED', 'PAUSED', null],
      'campaign.budget': ['20', '35.50', 'EUR'],
      'campaign.bidding_strategy': ['SALES_DOWN_ONLY', 'NONE', null],
      'ad_group.default_bid': ['0.40', '0.45', 'EUR'],
      'product_ad.state': ['ENABLED', 'PAUSED', null],
      'negative_target.state': ['ENABLED', 'ARCHIVED', null],
    });
  });

  it('liest eine Gebotsanpassung auch, wenn sie in `extra` als Zahl steht (API-Export)', async () => {
    await testDb.db
      .update(amazonAdsCampaigns)
      .set({ extra: { placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] } })
      .where(eq(amazonAdsCampaigns.id, ids.campaign));
    try {
      const result = await stage(ids.ada, [
        update('campaign', ids.campaign, 'placement_top', '50'),
        update('campaign', ids.campaign, 'placement_top', '70'),
      ]);

      expect(result.results.map((r) => r.outcome)).toEqual(['unchanged', 'created']);
      const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
      expect(cart!.map((c) => [c.before, c.after])).toEqual([['50', '70']]);
    } finally {
      await testDb.db
        .update(amazonAdsCampaigns)
        .set({
          extra: { placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: '50' }] },
        })
        .where(eq(amazonAdsCampaigns.id, ids.campaign));
    }
  });

  it('liest die Gebotsanpassung einer Platzierung aus `extra`; ohne Anpassung gilt 0 %', async () => {
    const result = await stage(ids.ada, [
      update('campaign', ids.campaign, 'placement_top', '120'),
      update('campaign', ids.campaign, 'placement_product_page', '25'),
      update('campaign', ids.campaign, 'placement_rest_of_search', '0'),
    ]);

    expect(result.results.map((r) => r.outcome)).toEqual(['created', 'created', 'unchanged']);
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    const byField = Object.fromEntries(
      cart!.map((c) => [c.field, [c.before, c.after, c.currencyCode]]),
    );
    expect(byField).toEqual({
      placement_top: ['50', '120', null],
      placement_product_page: [null, '25', null],
    });
  });
});

describe('stageAdChanges: anpassen (±Prozent, ±Betrag)', () => {
  const adjust = (
    entityType: 'campaign' | 'ad_group' | 'target',
    entityId: string,
    field: 'budget' | 'default_bid' | 'bid',
    mode: 'percent' | 'amount',
    value: string,
  ): AdChangeInput => ({ operation: 'adjust', entityType, entityId, field, mode, value });

  it('rechnet Prozent und Betrag auf den Stand der Entity und rundet kaufmännisch auf zwei Stellen', async () => {
    const result = await stage(ids.ada, [
      adjust('target', ids.target, 'bid', 'percent', '-15'),
      adjust('ad_group', ids.adGroup, 'default_bid', 'amount', '0.05'),
      adjust('campaign', ids.campaign, 'budget', 'percent', '12.5'),
    ]);

    expect(result.counts).toMatchObject({ created: 3, rejected: 0 });
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart!.map((c) => [c.field, c.before, c.after]).sort()).toEqual([
      // 0.50 − 15 % = 0.425 → 0.43
      ['bid', '0.50', '0.43'],
      ['budget', '20', '22.50'],
      ['default_bid', '0.40', '0.45'],
    ]);
  });

  it('rechnet immer auf den Stand der Entity, nicht auf einen schon vorgemerkten Wert', async () => {
    await stage(ids.ada, [adjust('target', ids.target, 'bid', 'percent', '10')]);
    const again = await stage(ids.ada, [adjust('target', ids.target, 'bid', 'percent', '10')]);

    expect(again.results).toEqual([{ outcome: 'unchanged' }]);
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart!.map((c) => c.after)).toEqual(['0.55']);
  });

  it('lässt bei Angaben zur selben Stelle die letzte gelten, auch wenn sie eine abgelehnte Anpassung ist', async () => {
    const result = await stage(ids.ada, [
      update('target', ids.target, 'bid', '1.00'),
      adjust('target', ids.target, 'bid', 'percent', '-99.9'),
    ]);
    expect(result.results).toEqual([
      { outcome: 'unchanged' },
      { outcome: 'rejected', reason: 'resultOutOfRange' },
    ]);
    expect(await listPendingAdChanges(testDb.db, as(ids.ada))).toEqual([]);

    const both = await stage(ids.ada, [
      adjust('target', ids.target, 'bid', 'percent', '10'),
      adjust('target', ids.target, 'bid', 'amount', '0.20'),
    ]);
    expect(both.results.map((r) => r.outcome)).toEqual(['unchanged', 'created']);
    expect((await listPendingAdChanges(testDb.db, as(ids.ada)))!.map((c) => c.after)).toEqual([
      '0.70',
    ]);
  });

  it('nimmt eine Vormerkung zurück, wenn das gerundete Ergebnis dem Stand entspricht', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.80')]);
    // 0.50 + 0.1 % = 0.5005 → 0.50
    const result = await stage(ids.ada, [adjust('target', ids.target, 'bid', 'percent', '0.1')]);
    expect(result.results).toEqual([{ outcome: 'removed' }]);
  });

  it('nimmt für ein Target ohne eigenes Gebot das Standardgebot der Ad Group als Ausgangswert', async () => {
    await stage(ids.ada, [adjust('target', ids.targetWithoutBid, 'bid', 'percent', '50')]);

    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart![0]).toMatchObject({ before: null, after: '0.60' });
  });

  it('lehnt ab, was keinen Ausgangswert hat oder kein Betrag über 0 wird', async () => {
    await testDb.db
      .update(amazonAdsAdGroups)
      .set({ defaultBid: null })
      .where(eq(amazonAdsAdGroups.id, ids.adGroup));
    try {
      const result = await stage(ids.ada, [
        adjust('target', ids.targetWithoutBid, 'bid', 'amount', '0.10'),
        adjust('target', ids.target, 'bid', 'amount', '-0.50'),
        adjust('target', ids.target, 'bid', 'percent', '-99.5'),
        adjust('campaign', ids.archivedCampaign, 'budget', 'percent', '10'),
        adjust('campaign', ids.foreignCampaign, 'budget', 'percent', '10'),
      ]);
      expect(result.results).toEqual([
        { outcome: 'rejected', reason: 'noCurrentValue' },
        { outcome: 'rejected', reason: 'resultOutOfRange' },
        { outcome: 'rejected', reason: 'resultOutOfRange' },
        { outcome: 'rejected', reason: 'entityArchived' },
        { outcome: 'rejected', reason: 'notFound' },
      ]);
    } finally {
      await testDb.db
        .update(amazonAdsAdGroups)
        .set({ defaultBid: '0.40' })
        .where(eq(amazonAdsAdGroups.id, ids.adGroup));
    }
  });
});

describe('stageAdChanges: Ablehnungen', () => {
  it('lehnt Entities fremder Organisationen und ausgeblendeter Profile als `notFound` ab', async () => {
    const result = await stage(ids.emil, [
      update('campaign', ids.foreignCampaign, 'state', 'PAUSED'),
      update('campaign', ids.hiddenCampaign, 'state', 'PAUSED'),
      update('target', ids.campaign, 'bid', '1'),
    ]);

    expect(result.results).toEqual([
      { outcome: 'rejected', reason: 'notFound' },
      { outcome: 'rejected', reason: 'notFound' },
      { outcome: 'rejected', reason: 'notFound' },
    ]);
    expect(await testDb.db.select().from(adChanges)).toHaveLength(0);
    expect(await auditActions()).toEqual([]);
  });

  it('lehnt entfernte und archivierte Entities ab', async () => {
    const result = await stage(ids.ada, [
      update('campaign', ids.removedCampaign, 'state', 'PAUSED'),
      update('campaign', ids.archivedCampaign, 'state', 'ENABLED'),
    ]);

    expect(result.results).toEqual([
      { outcome: 'rejected', reason: 'entityRemoved' },
      { outcome: 'rejected', reason: 'entityArchived' },
    ]);
  });

  it('ändert nur Tagesbudgets', async () => {
    const result = await stage(ids.ada, [update('campaign', ids.sbCampaign, 'budget', '50')]);

    expect(result.results[0]).toEqual({ outcome: 'rejected', reason: 'budgetNotDaily' });
  });

  it('kennt Gebotsstrategie und Platzierungen nur für Sponsored Products', async () => {
    const result = await stage(ids.ada, [
      update('campaign', ids.sbCampaign, 'bidding_strategy', 'NONE'),
      update('campaign', ids.sbCampaign, 'placement_top', '10'),
    ]);

    expect(result.results).toEqual([
      { outcome: 'rejected', reason: 'adProductNotSupported' },
      { outcome: 'rejected', reason: 'adProductNotSupported' },
    ]);
  });

  it('nimmt die gültigen Änderungen einer Anfrage trotz abgelehnter an', async () => {
    const result = await stage(ids.ada, [
      update('campaign', ids.archivedCampaign, 'state', 'ENABLED'),
      update('target', ids.target, 'bid', '0.75'),
    ]);

    expect(result.counts).toMatchObject({ created: 1, rejected: 1 });
    expect(await listPendingAdChanges(testDb.db, as(ids.ada))).toHaveLength(1);
  });
});

describe('stageAdChanges: Negatives anlegen', () => {
  it('merkt ein negatives Keyword in der Ad Group vor', async () => {
    const result = await stage(ids.ada, [negativeKeyword('kinder lampe', { matchType: 'PHRASE' })]);

    expect(result.results[0]).toMatchObject({ outcome: 'created' });
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart![0]).toMatchObject({
      operation: 'create',
      entityType: 'negative_target',
      entityId: null,
      profileId: ids.de,
      campaignId: ids.campaign,
      adGroupId: ids.adGroup,
      field: null,
      before: null,
      after: null,
      negative: { type: 'keyword', keywordText: 'kinder lampe', matchType: 'PHRASE' },
    });
  });

  it('merkt eine negative ASIN auf Kampagnenebene vor', async () => {
    await stage(ids.ada, [
      {
        operation: 'create_negative',
        campaignId: ids.campaign,
        adGroupId: null,
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
    ]);

    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart![0]).toMatchObject({
      adGroupId: null,
      negative: { type: 'product', asin: 'B0FREMD001' },
    });
  });

  it('meldet `unchanged`, wenn dasselbe Negative schon im eigenen Warenkorb liegt (ohne Groß/Klein)', async () => {
    await stage(ids.ada, [negativeKeyword('Kinder Lampe')]);

    const again = await stage(ids.ada, [negativeKeyword('kinder lampe')]);

    expect(again.results[0]).toEqual({ outcome: 'unchanged' });
    expect(await listPendingAdChanges(testDb.db, as(ids.ada))).toHaveLength(1);
  });

  it('hält dasselbe Keyword mit anderem Match-Typ oder auf anderer Ebene für ein anderes Negative', async () => {
    const result = await stage(ids.ada, [
      negativeKeyword('kinder lampe'),
      negativeKeyword('kinder lampe', { matchType: 'PHRASE' }),
      negativeKeyword('kinder lampe', { adGroupId: null }),
    ]);

    expect(result.counts.created).toBe(3);
  });

  it('lehnt ein Negative ab, das es dort schon gibt; ein archiviertes zählt nicht', async () => {
    const result = await stage(ids.ada, [
      negativeKeyword('gebraucht lampe'),
      negativeKeyword('alt'),
    ]);

    expect(result.results[0]).toEqual({ outcome: 'rejected', reason: 'alreadyExists' });
    expect(result.results[1]).toMatchObject({ outcome: 'created' });
  });

  it('lehnt eine negative ASIN ab, die es dort schon gibt', async () => {
    const [existing] = await testDb.db
      .insert(amazonAdsNegativeTargets)
      .values({
        organizationId: ids.org,
        profileId: ids.de,
        level: 'campaign',
        campaignId: ids.campaign,
        adGroupId: null,
        amazonTargetId: 'N-ASIN',
        adProduct: SP,
        targetType: 'product',
        expression: { matchType: 'PRODUCT_EXACT', asin: 'b0fremd001' },
        state: 'ENABLED',
      })
      .returning({ id: amazonAdsNegativeTargets.id });
    try {
      const asin = (adGroupId: string | null): AdChangeInput => ({
        operation: 'create_negative',
        campaignId: ids.campaign,
        adGroupId,
        negative: { type: 'product', asin: 'B0FREMD001' },
      });

      const result = await stage(ids.ada, [asin(null), asin(ids.adGroup)]);

      expect(result.results[0]).toEqual({ outcome: 'rejected', reason: 'alreadyExists' });
      expect(result.results[1]).toMatchObject({ outcome: 'created' });
    } finally {
      await testDb.db
        .delete(amazonAdsNegativeTargets)
        .where(eq(amazonAdsNegativeTargets.id, existing!.id));
    }
  });

  it('weist auf dasselbe offene Negative eines anderen Nutzers hin, nicht auf ein anderes', async () => {
    await stage(ids.emil, [negativeKeyword('kinder lampe'), negativeKeyword('holz lampe')]);

    const result = await stage(ids.ada, [negativeKeyword('Kinder Lampe'), negativeKeyword('x')]);

    expect(result.results.map((r) => (r.outcome === 'created' ? r.otherUsers : null))).toEqual([
      1, 0,
    ]);
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    const byText = Object.fromEntries(
      cart!.map((c) => [
        c.negative?.type === 'keyword' ? c.negative.keywordText : '',
        c.otherUsers,
      ]),
    );
    expect(byText).toEqual({ 'Kinder Lampe': [{ userId: ids.emil, name: 'Emil' }], x: [] });
  });

  it('lehnt unsichtbare Kampagnen und Ad Groups anderer Kampagnen als `notFound` ab', async () => {
    const result = await stage(ids.ada, [
      negativeKeyword('x', { campaignId: ids.foreignCampaign, adGroupId: null }),
      negativeKeyword('x', { campaignId: ids.hiddenCampaign, adGroupId: null }),
      negativeKeyword('x', { adGroupId: ids.sbAdGroup }),
    ]);

    expect(result.results.map((r) => (r.outcome === 'rejected' ? r.reason : r.outcome))).toEqual([
      'notFound',
      'notFound',
      'notFound',
    ]);
  });

  it('lehnt Negatives in archivierten Kampagnen ab', async () => {
    const result = await stage(ids.ada, [
      negativeKeyword('x', { campaignId: ids.archivedCampaign, adGroupId: null }),
    ]);

    expect(result.results[0]).toEqual({ outcome: 'rejected', reason: 'entityArchived' });
  });
});

describe('stageAdChanges: Nebenläufigkeit', () => {
  it('löscht nie eine Änderung, die gleichzeitig übermittelt wird', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);
    let racing: ReturnType<typeof stage> | undefined;

    const submitted = await submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'api',
      enqueue: async () => {
        // Zweite Verbindung: liest die Änderung noch als offen und will sie zurücknehmen.
        racing = stage(ids.ada, [update('target', ids.target, 'bid', '0.50')]);
        await new Promise((resolve) => setTimeout(resolve, 150));
      },
    });
    const result = await racing!;

    expect(result.results[0]).toEqual({ outcome: 'unchanged' });
    const rows = await testDb.db.select().from(adChanges);
    expect(rows.map((row) => [row.status, row.submissionId])).toEqual([
      ['submitted', submitted!.submissions[0]!.id],
    ]);
  });

  it('legt dasselbe Negative bei gleichzeitigem Vormerken nur einmal an', async () => {
    const results = await Promise.all(
      [1, 2, 3].map(() => stage(ids.ada, [negativeKeyword('kinder lampe')])),
    );

    expect(results.map((r) => r.results[0]!.outcome).sort()).toEqual([
      'created',
      'unchanged',
      'unchanged',
    ]);
    expect(await testDb.db.select().from(adChanges)).toHaveLength(1);
  });
});

describe('Warenkorb je Nutzer (F4)', () => {
  it('zeigt jedem nur die eigenen Änderungen', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);
    await stage(ids.emil, [update('campaign', ids.campaign, 'state', 'PAUSED')]);

    const ada = await listPendingAdChanges(testDb.db, as(ids.ada));
    const emil = await listPendingAdChanges(testDb.db, as(ids.emil));

    expect(ada!.map((c) => c.field)).toEqual(['bid']);
    expect(emil!.map((c) => c.field)).toEqual(['state']);
    expect(await listPendingAdChanges(testDb.db, as(ids.stranger))).toBeNull();
  });

  it('weist beim Vormerken und im Warenkorb auf offene Änderungen anderer an derselben Stelle hin', async () => {
    await stage(ids.emil, [update('target', ids.target, 'bid', '0.60')]);

    const result = await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('target', ids.target, 'state', 'PAUSED'),
    ]);

    expect(result.results.map((r) => (r.outcome === 'created' ? r.otherUsers : null))).toEqual([
      1, 0,
    ]);
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    const byField = Object.fromEntries(cart!.map((c) => [c.field, c.otherUsers]));
    expect(byField).toEqual({ bid: [{ userId: ids.emil, name: 'Emil' }], state: [] });
  });

  it('nennt Profil, Kampagne, Ad Group und die Entity beim Namen', async () => {
    await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('product_ad', ids.productAd, 'state', 'PAUSED'),
      update('negative_target', ids.negative, 'state', 'ARCHIVED'),
    ]);

    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    const byType = Object.fromEntries(cart!.map((c) => [c.entityType, c]));
    expect(byType.target).toMatchObject({
      accountName: 'Nordwind DE',
      countryCode: 'DE',
      adProduct: SP,
      campaignName: 'Kampagne C1',
      adGroupName: 'AG Lampen',
      entity: { targetType: 'keyword', keywordText: 'kw T1', matchType: 'BROAD', expression: null },
    });
    expect(byType.product_ad!.entity).toEqual({ asin: 'B0TEST0001', sku: 'SKU-1' });
    expect(byType.negative_target!.entity).toMatchObject({
      targetType: 'keyword',
      keywordText: 'Gebraucht  Lampe',
      matchType: 'EXACT',
    });
  });

  it('zeigt Änderungen eines inzwischen ausgeblendeten Profils nicht mehr', async () => {
    await stage(ids.emil, [update('target', ids.target, 'bid', '0.75')]);
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, ids.de));
    try {
      expect(await listPendingAdChanges(testDb.db, as(ids.emil))).toEqual([]);
    } finally {
      await testDb.db
        .update(amazonAdsProfiles)
        .set({ isHidden: false })
        .where(eq(amazonAdsProfiles.id, ids.de));
    }
  });
});

describe('discardPendingAdChanges', () => {
  it('verwirft die genannten eigenen Änderungen und schreibt ein Audit-Event', async () => {
    const staged = await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('campaign', ids.campaign, 'state', 'PAUSED'),
    ]);
    const bidId = (staged.results[0] as { changeId: string }).changeId;
    await testDb.db.delete(auditEvents);

    const discarded = await discardPendingAdChanges(testDb.db, {
      ...as(ids.ada),
      changeIds: [bidId],
    });

    expect(discarded).toBe(1);
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart!.map((c) => c.field)).toEqual(['state']);
    expect(await auditActions()).toEqual([
      {
        action: 'ad_changes.discard',
        target: expect.objectContaining({ type: 'ad_changes', discarded: 1 }),
      },
    ]);
  });

  it('verwirft ohne Angabe den ganzen eigenen Warenkorb, nie den eines anderen', async () => {
    await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('campaign', ids.campaign, 'state', 'PAUSED'),
    ]);
    const emil = await stage(ids.emil, [update('target', ids.target, 'bid', '0.60')]);
    const emilId = (emil.results[0] as { changeId: string }).changeId;

    expect(await discardPendingAdChanges(testDb.db, { ...as(ids.ada), changeIds: [emilId] })).toBe(
      0,
    );
    expect(await discardPendingAdChanges(testDb.db, as(ids.ada))).toBe(2);

    expect(await listPendingAdChanges(testDb.db, as(ids.emil))).toHaveLength(1);
    expect(await discardPendingAdChanges(testDb.db, as(ids.stranger))).toBeNull();
  });
});

describe('submitAdChanges', () => {
  it('bildet je Profil eine Übermittlung und nimmt die Änderungen aus dem Warenkorb', async () => {
    await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('campaign', ids.campaign, 'state', 'PAUSED'),
      update('target', ids.fileTarget, 'bid', '1.30'),
    ]);

    const result = await submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'bulk_file',
      enqueue: noEnqueue,
    });

    expect(result!.submissions).toHaveLength(2);
    const byProfile = Object.fromEntries(result!.submissions.map((s) => [s.profileId, s]));
    expect(byProfile[ids.de]).toMatchObject({
      channel: 'bulk_file',
      status: 'pending',
      createdBy: ids.ada,
      changes: 2,
    });
    expect(byProfile[ids.file]).toMatchObject({ changes: 1 });
    expect(await listPendingAdChanges(testDb.db, as(ids.ada))).toEqual([]);
    const rows = await testDb.db.select().from(adChanges);
    expect(rows.every((row) => row.status === 'submitted' && row.submissionId !== null)).toBe(true);
  });

  it('schreibt je Übermittlung ein Audit-Event und plant in derselben Transaktion ein', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);
    await testDb.db.delete(auditEvents);
    const enqueued: string[][] = [];

    const result = await submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'api',
      enqueue: async (tx, submissions) => {
        // In der Transaktion sind die Übermittlungen schon sichtbar.
        const seen = await tx.select({ id: adChangeSubmissions.id }).from(adChangeSubmissions);
        expect(seen).toHaveLength(submissions.length);
        enqueued.push(submissions.map((s) => s.id));
      },
    });

    const submissionId = result!.submissions[0]!.id;
    expect(enqueued).toEqual([[submissionId]]);
    expect(await auditActions()).toEqual([
      {
        action: 'ad_change_submission.create',
        target: expect.objectContaining({
          type: 'ad_change_submission',
          id: submissionId,
          profileId: ids.de,
          channel: 'api',
          changes: 1,
        }),
      },
    ]);
  });

  it('rollt alles zurück, wenn das Einplanen scheitert', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);

    await expect(
      submitAdChanges(testDb.db, {
        ...as(ids.ada),
        channel: 'api',
        enqueue: async () => {
          throw new Error('Queue nicht erreichbar');
        },
      }),
    ).rejects.toThrow('Queue nicht erreichbar');

    expect(await testDb.db.select().from(adChangeSubmissions)).toHaveLength(0);
    expect(await listPendingAdChanges(testDb.db, as(ids.ada))).toHaveLength(1);
  });

  it('liest „vorher“ beim Übermitteln neu', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);
    await testDb.db
      .update(amazonAdsTargets)
      .set({ bid: '0.55' })
      .where(eq(amazonAdsTargets.id, ids.target));
    try {
      const result = await submitAdChanges(testDb.db, {
        ...as(ids.ada),
        channel: 'api',
        enqueue: noEnqueue,
      });

      const detail = await getAdChangeSubmission(testDb.db, {
        ...as(ids.ada),
        submissionId: result!.submissions[0]!.id,
      });
      expect(detail!.changes.map((c) => [c.before, c.after])).toEqual([['0.55', '0.75']]);
    } finally {
      await testDb.db
        .update(amazonAdsTargets)
        .set({ bid: '0.50' })
        .where(eq(amazonAdsTargets.id, ids.target));
    }
  });

  it('lässt Änderungen fallen, deren Wert inzwischen dem Stand der Entity entspricht', async () => {
    await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('campaign', ids.campaign, 'state', 'PAUSED'),
    ]);
    await testDb.db
      .update(amazonAdsTargets)
      .set({ bid: '0.75' })
      .where(eq(amazonAdsTargets.id, ids.target));
    try {
      const result = await submitAdChanges(testDb.db, {
        ...as(ids.ada),
        channel: 'api',
        enqueue: noEnqueue,
      });

      expect(result).toMatchObject({ dropped: 1, blocked: [] });
      expect(result!.submissions.map((s) => s.changes)).toEqual([1]);
      expect(await testDb.db.select().from(adChanges)).toHaveLength(1);
    } finally {
      await testDb.db
        .update(amazonAdsTargets)
        .set({ bid: '0.50' })
        .where(eq(amazonAdsTargets.id, ids.target));
    }
  });

  it('lässt Änderungen im Warenkorb, die sich nicht mehr übermitteln lassen, und nennt den Grund', async () => {
    const staged = await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('ad_group', ids.adGroup, 'default_bid', '0.45'),
    ]);
    const bidId = (staged.results[0] as { changeId: string }).changeId;
    await testDb.db
      .update(amazonAdsTargets)
      .set({ state: 'ARCHIVED' })
      .where(eq(amazonAdsTargets.id, ids.target));
    try {
      const result = await submitAdChanges(testDb.db, {
        ...as(ids.ada),
        channel: 'api',
        enqueue: noEnqueue,
      });

      expect(result!.blocked).toEqual([{ changeId: bidId, reason: 'entityArchived' }]);
      expect(result!.submissions.map((s) => s.changes)).toEqual([1]);
      const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
      expect(cart!.map((c) => c.id)).toEqual([bidId]);
    } finally {
      await testDb.db
        .update(amazonAdsTargets)
        .set({ state: 'ENABLED' })
        .where(eq(amazonAdsTargets.id, ids.target));
    }
  });

  it('lässt ein vorgemerktes Negative im Warenkorb, wenn es das Negative inzwischen gibt', async () => {
    const staged = await stage(ids.ada, [negativeKeyword('neu negiert')]);
    const changeId = (staged.results[0] as { changeId: string }).changeId;
    const [existing] = await testDb.db
      .insert(amazonAdsNegativeTargets)
      .values({
        organizationId: ids.org,
        profileId: ids.de,
        level: 'ad_group',
        campaignId: ids.campaign,
        adGroupId: ids.adGroup,
        amazonTargetId: 'N-NEU',
        adProduct: SP,
        targetType: 'keyword',
        keywordText: 'Neu Negiert',
        matchType: 'NEGATIVE_EXACT',
        state: 'ENABLED',
      })
      .returning({ id: amazonAdsNegativeTargets.id });
    try {
      const result = await submitAdChanges(testDb.db, {
        ...as(ids.ada),
        channel: 'api',
        enqueue: noEnqueue,
      });

      expect(result).toEqual({
        submissions: [],
        dropped: 0,
        blocked: [{ changeId, reason: 'alreadyExists' }],
        review: null,
      });
    } finally {
      await testDb.db
        .delete(amazonAdsNegativeTargets)
        .where(eq(amazonAdsNegativeTargets.id, existing!.id));
    }
  });

  it('plant für Bulk-Dateien keinen Job ein', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);
    let enqueued = 0;

    const result = await submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'bulk_file',
      enqueue: async () => {
        enqueued += 1;
      },
    });

    expect(result!.submissions).toHaveLength(1);
    expect(enqueued).toBe(0);
  });

  it('übermittelt Profile ohne Connection nicht über die API und lässt dann alles im Warenkorb', async () => {
    await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('target', ids.fileTarget, 'bid', '1.30'),
    ]);

    const attempt = submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'api',
      enqueue: noEnqueue,
    });

    await expect(attempt).rejects.toBeInstanceOf(AdChangeError);
    await expect(attempt).rejects.toMatchObject({ code: 'PROFILE_HAS_NO_CONNECTION' });
    expect(await testDb.db.select().from(adChangeSubmissions)).toHaveLength(0);
    expect(await listPendingAdChanges(testDb.db, as(ids.ada))).toHaveLength(2);
  });

  it('übermittelt auf Wunsch nur ein Profil oder nur genannte Änderungen', async () => {
    const staged = await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('campaign', ids.campaign, 'state', 'PAUSED'),
      update('target', ids.fileTarget, 'bid', '1.30'),
    ]);
    const stateId = (staged.results[1] as { changeId: string }).changeId;

    const onlyProfile = await submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'bulk_file',
      profileId: ids.file,
      enqueue: noEnqueue,
    });
    const onlyChange = await submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'api',
      changeIds: [stateId],
      enqueue: noEnqueue,
    });

    expect(onlyProfile!.submissions.map((s) => [s.profileId, s.changes])).toEqual([[ids.file, 1]]);
    expect(onlyChange!.submissions.map((s) => [s.profileId, s.changes])).toEqual([[ids.de, 1]]);
    const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
    expect(cart!.map((c) => c.field)).toEqual(['bid']);
  });

  it('übermittelt nie die Änderungen eines anderen Nutzers', async () => {
    const emil = await stage(ids.emil, [update('target', ids.target, 'bid', '0.60')]);
    const emilId = (emil.results[0] as { changeId: string }).changeId;

    const result = await submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'api',
      changeIds: [emilId],
      enqueue: noEnqueue,
    });

    expect(result).toEqual({ submissions: [], dropped: 0, blocked: [], review: null });
    expect(await listPendingAdChanges(testDb.db, as(ids.emil))).toHaveLength(1);
  });

  it('übermittelt ein vorgemerktes Negative unverändert', async () => {
    await stage(ids.ada, [negativeKeyword('kinder lampe')]);

    const result = await submitAdChanges(testDb.db, {
      ...as(ids.ada),
      channel: 'bulk_file',
      enqueue: noEnqueue,
    });

    const detail = await getAdChangeSubmission(testDb.db, {
      ...as(ids.ada),
      submissionId: result!.submissions[0]!.id,
    });
    expect(detail!.changes[0]).toMatchObject({
      status: 'submitted',
      operation: 'create',
      negative: { type: 'keyword', keywordText: 'kinder lampe', matchType: 'EXACT' },
    });
  });

  it('liefert `null` für Nicht-Mitglieder', async () => {
    expect(
      await submitAdChanges(testDb.db, { ...as(ids.stranger), channel: 'api', enqueue: noEnqueue }),
    ).toBeNull();
  });
});

describe('Übermittlungen lesen', () => {
  async function submitOne(
    userId: string,
    change: AdChangeInput,
    channel: 'api' | 'bulk_file' = 'api',
  ) {
    await stage(userId, [change]);
    const result = await submitAdChanges(testDb.db, { ...as(userId), channel, enqueue: noEnqueue });
    return result!.submissions[0]!.id;
  }

  it('zeigt der ganzen Organisation die Übermittlungen, neueste zuerst, mit Zählern je Status', async () => {
    const first = await submitOne(ids.ada, update('target', ids.target, 'bid', '0.75'));
    const second = await submitOne(
      ids.emil,
      update('target', ids.fileTarget, 'bid', '1.30'),
      'bulk_file',
    );
    await testDb.db
      .update(adChangeSubmissions)
      .set({ createdAt: new Date('2026-10-01T08:00:00Z') })
      .where(eq(adChangeSubmissions.id, first));

    const list = await listAdChangeSubmissions(testDb.db, as(ids.emil));

    expect(list!.map((s) => s.id)).toEqual([second, first]);
    expect(list![1]).toMatchObject({
      profileId: ids.de,
      accountName: 'Nordwind DE',
      countryCode: 'DE',
      channel: 'api',
      status: 'pending',
      createdBy: ids.ada,
      createdByName: 'Ada',
      changes: 1,
      counts: { submitted: 1, applied: 0, failed: 0, dismissed: 0 },
    });
  });

  it('zeigt Übermittlungen fremder Organisationen und ausgeblendeter Profile nicht', async () => {
    const submissionId = await submitOne(ids.ada, update('target', ids.target, 'bid', '0.75'));

    expect(await listAdChangeSubmissions(testDb.db, as(ids.otto, ids.otherOrg))).toEqual([]);
    expect(await listAdChangeSubmissions(testDb.db, as(ids.otto))).toBeNull();
    expect(
      await getAdChangeSubmission(testDb.db, { ...as(ids.otto, ids.otherOrg), submissionId }),
    ).toBeNull();

    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, ids.de));
    try {
      expect(await listAdChangeSubmissions(testDb.db, as(ids.emil))).toEqual([]);
      expect(await getAdChangeSubmission(testDb.db, { ...as(ids.emil), submissionId })).toBeNull();
    } finally {
      await testDb.db
        .update(amazonAdsProfiles)
        .set({ isHidden: false })
        .where(eq(amazonAdsProfiles.id, ids.de));
    }
  });

  it('liefert eine Übermittlung mit ihren Änderungen und deren Namen', async () => {
    const submissionId = await submitOne(ids.ada, update('target', ids.target, 'bid', '0.75'));

    const detail = await getAdChangeSubmission(testDb.db, { ...as(ids.emil), submissionId });

    expect(detail!.submission).toMatchObject({ id: submissionId, changes: 1 });
    expect(detail!.changes).toHaveLength(1);
    expect(detail!.changes[0]).toMatchObject({
      status: 'submitted',
      submissionId,
      campaignName: 'Kampagne C1',
      before: '0.50',
      after: '0.75',
      errorCode: null,
      errorMessage: null,
      amazonEntityId: null,
    });
  });
});

describe('Schema', () => {
  it('lässt je Nutzer, Stelle und Feld nur eine offene Änderung zu', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);
    const [row] = await testDb.db.select().from(adChanges);
    const { id: _id, ...copy } = row!;

    await expect(testDb.db.insert(adChanges).values(copy)).rejects.toMatchObject({
      cause: { constraint_name: 'ad_changes_pending_uq' },
    });
  });

  it('verlangt bei Feldänderungen genau einen neuen Wert passend zur Art', async () => {
    await stage(ids.ada, [update('target', ids.target, 'bid', '0.75')]);
    const [row] = await testDb.db.select().from(adChanges);

    await expect(
      testDb.db.update(adChanges).set({ newValue: 'PAUSED' }).where(eq(adChanges.id, row!.id)),
    ).rejects.toMatchObject({ cause: { constraint_name: 'ad_changes_operation_ck' } });
    await expect(
      testDb.db
        .update(adChanges)
        .set({ newValue: 'PAUSED', newAmount: null })
        .where(eq(adChanges.id, row!.id)),
    ).rejects.toMatchObject({ cause: { constraint_name: 'ad_changes_value_kind_ck' } });
    await expect(
      testDb.db.update(adChanges).set({ status: 'submitted' }).where(eq(adChanges.id, row!.id)),
    ).rejects.toMatchObject({ cause: { constraint_name: 'ad_changes_pending_ck' } });
  });

  it('löscht eine Organisation samt Änderungen und Übermittlungen', async () => {
    const { db } = testDb;
    const org = await createTestOrganization(db, 'wegwerf');
    const [user] = await db
      .insert(users)
      .values({ name: 'Weg', email: 'weg@wegwerf.test' })
      .returning({ id: users.id });
    await db
      .insert(members)
      .values({ organizationId: org, userId: user!.id, role: 'admin', createdAt: new Date() });
    const [profile] = await db
      .insert(amazonAdsProfiles)
      .values({
        organizationId: org,
        connectionId: null,
        amazonProfileId: null,
        accountName: 'Wegwerf',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
        accountType: 'seller',
      })
      .returning({ id: amazonAdsProfiles.id });
    const [campaign] = await db
      .insert(amazonAdsCampaigns)
      .values({
        organizationId: org,
        profileId: profile!.id,
        amazonCampaignId: 'W1',
        adProduct: SP,
        name: 'Wegwerf',
        state: 'ENABLED',
      })
      .returning({ id: amazonAdsCampaigns.id });
    const actor = { userId: user!.id, orgId: org };
    await stageAdChanges(db, {
      ...actor,
      origin: 'explorer',
      changes: [
        update('campaign', campaign!.id, 'state', 'PAUSED'),
        {
          operation: 'create_negative',
          campaignId: campaign!.id,
          adGroupId: null,
          negative: { type: 'keyword', keywordText: 'weg', matchType: 'EXACT' },
        },
      ],
    });
    await submitAdChanges(db, { ...actor, channel: 'bulk_file', enqueue: noEnqueue });

    await db.delete(organizations).where(eq(organizations.id, org));

    expect(await db.select().from(adChanges).where(eq(adChanges.organizationId, org))).toHaveLength(
      0,
    );
    expect(
      await db
        .select()
        .from(adChangeSubmissions)
        .where(eq(adChangeSubmissions.organizationId, org)),
    ).toHaveLength(0);
  });
});

describe('submitAdChanges: Prüfung in der Transaktion (3.4)', () => {
  it('prüft mit dem neu gelesenen „vorher“ und übermittelt nichts, wenn die Prüfung etwas meldet', async () => {
    const staged = await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      negativeKeyword('ganz neu'),
    ]);
    // Seit dem Vormerken hat ein Sync das Gebot geändert.
    await testDb.db
      .update(amazonAdsTargets)
      .set({ bid: '0.30' })
      .where(eq(amazonAdsTargets.id, ids.target));
    try {
      const seen: unknown[] = [];
      const result = await submitAdChanges(testDb.db, {
        ...as(ids.ada),
        channel: 'api',
        enqueue: noEnqueue,
        review: (rows) => {
          seen.push(...rows);
          return 'abgelehnt';
        },
      });

      expect(result).toMatchObject({ submissions: [], review: 'abgelehnt' });
      expect(seen).toHaveLength(2);
      expect(seen).toContainEqual({
        id: (staged.results[0] as { changeId: string }).changeId,
        profileId: ids.de,
        field: 'bid',
        before: '0.30',
        comparisonBefore: null,
        after: '0.75',
        adProduct: SP,
        countryCode: 'DE',
        negative: null,
      });
      expect(seen).toContainEqual(
        expect.objectContaining({
          field: null,
          adProduct: SP,
          countryCode: 'DE',
          negative: { type: 'keyword', keywordText: 'ganz neu', matchType: 'EXACT' },
        }),
      );
      // Alles zurückgerollt: Der Warenkorb ist unverändert, es gibt keine Übermittlung.
      const cart = await listPendingAdChanges(testDb.db, as(ids.ada));
      expect(cart).toHaveLength(2);
      expect(cart!.find((change) => change.field === 'bid')).toMatchObject({ before: '0.50' });
      expect(await testDb.db.select().from(adChangeSubmissions)).toEqual([]);
    } finally {
      await testDb.db
        .update(amazonAdsTargets)
        .set({ bid: '0.50' })
        .where(eq(amazonAdsTargets.id, ids.target));
    }
  });

  it('übermittelt, wenn die Prüfung nichts meldet, und prüft nur, was übermittelt wird', async () => {
    await stage(ids.ada, [
      update('target', ids.target, 'bid', '0.75'),
      update('campaign', ids.campaign, 'budget', '25'),
    ]);
    // Das Budget steht inzwischen auf dem Wunschwert: Die Änderung entfällt und wird nicht geprüft.
    await testDb.db
      .update(amazonAdsCampaigns)
      .set({ budgetAmount: '25' })
      .where(eq(amazonAdsCampaigns.id, ids.campaign));
    try {
      let count = 0;
      const result = await submitAdChanges(testDb.db, {
        ...as(ids.ada),
        channel: 'api',
        enqueue: noEnqueue,
        review: (rows) => {
          count = rows.length;
          return null;
        },
      });
      expect(count).toBe(1);
      expect(result).toMatchObject({ dropped: 1, review: null });
      expect(result!.submissions).toHaveLength(1);
    } finally {
      await testDb.db
        .update(amazonAdsCampaigns)
        .set({ budgetAmount: '20' })
        .where(eq(amazonAdsCampaigns.id, ids.campaign));
    }
  });
});
