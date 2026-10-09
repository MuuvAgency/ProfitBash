import { createMockAmazonAdsClient, createRequestMeter } from '@profitbash/amazon-ads';
import {
  createConnectionTokenStore,
  getAdChangeSubmission,
  nextAmazonRequestPollAt,
  revertAdChanges,
  saveCampaignSetupDraft,
  schema,
  stageAdChanges,
  submitAdChanges,
  submitCampaignSetupDraft,
} from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import type { AdChangeInput } from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createConnection, createOrganization, testKeyring } from '../testing';
import { submitConnectionAdChanges } from './ad-changes-submit';
import { pollAmazonRequests } from './amazon-requests-poll';
import type { ConnectionJobDeps } from './connection-job';
import { syncConnectionEntities } from './entities-sync';
import { syncConnectionProfiles } from './profiles-sync';

/**
 * Ende-zu-Ende gegen den Mock-Anbieter (`phase-3.md` 3.3): Warenkorb → Übermittlung → Job → Entity-Sync → Revert.
 * Der echte Schreib-Client spricht mit den Schreib-Endpunkten des Mocks; der Mock merkt sich die Änderungen, der
 * nächste Sync liefert sie zurück.
 */

const {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProfiles,
  amazonAdsTargets,
  campaignSetupItems,
  members,
  users,
} = schema;

const DE = '9007199254740993';
const SP = 'SPONSORED_PRODUCTS';
const START = Date.parse('2026-09-27T06:00:00Z');

let testDb: TestDatabase;
let organizationId = '';
let connectionId = '';
let profileId = '';
let userId = '';
let clock = START;
let deps: ConnectionJobDeps;

const run = () => ({
  meter: createRequestMeter(),
  runId: null,
  extendLease: () => Promise.resolve(),
});
const job = () => ({ organizationId, connectionId });
const actor = () => ({ userId, orgId: organizationId });

/** Entity-Sync samt Abholen der Exports; die Uhr springt jeweils zum nächsten Termin. */
async function syncEntities() {
  clock += 60_000;
  await syncConnectionEntities(deps, job(), run());
  for (let i = 0; i < 50; i++) {
    const next = await nextAmazonRequestPollAt(testDb.db, job());
    if (next === null) return;
    clock = Math.max(clock, next.getTime());
    await pollAmazonRequests(deps, job(), run());
  }
  throw new Error('Exports wurden nicht fertig.');
}

async function entities() {
  const { db } = testDb;
  const [campaign] = await db
    .select()
    .from(amazonAdsCampaigns)
    .where(
      and(
        eq(amazonAdsCampaigns.profileId, profileId),
        eq(amazonAdsCampaigns.adProduct, SP),
        eq(amazonAdsCampaigns.state, 'ENABLED'),
        eq(amazonAdsCampaigns.targetingType, 'MANUAL'),
      ),
    )
    .orderBy(amazonAdsCampaigns.amazonCampaignId)
    .limit(1);
  const [adGroup] = await db
    .select()
    .from(amazonAdsAdGroups)
    .where(eq(amazonAdsAdGroups.campaignId, campaign!.id))
    .orderBy(amazonAdsAdGroups.amazonAdGroupId)
    .limit(1);
  const keywords = await db
    .select()
    .from(amazonAdsTargets)
    .where(
      and(eq(amazonAdsTargets.adGroupId, adGroup!.id), eq(amazonAdsTargets.targetType, 'keyword')),
    )
    .orderBy(amazonAdsTargets.amazonTargetId);
  return { campaign: campaign!, adGroup: adGroup!, keyword: keywords[0]!, other: keywords[1]! };
}

const update = (
  entityType: Extract<AdChangeInput, { operation: 'update' }>['entityType'],
  entityId: string,
  field: Extract<AdChangeInput, { operation: 'update' }>['field'],
  value: string,
): AdChangeInput => ({ operation: 'update', entityType, entityId, field, value });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  organizationId = await createOrganization(db, 'muuv');
  connectionId = await createConnection(db, {
    organizationId,
    externalAccountId: 'amzn1.account.MOCK',
  });
  const [user] = await db
    .insert(users)
    .values({ name: 'Ada', email: 'ada@muuv.test' })
    .returning({ id: users.id });
  userId = user!.id;
  await db.insert(members).values({ organizationId, userId, role: 'admin', createdAt: new Date() });
  deps = {
    db,
    logger: () => {},
    amazonAds: createMockAmazonAdsClient({
      redirectUri: 'http://localhost/cb',
      consentUrl: 'http://localhost/consent',
      store: createConnectionTokenStore({ db, keyring: testKeyring }),
      rateLimit: { requestsPerSecond: 100 },
      simulation: { now: () => clock, processingMs: 60_000 },
    }),
    scheduleRetry: () => Promise.resolve(true),
    enqueue: () => Promise.resolve(true),
    now: () => new Date(clock),
  };
  await syncConnectionProfiles(deps, job(), run());
  // Nur das DE-Profil, damit der Test kurz bleibt.
  await db.update(amazonAdsProfiles).set({ removedAt: new Date(START) });
  const [de] = await db
    .update(amazonAdsProfiles)
    .set({ removedAt: null })
    .where(eq(amazonAdsProfiles.amazonProfileId, DE))
    .returning({ id: amazonAdsProfiles.id });
  profileId = de!.id;
  await syncEntities();
}, 30_000);

