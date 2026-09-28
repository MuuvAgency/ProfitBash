import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ensureCampaigns, ProfileNotFoundError } from './amazon-ads-entities';
import {
  markMetricsImportedThrough,
  metricsImportedThroughSql,
  MetricsImportRejectedError,
  replaceDailyMetrics,
  selectReportAdProducts,
  type DailyMetricValues,
  type ReplaceDailyMetricsInput,
} from './amazon-ads-metrics';
import {
  amazonAdsAdGroupDailyMetrics,
  amazonAdsAdGroups,
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsProductAdDailyMetrics,
  amazonAdsProductAds,
  amazonAdsProfileMetricsImportedThrough,
  amazonAdsProfiles,
  amazonAdsSearchTermDailyMetrics,
  amazonAdsTargetDailyMetrics,
  amazonAdsTargets,
  organizations,
} from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let organizationId = '';
let otherOrganizationId = '';
let profileId = '';
let secondProfileId = '';
let foreignProfileId = '';

const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const SD = 'SPONSORED_DISPLAY';
/** Wie `REPORT_AD_PRODUCT_SELECTION` in `@profitbash/amazon-ads` (1.9). */
const SELECTION = { always: [SP], withCampaigns: [SB] };
const now = new Date('2026-09-27T06:00:00Z');
const later = new Date('2026-09-28T06:00:00Z');

const values = (overrides: Partial<DailyMetricValues> = {}): DailyMetricValues => ({
  impressions: 1000,
  clicks: 10,
  cost: '12.34',
  sales7d: '0.1',
  sales14d: '1234567.89',
  salesSameSku7d: '0.005',
  salesSameSku14d: '0.005',
  purchases7d: 1,
  purchases14d: 2,
  purchasesSameSku7d: 1,
  purchasesSameSku14d: 1,
  units7d: 1,
  units14d: 3,
  unitsSameSku7d: 1,
  unitsSameSku14d: 2,
  salesClicks14d: null,
  purchasesClicks14d: null,
  unitsClicks14d: null,
  extra: {},
  ...overrides,
});

const WINDOW = [{ startDate: '2026-09-01', endDate: '2026-09-03' }];

function campaignImport(
  rows: Array<{ date: string; amazonCampaignId: string } & Partial<DailyMetricValues>>,
  overrides: Partial<ReplaceDailyMetricsInput> = {},
): ReplaceDailyMetricsInput {
  return {
    organizationId,
    profileId,
    adProduct: SP,
    ranges: WINDOW,
    invalidRowCount: 0,
    now,
    level: 'campaign',
    rows: rows.map(({ date, amazonCampaignId, ...rest }) => ({
      date,
      amazonCampaignId,
      campaignName: `Name ${amazonCampaignId}`,
      ...values(rest),
    })),
    ...overrides,
  } as ReplaceDailyMetricsInput;
}

async function campaignMetrics(forProfileId = profileId) {
  return testDb.db
    .select({
      date: amazonAdsCampaignDailyMetrics.date,
      amazonCampaignId: amazonAdsCampaigns.amazonCampaignId,
      adProduct: amazonAdsCampaignDailyMetrics.adProduct,
      clicks: amazonAdsCampaignDailyMetrics.clicks,
      cost: amazonAdsCampaignDailyMetrics.cost,
    })
    .from(amazonAdsCampaignDailyMetrics)
    .innerJoin(
      amazonAdsCampaigns,
      eq(amazonAdsCampaigns.id, amazonAdsCampaignDailyMetrics.campaignId),
    )
    .where(eq(amazonAdsCampaignDailyMetrics.profileId, forProfileId))
    .orderBy(
      asc(amazonAdsCampaignDailyMetrics.date),
      asc(amazonAdsCampaigns.amazonCampaignId),
      asc(amazonAdsCampaignDailyMetrics.adProduct),
    );
}

