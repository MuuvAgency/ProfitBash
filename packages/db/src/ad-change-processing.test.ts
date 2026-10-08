import type { AdChangeChannel, AdChangeInput } from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import {
  claimNextAdChangeSubmission,
  confirmBulkFileAdChanges,
  failOpenAdChangeSubmissions,
  finishAdChangeSubmission,
  listConnectionsWithOpenAdChangeSubmissions,
  prepareAdChangeSubmission,
  recordAdChangeResults,
} from './ad-change-processing';
import { stageAdChanges, submitAdChanges } from './ad-changes';
import {
  adChangeSubmissions,
  adChanges,
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProductAds,
  amazonAdsTargets,
  auditEvents,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Verarbeitung der Übermittlungen durch den Job und Bestätigung durch den Import (`phase-3.md` 3.3). */

let testDb: TestDatabase;
let f: AdChangeFixture;
let other: AdChangeFixture;
const NOW = new Date('2026-10-08T12:00:00Z');
const RUN = '00000000-0000-4000-8000-000000000001';

const update = (
  entityType: Extract<AdChangeInput, { operation: 'update' }>['entityType'],
  entityId: string,
  field: Extract<AdChangeInput, { operation: 'update' }>['field'],
  value: string,
): AdChangeInput => ({ operation: 'update', entityType, entityId, field, value });

const negative = (keywordText: string, adGroupId: string | null = null): AdChangeInput => ({
  operation: 'create_negative',
  campaignId: f.campaign,
  adGroupId: adGroupId === null ? f.adGroup : adGroupId,
  negative: { type: 'keyword', keywordText, matchType: 'EXACT' },
});

/** Legt die Änderungen in den Warenkorb und übermittelt sie; liefert Übermittlung und Änderungen in Eingabe-Reihenfolge. */
async function submit(
  changes: AdChangeInput[],
  channel: AdChangeChannel = 'api',
  fixture: AdChangeFixture = f,
) {
  const actor = { userId: fixture.ada, orgId: fixture.org };
  const staged = await stageAdChanges(testDb.db, { ...actor, origin: 'explorer', changes });
  const changeIds = staged!.results.map((result) =>
    'changeId' in result ? result.changeId : 'abgelehnt',
  );
  const result = await submitAdChanges(testDb.db, { ...actor, channel, enqueue: async () => {} });
  return { submissionId: result!.submissions[0]!.id, changeIds };
}

const claim = (fixture: AdChangeFixture = f) =>
  claimNextAdChangeSubmission(testDb.db, {
    organizationId: fixture.org,
    connectionId: fixture.connection,
    jobRunId: RUN,
    now: NOW,
  });

async function changeRow(id: string) {
  const [row] = await testDb.db.select().from(adChanges).where(eq(adChanges.id, id));
  return row!;
}

async function submissionRow(id: string) {
  const [row] = await testDb.db
    .select()
    .from(adChangeSubmissions)
    .where(eq(adChangeSubmissions.id, id));
  return row!;
}

const record = (
  submissionId: string,
  results: Parameters<typeof recordAdChangeResults>[1]['results'],
) => recordAdChangeResults(testDb.db, { organizationId: f.org, submissionId, now: NOW, results });

beforeAll(async () => {
  testDb = await createTestDatabase();
  f = await seedAdChangeFixture(testDb.db, 'muuv');
  other = await seedAdChangeFixture(testDb.db, 'andere');
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(adChanges);
  await db.delete(adChangeSubmissions);
  await db.delete(auditEvents);
  // Stand der Entities zurücksetzen (die Tests ziehen ihn nach).
  await db.update(amazonAdsTargets).set({ state: 'ENABLED', removedAt: null });
  await db.update(amazonAdsTargets).set({ bid: '0.50' }).where(eq(amazonAdsTargets.id, f.keyword));
  await db
    .update(amazonAdsTargets)
    .set({ bid: null, bidCurrencyCode: null })
    .where(eq(amazonAdsTargets.id, f.productTarget));
  await db.update(amazonAdsCampaigns).set({
    state: 'ENABLED',
    budgetAmount: '20',
    biddingStrategy: 'SALES_DOWN_ONLY',
    extra: { placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: '50' }] },
  });
  await db.update(amazonAdsAdGroups).set({ state: 'ENABLED', defaultBid: '0.40' });
  await db.update(amazonAdsProductAds).set({ state: 'ENABLED' });
  await db
    .delete(amazonAdsNegativeTargets)
    .where(eq(amazonAdsNegativeTargets.amazonTargetId, '880000000001'));
  await db.update(amazonAdsNegativeTargets).set({ state: 'ENABLED', removedAt: null });
});