afterAll(async () => {
  await testDb?.close();
});

describe('Änderungen über die API gegen den Mock-Anbieter', () => {
  it('übermittelt, übersteht den nächsten Sync und lässt sich ohne Rückfrage zurücknehmen', async () => {
    const before = await entities();
    expect(before.keyword.bid).not.toBeNull();

    const staged = await stageAdChanges(testDb.db, {
      ...actor(),
      origin: 'explorer',
      changes: [
        update('campaign', before.campaign.id, 'budget', '33.5'),
        update('campaign', before.campaign.id, 'placement_product_page', '15'),
        update('target', before.keyword.id, 'bid', '0.77'),
        // Über dem Höchstgebot des Marktplatzes: Teilfehler von Amazon.
        update('target', before.other.id, 'bid', '99999'),
        {
          operation: 'create_negative',
          campaignId: before.campaign.id,
          adGroupId: before.adGroup.id,
          negative: { type: 'keyword', keywordText: 'ganz neu negativ', matchType: 'PHRASE' },
        },
      ],
    });
    expect(staged!.counts).toMatchObject({ created: 5, rejected: 0 });
    const submitted = await submitAdChanges(testDb.db, {
      ...actor(),
      channel: 'api',
      enqueue: async () => {},
    });
    const submissionId = submitted!.submissions[0]!.id;

    const outcome = await submitConnectionAdChanges(deps, job(), run());

    expect(outcome.counters).toMatchObject({
      submissions: 1,
      changesApplied: 4,
      changesFailed: 1,
      changesUnsent: 0,
    });
    const result = await getAdChangeSubmission(testDb.db, { ...actor(), submissionId });
    expect(result!.submission).toMatchObject({
      status: 'finished',
      counts: { submitted: 0, applied: 4, failed: 1, dismissed: 0 },
    });
    const failed = result!.changes.find((change) => change.status === 'failed')!;
    expect(failed).toMatchObject({
      entityId: before.other.id,
      errorCode: 'BID_OUT_OF_MARKET_PLACE_RANGE',
    });

    // Der nächste Sync liefert den neuen Stand (der Mock merkt sich die Änderungen), nichts springt zurück.
    await syncEntities();
    const after = await entities();
    expect(after.campaign.budgetAmount).toBe('33.5');
    expect(after.campaign.extra.placementBidAdjustments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ placement: 'PLACEMENT_TOP' }),
        expect.objectContaining({ placement: 'PLACEMENT_PRODUCT_PAGE', percentage: 15 }),
      ]),
    );
    expect(after.keyword.bid).toBe('0.77');
    expect(after.other.bid).toBe(before.other.bid);
    const negatives = await testDb.db
      .select()
      .from(amazonAdsNegativeTargets)
      .where(eq(amazonAdsNegativeTargets.keywordText, 'ganz neu negativ'));
    expect(negatives).toHaveLength(1);
    expect(negatives[0]).toMatchObject({
      level: 'ad_group',
      adGroupId: before.adGroup.id,
      matchType: 'PHRASE',
      state: 'ENABLED',
      removedAt: null,
    });
    expect(negatives[0]!.syncedAt).not.toBeNull();

    // Revert der ganzen Übermittlung: kein Konflikt, weil der Stand dem „nachher“ entspricht.
    const reverted = await revertAdChanges(testDb.db, {
      ...actor(),
      submissionId,
      channel: 'api',
      enqueue: async () => {},
    });
    expect(reverted).toMatchObject({
      status: 'submitted',
      skipped: [{ changeId: failed.id, reason: 'notApplied' }],
    });
    const revertOutcome = await submitConnectionAdChanges(deps, job(), run());
    expect(revertOutcome.counters).toMatchObject({ changesApplied: 4, changesFailed: 0 });

    await syncEntities();
    const [campaign] = await testDb.db
      .select()
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.id, before.campaign.id));
    expect(campaign!.budgetAmount).toBe(before.campaign.budgetAmount);
    const [keyword] = await testDb.db
      .select()
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.id, before.keyword.id));
    expect(keyword!.bid).toBe(before.keyword.bid);
    const [negative] = await testDb.db
      .select()
      .from(amazonAdsNegativeTargets)
      .where(eq(amazonAdsNegativeTargets.keywordText, 'ganz neu negativ'));
    expect(negative!.state).toBe('ARCHIVED');
  }, 30_000);
});

