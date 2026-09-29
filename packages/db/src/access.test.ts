import { and, eq, inArray, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  canSeeProfile,
  getOrgRole,
  listEnabledFeatures,
  listMemberships,
  listVisibleClientsAndProfiles,
  visibleProfileIds,
  visibleProfilesScope,
} from './access';
import {
  amazonAdsProfiles,
  clients,
  connections,
  members,
  orgEntitlements,
  organizations,
  users,
} from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;

// Testdaten: zwei Organisationen, Muuv mit Admin und Viewer, dazu ein fremder Nutzer.
const ids = {
  admin: '',
  viewer: '',
  outsider: '',
  muuv: '',
  other: '',
  muuvConnection: '',
  otherConnection: '',
  otherClient: '',
  visible: '',
  hidden: '',
  removed: '',
  otherOrgProfile: '',
};

function profile(
  organizationId: string,
  connectionId: string,
  amazonProfileId: string,
): typeof amazonAdsProfiles.$inferInsert {
  return {
    organizationId,
    connectionId,
    amazonProfileId,
    accountName: `Konto ${amazonProfileId}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
  };
}

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
        externalAccountId: 'amzn1.account.MUUV',
        refreshTokenEncrypted: 'v1:x',
      },
      {
        organizationId: ids.other,
        provider: 'amazon_ads',
        region: 'eu',
        externalAccountId: 'amzn1.account.OTHER',
        refreshTokenEncrypted: 'v1:y',
      },
    ])
    .returning({ id: connections.id });
  ids.muuvConnection = muuvConnection!.id;
  ids.otherConnection = otherConnection!.id;

  const [otherClient] = await db
    .insert(clients)
    .values({ organizationId: ids.other, name: 'Fremder Client', slug: 'fremd' })
    .returning({ id: clients.id });
  ids.otherClient = otherClient!.id;

  const [visible, hidden, removed, otherOrgProfile] = await db
    .insert(amazonAdsProfiles)
    .values([
      profile(ids.muuv, ids.muuvConnection, '1111111111111111'),
      { ...profile(ids.muuv, ids.muuvConnection, '2222222222222222'), isHidden: true },
      { ...profile(ids.muuv, ids.muuvConnection, '3333333333333333'), removedAt: new Date() },
      profile(ids.other, ids.otherConnection, '4444444444444444'),
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

describe('listMemberships', () => {
  it('liefert alle Organisationen des Nutzers mit Rolle, älteste Mitgliedschaft zuerst', async () => {
    // Der Admin tritt zusätzlich (später) der anderen Organisation als Editor bei.
    await testDb.db.insert(members).values({
      organizationId: ids.other,
      userId: ids.admin,
      role: 'editor',
      createdAt: new Date(Date.now() + 60_000),
    });

    expect(await listMemberships(testDb.db, ids.admin)).toEqual([
      { organizationId: ids.muuv, name: 'Muuv', slug: 'muuv', type: 'internal', role: 'admin' },
      {
        organizationId: ids.other,
        name: 'Andere Agentur',
        slug: 'andere',
        type: 'client',
        role: 'editor',
      },
    ]);

    await testDb.db
      .delete(members)
      .where(and(eq(members.organizationId, ids.other), eq(members.userId, ids.admin)));
  });

  it('liefert eine leere Liste für Nutzer ohne Mitgliedschaft', async () => {
    const [loner] = await testDb.db
      .insert(users)
      .values({ name: 'Lea Lonely', email: 'lonely@muuv.test' })
      .returning({ id: users.id });
    expect(await listMemberships(testDb.db, loner!.id)).toEqual([]);
  });
});

describe('listEnabledFeatures', () => {
  it('liefert nur die aktivierten Features genau dieser Organisation', async () => {
    await testDb.db.insert(orgEntitlements).values([
      { organizationId: ids.muuv, feature: 'dashboard', enabled: true },
      { organizationId: ids.muuv, feature: 'profit', enabled: false },
      { organizationId: ids.other, feature: 'goals', enabled: true },
    ]);

    expect(await listEnabledFeatures(testDb.db, ids.muuv)).toEqual(['dashboard']);
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

  it('zeigt Admins mit includeRemoved auch entfernte Profile (Admin-Seite „entfernte anzeigen“)', async () => {
    const admin = { userId: ids.admin, orgId: ids.muuv };
    const withRemoved = await visibleProfileIds(testDb.db, { ...admin, includeRemoved: true });
    expect(withRemoved.sort()).toEqual([ids.visible, ids.removed].sort());

    const all = await visibleProfileIds(testDb.db, {
      ...admin,
      includeHidden: true,
      includeRemoved: true,
    });
    expect(all.sort()).toEqual([ids.visible, ids.hidden, ids.removed].sort());
  });

  it('verweigert includeRemoved für Nicht-Admins', async () => {
    await expect(
      visibleProfileIds(testDb.db, { userId: ids.viewer, orgId: ids.muuv, includeRemoved: true }),
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
      .select({ amazonProfileId: amazonAdsProfiles.amazonProfileId })
      .from(amazonAdsProfiles)
      .where(inArray(amazonAdsProfiles.id, scope!.ids));

    expect(rows).toEqual([{ amazonProfileId: '1111111111111111' }]);
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
  it('erlaubt eine Amazon-Profil-ID nur einmal pro Organisation', async () => {
    await expect(
      testDb.db
        .insert(amazonAdsProfiles)
        .values(profile(ids.muuv, ids.muuvConnection, '1111111111111111')),
    ).rejects.toThrow();
  });

  it('verhindert, dass ein Profil einem Client einer fremden Organisation zugeordnet wird', async () => {
    await expect(
      testDb.db
        .update(amazonAdsProfiles)
        .set({ clientId: ids.otherClient })
        .where(eq(amazonAdsProfiles.id, ids.visible)),
    ).rejects.toThrow();
  });

  it('verhindert Profile an einer Connection einer fremden Organisation', async () => {
    await expect(
      testDb.db
        .insert(amazonAdsProfiles)
        .values(profile(ids.muuv, ids.otherConnection, '5555555555555555')),
    ).rejects.toThrow();
  });

  it('verhindert eine zweite Connection für dasselbe externe Konto', async () => {
    await expect(
      testDb.db.insert(connections).values({
        organizationId: ids.muuv,
        provider: 'amazon_ads',
        region: 'eu',
        externalAccountId: 'amzn1.account.MUUV',
        refreshTokenEncrypted: 'v1:z',
      }),
    ).rejects.toThrow();
  });

  it('speichert Profil-IDs jenseits von Number.MAX_SAFE_INTEGER verlustfrei', async () => {
    const bigId = '9007199254740993123';
    const [row] = await testDb.db
      .insert(amazonAdsProfiles)
      .values(profile(ids.muuv, ids.muuvConnection, bigId))
      .returning({ amazonProfileId: amazonAdsProfiles.amazonProfileId });
    expect(row!.amazonProfileId).toBe(bigId);
  });

  it('leert die Client-Zuordnung, wenn ein Client gelöscht wird', async () => {
    const [ownClient] = await testDb.db
      .insert(clients)
      .values({ organizationId: ids.muuv, name: 'Eigener Client', slug: 'eigen' })
      .returning({ id: clients.id });
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ clientId: ownClient!.id })
      .where(eq(amazonAdsProfiles.id, ids.visible));

    await testDb.db.delete(clients).where(eq(clients.id, ownClient!.id));

    const [row] = await testDb.db
      .select({ clientId: amazonAdsProfiles.clientId })
      .from(amazonAdsProfiles)
      .where(eq(amazonAdsProfiles.id, ids.visible));
    expect(row?.clientId).toBeNull();
  });

  it('erlaubt jede Mitgliedschaft nur einmal und nur mit bekannten Rollen', async () => {
    await expect(
      testDb.db.insert(members).values({
        organizationId: ids.muuv,
        userId: ids.viewer,
        role: 'editor',
        createdAt: new Date(),
      }),
    ).rejects.toThrow();
    await expect(
      testDb.db.insert(members).values({
        organizationId: ids.other,
        userId: ids.viewer,
        role: 'member',
        createdAt: new Date(),
      }),
    ).rejects.toThrow();
  });

  it('nutzt UTC als Zeitzone der Datenbank-Session', async () => {
    const rows = await testDb.db.execute<{ tz: string }>(
      sql`select current_setting('TimeZone') as tz`,
    );
    expect(rows[0]!.tz).toBe('UTC');
  });
});

describe('listVisibleClientsAndProfiles', () => {
  it('liefert nur Clients mit sichtbaren Profilen (für jede Rolle), dazu die sichtbaren Profile', async () => {
    const [withVisible, onlyHidden, empty] = await testDb.db
      .insert(clients)
      .values([
        { organizationId: ids.muuv, name: 'Nordwind', slug: 'nordwind' },
        { organizationId: ids.muuv, name: 'Nur ausgeblendet', slug: 'nur-ausgeblendet' },
        { organizationId: ids.muuv, name: 'Ohne Profile', slug: 'ohne-profile' },
      ])
      .returning({ id: clients.id });
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ clientId: withVisible!.id })
      .where(eq(amazonAdsProfiles.id, ids.visible));
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ clientId: onlyHidden!.id })
      .where(inArray(amazonAdsProfiles.id, [ids.hidden, ids.removed]));
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ clientId: ids.otherClient })
      .where(eq(amazonAdsProfiles.id, ids.otherOrgProfile));

    const result = await listVisibleClientsAndProfiles(testDb.db, {
      userId: ids.viewer,
      orgId: ids.muuv,
    });
    expect(result.clients).toEqual([{ id: withVisible!.id, name: 'Nordwind', slug: 'nordwind' }]);
    const seen = result.profiles.map((p) => p.id);
    expect(seen).not.toContain(ids.hidden);
    expect(seen).not.toContain(ids.removed);
    expect(seen).not.toContain(ids.otherOrgProfile);
    expect(result.profiles.find((p) => p.id === ids.visible)).toEqual({
      id: ids.visible,
      amazonProfileId: '1111111111111111',
      accountName: 'Konto 1111111111111111',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
      clientId: withVisible!.id,
    });
    expect(empty).toBeDefined();

    // Auch der Admin bekommt in der Auswahl nur sichtbare Profile (Ausblenden gilt für Auswertungen aller Rollen).
    const asAdmin = await listVisibleClientsAndProfiles(testDb.db, {
      userId: ids.admin,
      orgId: ids.muuv,
    });
    expect(asAdmin.clients).toEqual(result.clients);
    expect(asAdmin.profiles.map((p) => p.id)).toEqual(seen);

    expect(
      await listVisibleClientsAndProfiles(testDb.db, { userId: ids.outsider, orgId: ids.muuv }),
    ).toEqual({ clients: [], profiles: [] });

    await testDb.db
      .update(amazonAdsProfiles)
      .set({ clientId: null })
      .where(inArray(amazonAdsProfiles.id, [ids.visible, ids.hidden, ids.removed]));
  });
});
