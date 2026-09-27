import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { completeBackfill, ensureBackfill } from './amazon-backfills';
import { amazonAdsBackfills } from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
let organizationId = '';
let otherOrganizationId = '';
let profileId = '';

const SP = 'SPONSORED_PRODUCTS';
const now = new Date('2026-09-27T06:00:00Z');

const key = () => ({ organizationId, profileId, adProduct: SP, reportType: 'spCampaigns' });

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createTestOrganization(testDb.db, 'muuv');
  otherOrganizationId = await createTestOrganization(testDb.db, 'andere');
  const connectionId = await createTestConnection(testDb.db, organizationId, 'amzn1.account.A');
  profileId = await createTestProfile(testDb.db, {
    organizationId,
    connectionId,
    amazonProfileId: '111',
  });
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(amazonAdsBackfills);
});

describe('ensureBackfill', () => {
  it('legt den Merker beim ersten Aufruf an und behält danach den ersten Beginn', async () => {
    const first = await ensureBackfill(testDb.db, { ...key(), fromDate: '2026-06-25' });
    expect(first).toMatchObject({ ...key(), fromDate: '2026-06-25', completedAt: null });

    const again = await ensureBackfill(testDb.db, { ...key(), fromDate: '2026-06-26' });
    expect(again).toEqual(first);
  });

  it('trennt nach Report-Typ und Ad-Typ', async () => {
    const campaigns = await ensureBackfill(testDb.db, { ...key(), fromDate: '2026-06-25' });
    const targeting = await ensureBackfill(testDb.db, {
      ...key(),
      reportType: 'spTargeting',
      fromDate: '2026-06-25',
    });
    const brands = await ensureBackfill(testDb.db, {
      ...key(),
      adProduct: 'SPONSORED_BRANDS',
      fromDate: '2026-07-30',
    });
    expect(new Set([campaigns.id, targeting.id, brands.id]).size).toBe(3);
  });

  it('verweigert ein Profil einer anderen Organisation (zusammengesetzter FK)', async () => {
    await expect(
      ensureBackfill(testDb.db, {
        ...key(),
        organizationId: otherOrganizationId,
        fromDate: '2026-06-25',
      }),
    ).rejects.toMatchObject({ cause: { constraint_name: 'amazon_ads_backfills_profile_org_fk' } });
  });
});

describe('completeBackfill', () => {
  it('setzt completed_at nur im Org-Kontext', async () => {
    const backfill = await ensureBackfill(testDb.db, { ...key(), fromDate: '2026-06-25' });

    await completeBackfill(testDb.db, {
      organizationId: otherOrganizationId,
      id: backfill.id,
      now,
    });
    expect(
      (await ensureBackfill(testDb.db, { ...key(), fromDate: '2026-06-25' })).completedAt,
    ).toBe(null);

    await completeBackfill(testDb.db, { organizationId, id: backfill.id, now });
    expect(
      (await ensureBackfill(testDb.db, { ...key(), fromDate: '2026-06-25' })).completedAt,
    ).toEqual(now);
  });
});