afterAll(async () => {
  await testDb?.close();
});

describe('claimNextAdChangeSubmission', () => {
  it('holt die älteste offene Übermittlung der Connection über die API ab', async () => {
    const first = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await submit([update('campaign', f.campaign, 'budget', '25')]);

    const claimed = await claim();

    expect(claimed).toEqual({
      id: first.submissionId,
      profileId: f.profile,
      amazonProfileId: '111',
      attempts: 1,
    });
    expect(await submissionRow(first.submissionId)).toMatchObject({
      status: 'running',
      attempts: 1,
      jobRunId: RUN,
      startedAt: NOW,
    });
  });

  it('übergeht Bulk-Dateien, andere Connections und ausgeschlossene Übermittlungen', async () => {
    await submit([update('target', f.fileKeyword, 'bid', '0.75')], 'bulk_file');
    await submit([update('target', other.keyword, 'bid', '0.75')], 'api', other);
    expect(await claim()).toBeNull();

    const mine = await submit([update('target', f.keyword, 'bid', '0.75')]);
    expect(
      await claimNextAdChangeSubmission(testDb.db, {
        organizationId: f.org,
        connectionId: f.connection,
        jobRunId: RUN,
        now: NOW,
        excludeIds: [mine.submissionId],
      }),
    ).toBeNull();
  });

  it('nimmt eine unterbrochene Übermittlung wieder auf und lässt unklare Anlagen scheitern', async () => {
    const { submissionId, changeIds } = await submit([
      update('target', f.keyword, 'bid', '0.75'),
      negative('gratis'),
    ]);
    await claim();

    const again = await claim();

    expect(again).toMatchObject({ id: submissionId, attempts: 2 });
    expect(await changeRow(changeIds[0]!)).toMatchObject({ status: 'submitted' });
    expect(await changeRow(changeIds[1]!)).toMatchObject({
      status: 'failed',
      errorCode: 'UNKNOWN_OUTCOME',
      resolvedAt: NOW,
    });
  });
});

