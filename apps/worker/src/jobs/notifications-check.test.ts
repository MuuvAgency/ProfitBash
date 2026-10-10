import { createNotification, schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createOrganization } from '../testing';
import { checkNotifications } from './notifications-check';

const { amazonAdsProfiles, notifications } = schema;

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2099-10-10T05:00:00Z');

let testDb: TestDatabase;
let organizationId = '';

beforeAll(async () => {
  testDb = await createTestDatabase();
  organizationId = await createOrganization(testDb.db, 'muuv');
});

afterAll(async () => {
  await testDb.close();
});

describe('checkNotifications', () => {
  it('erzeugt die zeitgesteuerten Meldungen und räumt alte auf', async () => {
    await testDb.db.insert(amazonAdsProfiles).values({
      organizationId,
      accountName: 'Datei',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
      createdAt: new Date(now.getTime() - 10 * DAY),
    });
    const old = await createNotification(testDb.db, {
      organizationId,
      audience: 'admins',
      kind: 'consent_expiring',
      severity: 'warning',
    });
    await testDb.db
      .update(notifications)
      .set({ createdAt: new Date(now.getTime() - 400 * DAY) })
      .where(eq(notifications.id, old!));

    const outcome = await checkNotifications({ db: testDb.db, now: () => now });

    expect(outcome).toEqual({
      counters: { staleBulkFiles: 1, expiringConsents: 0, deletedNotifications: 1 },
    });
    const rows = await testDb.db.select({ kind: notifications.kind }).from(notifications);
    expect(rows).toEqual([{ kind: 'bulk_file_stale' }]);
  });
});
