import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  canSeeProfile,
  listVisibleClientsAndProfiles,
  visibleClientIds,
  visibleProfileIds,
} from './access';
import { amazonAdsProfiles, clients, memberClientGrants, members, users } from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Freigaben je Mitglied und Client (`phase-6.md` 6.2): Eingeschränkte sehen nur Profile ihrer Clients. */

let testDb: TestDatabase;
const ids = {
  org: '',
  admin: '',
  editor: '',
  free: '',
  editorMember: '',
  adminMember: '',
  nord: '',
  sued: '',
  nordProfile: '',
  suedProfile: '',
  noClientProfile: '',
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  const [admin, editor, free] = await db
    .insert(users)
    .values([
      { name: 'Ada', email: 'ada@muuv.test' },
      { name: 'Edi', email: 'edi@muuv.test' },
      { name: 'Frei', email: 'frei@muuv.test' },
    ])
    .returning({ id: users.id });
  ids.admin = admin!.id;
  ids.editor = editor!.id;
  ids.free = free!.id;
  const [adminMember, editorMember] = await db
    .insert(members)
    .values([
      { organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() },
      { organizationId: ids.org, userId: ids.editor, role: 'editor', createdAt: new Date() },
      { organizationId: ids.org, userId: ids.free, role: 'viewer', createdAt: new Date() },
    ])
    .returning({ id: members.id });
  ids.adminMember = adminMember!.id;
  ids.editorMember = editorMember!.id;

  const [nord, sued] = await db
    .insert(clients)
    .values([
      { organizationId: ids.org, name: 'Nordwind', slug: 'nordwind' },
      { organizationId: ids.org, name: 'Südhang', slug: 'suedhang' },
    ])
    .returning({ id: clients.id });
  ids.nord = nord!.id;
  ids.sued = sued!.id;
  const connectionId = await createTestConnection(db, ids.org, 'amzn1.account.A');
  const profile = async (amazonProfileId: string, clientId: string | null) => {
    const id = await createTestProfile(db, {
      organizationId: ids.org,
      connectionId,
      amazonProfileId,
    });
    await db.update(amazonAdsProfiles).set({ clientId }).where(eq(amazonAdsProfiles.id, id));
    return id;
  };
  ids.nordProfile = await profile('1', ids.nord);
  ids.suedProfile = await profile('2', ids.sued);
  ids.noClientProfile = await profile('3', null);

  // Edi ist auf Nordwind eingeschränkt. Die Freigabe der Admin greift nicht (Admins sehen immer alles).
  await db.insert(memberClientGrants).values([
    { organizationId: ids.org, memberId: ids.editorMember, clientId: ids.nord },
    { organizationId: ids.org, memberId: ids.adminMember, clientId: ids.nord },
  ]);
});

afterAll(async () => {
  await testDb.close();
});

const as = (userId: string) => ({ userId, orgId: ids.org });
const sorted = (list: string[]) => [...list].sort();

describe('Freigaben je Client', () => {
  it('ohne Freigabe sieht ein Mitglied alle Profile', async () => {
    expect(sorted(await visibleProfileIds(testDb.db, as(ids.free)))).toEqual(
      sorted([ids.nordProfile, ids.suedProfile, ids.noClientProfile]),
    );
    expect(await visibleClientIds(testDb.db, as(ids.free))).toBeNull();
  });

  it('mit Freigabe nur die Profile dieser Clients, keine ohne Client', async () => {
    expect(await visibleProfileIds(testDb.db, as(ids.editor))).toEqual([ids.nordProfile]);
    expect(await canSeeProfile(testDb.db, { ...as(ids.editor), profileId: ids.nordProfile })).toBe(
      true,
    );
    for (const profileId of [ids.suedProfile, ids.noClientProfile]) {
      expect(await canSeeProfile(testDb.db, { ...as(ids.editor), profileId })).toBe(false);
    }
    const selection = await listVisibleClientsAndProfiles(testDb.db, as(ids.editor));
    expect(selection.clients.map((c) => c.name)).toEqual(['Nordwind']);
    expect(selection.profiles.map((p) => p.id)).toEqual([ids.nordProfile]);
    expect(await visibleClientIds(testDb.db, as(ids.editor))).toEqual([ids.nord]);
  });

  it('Admins sehen alles, auch mit Freigaben', async () => {
    expect(await visibleProfileIds(testDb.db, as(ids.admin))).toHaveLength(3);
    expect(await visibleClientIds(testDb.db, as(ids.admin))).toBeNull();
  });

  it('kein Mitglied: keine Clients', async () => {
    const stranger = '00000000-0000-4000-8000-000000000001';
    expect(await visibleClientIds(testDb.db, as(stranger))).toEqual([]);
  });

  it('ein Client mit Freigaben lässt sich nicht löschen (sonst sähe das Mitglied plötzlich alles)', async () => {
    await expect(testDb.db.delete(clients).where(eq(clients.id, ids.nord))).rejects.toThrow();
  });

  it('die Freigaben verschwinden mit der Mitgliedschaft', async () => {
    await testDb.db.delete(members).where(eq(members.id, ids.adminMember));
    const left = await testDb.db
      .select({ memberId: memberClientGrants.memberId })
      .from(memberClientGrants);
    expect(left).toEqual([{ memberId: ids.editorMember }]);
  });
});