async function clearCampaignMetrics() {
  await testDb.db.delete(amazonAdsCampaignDailyMetrics);
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createTestOrganization(testDb.db, 'muuv');
  otherOrganizationId = await createTestOrganization(testDb.db, 'andere');
  const connectionId = await createTestConnection(testDb.db, organizationId, 'amzn1.account.A');
  const otherConnectionId = await createTestConnection(
    testDb.db,
    otherOrganizationId,
    'amzn1.account.B',
  );
  profileId = await createTestProfile(testDb.db, {
    organizationId,
    connectionId,
    amazonProfileId: '111',
    currencyCode: 'GBP',
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

describe('replaceDailyMetrics: Kampagnen', () => {
  beforeEach(clearCampaignMetrics);

  it('speichert exakte Beträge und Zähler, Währung aus dem Profil, Platzhalter mit Report-Namen', async () => {
    const result = await replaceDailyMetrics(
      testDb.db,
      campaignImport([
        { date: '2026-09-01', amazonCampaignId: 'c-neu' },
        {
          date: '2026-09-02',
          amazonCampaignId: 'c-neu',
          impressions: 9_007_199_254,
          sales7d: null,
          purchases7d: null,
          units7d: null,
          extra: { topOfSearchImpressionShare: '0.25' },
        },
      ]),
    );
    expect(result).toEqual({ rows: 2, skipped: 0, deleted: 0, placeholdersCreated: 1 });

    const [campaign] = await testDb.db
      .select()
      .from(amazonAdsCampaigns)
      .where(
        and(
          eq(amazonAdsCampaigns.profileId, profileId),
          eq(amazonAdsCampaigns.amazonCampaignId, 'c-neu'),
        ),
      );
    expect(campaign).toMatchObject({ adProduct: SP, name: 'Name c-neu', syncedAt: null });

    const rows = await testDb.db
      .select()
      .from(amazonAdsCampaignDailyMetrics)
      .where(eq(amazonAdsCampaignDailyMetrics.profileId, profileId))
      .orderBy(amazonAdsCampaignDailyMetrics.date);
    expect(rows).toMatchObject([
      {
        organizationId,
        campaignId: campaign!.id,
        date: '2026-09-01',
        adProduct: SP,
        currencyCode: 'GBP',
        impressions: 1000,
        clicks: 10,
        cost: '12.34',
        sales7d: '0.1',
        sales14d: '1234567.89',
        salesSameSku7d: '0.005',
        purchases14d: 2,
        unitsSameSku14d: 2,
        importedAt: now,
      },
      {
        date: '2026-09-02',
        impressions: 9_007_199_254,
        sales7d: null,
        purchases7d: null,
        units7d: null,
        extra: { topOfSearchImpressionShare: '0.25' },
      },
    ]);
  });

  it('speichert den Klick-Anteil (SB/SD) in eigenen Spalten und aktualisiert ihn', async () => {
    const row = { date: '2026-09-01', amazonCampaignId: 'c-klick' };
    await replaceDailyMetrics(
      testDb.db,
      campaignImport([
        { ...row, salesClicks14d: '0.005', purchasesClicks14d: 1, unitsClicks14d: 2 },
      ]),
    );
    await replaceDailyMetrics(
      testDb.db,
      campaignImport([
        { ...row, salesClicks14d: '1234567.89', purchasesClicks14d: 3, unitsClicks14d: null },
      ]),
    );
    const rows = await testDb.db
      .select({
        salesClicks14d: amazonAdsCampaignDailyMetrics.salesClicks14d,
        purchasesClicks14d: amazonAdsCampaignDailyMetrics.purchasesClicks14d,
        unitsClicks14d: amazonAdsCampaignDailyMetrics.unitsClicks14d,
      })
      .from(amazonAdsCampaignDailyMetrics)
      .where(eq(amazonAdsCampaignDailyMetrics.profileId, profileId));
    expect(rows).toEqual([
      { salesClicks14d: '1234567.89', purchasesClicks14d: 3, unitsClicks14d: null },
    ]);
  });

  it('aktualisiert beim erneuten Import, statt Zeilen zu verdoppeln', async () => {
    const rows = [{ date: '2026-09-01', amazonCampaignId: 'c-1' }];
    await replaceDailyMetrics(testDb.db, campaignImport(rows));
    const again = await replaceDailyMetrics(
      testDb.db,
      campaignImport([{ ...rows[0]!, clicks: 11, cost: '13' }], { now: later }),
    );
    expect(again).toEqual({ rows: 1, skipped: 0, deleted: 0, placeholdersCreated: 0 });
    expect(await campaignMetrics()).toEqual([
      { date: '2026-09-01', amazonCampaignId: 'c-1', adProduct: SP, clicks: 11, cost: '13' },
    ]);
  });

  it('ersetzt den Ausschnitt: fehlende Zeilen in den Tagen des Auftrags werden gelöscht', async () => {
    await replaceDailyMetrics(
      testDb.db,
      campaignImport(
        [
          { date: '2026-08-31', amazonCampaignId: 'c-1' },
          { date: '2026-09-01', amazonCampaignId: 'c-1' },
          { date: '2026-09-01', amazonCampaignId: 'c-2' },
          { date: '2026-09-03', amazonCampaignId: 'c-2' },
          { date: '2026-09-04', amazonCampaignId: 'c-2' },
        ],
        { ranges: [{ startDate: '2026-08-31', endDate: '2026-09-04' }] },
      ),
    );
    // Anderer Ad-Typ und anderes Profil im selben Zeitraum
    await replaceDailyMetrics(
      testDb.db,
      campaignImport([{ date: '2026-09-02', amazonCampaignId: 'sb-1' }], { adProduct: SB }),
    );
    await replaceDailyMetrics(
      testDb.db,
      campaignImport([{ date: '2026-09-02', amazonCampaignId: 'c-1' }], {
        profileId: secondProfileId,
      }),
    );

    const result = await replaceDailyMetrics(
      testDb.db,
      campaignImport([{ date: '2026-09-01', amazonCampaignId: 'c-1', clicks: 5 }]),
    );
    expect(result).toEqual({ rows: 1, skipped: 0, deleted: 2, placeholdersCreated: 0 });
    expect(await campaignMetrics()).toEqual([
      { date: '2026-08-31', amazonCampaignId: 'c-1', adProduct: SP, clicks: 10, cost: '12.34' },
      { date: '2026-09-01', amazonCampaignId: 'c-1', adProduct: SP, clicks: 5, cost: '12.34' },
      { date: '2026-09-02', amazonCampaignId: 'sb-1', adProduct: SB, clicks: 10, cost: '12.34' },
      { date: '2026-09-04', amazonCampaignId: 'c-2', adProduct: SP, clicks: 10, cost: '12.34' },
    ]);
    expect(await campaignMetrics(secondProfileId)).toHaveLength(1);
  });

  it('schreibt und löscht nur in den übergebenen Tagen (überholte Tage bleiben unberührt)', async () => {
    await replaceDailyMetrics(
      testDb.db,
      campaignImport([
        { date: '2026-09-01', amazonCampaignId: 'c-1' },
        { date: '2026-09-02', amazonCampaignId: 'c-1' },
        { date: '2026-09-03', amazonCampaignId: 'c-1' },
      ]),
    );
    const result = await replaceDailyMetrics(
      testDb.db,
      campaignImport(
        [
          { date: '2026-09-01', amazonCampaignId: 'c-3' },
          { date: '2026-09-02', amazonCampaignId: 'c-3' },
          { date: '2026-09-03', amazonCampaignId: 'c-3' },
        ],
        {
          ranges: [
            { startDate: '2026-09-01', endDate: '2026-09-01' },
            { startDate: '2026-09-03', endDate: '2026-09-03' },
          ],
        },
      ),
    );
    expect(result).toEqual({ rows: 2, skipped: 1, deleted: 2, placeholdersCreated: 1 });
    expect((await campaignMetrics()).map((r) => `${r.date} ${r.amazonCampaignId}`)).toEqual([
      '2026-09-01 c-3',
      '2026-09-02 c-1',
      '2026-09-03 c-3',
    ]);
  });

  it('löscht nichts, wenn der Auftrag ungültige Zeilen hatte', async () => {
    await replaceDailyMetrics(
      testDb.db,
      campaignImport([
        { date: '2026-09-01', amazonCampaignId: 'c-1' },
        { date: '2026-09-02', amazonCampaignId: 'c-1' },
      ]),
    );
    const result = await replaceDailyMetrics(
      testDb.db,
      campaignImport([{ date: '2026-09-01', amazonCampaignId: 'c-1', clicks: 7 }], {
        invalidRowCount: 1,
      }),
    );
    expect(result.deleted).toBe(0);
    expect((await campaignMetrics()).map((r) => r.clicks)).toEqual([7, 10]);
  });

  it('lehnt 0 Zeilen ab, wenn der Ausschnitt schon Kennzahlen hat', async () => {
    await replaceDailyMetrics(
      testDb.db,
      campaignImport([{ date: '2026-09-02', amazonCampaignId: 'c-1' }]),
    );
    await expect(replaceDailyMetrics(testDb.db, campaignImport([]))).rejects.toBeInstanceOf(
      MetricsImportRejectedError,
    );
    expect(await campaignMetrics()).toHaveLength(1);
  });

  it('nimmt 0 Zeilen an, wenn der Ausschnitt leer ist', async () => {
    const result = await replaceDailyMetrics(testDb.db, campaignImport([]));
    expect(result).toEqual({ rows: 0, skipped: 0, deleted: 0, placeholdersCreated: 0 });
  });

  it('lehnt eine Datei ab, deren Zeilen alle ungültig sind', async () => {
    await expect(
      replaceDailyMetrics(testDb.db, campaignImport([], { invalidRowCount: 3 })),
    ).rejects.toThrow(MetricsImportRejectedError);
  });

  it('lehnt doppelte Zeilen (gleicher Tag, gleiche Kampagne) ab', async () => {
    await expect(
      replaceDailyMetrics(
        testDb.db,
        campaignImport([
          { date: '2026-09-01', amazonCampaignId: 'c-1' },
          { date: '2026-09-01', amazonCampaignId: 'c-1' },
        ]),
      ),
    ).rejects.toThrow(MetricsImportRejectedError);
  });

  it('schreibt große Lieferungen in Stücken', async () => {
    const many = Array.from({ length: 2500 }, (_, i) => ({
      date: '2026-09-01',
      amazonCampaignId: `c-viele-${i}`,
    }));
    const result = await replaceDailyMetrics(testDb.db, campaignImport(many));
    expect(result.rows).toBe(2500);
    const again = await replaceDailyMetrics(testDb.db, campaignImport(many.slice(0, 1200)));
    expect(again.deleted).toBe(1300);
  });

  it('läuft in der Transaktion des Aufrufers; eine Ablehnung lässt sie abbrechen', async () => {
    await expect(
      testDb.db.transaction(async (tx) => {
        await replaceDailyMetrics(
          tx,
          campaignImport([{ date: '2026-09-01', amazonCampaignId: 'c-1' }]),
        );
        await replaceDailyMetrics(tx, campaignImport([]));
      }),
    ).rejects.toBeInstanceOf(MetricsImportRejectedError);
    expect(await campaignMetrics()).toEqual([]);
  });

  it('lehnt ein Profil einer anderen Organisation ab', async () => {
    await expect(
      replaceDailyMetrics(
        testDb.db,
        campaignImport([{ date: '2026-09-01', amazonCampaignId: 'c-1' }], {
          profileId: foreignProfileId,
        }),
      ),
    ).rejects.toThrow('Profil');
  });
});

describe('replaceDailyMetrics: weitere Ebenen', () => {
  const base = {
    get organizationId() {
      return organizationId;
    },
    get profileId() {
      return profileId;
    },
    adProduct: SP,
    ranges: WINDOW,
    invalidRowCount: 0,
    now,
  };

  it('Ad Groups: legt Kampagne und Ad Group als Platzhalter an', async () => {
    const result = await replaceDailyMetrics(testDb.db, {
      ...base,
      level: 'adGroup',
      rows: [
        {
          date: '2026-09-01',
          amazonCampaignId: 'c-ag',
          amazonAdGroupId: 'ag-1',
          campaignName: 'Kampagne AG',
          adGroupName: 'Ad Group 1',
          ...values(),
        },
      ],
    });
    expect(result.placeholdersCreated).toBe(2);
    const [adGroup] = await testDb.db
      .select()
      .from(amazonAdsAdGroups)
      .where(eq(amazonAdsAdGroups.amazonAdGroupId, 'ag-1'));
    expect(adGroup).toMatchObject({ name: 'Ad Group 1', syncedAt: null });
    const [metric] = await testDb.db.select().from(amazonAdsAdGroupDailyMetrics);
    expect(metric).toMatchObject({ adGroupId: adGroup!.id, date: '2026-09-01' });
  });

  it('Targets: auch ohne Ad Group (Kampagnenebene)', async () => {
    const result = await replaceDailyMetrics(testDb.db, {
      ...base,
      level: 'target',
      rows: [
        {
          date: '2026-09-01',
          amazonCampaignId: 'c-t',
          amazonAdGroupId: 'ag-t',
          amazonTargetId: 't-1',
          ...values(),
        },
        {
          date: '2026-09-01',
          amazonCampaignId: 'c-t',
          amazonAdGroupId: null,
          amazonTargetId: 't-kampagne',
          ...values(),
        },
      ],
    });
    expect(result).toMatchObject({ rows: 2, placeholdersCreated: 4 });
    const targets = await testDb.db
      .select()
      .from(amazonAdsTargets)
      .where(eq(amazonAdsTargets.profileId, profileId))
      .orderBy(amazonAdsTargets.amazonTargetId);
    expect(targets).toMatchObject([
      { amazonTargetId: 't-1', targetType: null, state: null, bid: null, syncedAt: null },
      { amazonTargetId: 't-kampagne', adGroupId: null },
    ]);
    expect(await testDb.db.select().from(amazonAdsTargetDailyMetrics)).toHaveLength(2);
  });

  it('Product Ads: Platzhalter mit ASIN und SKU aus dem Report', async () => {
    await replaceDailyMetrics(testDb.db, {
      ...base,
      level: 'productAd',
      rows: [
        {
          date: '2026-09-01',
          amazonCampaignId: 'c-p',
          amazonAdGroupId: 'ag-p',
          amazonAdId: 'ad-1',
          asin: 'B000000001',
          sku: null,
          ...values(),
        },
      ],
    });
    const [ad] = await testDb.db
      .select()
      .from(amazonAdsProductAds)
      .where(eq(amazonAdsProductAds.amazonAdId, 'ad-1'));
    expect(ad).toMatchObject({ asin: 'B000000001', sku: null, syncedAt: null });
    expect(await testDb.db.select().from(amazonAdsProductAdDailyMetrics)).toMatchObject([
      { productAdId: ad!.id },
    ]);
  });

  it('Suchbegriffe: Schlüssel mit Text, bezogen auf das Target', async () => {
    const row = (date: string, searchTerm: string, clicks: number) => ({
      date,
      amazonCampaignId: 'c-t',
      amazonAdGroupId: 'ag-t',
      amazonTargetId: 't-1',
      searchTerm,
      ...values({ clicks }),
    });
    await replaceDailyMetrics(testDb.db, {
      ...base,
      level: 'searchTerm',
      rows: [
        row('2026-09-01', 'laufschuhe', 1),
        row('2026-09-01', 'laufschuhe herren', 2),
        row('2026-09-02', 'laufschuhe', 3),
      ],
    });
    const result = await replaceDailyMetrics(testDb.db, {
      ...base,
      level: 'searchTerm',
      rows: [row('2026-09-01', 'laufschuhe', 4), row('2026-09-02', 'laufschuhe', 3)],
    });
    expect(result).toEqual({ rows: 2, skipped: 0, deleted: 1, placeholdersCreated: 0 });
    const rows = await testDb.db
      .select({
        date: amazonAdsSearchTermDailyMetrics.date,
        searchTerm: amazonAdsSearchTermDailyMetrics.searchTerm,
        clicks: amazonAdsSearchTermDailyMetrics.clicks,
      })
      .from(amazonAdsSearchTermDailyMetrics)
      .orderBy(amazonAdsSearchTermDailyMetrics.date);
    expect(rows).toEqual([
      { date: '2026-09-01', searchTerm: 'laufschuhe', clicks: 4 },
      { date: '2026-09-02', searchTerm: 'laufschuhe', clicks: 3 },
    ]);
  });
});

describe('markMetricsImportedThrough', () => {
  beforeEach(async () => {
    await testDb.db.delete(amazonAdsProfileMetricsImportedThrough);
  });

  async function marks(profile = secondProfileId) {
    return testDb.db
      .select({
        adProduct: amazonAdsProfileMetricsImportedThrough.adProduct,
        date: amazonAdsProfileMetricsImportedThrough.importedThrough,
      })
      .from(amazonAdsProfileMetricsImportedThrough)
      .where(eq(amazonAdsProfileMetricsImportedThrough.profileId, profile))
      .orderBy(asc(amazonAdsProfileMetricsImportedThrough.adProduct));
  }
  const mark = (
    date: string,
    overrides: Partial<{ organizationId: string; profileId: string; adProduct: string }> = {},
  ) =>
    markMetricsImportedThrough(testDb.db, {
      organizationId,
      profileId: secondProfileId,
      adProduct: SP,
      date,
      ...overrides,
    });

  it('setzt den Tag und rückt nur vor, nie zurück (Historie nach dem Fenster)', async () => {
    expect(await marks()).toEqual([]);
    await mark('2026-09-26');
    expect(await marks()).toEqual([{ adProduct: SP, date: '2026-09-26' }]);
    await mark('2026-08-01');
    expect(await marks()).toEqual([{ adProduct: SP, date: '2026-09-26' }]);
    await mark('2026-09-27');
    expect(await marks()).toEqual([{ adProduct: SP, date: '2026-09-27' }]);
  });

  it('führt den Tag je Ad-Typ', async () => {
    await mark('2026-09-27');
    await mark('2026-09-20', { adProduct: SB });
    expect(await marks()).toEqual([
      { adProduct: SB, date: '2026-09-20' },
      { adProduct: SP, date: '2026-09-27' },
    ]);
  });

  it('lässt updated_at des Profils unverändert (Datenstand, keine Stammdaten)', async () => {
    const profileUpdatedAt = async () =>
      (
        await testDb.db
          .select({ updatedAt: amazonAdsProfiles.updatedAt })
          .from(amazonAdsProfiles)
          .where(eq(amazonAdsProfiles.id, secondProfileId))
      )[0]!.updatedAt;
    const before = await profileUpdatedAt();
    await mark('2026-09-30');
    expect(await profileUpdatedAt()).toEqual(before);
  });

  it('lehnt ein Profil einer anderen Organisation ab', async () => {
    await expect(mark('2026-09-26', { profileId: foreignProfileId })).rejects.toBeInstanceOf(
      ProfileNotFoundError,
    );
    expect(await marks(foreignProfileId)).toEqual([]);
  });
});

describe('selectReportAdProducts', () => {
  beforeEach(async () => {
    await testDb.db
      .delete(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.profileId, secondProfileId));
  });

  const select = (overrides: Partial<{ organizationId: string; profileId: string }> = {}) =>
    selectReportAdProducts(
      testDb.db,
      { organizationId, profileId: secondProfileId, ...overrides },
      SELECTION,
    );

  it('nimmt SP immer, SB erst mit einer Kampagne dieses Ad-Typs (auch als Platzhalter)', async () => {
    expect(await select()).toEqual([SP]);
    await ensureCampaigns(testDb.db, { organizationId, profileId: secondProfileId }, [
      { amazonCampaignId: 'sd-1', adProduct: SD },
    ]);
    expect(await select()).toEqual([SP]);
    await ensureCampaigns(testDb.db, { organizationId, profileId: secondProfileId }, [
      { amazonCampaignId: 'sb-1', adProduct: SB },
      { amazonCampaignId: 'sb-2', adProduct: SB },
    ]);
    expect(await select()).toEqual([SP, SB]);
  });

  it('zählt nur Kampagnen dieses Profils', async () => {
    await ensureCampaigns(testDb.db, { organizationId, profileId }, [
      { amazonCampaignId: 'sb-anderes-profil', adProduct: SB },
    ]);
    expect(await select()).toEqual([SP]);
  });

  it('lehnt ein Profil einer anderen Organisation ab', async () => {
    await expect(select({ profileId: foreignProfileId })).rejects.toBeInstanceOf(
      ProfileNotFoundError,
    );
  });
});

describe('metricsImportedThroughSql', () => {
  beforeEach(async () => {
    await testDb.db.delete(amazonAdsProfileMetricsImportedThrough);
    await testDb.db
      .delete(amazonAdsCampaigns)
      .where(eq(amazonAdsCampaigns.profileId, secondProfileId));
  });

  async function dataThrough(selection: { always: string[]; withCampaigns: string[] } = SELECTION) {
    const [row] = await testDb.db
      .select({ date: metricsImportedThroughSql(selection) })
      .from(amazonAdsProfiles)
      .where(eq(amazonAdsProfiles.id, secondProfileId));
    return row!.date;
  }
  const mark = (adProduct: string, date: string) =>
    markMetricsImportedThrough(testDb.db, {
      organizationId,
      profileId: secondProfileId,
      adProduct,
      date,
    });
  const campaign = (adProduct: string) =>
    ensureCampaigns(testDb.db, { organizationId, profileId: secondProfileId }, [
      { amazonCampaignId: `${adProduct}-1`, adProduct },
    ]);

  it('ist das Minimum über SP und die Ad-Typen mit Kampagnen: ein hängender Ad-Typ bremst', async () => {
    await mark(SP, '2026-09-27');
    await mark(SB, '2026-09-20');
    // Ohne SB-Kampagne zählt SB nicht (Profil nutzt SB nicht).
    expect(await dataThrough()).toBe('2026-09-27');
    await campaign(SB);
    expect(await dataThrough()).toBe('2026-09-20');
  });

  it('ist leer, solange einem der ausgewählten Ad-Typen ein Tag fehlt', async () => {
    expect(await dataThrough()).toBeNull();
    await mark(SP, '2026-09-27');
    await campaign(SB);
    expect(await dataThrough()).toBeNull();
  });

  it('ignoriert Ad-Typen außerhalb der Auswahl, auch mit Kampagnen', async () => {
    await mark(SP, '2026-09-27');
    await mark(SD, '2026-09-01');
    await campaign(SD);
    expect(await dataThrough()).toBe('2026-09-27');
  });

  it('zählt einen doppelt genannten Ad-Typ einmal', async () => {
    await mark(SP, '2026-09-27');
    await campaign(SP);
    expect(await dataThrough({ always: [SP, SP], withCampaigns: [SP] })).toBe('2026-09-27');
  });

  it('ist leer ohne Ad-Typen', async () => {
    await mark(SP, '2026-09-27');
    expect(await dataThrough({ always: [], withCampaigns: [] })).toBeNull();
  });
});

describe('Löschen', () => {
  it('verhindert das Löschen einer Kampagne mit Kennzahlen', async () => {
    await replaceDailyMetrics(
      testDb.db,
      campaignImport([{ date: '2026-09-01', amazonCampaignId: 'c-del' }], {
        profileId: secondProfileId,
      }),
    );
    await expect(
      testDb.db
        .delete(amazonAdsCampaigns)
        .where(
          and(
            eq(amazonAdsCampaigns.profileId, secondProfileId),
            eq(amazonAdsCampaigns.amazonCampaignId, 'c-del'),
          ),
        ),
    ).rejects.toMatchObject({
      cause: { constraint_name: 'amazon_ads_campaign_daily_metrics_campaign_fk' },
    });
  });

  it('verhindert das Löschen eines Profils mit Kennzahlen', async () => {
    await expect(
      testDb.db.delete(amazonAdsProfiles).where(eq(amazonAdsProfiles.id, profileId)),
    ).rejects.toMatchObject({ cause: { code: '23503' } });
  });

  it('erlaubt das Löschen der ganzen Organisation samt Kennzahlen', async () => {
    await testDb.db.delete(organizations).where(eq(organizations.id, organizationId));
    expect(await testDb.db.select().from(amazonAdsSearchTermDailyMetrics)).toEqual([]);
    expect(await testDb.db.select().from(amazonAdsCampaignDailyMetrics)).toEqual([]);
  });
});