describe('prepareAdChangeSubmission', () => {
  it('liefert die Änderungen mit Amazon-IDs und dem Stand der Kampagne', async () => {
    const { submissionId, changeIds } = await submit([
      update('target', f.productTarget, 'bid', '0.60'),
      update('campaign', f.campaign, 'placement_product_page', '30'),
      update('negative_target', f.campaignNegativeProduct, 'state', 'ARCHIVED'),
      negative('gratis'),
    ]);

    const found = await prepareAdChangeSubmission(testDb.db, {
      organizationId: f.org,
      submissionId,
    });

    // Gemeinsam vorgemerkte Änderungen haben denselben Zeitpunkt: nach der Eingabe ordnen.
    const rows = changeIds.map((id) => found.find((row) => row.id === id));
    expect(found).toHaveLength(4);
    expect(rows[0]).toMatchObject({
      operation: 'update',
      entityType: 'target',
      field: 'bid',
      after: '0.60',
      adProduct: 'SPONSORED_PRODUCTS',
      amazonCampaignId: '1001',
      amazonAdGroupId: '2001',
      amazonEntityId: '3002',
      targetType: 'product',
      entityRemoved: false,
    });
    expect(rows[1]).toMatchObject({
      entityType: 'campaign',
      amazonEntityId: '1001',
      amazonAdGroupId: null,
      campaignBiddingStrategy: 'SALES_DOWN_ONLY',
      campaignPlacements: [{ placement: 'PLACEMENT_TOP', percentage: '50' }],
    });
    expect(rows[2]).toMatchObject({
      amazonEntityId: '5002',
      targetType: 'product',
      negativeLevel: 'campaign',
    });
    expect(rows[3]).toMatchObject({
      operation: 'create',
      amazonEntityId: null,
      amazonAdGroupId: '2001',
      negative: { type: 'keyword', keywordText: 'gratis', matchType: 'EXACT' },
    });
  });

  it('setzt „vorher“ endgültig auf den Stand der Entity beim Anwenden', async () => {
    const { submissionId, changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    // Eine frühere Übermittlung hat das Gebot inzwischen geändert.
    await testDb.db
      .update(amazonAdsTargets)
      .set({ bid: '0.65' })
      .where(eq(amazonAdsTargets.id, f.keyword));

    await prepareAdChangeSubmission(testDb.db, { organizationId: f.org, submissionId });

    expect(await changeRow(changeIds[0]!)).toMatchObject({ oldAmount: '0.65', newAmount: '0.75' });
  });

  it('behält „vorher“, wenn der Stand schon dem neuen Wert entspricht (Wiederaufnahme nach einem Sync)', async () => {
    const { submissionId, changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await testDb.db
      .update(amazonAdsTargets)
      .set({ bid: '0.75' })
      .where(eq(amazonAdsTargets.id, f.keyword));

    await prepareAdChangeSubmission(testDb.db, { organizationId: f.org, submissionId });

    expect(await changeRow(changeIds[0]!)).toMatchObject({ oldAmount: '0.50', newAmount: '0.75' });
  });

  it('meldet entfernte Entities und liest nur Übermittlungen der Organisation', async () => {
    const { submissionId } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await testDb.db
      .update(amazonAdsTargets)
      .set({ removedAt: NOW })
      .where(eq(amazonAdsTargets.id, f.keyword));

    const rows = await prepareAdChangeSubmission(testDb.db, {
      organizationId: f.org,
      submissionId,
    });
    expect(rows[0]).toMatchObject({ entityRemoved: true });
    expect(
      await prepareAdChangeSubmission(testDb.db, { organizationId: other.org, submissionId }),
    ).toEqual([]);
  });
});

describe('recordAdChangeResults', () => {
  it('hält Erfolg fest und zieht Gebot, Budget, Zustand und Strategie nach', async () => {
    const { submissionId, changeIds } = await submit([
      update('target', f.keyword, 'bid', '0.75'),
      update('target', f.productTarget, 'bid', '0.60'),
      update('campaign', f.campaign, 'budget', '25.50'),
      update('campaign', f.campaign, 'state', 'PAUSED'),
      update('campaign', f.campaign, 'bidding_strategy', 'NONE'),
      update('ad_group', f.adGroup, 'default_bid', '0.45'),
      update('product_ad', f.productAd, 'state', 'PAUSED'),
      update('negative_target', f.negativeKeyword, 'state', 'ARCHIVED'),
    ]);

    const counts = await record(
      submissionId,
      changeIds.map((changeId) => ({ changeId, outcome: 'applied', amazonEntityId: null })),
    );

    expect(counts).toEqual({ applied: 8, failed: 0 });
    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'applied',
      resolvedAt: NOW,
      errorCode: null,
    });
    const { db } = testDb;
    const [keyword] = await db
      .select()
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.id, f.keyword));
    expect(keyword).toMatchObject({ bid: '0.75', bidCurrencyCode: 'EUR' });
    const [productTarget] = await db
      .select()
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.id, f.productTarget));
    // Ein Target ohne eigenes Gebot bekommt mit dem Gebot auch die Währung.
    expect(productTarget).toMatchObject({ bid: '0.60', bidCurrencyCode: 'EUR' });
    const [campaign] = await db
      .select()
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.id, f.campaign));
    expect(campaign).toMatchObject({
      budgetAmount: '25.50',
      state: 'PAUSED',
      biddingStrategy: 'NONE',
    });
    const [adGroup] = await db
      .select()
      .from(amazonAdsAdGroups)
      .where(eq(amazonAdsAdGroups.id, f.adGroup));
    expect(adGroup).toMatchObject({ defaultBid: '0.45' });
    const [productAd] = await db
      .select()
      .from(amazonAdsProductAds)
      .where(eq(amazonAdsProductAds.id, f.productAd));
    expect(productAd).toMatchObject({ state: 'PAUSED' });
    const [negativeRow] = await db
      .select()
      .from(amazonAdsNegativeTargets)
      .where(eq(amazonAdsNegativeTargets.id, f.negativeKeyword));
    expect(negativeRow).toMatchObject({ state: 'ARCHIVED' });
  });

  it('zieht Platzierungen in extra nach: vorhandene ersetzt, neue ergänzt, übrige Felder bleiben', async () => {
    await testDb.db
      .update(amazonAdsCampaigns)
      .set({
        extra: {
          deliveryStatus: 'DELIVERING',
          placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: 50 }],
        },
      })
      .where(eq(amazonAdsCampaigns.id, f.campaign));
    const { submissionId, changeIds } = await submit([
      update('campaign', f.campaign, 'placement_top', '80'),
      update('campaign', f.campaign, 'placement_product_page', '30'),
    ]);

    await record(
      submissionId,
      changeIds.map((changeId) => ({ changeId, outcome: 'applied', amazonEntityId: null })),
    );

    const [campaign] = await testDb.db
      .select({ extra: amazonAdsCampaigns.extra })
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.id, f.campaign));
    expect(campaign!.extra).toEqual({
      deliveryStatus: 'DELIVERING',
      placementBidAdjustments: [
        { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: '30' },
        { placement: 'PLACEMENT_TOP', percentage: '80' },
      ],
    });
  });

  it('trägt die neue Amazon-ID ein und legt das Negative als Entity an', async () => {
    const { submissionId, changeIds } = await submit([negative('Gratis')]);

    await record(submissionId, [
      { changeId: changeIds[0]!, outcome: 'applied', amazonEntityId: '880000000001' },
    ]);

    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'applied',
      amazonEntityId: '880000000001',
    });
    const [created] = await testDb.db
      .select()
      .from(amazonAdsNegativeTargets)
      .where(eq(amazonAdsNegativeTargets.amazonTargetId, '880000000001'));
    expect(created).toMatchObject({
      organizationId: f.org,
      profileId: f.profile,
      level: 'ad_group',
      campaignId: f.campaign,
      adGroupId: f.adGroup,
      adProduct: 'SPONSORED_PRODUCTS',
      targetType: 'keyword',
      keywordText: 'Gratis',
      matchType: 'EXACT',
      state: 'ENABLED',
    });
  });

  it('hält Fehler mit Code und Text fest und lässt die Entity unberührt', async () => {
    const { submissionId, changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);

    const counts = await record(submissionId, [
      {
        changeId: changeIds[0]!,
        outcome: 'failed',
        code: 'BID_OUT_OF_MARKET_PLACE_RANGE',
        message: 'Gebot zu niedrig.',
      },
    ]);

    expect(counts).toEqual({ applied: 0, failed: 1 });
    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'BID_OUT_OF_MARKET_PLACE_RANGE',
      errorMessage: 'Gebot zu niedrig.',
      resolvedAt: NOW,
    });
    const [keyword] = await testDb.db
      .select({ bid: amazonAdsTargets.bid })
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.id, f.keyword));
    expect(keyword!.bid).toBe('0.50');
  });

  it('übergeht Änderungen anderer Übermittlungen und schon abgeschlossene', async () => {
    const first = await submit([update('target', f.keyword, 'bid', '0.75')]);
    const second = await submit([update('campaign', f.campaign, 'budget', '25')]);
    await record(first.submissionId, [
      { changeId: first.changeIds[0]!, outcome: 'failed', code: 'X', message: 'x' },
    ]);

    const counts = await record(first.submissionId, [
      { changeId: first.changeIds[0]!, outcome: 'applied', amazonEntityId: null },
      { changeId: second.changeIds[0]!, outcome: 'applied', amazonEntityId: null },
    ]);

    expect(counts).toEqual({ applied: 0, failed: 0 });
    expect(await changeRow(first.changeIds[0]!)).toMatchObject({ status: 'failed' });
    expect(await changeRow(second.changeIds[0]!)).toMatchObject({ status: 'submitted' });
  });
});

