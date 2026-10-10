import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ProfileNotFoundError } from './amazon-ads-entities';
import {
  findProfileMetricsState,
  listEntityPeriodMetrics,
  listLatestEntityPeriodMetrics,
  replaceEntityPeriodMetrics,
  type EntityPeriodMetric,
} from './entity-period-metrics';
import { amazonAdsEntityPeriodMetrics } from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

const SP = 'SPONSORED_PRODUCTS';
const SD = 'SPONSORED_DISPLAY';
const C1 = '300000000000001';
const C2 = '300000000000002';
const AG1 = '400000000000001';
const KW1 = '600000000000001';
const SEPTEMBER = { startDate: '2099-09-01', endDate: '2099-09-30' };
const OCTOBER = { startDate: '2099-10-01', endDate: '2099-10-30' };
const now = new Date('2099-10-31T06:00:00Z');
const later = new Date('2099-11-01T06:00:00Z');

let testDb: TestDatabase;
let organizationId = '';
let otherOrganizationId = '';
let profileId = '';
let foreignProfileId = '';

const metric = (overrides: Partial<EntityPeriodMetric> = {}): EntityPeriodMetric => ({
  level: 'campaign',
  amazonCampaignId: C1,
  amazonEntityId: C1,
  impressions: 1000,
  clicks: 20,
  cost: '12.34',
  sales: '99.9',
  purchases: 3,
  units: 4,
  ...overrides,
});

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
  foreignProfileId = await createTestProfile(testDb.db, {
    organizationId: otherOrganizationId,
    connectionId: otherConnectionId,
    amazonProfileId: '333',
  });
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(amazonAdsEntityPeriodMetrics);
});

const scope = () => ({ organizationId, profileId });

describe('replaceEntityPeriodMetrics', () => {
  it('speichert Summen je Ebene mit der Währung des Profils', async () => {
    const result = await replaceEntityPeriodMetrics(testDb.db, {
      ...scope(),
      adProduct: SP,
      period: SEPTEMBER,
      currencyCode: 'GBP',
      rows: [
        metric(),
        metric({ level: 'adGroup', amazonEntityId: AG1 }),
        metric({ level: 'target', amazonEntityId: KW1 }),
        metric({ level: 'placement', amazonEntityId: 'PLACEMENT_TOP', cost: '0.1' }),
      ],
      replace: 'period',
      now,
    });
    expect(result).toEqual({ rows: 4, deleted: 0 });
    const rows = await listEntityPeriodMetrics(testDb.db, {
      ...scope(),
      period: SEPTEMBER,
      level: 'placement',
    });
    expect(rows).toEqual([
      expect.objectContaining({
        adProduct: SP,
        amazonCampaignId: C1,
        amazonEntityId: 'PLACEMENT_TOP',
        currencyCode: 'GBP',
        impressions: 1000,
        clicks: 20,
        cost: '0.1',
        sales: '99.9',
        purchases: 3,
        units: 4,
        viewableImpressions: null,
        salesViewsClicks: null,
      }),
    ]);
  });

  it('speichert die SD-Werte mit Views getrennt', async () => {
    await replaceEntityPeriodMetrics(testDb.db, {
      ...scope(),
      adProduct: SD,
      period: SEPTEMBER,
      currencyCode: 'GBP',
      rows: [
        metric({
          viewableImpressions: 800,
          salesViewsClicks: '150',
          purchasesViewsClicks: 5,
          unitsViewsClicks: 6,
        }),
      ],
      replace: 'period',
      now,
    });
    const [row] = await listEntityPeriodMetrics(testDb.db, {
      ...scope(),
      period: SEPTEMBER,
      level: 'campaign',
    });
    expect(row).toMatchObject({
      viewableImpressions: 800,
      salesViewsClicks: '150',
      purchasesViewsClicks: 5,
      unitsViewsClicks: 6,
    });
  });

  it('ersetzt denselben Zeitraum (ganz oder nur die Kampagnen der Datei), andere Zeiträume bleiben', async () => {
    const write = (
      period: typeof SEPTEMBER,
      rows: EntityPeriodMetric[],
      replace: 'period' | { amazonCampaignIds: string[] },
    ) =>
      replaceEntityPeriodMetrics(testDb.db, {
        ...scope(),
        adProduct: SP,
        period,
        currencyCode: 'GBP',
        rows,
        replace,
        now,
      });
    await write(
      SEPTEMBER,
      [metric(), metric({ amazonCampaignId: C2, amazonEntityId: C2 })],
      'period',
    );
    await write(OCTOBER, [metric()], 'period');
    // Teilmenge: nur C1 ersetzt, C2 bleibt.
    expect(await write(SEPTEMBER, [metric({ clicks: 99 })], { amazonCampaignIds: [C1] })).toEqual({
      rows: 1,
      deleted: 1,
    });
    const september = await listEntityPeriodMetrics(testDb.db, {
      ...scope(),
      period: SEPTEMBER,
      level: 'campaign',
    });
    expect(september.map((r) => [r.amazonEntityId, r.clicks])).toEqual([
      [C1, 99],
      [C2, 20],
    ]);
    // Ganze Datei: alles im Zeitraum ersetzt.
    await write(SEPTEMBER, [metric({ clicks: 7 })], 'period');
    expect(
      (
        await listEntityPeriodMetrics(testDb.db, {
          ...scope(),
          period: SEPTEMBER,
          level: 'campaign',
        })
      ).map((r) => [r.amazonEntityId, r.clicks]),
    ).toEqual([[C1, 7]]);
    expect(
      await listEntityPeriodMetrics(testDb.db, { ...scope(), period: OCTOBER, level: 'campaign' }),
    ).toHaveLength(1);
  });

  it('löscht ohne Zeilen nichts (Datei ohne Leistungsdaten)', async () => {
    await replaceEntityPeriodMetrics(testDb.db, {
      ...scope(),
      adProduct: SP,
      period: SEPTEMBER,
      currencyCode: 'GBP',
      rows: [metric()],
      replace: 'period',
      now,
    });
    expect(
      await replaceEntityPeriodMetrics(testDb.db, {
        ...scope(),
        adProduct: SP,
        period: SEPTEMBER,
        currencyCode: 'GBP',
        rows: [],
        replace: 'period',
        now,
      }),
    ).toEqual({ rows: 0, deleted: 0 });
    expect(
      await listEntityPeriodMetrics(testDb.db, {
        ...scope(),
        period: SEPTEMBER,
        level: 'campaign',
      }),
    ).toHaveLength(1);
  });

  it('lehnt ein Profil einer anderen Organisation ab', async () => {
    await expect(
      replaceEntityPeriodMetrics(testDb.db, {
        organizationId,
        profileId: foreignProfileId,
        adProduct: SP,
        period: SEPTEMBER,
        currencyCode: 'EUR',
        rows: [metric()],
        replace: 'period',
        now,
      }),
    ).rejects.toBeInstanceOf(ProfileNotFoundError);
  });
});

