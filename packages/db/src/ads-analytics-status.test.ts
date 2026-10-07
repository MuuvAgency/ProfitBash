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
const ids = {
  org: '',
  other: '',
  viewer: '',
  connA: '',
  connB: '',
  connC: '',
  de: '',
  fr: '',
  it: '',
  hidden: '',
};

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
  // Neu verbunden: noch kein erfolgreicher Report-Sync, noch kein Datenstand.
  ids.connC = await createTestConnection(db, ids.org, 'amzn1.account.C');
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
  ids.it = await createTestProfile(db, {
    organizationId: ids.org,
    connectionId: ids.connC,
    amazonProfileId: '4',
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

  const deFr = () => ({ ...viewer(), profileIds: [ids.de, ids.fr] });

  it('„Letzter Sync“ = der älteste letzte Erfolg der Connections (eine hängende Connection fällt auf)', async () => {
    // A 04:00, B 05:00 → 04:00; der fehlgeschlagene Lauf und andere Jobs zählen nicht.
    expect((await queryDashboardStatus(testDb.db, deFr(), SELECTION)).lastSyncAt).toBe(
      '2026-09-11T04:00:00.000Z',
    );
    expect(
      (await queryDashboardStatus(testDb.db, { ...viewer(), profileIds: [ids.fr] }, SELECTION))
        .lastSyncAt,
    ).toBe('2026-09-11T05:00:00.000Z');
    // Eine Connection ohne jeden Erfolg: „noch nie“.
    expect((await queryDashboardStatus(testDb.db, viewer(), SELECTION)).lastSyncAt).toBeNull();
  });

  it('„Letzter Sync“ zählt bei Profilen ohne Connection den letzten erfolgreichen Datei-Import (1.11c)', async () => {
    const { eq } = await import('drizzle-orm');
    const [file] = await testDb.db
      .insert(amazonAdsProfiles)
      .values({
        organizationId: ids.org,
        connectionId: null,
        amazonProfileId: null,
        accountName: 'Datei',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
        accountType: 'seller',
      })
      .returning({ id: amazonAdsProfiles.id });
    const status = () =>
      queryDashboardStatus(testDb.db, { ...viewer(), profileIds: [ids.de, file!.id] }, SELECTION);
    try {
      // Noch kein Import: „noch nie“, wie eine neue Connection.
      expect((await status()).lastSyncAt).toBeNull();
      await testDb.db.insert(jobRuns).values([
        {
          organizationId: ids.org,
          job: 'file-import',
          scope: file!.id,
          status: 'success',
          startedAt: new Date('2026-09-11T02:00:00Z'),
          finishedAt: new Date('2026-09-11T02:00:00Z'),
          counters: { files: 1, imported: 1, filesFailed: 0 },
        },
        // Erfolgreich, aber nichts importiert (z. B. von einem neueren Lauf übernommen): zählt nicht.
        {
          organizationId: ids.org,
          job: 'file-import',
          scope: file!.id,
          status: 'success',
          startedAt: new Date('2026-09-11T08:00:00Z'),
          finishedAt: new Date('2026-09-11T08:00:00Z'),
          counters: { files: 0, imported: 0, filesFailed: 0 },
        },
        {
          organizationId: ids.org,
          job: 'file-import',
          scope: file!.id,
          status: 'failed',
          startedAt: new Date('2026-09-11T09:00:00Z'),
          finishedAt: new Date('2026-09-11T09:00:00Z'),
        },
      ]);
      // Ältester letzter Erfolg: Datei 02:00 vor Connection A 04:00; der gescheiterte zählt nicht.
      expect((await status()).lastSyncAt).toBe('2026-09-11T02:00:00.000Z');
    } finally {
      await testDb.db.delete(jobRuns).where(eq(jobRuns.scope, file!.id));
      await testDb.db.delete(amazonAdsProfiles).where(eq(amazonAdsProfiles.id, file!.id));
    }
  });

  it('„Daten bis“ je Ad-Typ und hängende Ad-Typen je Profil (nicht über verschiedene Profile verglichen)', async () => {
    const status = await queryDashboardStatus(testDb.db, deFr(), SELECTION);
    expect(status.adProducts).toEqual([
      // In DE steht SB (07.09.) hinter SP (10.09.).
      { adProduct: SB, dataThrough: '2026-09-07', profilesWithoutData: 0, profilesBehind: 1 },
      // FR hat SD-Kampagnen, aber noch keinen Datenstand dafür.
      { adProduct: SD, dataThrough: null, profilesWithoutData: 1, profilesBehind: 0 },
      // FR-SP (09.09.) liegt hinter DE-SP (10.09.), ist aber in FR nicht hinter einem anderen Ad-Typ: kein Alarm.
      { adProduct: SP, dataThrough: '2026-09-09', profilesWithoutData: 0, profilesBehind: 0 },
    ]);
    const all = await queryDashboardStatus(testDb.db, viewer(), SELECTION);
    expect(all.adProducts.find((p) => p.adProduct === SP)).toEqual({
      adProduct: SP,
      dataThrough: null,
      profilesWithoutData: 1,
      profilesBehind: 0,
    });
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