describe('Setup über die API gegen den Mock-Anbieter (4.4)', () => {
  it('legt eine neue Kampagne an, die der nächste Sync mit denselben IDs liefert', async () => {
    const { db } = testDb;
    const name = 'SP | EXACT | Neue Flaschen';
    const [{ accountType } = { accountType: 'seller' }] = await db
      .select({ accountType: amazonAdsProfiles.accountType })
      .from(amazonAdsProfiles)
      .where(eq(amazonAdsProfiles.id, profileId));
    const draft = (await saveCampaignSetupDraft(db, {
      ...actor(),
      draft: {
        profileId,
        productGroupId: null,
        presetKey: 'muuv-standard',
        name: 'Neue Flaschen',
        campaignState: 'PAUSED',
        inputs: {
          keywords: [],
          brandTerms: [],
          productTargets: [],
          categories: [],
          harvest: [],
          unlocks: {},
        },
        sourceNegatives: [],
        campaigns: [
          {
            block: 'SP-KW-EXACT',
            adProduct: 'SP',
            targeting: 'keyword',
            name,
            state: 'ENABLED',
            currencyCode: 'EUR',
            dailyBudget: '12.50',
            biddingStrategy: 'SALES_DOWN_ONLY',
            sdOptimization: null,
            costType: 'cpc',
            offAmazon: false,
            placements: { topOfSearch: 25, productPages: 0, restOfSearch: 0 },
            adGroup: { name, defaultBid: '0.65' },
            ads: [{ asin: 'B0NEUFLAS1', sku: accountType === 'vendor' ? null : 'NEU-FL-1' }],
            targets: [
              { type: 'keyword', text: 'neue trinkflasche', matchType: 'exact', bid: '0.70' },
            ],
            negatives: [{ type: 'keyword', text: 'glas', matchType: 'negativePhrase' }],
          },
        ],
      },
    }))!;
    const submitted = await submitCampaignSetupDraft(db, {
      ...actor(),
      draftId: draft.id,
      version: 1,
      channel: 'api',
      enqueue: async () => undefined,
      limitFor: () => null,
    });
    if (submitted?.status !== 'submitted') throw new Error('nicht übermittelt');

    await submitConnectionAdChanges(deps, job(), run());
    const items = await db
      .select()
      .from(campaignSetupItems)
      .where(eq(campaignSetupItems.submissionId, submitted.submission.id))
      .orderBy(campaignSetupItems.position);
    expect(items.map((item) => [item.entityType, item.status])).toEqual([
      ['campaign', 'applied'],
      ['placement', 'applied'],
      ['ad_group', 'applied'],
      ['product_ad', 'applied'],
      ['keyword', 'applied'],
      ['negative_keyword', 'applied'],
    ]);

    await syncEntities();
    const [campaign] = await db
      .select()
      .from(amazonAdsCampaigns)
      .where(and(eq(amazonAdsCampaigns.profileId, profileId), eq(amazonAdsCampaigns.name, name)));
    expect(campaign).toMatchObject({
      amazonCampaignId: items[0]!.amazonEntityId,
      state: 'PAUSED',
      budgetAmount: '12.5',
      targetingType: 'MANUAL',
    });
    const [adGroup] = await db
      .select()
      .from(amazonAdsAdGroups)
      .where(eq(amazonAdsAdGroups.campaignId, campaign!.id));
    expect(adGroup!.amazonAdGroupId).toBe(items[2]!.amazonEntityId);
    const [keyword] = await db
      .select()
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.adGroupId, adGroup!.id));
    expect(keyword).toMatchObject({
      amazonTargetId: items[4]!.amazonEntityId,
      keywordText: 'neue trinkflasche',
      matchType: 'EXACT',
    });
    const [negative] = await db
      .select()
      .from(amazonAdsNegativeTargets)
      .where(eq(amazonAdsNegativeTargets.adGroupId, adGroup!.id));
    expect(negative).toMatchObject({ keywordText: 'glas', matchType: 'PHRASE' });
  }, 30_000);
});