describe('findProfileMetricsState', () => {
  it('nennt den Zeitraum der zuletzt importierten Datei, sonst null', async () => {
    expect(await findProfileMetricsState(testDb.db, scope())).toBeNull();
    await replaceEntityPeriodMetrics(testDb.db, {
      ...scope(),
      adProduct: SP,
      period: OCTOBER,
      currencyCode: 'GBP',
      rows: [metric()],
      replace: 'period',
      now,
    });
    // Später hochgeladen, aber älterer Zeitraum: Der Datenstand folgt dem Upload.
    await replaceEntityPeriodMetrics(testDb.db, {
      ...scope(),
      adProduct: SP,
      period: SEPTEMBER,
      currencyCode: 'GBP',
      rows: [metric()],
      replace: 'period',
      now: later,
    });
    expect(await findProfileMetricsState(testDb.db, scope())).toEqual({
      period: SEPTEMBER,
      importedAt: later,
      source: 'file',
    });
    expect(
      await findProfileMetricsState(testDb.db, { organizationId: otherOrganizationId, profileId }),
    ).toBeNull();
  });
});

describe('listLatestEntityPeriodMetrics', () => {
  it('nimmt je Entity die zuletzt hochgeladene Datei, die sie enthält (Teil-Export lässt die übrigen stehen)', async () => {
    await replaceEntityPeriodMetrics(testDb.db, {
      ...scope(),
      adProduct: SP,
      period: SEPTEMBER,
      currencyCode: 'GBP',
      rows: [metric(), metric({ amazonCampaignId: C2, amazonEntityId: C2 })],
      replace: 'period',
      now,
    });
    // Neuere Datei nur mit C1 (Teil-Export).
    await replaceEntityPeriodMetrics(testDb.db, {
      ...scope(),
      adProduct: SP,
      period: OCTOBER,
      currencyCode: 'GBP',
      rows: [metric({ clicks: 5 })],
      replace: { amazonCampaignIds: [C1] },
      now: later,
    });
    const rows = await listLatestEntityPeriodMetrics(testDb.db, { ...scope(), level: 'campaign' });
    expect(rows.map((r) => [r.amazonEntityId, r.periodStart, r.periodEnd, r.clicks])).toEqual([
      [C1, OCTOBER.startDate, OCTOBER.endDate, 5],
      [C2, SEPTEMBER.startDate, SEPTEMBER.endDate, 20],
    ]);
    expect(await listLatestEntityPeriodMetrics(testDb.db, { ...scope(), level: 'target' })).toEqual(
      [],
    );
    expect(
      await listLatestEntityPeriodMetrics(testDb.db, {
        organizationId: otherOrganizationId,
        profileId,
        level: 'campaign',
      }),
    ).toEqual([]);
  });
});
