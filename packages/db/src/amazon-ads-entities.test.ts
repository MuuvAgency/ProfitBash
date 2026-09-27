import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ensureCampaigns,
  upsertAdGroups,
  upsertCampaigns,
  upsertNegativeTargets,
  upsertPortfolios,
  upsertProductAds,
  upsertTargets,
  type AdGroupRecord,
  type CampaignRecord,
  type EntityWriteScope,
  type NegativeTargetRecord,
  type PortfolioRecord,
  type ProductAdRecord,
  type TargetRecord,
} from './amazon-ads-entities';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsPortfolios,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsTargets,
  organizations,
} from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let organizationId = '';
let otherOrganizationId = '';
let connectionId = '';
let otherConnectionId = '';
let profileId = '';
let secondProfileId = '';
let foreignProfileId = '';

const SP = 'SPONSORED_PRODUCTS';
/** Größer als `Number.MAX_SAFE_INTEGER`: muss unverändert als Text ankommen. */
const BIG_ID = '144115188075855873';

const t0 = new Date('2026-09-27T06:00:00Z');
const t1 = new Date('2026-09-28T06:00:00Z');
const t2 = new Date('2026-09-29T06:00:00Z');

const scope = (overrides: Partial<EntityWriteScope> = {}): EntityWriteScope => ({
  organizationId,
  profileId,
  now: t0,
  ...overrides,
});

const portfolio = (overrides: Partial<PortfolioRecord> = {}): PortfolioRecord => ({
  amazonPortfolioId: 'pf-1',
  name: 'Portfolio 1',
  state: 'ENABLED',
  budgetAmount: '1000.50',
  budgetCurrencyCode: 'EUR',
  budgetPolicy: 'MONTHLY_RECURRING',
  budgetStartDate: '2026-09-01',
  budgetEndDate: null,
  inBudget: true,
  amazonUpdatedAt: null,
  extra: {},
  ...overrides,
});

const campaign = (overrides: Partial<CampaignRecord> = {}): CampaignRecord => ({
  amazonCampaignId: 'c-1',
  amazonPortfolioId: null,
  adProduct: SP,
  name: 'Kampagne 1',
  state: 'ENABLED',
  targetingType: 'MANUAL',
  budgetAmount: '50',
  budgetCurrencyCode: 'EUR',
  budgetType: 'DAILY',
  biddingStrategy: 'LEGACY_FOR_SALES',
  startDate: '2026-01-01',
  endDate: null,
  amazonUpdatedAt: new Date('2026-09-20T10:00:00Z'),
  extra: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] },
  ...overrides,
});

const adGroup = (overrides: Partial<AdGroupRecord> = {}): AdGroupRecord => ({
  amazonAdGroupId: 'ag-1',
  amazonCampaignId: 'c-1',
  adProduct: SP,
  name: 'Ad Group 1',
  state: 'ENABLED',
  defaultBid: '0.75',
  defaultBidCurrencyCode: 'EUR',
  amazonUpdatedAt: null,
  extra: {},
  ...overrides,
});

const target = (overrides: Partial<TargetRecord> = {}): TargetRecord => ({
  amazonTargetId: 't-1',
  amazonCampaignId: 'c-1',
  amazonAdGroupId: 'ag-1',
  adProduct: SP,
  targetType: 'keyword',
  keywordText: 'laufschuhe herren',
  matchType: 'EXACT',
  expression: null,
  state: 'ENABLED',
  bid: '0.005',
  bidCurrencyCode: 'EUR',
  amazonUpdatedAt: null,
  extra: {},
  ...overrides,
});

const negative = (overrides: Partial<NegativeTargetRecord> = {}): NegativeTargetRecord => ({
  amazonTargetId: 'n-1',
  level: 'ad_group',
  amazonCampaignId: 'c-1',
  amazonAdGroupId: 'ag-1',
  adProduct: SP,
  targetType: 'keyword',
  keywordText: 'gratis',
  matchType: 'NEGATIVE_EXACT',
  expression: null,
  state: 'ENABLED',
  amazonUpdatedAt: null,
  extra: {},
  ...overrides,
});

