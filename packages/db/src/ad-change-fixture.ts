import type { Db } from './client';
import {
  amazonAdsAdGroups,
  amazonAdsCampaigns,
  amazonAdsNegativeTargets,
  amazonAdsProductAds,
  amazonAdsProfiles,
  amazonAdsTargets,
  members,
  users,
} from './schema';
import { createTestConnection, createTestOrganization } from './test-fixtures';

/**
 * Stammdaten für Tests der Übermittlung von Änderungen (`phase-3.md` 3.3): eine Organisation mit zwei Nutzern, ein
 * Profil mit Connection, eines ohne (Datei-Import) und je eine kleine SP-Struktur. Nur für Tests
 * (`@profitbash/db/testing`).
 */
export interface AdChangeFixture {
  org: string;
  ada: string;
  emil: string;
  connection: string;
  /** Profil mit Connection (Amazon-Profil `111`). */
  profile: string;
  /** Profil ohne Connection. */
  fileProfile: string;
  campaign: string;
  adGroup: string;
  /** Keyword-Target mit Gebot 0.50. */
  keyword: string;
  /** Produkt-Target ohne eigenes Gebot. */
  productTarget: string;
  productAd: string;
  /** Negatives Keyword in der Ad Group. */
  negativeKeyword: string;
  /** Negative ASIN auf Kampagnenebene. */
  campaignNegativeProduct: string;
  fileCampaign: string;
  fileAdGroup: string;
  fileKeyword: string;
}

const SP = 'SPONSORED_PRODUCTS';

export async function seedAdChangeFixture(db: Db, slug = 'muuv'): Promise<AdChangeFixture> {
  const org = await createTestOrganization(db, slug);
  const [ada, emil] = await db
    .insert(users)
    .values([
      { name: 'Ada', email: `ada@${slug}.test` },
      { name: 'Emil', email: `emil@${slug}.test` },
    ])
    .returning({ id: users.id });
  await db.insert(members).values([
    { organizationId: org, userId: ada!.id, role: 'admin', createdAt: new Date() },
    { organizationId: org, userId: emil!.id, role: 'editor', createdAt: new Date() },
  ]);
  const connection = await createTestConnection(db, org, `amzn1.account.${slug}`);
  const base = {
    organizationId: org,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
  };
  const [profile, fileProfile] = await db
    .insert(amazonAdsProfiles)
    .values([
      { ...base, connectionId: connection, amazonProfileId: '111', accountName: 'Nordwind DE' },
      { ...base, connectionId: null, amazonProfileId: null, accountName: 'Datei-Konto' },
    ])
    .returning({ id: amazonAdsProfiles.id });

  const campaignRow = (profileId: string, amazonCampaignId: string) => ({
    organizationId: org,
    profileId,
    amazonCampaignId,
    adProduct: SP,
    name: `Kampagne ${amazonCampaignId}`,
    state: 'ENABLED',
    budgetAmount: '20',
    budgetCurrencyCode: 'EUR',
    budgetType: 'DAILY',
    biddingStrategy: 'SALES_DOWN_ONLY',
    extra: { placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: '50' }] },
  });
  const [campaign, fileCampaign] = await db
    .insert(amazonAdsCampaigns)
    .values([campaignRow(profile!.id, '1001'), campaignRow(fileProfile!.id, '9001')])
    .returning({ id: amazonAdsCampaigns.id });

  const adGroupRow = (profileId: string, campaignId: string, amazonAdGroupId: string) => ({
    organizationId: org,
    profileId,
    campaignId,
    amazonAdGroupId,
    adProduct: SP,
    name: `AG ${amazonAdGroupId}`,
    state: 'ENABLED',
    defaultBid: '0.40',
    defaultBidCurrencyCode: 'EUR',
  });
  const [adGroup, fileAdGroup] = await db
    .insert(amazonAdsAdGroups)
    .values([
      adGroupRow(profile!.id, campaign!.id, '2001'),
      adGroupRow(fileProfile!.id, fileCampaign!.id, '9002'),
    ])
    .returning({ id: amazonAdsAdGroups.id });

  const targetRow = (
    profileId: string,
    campaignId: string,
    adGroupId: string,
    amazonTargetId: string,
    patch: Partial<typeof amazonAdsTargets.$inferInsert>,
  ) => ({
    organizationId: org,
    profileId,
    campaignId,
    adGroupId,
    amazonTargetId,
    adProduct: SP,
    targetType: 'keyword',
    keywordText: `kw ${amazonTargetId}`,
    matchType: 'BROAD',
    state: 'ENABLED',
    bid: '0.50',
    bidCurrencyCode: 'EUR',
    ...patch,
  });
  const [keyword, productTarget, fileKeyword] = await db
    .insert(amazonAdsTargets)
    .values([
      targetRow(profile!.id, campaign!.id, adGroup!.id, '3001', {}),
      targetRow(profile!.id, campaign!.id, adGroup!.id, '3002', {
        targetType: 'product',
        keywordText: null,
        matchType: null,
        expression: { matchType: 'PRODUCT_EXACT', asin: 'B0TEST0002' },
        bid: null,
        bidCurrencyCode: null,
      }),
      targetRow(fileProfile!.id, fileCampaign!.id, fileAdGroup!.id, '9003', {}),
    ])
    .returning({ id: amazonAdsTargets.id });

  const [productAd] = await db
    .insert(amazonAdsProductAds)
    .values({
      organizationId: org,
      profileId: profile!.id,
      campaignId: campaign!.id,
      adGroupId: adGroup!.id,
      amazonAdId: '4001',
      adProduct: SP,
      asin: 'B0TEST0001',
      sku: 'SKU-1',
      state: 'ENABLED',
    })
    .returning({ id: amazonAdsProductAds.id });

  const [negativeKeyword, campaignNegativeProduct] = await db
    .insert(amazonAdsNegativeTargets)
    .values([
      {
        organizationId: org,
        profileId: profile!.id,
        level: 'ad_group',
        campaignId: campaign!.id,
        adGroupId: adGroup!.id,
        amazonTargetId: '5001',
        adProduct: SP,
        targetType: 'keyword',
        keywordText: 'gebraucht',
        matchType: 'EXACT',
        state: 'ENABLED',
      },
      {
        organizationId: org,
        profileId: profile!.id,
        level: 'campaign',
        campaignId: campaign!.id,
        adGroupId: null,
        amazonTargetId: '5002',
        adProduct: SP,
        targetType: 'product',
        expression: { matchType: 'PRODUCT_EXACT', asin: 'B0TEST0009' },
        state: 'ENABLED',
      },
    ])
    .returning({ id: amazonAdsNegativeTargets.id });

  return {
    org,
    ada: ada!.id,
    emil: emil!.id,
    connection,
    profile: profile!.id,
    fileProfile: fileProfile!.id,
    campaign: campaign!.id,
    adGroup: adGroup!.id,
    keyword: keyword!.id,
    productTarget: productTarget!.id,
    productAd: productAd!.id,
    negativeKeyword: negativeKeyword!.id,
    campaignNegativeProduct: campaignNegativeProduct!.id,
    fileCampaign: fileCampaign!.id,
    fileAdGroup: fileAdGroup!.id,
    fileKeyword: fileKeyword!.id,
  };
}