describe('finishAdChangeSubmission', () => {
  it('schließt ab, wenn jede Änderung ein Ergebnis hat', async () => {
    const { submissionId, changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await claim();
    await record(submissionId, [
      { changeId: changeIds[0]!, outcome: 'applied', amazonEntityId: null },
    ]);

    const result = await finishAdChangeSubmission(testDb.db, {
      organizationId: f.org,
      submissionId,
      now: NOW,
    });

    expect(result).toEqual({ status: 'finished', open: 0, failed: 0 });
    expect(await submissionRow(submissionId)).toMatchObject({
      status: 'finished',
      finishedAt: NOW,
      error: null,
    });
  });

  it('stellt eine Übermittlung mit ungesendeten Änderungen zurück auf wartend', async () => {
    const { submissionId } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await claim();

    const result = await finishAdChangeSubmission(testDb.db, {
      organizationId: f.org,
      submissionId,
      now: NOW,
      error: 'Amazon drosselt, neuer Versuch folgt.',
    });

    expect(result).toEqual({ status: 'pending', open: 1, failed: 0 });
    expect(await submissionRow(submissionId)).toMatchObject({
      status: 'pending',
      finishedAt: null,
      error: 'Amazon drosselt, neuer Versuch folgt.',
    });
  });

  it('lässt auf Wunsch die offenen Änderungen und die Übermittlung scheitern', async () => {
    const { submissionId, changeIds } = await submit([
      update('target', f.keyword, 'bid', '0.75'),
      update('campaign', f.campaign, 'budget', '25'),
    ]);
    await claim();
    await record(submissionId, [
      { changeId: changeIds[0]!, outcome: 'applied', amazonEntityId: null },
    ]);

    const result = await finishAdChangeSubmission(testDb.db, {
      organizationId: f.org,
      submissionId,
      now: NOW,
      error: 'Kein Zugriff auf das Profil.',
      failRemaining: { code: 'NOT_SENT', message: 'Nicht gesendet: kein Zugriff.' },
    });

    expect(result).toEqual({ status: 'failed', open: 0, failed: 1 });
    expect(await changeRow(changeIds[0]!)).toMatchObject({ status: 'applied' });
    expect(await changeRow(changeIds[1]!)).toMatchObject({
      status: 'failed',
      errorCode: 'NOT_SENT',
      errorMessage: 'Nicht gesendet: kein Zugriff.',
    });
    expect(await submissionRow(submissionId)).toMatchObject({
      status: 'failed',
      error: 'Kein Zugriff auf das Profil.',
      finishedAt: NOW,
    });
  });
});

describe('offene Übermittlungen je Connection', () => {
  it('nennt Connections mit offenen API-Übermittlungen', async () => {
    await submit([update('target', f.fileKeyword, 'bid', '0.75')], 'bulk_file');
    expect(await listConnectionsWithOpenAdChangeSubmissions(testDb.db)).toEqual([]);

    await submit([update('target', f.keyword, 'bid', '0.75')]);
    expect(await listConnectionsWithOpenAdChangeSubmissions(testDb.db)).toEqual([
      { id: f.connection, organizationId: f.org },
    ]);
  });

  it('lässt alle offenen API-Übermittlungen einer Connection scheitern', async () => {
    const mine = await submit([update('target', f.keyword, 'bid', '0.75')]);
    const foreign = await submit([update('target', other.keyword, 'bid', '0.75')], 'api', other);

    const failed = await failOpenAdChangeSubmissions(testDb.db, {
      organizationId: f.org,
      connectionId: f.connection,
      now: NOW,
      error: 'Die Connection muss neu verbunden werden.',
      code: 'NOT_SENT',
      message: 'Nicht gesendet.',
    });

    expect(failed).toBe(1);
    expect(await submissionRow(mine.submissionId)).toMatchObject({ status: 'failed' });
    expect(await changeRow(mine.changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'NOT_SENT',
    });
    expect(await submissionRow(foreign.submissionId)).toMatchObject({ status: 'pending' });
  });
});

describe('failOpenAdChangeSubmissions: unterbrochene Übermittlung', () => {
  it('wertet die offenen Änderungen einer laufenden Übermittlung als unklar, nicht als ungesendet', async () => {
    const { changeIds } = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await claim();

    await failOpenAdChangeSubmissions(testDb.db, {
      organizationId: f.org,
      connectionId: f.connection,
      now: NOW,
      error: 'Die Connection muss neu verbunden werden.',
      code: 'NOT_SENT',
      message: 'Nicht gesendet.',
    });

    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'failed',
      errorCode: 'UNKNOWN_OUTCOME',
    });
  });
});

