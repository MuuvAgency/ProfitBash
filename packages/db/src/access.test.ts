import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  canSeeProfile,
  getOrgRole,
  visibleProfileIds,
  visibleProfilesScope,
} from './access';
import { amazonAdsProfiles, connections, members, organizations, users } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;

// Testdaten: zwei Organisationen, Muuv mit Admin und Viewer, dazu ein fremder Nutzer.
const ids = {
  admin: '',
  viewer: '',
  outsider: '',
  muuv: '',
  other: '',
  visible: '',
  hidden: '',
  removed: '',
  otherOrgProfile: '',
  muuvConnection: '',
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;

  const [admin, viewer, outsider] = await db
    .insert(users)
    .values([
      { name: 'Ada Admin', email: 'admin@muuv.test' },
      { name: 'Vera Viewer', email: 'viewer@muuv.test' },
      { name: 'Otto Outsider', email: 'outsider@other.test' },
    ])
    .returning({ id: users.id });

  const [muuv, other] = await db
    .insert(organizations)
    .values([
      { name: 'Muuv', slug: 'muuv', type: 'internal', createdAt: new Date() },
      { name: 'Andere Agentur', slug: 'andere', type: 'client', createdAt: new Date() },
    ])
    .returning({ id: organizations.id });

  ids.admin = admin!.id;
  ids.viewer = viewer!.id;
  ids.outsider = outsider!.id;
  ids.muuv = muuv!.id;
  ids.other = other!.id;

  await db.insert(members).values([
    { organizationId: ids.muuv, userId: ids.admin, role: 'admin', createdAt: new Date() },
    { organizationId: ids.muuv, userId: ids.viewer, role: 'viewer', createdAt: new Date() },
    { organizationId: ids.other, userId: ids.outsider, role: 'admin', createdAt: new Date() },
  ]);

  const [muuvConnection, otherConnection] = await db
    .insert(connections)
    .values([
      {
        organizationId: ids.muuv,
        provider: 'amazon_ads',
        region: 'eu',
        refreshTokenEncrypted: 'v1:x',
      },
      {
        organizationId: ids.other,
        provider: 'amazon_ads',
        region: 'eu',
        refreshTokenEncrypted: 'v1:y',
      },
    ])
    .returning({ id: connections.id });
  ids.muuvConnection = muuvConnection!.id;

  const profile = (connectionId: string, organizationId: string, profileId: string) => ({
    organizationId,
    connectionId,
    profileId,
    accountName: `Konto ${profileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller' as const,
  });

  const [visible, hidden, removed, otherOrgProfile] = await db
    .insert(amazonAdsProfiles)
    .values([
      profile(muuvConnection!.id, ids.muuv, '1111111111111111'),
      { ...profile(muuvConnection!.id, ids.muuv, '2222222222222222'), isHidden: true },
      { ...profile(muuvConnection!.id, ids.muuv, '3333333333333333'), removedAt: new Date() },
      profile(otherConnection!.id, ids.other, '4444444444444444'),
    ])
    .returning({ id: amazonAdsProfiles.id });

  ids.visible = visible!.id;
  ids.hidden = hidden!.id;
  ids.removed = removed!.id;
  ids.otherOrgProfile = otherOrgProfile!.id;
});

afterAll(async () => {
  await testDb?.close();
});

describe('getOrgRole', () => {
  it('liefert die Rolle eines Mitglieds und null für Nicht-Mitglieder', async () => {
    expect(await getOrgRole(testDb.db, ids.admin, ids.muuv)).toBe('admin');
    expect(await getOrgRole(testDb.db, ids.viewer, ids.muuv)).toBe('viewer');
    expect(await getOrgRole(testDb.db, ids.outsider, ids.muuv)).toBeNull();
  });
});

describe('visibleProfileIds', () => {
  it('zeigt nur sichtbare, nicht entfernte Profile der eigenen Organisation', async () => {
    const result = await visibleProfileIds(testDb.db, { userId: ids.viewer, orgId: ids.muuv });
    expect(result).toEqual([ids.visible]);
  });

  it('zeigt Admins mit includeHidden auch ausgeblendete, aber nie entfernte Profile', async () => {
    const result = await visibleProfileIds(testDb.db, {
      userId: ids.admin,
      orgId: ids.muuv,
      includeHidden: true,
    });
    expect(result.sort()).toEqual([ids.visible, ids.hidden].sort());
  });

  it('verweigert includeHidden für Nicht-Admins', async () => {
    await expect(
      visibleProfileIds(testDb.db, { userId: ids.viewer, orgId: ids.muuv, includeHidden: true }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('liefert nichts für Nutzer ohne Mitgliedschaft', async () => {
    const result = await visibleProfileIds(testDb.db, { userId: ids.outsider, orgId: ids.muuv });
    expect(result).toEqual([]);
  });
});

describe('visibleProfilesScope', () => {
  it('lässt sich als Unterabfrage verwenden und liefert dieselben Profile', async () => {
    const scope = await visibleProfilesScope(testDb.db, { userId: ids.viewer, orgId: ids.muuv });
    expect(scope).not.toBeNull();

    const rows = await testDb.db
      .select({ profileId: amazonAdsProfiles.profileId })
      .from(amazonAdsProfiles)
      .where(inArray(amazonAdsProfiles.id, scope!.ids));

    expect(rows).toEqual([{ profileId: '1111111111111111' }]);
  });
});

describe('canSeeProfile', () => {
  it('prüft einzelne Profile inklusive Organisationsgrenze', async () => {
    const viewer = { userId: ids.viewer, orgId: ids.muuv };
    expect(await canSeeProfile(testDb.db, { ...viewer, profileId: ids.visible })).toBe(true);
    expect(await canSeeProfile(testDb.db, { ...viewer, profileId: ids.hidden })).toBe(false);
    expect(await canSeeProfile(testDb.db, { ...viewer, profileId: ids.otherOrgProfile })).toBe(
      false,
    );
  });
});

describe('Schema-Regeln', () => {
  it('erlaubt dieselbe Amazon-Profil-ID nur einmal pro Connection', async () => {
    const [existing] = await testDb.db
      .select()
      .from(amazonAdsProfiles)
      .where(eq(amazonAdsProfiles.id, ids.visible));

    const { id: _id, createdAt: _c, updatedAt: _u, ...duplicate } = existing!;
    await expect(testDb.db.insert(amazonAdsProfiles).values(duplicate)).rejects.toThrow();
  });

  it('speichert Profil-IDs jenseits von Number.MAX_SAFE_INTEGER verlustfrei', async () => {
    const bigId = '9007199254740993123';
    const [row] = await testDb.db
      .insert(amazonAdsProfiles)
      .values({
        organizationId: ids.muuv,
        connectionId: ids.muuvConnection,
        profileId: bigId,
        accountName: 'Große ID',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
        accountType: 'seller',
      })
      .returning({ profileId: amazonAdsProfiles.profileId });
    expect(row!.profileId).toBe(bigId);
  });
});