const productAd = (overrides: Partial<ProductAdRecord> = {}): ProductAdRecord => ({
  amazonAdId: 'ad-1',
  amazonCampaignId: 'c-1',
  amazonAdGroupId: 'ag-1',
  adProduct: SP,
  asin: 'B000000001',
  sku: 'SKU-1',
  state: 'ENABLED',
  amazonUpdatedAt: null,
  extra: {},
  ...overrides,
});

async function campaignRow(amazonCampaignId: string, forProfileId = profileId) {
  const [row] = await testDb.db
    .select()
    .from(amazonAdsCampaigns)
    .where(
      and(
        eq(amazonAdsCampaigns.profileId, forProfileId),
        eq(amazonAdsCampaigns.amazonCampaignId, amazonCampaignId),
      ),
    );
  return row;
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createTestOrganization(testDb.db, 'muuv');
  otherOrganizationId = await createTestOrganization(testDb.db, 'andere');
  connectionId = await createTestConnection(testDb.db, organizationId, 'amzn1.account.A');
  otherConnectionId = await createTestConnection(testDb.db, otherOrganizationId, 'amzn1.account.B');
  profileId = await createTestProfile(testDb.db, {
    organizationId,
    connectionId,
    amazonProfileId: '111',
  });
  secondProfileId = await createTestProfile(testDb.db, {
    organizationId,
    connectionId,
    amazonProfileId: '222',
  });
  foreignProfileId = await createTestProfile(testDb.db, {
    organizationId: otherOrganizationId,
    connectionId: otherConnectionId,
    amazonProfileId: '333',
  });
});

afterAll(async () => {
  await testDb.close();
});

describe('upsertPortfolios', () => {
  it('legt Portfolios an, ein zweiter gleicher Lauf ändert nur synced_at', async () => {
    const first = await upsertPortfolios(testDb.db, scope(), [portfolio()]);
    expect(first).toEqual({
      created: 1,
      updated: 0,
      placeholdersFilled: 0,
      placeholdersCreated: 0,
    });

    const [before] = await testDb.db
      .select({ updatedAt: amazonAdsPortfolios.updatedAt })
      .from(amazonAdsPortfolios)
      .where(eq(amazonAdsPortfolios.profileId, profileId));

    const second = await upsertPortfolios(testDb.db, scope({ now: t1 }), [portfolio()]);
    expect(second).toEqual({
      created: 0,
      updated: 0,
      placeholdersFilled: 0,
      placeholdersCreated: 0,
    });

    const [row] = await testDb.db
      .select()
      .from(amazonAdsPortfolios)
      .where(eq(amazonAdsPortfolios.profileId, profileId));
    expect(row).toMatchObject({
      organizationId,
      amazonPortfolioId: 'pf-1',
      name: 'Portfolio 1',
      budgetAmount: '1000.50',
      budgetCurrencyCode: 'EUR',
      budgetPolicy: 'MONTHLY_RECURRING',
      budgetStartDate: '2026-09-01',
      budgetEndDate: null,
      inBudget: true,
      syncedAt: t1,
      removedAt: null,
      updatedAt: before!.updatedAt,
    });
  });

  it('zählt geänderte Portfolios als aktualisiert', async () => {
    const result = await upsertPortfolios(testDb.db, scope({ now: t2 }), [
      portfolio({ name: 'Portfolio 1 neu', budgetAmount: '1234567.89' }),
    ]);
    expect(result.updated).toBe(1);
    const [row] = await testDb.db
      .select()
      .from(amazonAdsPortfolios)
      .where(eq(amazonAdsPortfolios.profileId, profileId));
    expect(row).toMatchObject({ name: 'Portfolio 1 neu', budgetAmount: '1234567.89' });
  });
});

