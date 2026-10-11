import type { PlannedCampaign } from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import {
  CampaignBlockError,
  listCampaignBlocks,
  loadCampaignBlocks,
  setCampaignBlocks,
} from './campaign-blocks';
import { saveCampaignSetupDraft, submitCampaignSetupDraft } from './campaign-setup';
import {
  amazonAdsCampaigns,
  amazonAdsProfiles,
  auditEvents,
  campaignBlocks,
  campaignSetupItems,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/**
 * Zuordnung Kampagne → Baustein (`phase-5.md` 5.11a): aus dem Setup, das die Kampagne angelegt hat, sonst von Hand
 * bestätigt; der Name liefert nur einen Vorschlag.
 */

let testDb: TestDatabase;
let f: AdChangeFixture;
const SP = 'SPONSORED_PRODUCTS';
const SETUP_NAME = 'SP | EXACT | Flaschen';
let named = '';
let fromSetup = '';

const who = (userId = f.ada) => ({ userId, orgId: f.org });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof CampaignBlockError) return err.code;
    throw err;
  }
  return null;
};

const plan: PlannedCampaign = {
  block: 'SP-KW-EXACT',
  adProduct: 'SP',
  targeting: 'keyword',
  name: SETUP_NAME,
  state: 'ENABLED',
  currencyCode: 'EUR',
  dailyBudget: '25.00',
  biddingStrategy: 'SALES_DOWN_ONLY',
  sdOptimization: null,
  costType: 'cpc',
  offAmazon: false,
  placements: null,
  adGroup: { name: SETUP_NAME, defaultBid: '0.85' },
  ads: [{ asin: 'B0TEST0001', sku: 'SKU-1' }],
  targets: [{ type: 'keyword', text: 'trinkflasche', matchType: 'exact', bid: '0.90' }],
  negatives: [],
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  f = await seedAdChangeFixture(db);
  // Ein übermitteltes Setup, dessen Kampagne der Import danach als `1003` bestätigt.
  const saved = (await saveCampaignSetupDraft(db, {
    ...who(),
    draft: {
      profileId: f.profile,
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
        creative: null,
      },
      campaigns: [plan],
      sourceNegatives: [],
      portfolioId: null,
    },
  }))!;
  const result = await submitCampaignSetupDraft(db, {
    ...who(),
    draftId: saved.id,
    version: 1,
    channel: 'bulk_file',
    enqueue: async () => undefined,
    limitFor: () => null,
  });
  if (result?.status !== 'submitted') throw new Error(JSON.stringify(result));
  const campaign = (amazonCampaignId: string, name: string, state = 'ENABLED') => ({
    organizationId: f.org,
    profileId: f.profile,
    amazonCampaignId,
    adProduct: SP,
    name,
    state,
  });
  const rows = await db
    .insert(amazonAdsCampaigns)
    .values([
      campaign('1002', 'SP | AUTO | Flaschen'),
      campaign('1003', SETUP_NAME),
      campaign('1004', 'SP | AUTO | Alt', 'ARCHIVED'),
    ])
    .returning({ id: amazonAdsCampaigns.id });
  named = rows[0]!.id;
  fromSetup = rows[1]!.id;
  await db
    .update(campaignSetupItems)
    .set({ status: 'applied', amazonEntityId: '1003' })
    .where(
      and(
        eq(campaignSetupItems.submissionId, result.submission.id),
        eq(campaignSetupItems.entityType, 'campaign'),
      ),
    );
});

beforeEach(async () => {
  await testDb.db.delete(campaignBlocks);
  await testDb.db.delete(auditEvents);
});

afterAll(async () => {
  await testDb?.close();
});

const row = async (campaignId: string) =>
  (await listCampaignBlocks(testDb.db, { ...who(), profileId: f.profile }))!.campaigns.find(
    (campaign) => campaign.campaignId === campaignId,
  );

