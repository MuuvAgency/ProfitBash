import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { queryDashboardStatus } from './ads-analytics';
import { markMetricsImportedThrough } from './amazon-ads-metrics';
import {
  amazonAdsCampaignDailyMetrics,
  amazonAdsCampaigns,
  amazonAdsProfiles,
  jobRuns,
  members,
  users,
} from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/**
 * Datenstand fürs Dashboard (2.7, F11): letzter Sync der Connections der Auswahl, „Daten bis“ je Ad-Typ (hängende
 * Ad-Typen) und SB-Kampagnen ohne Kennzahlen (v3-Preview-Lücke).
 */

const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';
const SD = 'SPONSORED_DISPLAY';
const SELECTION = { always: [SP], withCampaigns: [SB, SD] };

let testDb: TestDatabase;
const ids = { org: '', other: '', viewer: '', connA: '', connB: '', de: '', fr: '', hidden: '' };

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.other = await createTestOrganization(db, 'andere');
  const [viewer] = await db
    .insert(users)
    .values({ name: 'Vera', email: 'vera@muuv.test' })
    .returning({ id: users.id });
  ids.viewer = viewer!.id;
  await db
    .insert(members)
    .values({ organizationId: ids.org, userId: ids.viewer, role: 'viewer', createdAt: new Date() });
  ids.connA = await createTestConnection(db, ids.org, 'amzn1.account.A');
  ids.connB = await createTestConnection(db, ids.org, 'amzn1.account.B');
  ids.de = await createTestProfile(db, {
    organizationId: ids.org,
    connectionId: ids.connA,
    amazonProfileId: '1',
  });
  ids.fr = await createTestProfile(db, {
    organizationId: ids.org,
    connectionId: ids.connB,
    amazonProfileId: '2',
  });
  ids.hidden = await createTestProfile(db, {
    organizationId: ids.org,
    connectionId: ids.connB,
    amazonProfileId: '3',
  });
  const { eq } = await import('drizzle-orm');
  await db
    .update(amazonAdsProfiles)
    .set({ isHidden: true })
    .where(eq(amazonAdsProfiles.id, ids.hidden));

  const campaign = (
    profileId: string,
    amazonCampaignId: string,
    adProduct: string,
    extra = {},
  ) => ({
    organizationId: ids.org,
    profileId,
    amazonCampaignId,
    adProduct,
    name: amazonCampaignId,
    state: 'ENABLED',
    syncedAt: new Date(),
    ...extra,
  });
  const [, sbWith] = await db
    .insert(amazonAdsCampaigns)
    .values([
      campaign(ids.de, 'sp', SP),
      campaign(ids.de, 'sb-mit', SB),
      campaign(ids.de, 'sb-ohne-1', SB),
      campaign(ids.de, 'sb-ohne-2', SB),
      campaign(ids.de, 'sb-entfernt', SB, { removedAt: new Date() }),
      campaign(ids.fr, 'sp-fr', SP),
      campaign(ids.fr, 'sd-fr', SD),
      campaign(ids.hidden, 'sb-versteckt', SB),
    ])
    .returning({ id: amazonAdsCampaigns.id });
  await db.insert(amazonAdsCampaignDailyMetrics).values({
    organizationId: ids.org,
    profileId: ids.de,
    campaignId: sbWith!.id,
    date: '2026-09-01',
    adProduct: SB,
    currencyCode: 'EUR',
    impressions: 10,
    clicks: 1,
    cost: '1.00',
    importedAt: new Date(),
  });

  for (const [profileId, adProduct, date] of [
    [ids.de, SP, '2026-09-10'],
    [ids.de, SB, '2026-09-07'],
    [ids.fr, SP, '2026-09-09'],
  ] as const) {
    await markMetricsImportedThrough(db, { organizationId: ids.org, profileId, adProduct, date });
  }

  const run = (
    organizationId: string | null,
    job: string,
    scope: string,
    status: 'success' | 'failed',
    finishedAt: string,
  ) => ({
    organizationId,
    job,
    scope,
    status,
    startedAt: new Date(finishedAt),
    finishedAt: new Date(finishedAt),
  });
  await db
    .insert(jobRuns)
    .values([
      run(ids.org, 'reports-sync', ids.connA, 'success', '2026-09-11T04:00:00Z'),
      run(ids.org, 'reports-sync', ids.connB, 'success', '2026-09-11T05:00:00Z'),
      run(ids.org, 'reports-sync', ids.connA, 'failed', '2026-09-11T06:00:00Z'),
      run(ids.org, 'entities-sync', ids.connA, 'success', '2026-09-11T07:00:00Z'),
      run(ids.other, 'reports-sync', ids.connA, 'success', '2026-09-11T08:00:00Z'),
    ]);
});

afterAll(() => testDb?.close());

describe('queryDashboardStatus', () => {
  const viewer = () => ({ userId: ids.viewer, orgId: ids.org });

  it('letzter erfolgreicher Report-Sync der Connections in der Auswahl', async () => {
    const all = await queryDashboardStatus(testDb.db, viewer(), SELECTION);
    expect(all.lastSyncAt).toBe('2026-09-11T05:00:00.000Z');
    const onlyDe = await queryDashboardStatus(
      testDb.db,
      { ...viewer(), profileIds: [ids.de] },
      SELECTION,
    );
    // Der fehlgeschlagene Lauf und andere Jobs zählen nicht.
    expect(onlyDe.lastSyncAt).toBe('2026-09-11T04:00:00.000Z');
  });

  it('„Daten bis“ je Ad-Typ, den die Auswahl nutzt; fehlt ein Profil, ist der Ad-Typ offen', async () => {
    const status = await queryDashboardStatus(testDb.db, viewer(), SELECTION);
    expect(status.adProducts).toEqual([
      { adProduct: SB, dataThrough: '2026-09-07', profilesWithoutData: 0 },
      // FR hat SD-Kampagnen, aber noch keinen Datenstand dafür.
      { adProduct: SD, dataThrough: null, profilesWithoutData: 1 },
      { adProduct: SP, dataThrough: '2026-09-09', profilesWithoutData: 0 },
    ]);
  });

  it('SB-Kampagnen ohne jede Kennzahl (Preview-Lücke), ohne entfernte und ausgeblendete', async () => {
    const status = await queryDashboardStatus(testDb.db, viewer(), SELECTION);
    expect(status.sbCampaignsWithoutMetrics).toBe(2);
  });

  it('fremde Organisation oder Nicht-Mitglied: leer', async () => {
    expect(
      await queryDashboardStatus(testDb.db, { userId: ids.viewer, orgId: ids.other }, SELECTION),
    ).toEqual({ lastSyncAt: null, adProducts: [], sbCampaignsWithoutMetrics: 0 });
  });
});