describe('upsertCampaigns', () => {
  it('speichert Kampagnen mit Portfolio, exakten Beträgen und großen IDs', async () => {
    const result = await upsertCampaigns(testDb.db, scope(), [
      campaign({ amazonPortfolioId: 'pf-1' }),
      campaign({ amazonCampaignId: BIG_ID, name: 'Groß', budgetAmount: '0.1' }),
    ]);
    expect(result).toEqual({
      created: 2,
      updated: 0,
      placeholdersFilled: 0,
      placeholdersCreated: 0,
    });

    const [pf] = await testDb.db
      .select({ id: amazonAdsPortfolios.id })
      .from(amazonAdsPortfolios)
      .where(eq(amazonAdsPortfolios.profileId, profileId));
    expect(await campaignRow('c-1')).toMatchObject({
      portfolioId: pf!.id,
      adProduct: SP,
      targetingType: 'MANUAL',
      budgetAmount: '50',
      budgetType: 'DAILY',
      biddingStrategy: 'LEGACY_FOR_SALES',
      startDate: '2026-01-01',
      endDate: null,
      amazonUpdatedAt: new Date('2026-09-20T10:00:00Z'),
      extra: { placementBidding: [{ placement: 'PLACEMENT_TOP', percentage: 50 }] },
      syncedAt: t0,
    });
    expect(await campaignRow(BIG_ID)).toMatchObject({ name: 'Groß', budgetAmount: '0.1' });
  });

  it('legt ein unbekanntes Portfolio als Platzhalter an', async () => {
    const result = await upsertCampaigns(testDb.db, scope(), [
      campaign({ amazonCampaignId: 'c-pf', amazonPortfolioId: 'pf-unbekannt' }),
    ]);
    expect(result.placeholdersCreated).toBe(1);
    const [pf] = await testDb.db
      .select()
      .from(amazonAdsPortfolios)
      .where(eq(amazonAdsPortfolios.amazonPortfolioId, 'pf-unbekannt'));
    expect(pf).toMatchObject({ profileId, name: null, state: null, syncedAt: null });
    expect((await campaignRow('c-pf'))?.portfolioId).toBe(pf!.id);
  });

  it('hält gleiche Amazon-IDs verschiedener Profile auseinander', async () => {
    await upsertCampaigns(testDb.db, scope({ profileId: secondProfileId }), [
      campaign({ name: 'Anderes Profil' }),
    ]);
    expect((await campaignRow('c-1'))?.name).toBe('Kampagne 1');
    expect((await campaignRow('c-1', secondProfileId))?.name).toBe('Anderes Profil');
  });

  it('nimmt bei doppelten IDs in einer Lieferung den letzten Datensatz', async () => {
    await upsertCampaigns(testDb.db, scope(), [
      campaign({ amazonCampaignId: 'c-dup', name: 'alt' }),
      campaign({ amazonCampaignId: 'c-dup', name: 'neu' }),
    ]);
    expect((await campaignRow('c-dup'))?.name).toBe('neu');
  });

  it('setzt removed_at zurück, wenn eine Kampagne wieder auftaucht', async () => {
    await testDb.db
      .update(amazonAdsCampaigns)
      .set({ removedAt: t0 })
      .where(eq(amazonAdsCampaigns.amazonCampaignId, 'c-dup'));
    const result = await upsertCampaigns(testDb.db, scope({ now: t1 }), [
      campaign({ amazonCampaignId: 'c-dup', name: 'neu' }),
    ]);
    expect(result.updated).toBe(1);
    expect(await campaignRow('c-dup')).toMatchObject({ removedAt: null, syncedAt: t1 });
  });

  it('lehnt ein Profil einer anderen Organisation ab, auch für vorhandene Entities', async () => {
    const foreignScope = { organizationId: otherOrganizationId, profileId: foreignProfileId };
    await upsertCampaigns(testDb.db, { ...foreignScope, now: t0 }, [campaign({ name: 'Fremd' })]);

    await expect(
      upsertCampaigns(testDb.db, scope({ profileId: foreignProfileId }), [
        campaign({ name: 'Überschrieben' }),
      ]),
    ).rejects.toThrow('Profil nicht gefunden');
    await expect(
      ensureCampaigns(testDb.db, { organizationId, profileId: foreignProfileId }, [
        { amazonCampaignId: 'c-1', adProduct: SP },
      ]),
    ).rejects.toThrow('Profil nicht gefunden');
    expect((await campaignRow('c-1', foreignProfileId))?.name).toBe('Fremd');
  });

  it('schreibt nichts, wenn ein Teil der Lieferung scheitert', async () => {
    await expect(
      upsertCampaigns(testDb.db, scope(), [
        campaign({ amazonCampaignId: 'c-atomar', amazonPortfolioId: 'pf-atomar' }),
        campaign({ amazonCampaignId: 'c-kaputt', budgetAmount: 'kein Betrag' }),
      ]),
    ).rejects.toThrow();
    expect(await campaignRow('c-atomar')).toBeUndefined();
    const [pf] = await testDb.db
      .select()
      .from(amazonAdsPortfolios)
      .where(eq(amazonAdsPortfolios.amazonPortfolioId, 'pf-atomar'));
    expect(pf).toBeUndefined();
  });
});