describe('listCampaignBlocks', () => {
  it('kennt den Baustein aus dem Setup, schlägt sonst einen aus dem Namen vor und lässt Archivierte weg', async () => {
    const list = (await listCampaignBlocks(testDb.db, { ...who(), profileId: f.profile }))!;
    expect(list.campaigns.map((campaign) => campaign.name)).toEqual([
      'Kampagne 1001',
      'SP | AUTO | Flaschen',
      SETUP_NAME,
    ]);
    expect(await row(fromSetup)).toMatchObject({
      amazonCampaignId: '1003',
      adProduct: 'SP',
      blockKey: 'SP-KW-EXACT',
      source: 'setup',
    });
    expect(await row(named)).toMatchObject({
      blockKey: null,
      source: null,
      suggestedBlockKey: 'SP-AUTO',
    });
    expect(await row(f.campaign)).toMatchObject({ blockKey: null, suggestedBlockKey: null });
  });

  it('liefert null für ein ausgeblendetes Profil und für Fremde', async () => {
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.fileProfile));
    expect(
      await listCampaignBlocks(testDb.db, { ...who(f.emil), profileId: f.fileProfile }),
    ).toBeNull();
    const other = await seedAdChangeFixture(testDb.db, 'andere');
    expect(
      await listCampaignBlocks(testDb.db, {
        userId: other.ada,
        orgId: other.org,
        profileId: f.profile,
      }),
    ).toBeNull();
  });
});

describe('setCampaignBlocks', () => {
  const set = (assignments: { campaignId: string; blockKey: string | null }[], userId = f.ada) =>
    setCampaignBlocks(testDb.db, { ...who(userId), profileId: f.profile, assignments });

  it('bestätigt von Hand (geht dem Setup vor), nimmt die Bestätigung zurück und schreibt Audit nur bei Änderung', async () => {
    expect(
      await set([
        { campaignId: named, blockKey: 'SP-AUTO' },
        { campaignId: fromSetup, blockKey: 'SP-KW-EXACT-SINGLE' },
      ]),
    ).toEqual({ changed: 2 });
    expect(await row(named)).toMatchObject({ blockKey: 'SP-AUTO', source: 'manual' });
    expect(await row(fromSetup)).toMatchObject({
      blockKey: 'SP-KW-EXACT-SINGLE',
      source: 'manual',
    });
    expect(await set([{ campaignId: named, blockKey: 'SP-AUTO' }])).toEqual({ changed: 0 });
    expect(await set([{ campaignId: fromSetup, blockKey: null }])).toEqual({ changed: 1 });
    expect(await row(fromSetup)).toMatchObject({ blockKey: 'SP-KW-EXACT', source: 'setup' });
    const audits = await testDb.db.select().from(auditEvents);
    expect(audits.map((event) => event.action)).toEqual([
      'campaign_blocks.update',
      'campaign_blocks.update',
    ]);
    expect(audits[0]!.target).toMatchObject({
      type: 'profile',
      id: f.profile,
      changes: [
        { campaignId: named, before: null, after: 'SP-AUTO' },
        { campaignId: fromSetup, before: null, after: 'SP-KW-EXACT-SINGLE' },
      ],
    });
  });

  it('lehnt unbekannte Bausteine, Bausteine eines anderen Anzeigentyps und fremde Kampagnen ab', async () => {
    expect(await code(set([{ campaignId: named, blockKey: 'SP-GIBT-ES-NICHT' }]))).toBe(
      'UNKNOWN_BLOCK',
    );
    expect(await code(set([{ campaignId: named, blockKey: 'SD-PAT' }]))).toBe('UNKNOWN_BLOCK');
    expect(await code(set([{ campaignId: f.fileCampaign, blockKey: 'SP-AUTO' }]))).toBe(
      'UNKNOWN_CAMPAIGN',
    );
    expect(await testDb.db.select().from(campaignBlocks)).toEqual([]);
  });

  it('liefert null für ein Profil, das der Nutzer nicht sieht', async () => {
    expect(
      await setCampaignBlocks(testDb.db, {
        ...who(f.emil),
        profileId: f.fileProfile,
        assignments: [{ campaignId: f.fileCampaign, blockKey: 'SP-AUTO' }],
      }),
    ).toBeNull();
  });
});

describe('loadCampaignBlocks (für den Lauf)', () => {
  it('liefert je Amazon-Kampagnen-ID den Baustein, von Hand vor Setup', async () => {
    await setCampaignBlocks(testDb.db, {
      ...who(),
      profileId: f.profile,
      assignments: [{ campaignId: named, blockKey: 'SP-AUTO' }],
    });
    expect(await loadCampaignBlocks(testDb.db, f.org, f.profile)).toEqual(
      new Map([
        ['1002', 'SP-AUTO'],
        ['1003', 'SP-KW-EXACT'],
      ]),
    );
  });
});
