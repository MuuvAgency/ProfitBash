import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { notifyExpiringConsents, notifyStaleBulkFiles } from './notification-sources';
import { amazonAdsProfiles, connections, fileImports, notifications } from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Zeitgesteuerte Quellen der Benachrichtigungen (5.2a): keine Bulk-Datei seit 8 Tagen, Ablauf der Einwilligung. */

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2099-10-10T06:00:00Z');
const daysAgo = (days: number) => new Date(now.getTime() - days * DAY);

let testDb: TestDatabase;
const ids = { org: '', connection: '', apiProfile: '', fileProfile: '', hidden: '', removed: '' };

async function fileProfile(
  name: string,
  extra: Partial<typeof amazonAdsProfiles.$inferInsert> = {},
) {
  const [row] = await testDb.db
    .insert(amazonAdsProfiles)
    .values({
      organizationId: ids.org,
      accountName: name,
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
      ...extra,
    })
    .returning({ id: amazonAdsProfiles.id });
  return row!.id;
}

async function bulkImport(profileId: string, createdAt: Date, status = 'imported', kind = 'bulk') {
  await testDb.db.insert(fileImports).values({
    organizationId: ids.org,
    profileId,
    kind,
    fileName: 'bulk.xlsx',
    byteSize: 1,
    sha256: 'x',
    status,
    createdAt,
  });
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  ids.org = await createTestOrganization(testDb.db, 'muuv');
  ids.connection = await createTestConnection(testDb.db, ids.org, 'amzn1.account.A');
  ids.apiProfile = await createTestProfile(testDb.db, {
    organizationId: ids.org,
    connectionId: ids.connection,
    amazonProfileId: '1',
  });
  ids.fileProfile = await fileProfile('Datei DE');
  ids.hidden = await fileProfile('Datei ausgeblendet', { isHidden: true });
  ids.removed = await fileProfile('Datei entfernt', { removedAt: daysAgo(1) });
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(notifications);
  await testDb.db.delete(fileImports);
});

describe('notifyStaleBulkFiles', () => {
  it('warnt alle Mitglieder je Datei-Profil ab Tag 8 ohne neue Bulk-Datei, einmal je Woche', async () => {
    await bulkImport(ids.fileProfile, daysAgo(9));
    // Ältere, gescheiterte und andere Dateien zählen nicht als „neu“.
    await bulkImport(ids.fileProfile, daysAgo(2), 'failed');
    await bulkImport(ids.fileProfile, daysAgo(2), 'imported', 'daily_report');
    for (const profileId of [ids.apiProfile, ids.hidden, ids.removed]) {
      await bulkImport(profileId, daysAgo(30));
    }

    expect(await notifyStaleBulkFiles(testDb.db, { now })).toBe(1);
    expect(await notifyStaleBulkFiles(testDb.db, { now: new Date(now.getTime() + DAY) })).toBe(0);
    const rows = await testDb.db.select().from(notifications);
    expect(rows).toEqual([
      expect.objectContaining({
        organizationId: ids.org,
        profileId: ids.fileProfile,
        audience: 'members',
        kind: 'bulk_file_stale',
        severity: 'warning',
        params: { days: 9 },
        link: null,
      }),
    ]);
    // Eine Woche später wieder.
    expect(await notifyStaleBulkFiles(testDb.db, { now: new Date(now.getTime() + 7 * DAY) })).toBe(
      1,
    );
  });

  it('warnt nicht bei aktueller Datei; ohne jede Datei zählt die Anlage des Profils', async () => {
    await bulkImport(ids.fileProfile, daysAgo(7));
    expect(await notifyStaleBulkFiles(testDb.db, { now })).toBe(0);

    await testDb.db.delete(fileImports);
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ createdAt: daysAgo(10) })
      .where(eq(amazonAdsProfiles.id, ids.fileProfile));
    expect(await notifyStaleBulkFiles(testDb.db, { now })).toBe(1);
  });
});

describe('notifyExpiringConsents', () => {
  const consent = (consentedAt: Date | null) =>
    testDb.db
      .update(connections)
      .set({ consentedAt, externalAccountEmail: 'konto@muuv.test' })
      .where(eq(connections.id, ids.connection));

  it('erinnert die Admins 30, 14 und 3 Tage vor dem Ablauf, je Stufe einmal', async () => {
    // Ablauf in 20 Tagen: Stufe 30.
    await consent(daysAgo(365 - 20));
    expect(await notifyExpiringConsents(testDb.db, { now })).toBe(1);
    expect(await notifyExpiringConsents(testDb.db, { now })).toBe(0);
    // 10 Tage später (Ablauf in 10 Tagen): Stufe 14.
    expect(
      await notifyExpiringConsents(testDb.db, { now: new Date(now.getTime() + 10 * DAY) }),
    ).toBe(1);
    const rows = await testDb.db.select().from(notifications).orderBy(notifications.seq);
    expect(rows).toEqual([
      expect.objectContaining({
        organizationId: ids.org,
        profileId: null,
        connectionId: ids.connection,
        audience: 'admins',
        recipientUserId: null,
        kind: 'consent_expiring',
        severity: 'warning',
        params: { days: 20, account: 'konto@muuv.test' },
        link: '/admin/connections',
      }),
      expect.objectContaining({ params: { days: 10, account: 'konto@muuv.test' } }),
    ]);
  });

  it('3 Tage vorher als Fehler; nichts ohne Einwilligung, weit vorher oder nach dem Ablauf', async () => {
    await consent(null);
    expect(await notifyExpiringConsents(testDb.db, { now })).toBe(0);
    await consent(daysAgo(365 - 40));
    expect(await notifyExpiringConsents(testDb.db, { now })).toBe(0);
    await consent(daysAgo(366));
    expect(await notifyExpiringConsents(testDb.db, { now })).toBe(0);
    await consent(daysAgo(365 - 2));
    expect(await notifyExpiringConsents(testDb.db, { now })).toBe(1);
    const [row] = await testDb.db.select().from(notifications);
    expect(row).toMatchObject({ severity: 'error', params: { days: 2 } });
  });
});