describe('upsertAdGroups', () => {
  it('legt eine unbekannte Kampagne als Platzhalter an, der Kampagnen-Sync füllt ihn', async () => {
    const result = await upsertAdGroups(testDb.db, scope(), [
      adGroup({ amazonAdGroupId: 'ag-x', amazonCampaignId: 'c-neu' }),
    ]);
    expect(result).toEqual({
      created: 1,
      updated: 0,
      placeholdersFilled: 0,
      placeholdersCreated: 1,
    });
    expect(await campaignRow('c-neu')).toMatchObject({
      adProduct: SP,
      name: null,
      state: null,
      budgetAmount: null,
      budgetCurrencyCode: null,
      syncedAt: null,
    });

    const filled = await upsertCampaigns(testDb.db, scope({ now: t1 }), [
      campaign({ amazonCampaignId: 'c-neu', name: 'Jetzt bekannt' }),
    ]);
    expect(filled).toEqual({
      created: 0,
      updated: 0,
      placeholdersFilled: 1,
      placeholdersCreated: 0,
    });
    expect(await campaignRow('c-neu')).toMatchObject({ name: 'Jetzt bekannt', syncedAt: t1 });
  });

  it('speichert das Standardgebot exakt und hängt die Ad Group an die Kampagne', async () => {
    await upsertAdGroups(testDb.db, scope(), [adGroup({ defaultBid: '0.123456789' })]);
    const [row] = await testDb.db
      .select()
      .from(amazonAdsAdGroups)
      .where(eq(amazonAdsAdGroups.amazonAdGroupId, 'ag-1'));
    expect(row).toMatchObject({
      campaignId: (await campaignRow('c-1'))!.id,
      defaultBid: '0.123456789',
      defaultBidCurrencyCode: 'EUR',
    });
  });
});

describe('upsertTargets', () => {
  it('speichert Keyword- und Kampagnen-Targets', async () => {
    const result = await upsertTargets(testDb.db, scope(), [
      target(),
      target({
        amazonTargetId: 't-kampagne',
        amazonAdGroupId: null,
        targetType: 'product',
        keywordText: null,
        matchType: null,
        expression: [{ type: 'ASIN_SAME_AS', value: 'B000000002' }],
        bid: null,
        bidCurrencyCode: null,
      }),
    ]);
    expect(result.created).toBe(2);

    const rows = await testDb.db
      .select()
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.profileId, profileId))
      .orderBy(amazonAdsTargets.amazonTargetId);
    expect(rows).toMatchObject([
      { amazonTargetId: 't-1', keywordText: 'laufschuhe herren', matchType: 'EXACT', bid: '0.005' },
      {
        amazonTargetId: 't-kampagne',
        adGroupId: null,
        targetType: 'product',
        expression: [{ type: 'ASIN_SAME_AS', value: 'B000000002' }],
        bid: null,
      },
    ]);
  });

  it('schreibt große Lieferungen in Stücken', async () => {
    const many = Array.from({ length: 2500 }, (_, i) =>
      target({ amazonTargetId: `t-viele-${i}`, keywordText: `keyword ${i}` }),
    );
    const result = await upsertTargets(testDb.db, scope(), many);
    expect(result.created).toBe(2500);
    const again = await upsertTargets(testDb.db, scope({ now: t1 }), many);
    expect(again).toEqual({
      created: 0,
      updated: 0,
      placeholdersFilled: 0,
      placeholdersCreated: 0,
    });
    const touched = await testDb.db
      .select({ syncedAt: amazonAdsTargets.syncedAt })
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.amazonTargetId, 't-viele-2499'));
    expect(touched).toEqual([{ syncedAt: t1 }]);
  });
});

