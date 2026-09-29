import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AccessDeniedError, listVisibleClientsAndProfiles } from './access';
import { createFileProfile } from './file-profiles';
import { amazonAdsProfiles, auditEvents, members, users } from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Profile ohne Connection (`phase-1.md` 1.11a): Anlage durch Admins, Liste, Regeln der DB. */

let testDb: TestDatabase;
const ids = { org: '', otherOrg: '', admin: '', editor: '', outsider: '', connection: '' };

const input = {
  accountName: 'Beispielmarke DE',
  countryCode: 'DE',
  currencyCode: 'EUR',
  timezone: 'Europe/Berlin',
  accountType: 'seller' as const,
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const [admin, editor, outsider] = await db
    .insert(users)
    .values([
      { name: 'Ada', email: 'ada@muuv.test' },
      { name: 'Emil', email: 'emil@muuv.test' },
      { name: 'Otto', email: 'otto@andere.test' },
    ])
    .returning({ id: users.id });
  ids.admin = admin!.id;
  ids.editor = editor!.id;
  ids.outsider = outsider!.id;
  await db.insert(members).values([
    { organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() },
    { organizationId: ids.org, userId: ids.editor, role: 'editor', createdAt: new Date() },
    { organizationId: ids.otherOrg, userId: ids.outsider, role: 'admin', createdAt: new Date() },
  ]);
  ids.connection = await createTestConnection(db, ids.org, 'amzn1.account.MUUV');
  await createTestProfile(db, {
    organizationId: ids.org,
    connectionId: ids.connection,
    amazonProfileId: '111',
  });
});

afterAll(async () => {
  await testDb.close();
});

describe('createFileProfile', () => {
  it('legt ein Profil ohne Connection und ohne Amazon-Profil-ID an, mit Marktplatz aus dem Land', async () => {
    const { db } = testDb;
    const profile = await createFileProfile(db, { userId: ids.admin, orgId: ids.org, input });

    const [row] = await db
      .select()
      .from(amazonAdsProfiles)
      .where(eq(amazonAdsProfiles.id, profile.id));
    expect(row).toMatchObject({
      organizationId: ids.org,
      connectionId: null,
      amazonProfileId: null,
      accountName: 'Beispielmarke DE',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      marketplaceId: 'A1PA6795UKMFR9',
      accountType: 'seller',
      isHidden: false,
      removedAt: null,
      syncedAt: null,
    });

    const [event] = await db
      .select()
      .from(auditEvents)
      .where(
        and(eq(auditEvents.action, 'profile.create'), eq(auditEvents.organizationId, ids.org)),
      );
    expect(event).toMatchObject({
      actorUserId: ids.admin,
      target: { type: 'amazon_ads_profile', id: profile.id, source: 'file', after: input },
    });
  });

  it('erlaubt mehrere Datei-Profile ohne Amazon-Profil-ID in derselben Organisation', async () => {
    const { db } = testDb;
    const a = await createFileProfile(db, { userId: ids.admin, orgId: ids.org, input });
    const b = await createFileProfile(db, {
      userId: ids.admin,
      orgId: ids.org,
      input: { ...input, countryCode: 'FR', timezone: 'Europe/Paris' },
    });
    expect(a.id).not.toBe(b.id);
  });

  it('lässt nur Admins der Organisation anlegen', async () => {
    const { db } = testDb;
    await expect(
      createFileProfile(db, { userId: ids.editor, orgId: ids.org, input }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      createFileProfile(db, { userId: ids.outsider, orgId: ids.org, input }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});

describe('Sichtbarkeit', () => {
  it('zeigt Datei-Profile in der Auswahl der Filterleiste wie andere Profile', async () => {
    const hidden = await createFileProfile(testDb.db, {
      userId: ids.admin,
      orgId: ids.org,
      input: { ...input, accountName: 'Ausgeblendet' },
    });
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, hidden.id));
    const { profiles } = await listVisibleClientsAndProfiles(testDb.db, {
      userId: ids.editor,
      orgId: ids.org,
    });
    expect(
      profiles.some((p) => p.amazonProfileId === null && p.accountName === 'Beispielmarke DE'),
    ).toBe(true);
    expect(profiles.some((p) => p.accountName === 'Ausgeblendet')).toBe(false);
  });
});

describe('Regeln der Datenbank', () => {
  it('verlangt bei einem Profil mit Connection die Amazon-Profil-ID', async () => {
    await expect(
      testDb.db.insert(amazonAdsProfiles).values({
        organizationId: ids.org,
        connectionId: ids.connection,
        amazonProfileId: null,
        accountName: 'Kaputt',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
        accountType: 'seller',
      }),
    ).rejects.toMatchObject({
      cause: { constraint_name: 'amazon_ads_profiles_connection_amazon_id_ck' },
    });
  });
});