describe('confirmBulkFileAdChanges', () => {
  const confirm = (profileId = f.fileProfile) =>
    confirmBulkFileAdChanges(testDb.db, { organizationId: f.org, profileId, now: NOW });

  it('bestätigt Änderungen, deren neuer Wert dem Stand nach dem Import entspricht', async () => {
    const { submissionId, changeIds } = await submit(
      [
        update('target', f.fileKeyword, 'bid', '0.75'),
        update('campaign', f.fileCampaign, 'budget', '30'),
      ],
      'bulk_file',
    );
    // Der Import hat das Gebot aus der Werbekonsole gelesen, das Budget ist dort noch das alte.
    await testDb.db
      .update(amazonAdsTargets)
      .set({ bid: '0.750' })
      .where(eq(amazonAdsTargets.id, f.fileKeyword));

    expect(await confirm()).toEqual({ confirmed: 1, finished: 0 });

    expect(await changeRow(changeIds[0]!)).toMatchObject({ status: 'applied', resolvedAt: NOW });
    expect(await changeRow(changeIds[1]!)).toMatchObject({ status: 'submitted' });
    expect(await submissionRow(submissionId)).toMatchObject({ status: 'pending' });

    await testDb.db
      .update(amazonAdsCampaigns)
      .set({ budgetAmount: '30' })
      .where(eq(amazonAdsCampaigns.id, f.fileCampaign));
    expect(await confirm()).toEqual({ confirmed: 1, finished: 1 });
    expect(await submissionRow(submissionId)).toMatchObject({
      status: 'finished',
      finishedAt: NOW,
    });
  });

  it('bestätigt ein neues Negative über den Eintrag aus der Datei und merkt sich dessen ID', async () => {
    const { changeIds } = await submit(
      [
        {
          operation: 'create_negative',
          campaignId: f.fileCampaign,
          adGroupId: f.fileAdGroup,
          negative: { type: 'keyword', keywordText: 'Gratis Lampe', matchType: 'PHRASE' },
        },
      ],
      'bulk_file',
    );
    expect(await confirm()).toEqual({ confirmed: 0, finished: 0 });

    await testDb.db.insert(amazonAdsNegativeTargets).values({
      organizationId: f.org,
      profileId: f.fileProfile,
      level: 'ad_group',
      campaignId: f.fileCampaign,
      adGroupId: f.fileAdGroup,
      amazonTargetId: '880000000001',
      adProduct: 'SPONSORED_PRODUCTS',
      targetType: 'keyword',
      keywordText: 'gratis lampe',
      matchType: 'PHRASE',
      state: 'ENABLED',
    });

    expect(await confirm()).toEqual({ confirmed: 1, finished: 1 });
    expect(await changeRow(changeIds[0]!)).toMatchObject({
      status: 'applied',
      amazonEntityId: '880000000001',
    });
  });

  it('wertet eine archivierte oder aus der Datei verschwundene Entity als archiviert', async () => {
    const { changeIds } = await submit(
      [update('target', f.fileKeyword, 'state', 'ARCHIVED')],
      'bulk_file',
    );
    await testDb.db
      .update(amazonAdsTargets)
      .set({ removedAt: NOW })
      .where(eq(amazonAdsTargets.id, f.fileKeyword));

    expect(await confirm()).toEqual({ confirmed: 1, finished: 1 });
    expect(await changeRow(changeIds[0]!)).toMatchObject({ status: 'applied' });
  });

  it('lässt Übermittlungen über die API und andere Profile unberührt', async () => {
    const api = await submit([update('target', f.keyword, 'bid', '0.75')]);
    await testDb.db
      .update(amazonAdsTargets)
      .set({ bid: '0.75' })
      .where(and(eq(amazonAdsTargets.id, f.keyword)));

    expect(await confirm(f.profile)).toEqual({ confirmed: 0, finished: 0 });
    expect(await changeRow(api.changeIds[0]!)).toMatchObject({ status: 'submitted' });
  });
});