describe('upsertNegativeTargets', () => {
  it('speichert Negatives auf Kampagnen- und Ad-Group-Ebene', async () => {
    const result = await upsertNegativeTargets(testDb.db, scope(), [
      negative(),
      negative({
        amazonTargetId: 'n-kampagne',
        level: 'campaign',
        amazonAdGroupId: null,
        matchType: 'NEGATIVE_PHRASE',
      }),
    ]);
    expect(result.created).toBe(2);
    const rows = await testDb.db
      .select()
      .from(amazonAdsNegativeTargets)
      .where(eq(amazonAdsNegativeTargets.profileId, profileId))
      .orderBy(amazonAdsNegativeTargets.amazonTargetId);
    expect(rows).toMatchObject([
      { amazonTargetId: 'n-1', level: 'ad_group', keywordText: 'gratis' },
      { amazonTargetId: 'n-kampagne', level: 'campaign', adGroupId: null },
    ]);
  });

  it('lehnt eine Ebene ab, die nicht zur Ad Group passt', async () => {
    await expect(
      upsertNegativeTargets(testDb.db, scope(), [
        negative({ amazonTargetId: 'n-falsch', level: 'campaign' }),
      ]),
    ).rejects.toMatchObject({ cause: { constraint_name: 'amazon_ads_negative_targets_level_ck' } });
  });
});

describe('upsertProductAds', () => {
  it('speichert Product Ads, auch ohne SKU (Vendoren)', async () => {
    const result = await upsertProductAds(testDb.db, scope(), [
      productAd(),
      productAd({ amazonAdId: 'ad-vendor', sku: null }),
    ]);
    expect(result.created).toBe(2);
    const rows = await testDb.db
      .select()
      .from(amazonAdsProductAds)
      .where(eq(amazonAdsProductAds.profileId, profileId))
      .orderBy(amazonAdsProductAds.amazonAdId);
    expect(rows).toMatchObject([
      { amazonAdId: 'ad-1', asin: 'B000000001', sku: 'SKU-1' },
      { amazonAdId: 'ad-vendor', sku: null },
    ]);
  });
});

describe('Fremdschlüssel', () => {
  it('verhindert, dass eine Ad Group auf die Kampagne eines anderen Profils zeigt', async () => {
    const otherCampaign = await campaignRow('c-1', secondProfileId);
    await expect(
      testDb.db.insert(amazonAdsAdGroups).values({
        organizationId,
        profileId,
        campaignId: otherCampaign!.id,
        amazonAdGroupId: 'ag-fremd',
        adProduct: SP,
      }),
    ).rejects.toMatchObject({ cause: { constraint_name: 'amazon_ads_ad_groups_campaign_fk' } });
  });

  it('verhindert das Löschen einer Kampagne mit Ad Groups', async () => {
    await expect(
      testDb.db.delete(amazonAdsCampaigns).where(eq(amazonAdsCampaigns.amazonCampaignId, 'c-1')),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('verhindert das Löschen eines Profils mit Entities', async () => {
    await expect(
      testDb.db.delete(amazonAdsProfiles).where(eq(amazonAdsProfiles.id, profileId)),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('erlaubt das Löschen der ganzen Organisation', async () => {
    await testDb.db.delete(organizations).where(eq(organizations.id, organizationId));
    const left = await testDb.db
      .select({ id: amazonAdsCampaigns.id })
      .from(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.organizationId, organizationId));
    expect(left).toEqual([]);
  });
});
