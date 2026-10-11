import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AccessDeniedError,
  canSeeProfile,
  getOrgRole,
  listMemberships,
  listVisibleClientsAndProfiles,
  visibleClientIds,
  visibleProfileIds,
} from './access';
import { amazonAdsProfiles, clients, members, organizations, users } from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Kunden-Org (`phase-6.md` 6.3a): Mitglieder sehen nur die Profile des verknüpften Clients der Eigentümer-Org. */

let testDb: TestDatabase;
const ids = {
  agency: '',
  customerOrg: '',
  unlinkedOrg: '',
  customer: '',
  customerAdmin: '',
  unlinked: '',
  nord: '',
  sued: '',
  nordProfile: '',
  nordHidden: '',
  nordRemoved: '',
  suedProfile: '',
  noClientProfile: '',
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.agency = await createTestOrganization(db, 'muuv');
  const [customerOrg, unlinkedOrg] = await db
    .insert(organizations)
    .values([
      { name: 'Nordwind GmbH', slug: 'nordwind-kunde', type: 'client', createdAt: new Date() },
      { name: 'Ohne Client', slug: 'ohne-client', type: 'client', createdAt: new Date() },
    ])
    .returning({ id: organizations.id });
  ids.customerOrg = customerOrg!.id;
  ids.unlinkedOrg = unlinkedOrg!.id;

  const [customer, customerAdmin, unlinked] = await db
    .insert(users)
    .values([
      { name: 'Kim', email: 'kim@nordwind.test' },
      { name: 'Falsch gesetzt', email: 'admin@nordwind.test' },
      { name: 'Uli', email: 'uli@ohne.test' },
    ])
    .returning({ id: users.id });
  ids.customer = customer!.id;
  ids.customerAdmin = customerAdmin!.id;
  ids.unlinked = unlinked!.id;
  await db.insert(members).values([
    {
      organizationId: ids.customerOrg,
      userId: ids.customer,
      role: 'viewer',
      createdAt: new Date(),
    },
    // Kunden-Mitglieder sind immer viewer; ein falsch gesetzter Rollenwert darf nichts öffnen.
    {
      organizationId: ids.customerOrg,
      userId: ids.customerAdmin,
      role: 'admin',
      createdAt: new Date(),
    },
    {
      organizationId: ids.unlinkedOrg,
      userId: ids.unlinked,
      role: 'viewer',
      createdAt: new Date(),
    },
  ]);

  const [nord, sued] = await db
    .insert(clients)
    .values([
      {
        organizationId: ids.agency,
        name: 'Nordwind',
        slug: 'nordwind',
        clientOrganizationId: ids.customerOrg,
      },
      { organizationId: ids.agency, name: 'Südhang', slug: 'suedhang' },
    ])
    .returning({ id: clients.id });
  ids.nord = nord!.id;
  ids.sued = sued!.id;
  const connectionId = await createTestConnection(db, ids.agency, 'amzn1.account.A');
  const profile = async (
    amazonProfileId: string,
    values: Partial<typeof amazonAdsProfiles.$inferInsert>,
  ) => {
    const id = await createTestProfile(db, {
      organizationId: ids.agency,
      connectionId,
      amazonProfileId,
    });
    await db.update(amazonAdsProfiles).set(values).where(eq(amazonAdsProfiles.id, id));
    return id;
  };
  ids.nordProfile = await profile('1', { clientId: ids.nord });
  ids.nordHidden = await profile('2', { clientId: ids.nord, isHidden: true });
  ids.nordRemoved = await profile('3', { clientId: ids.nord, removedAt: new Date() });
  ids.suedProfile = await profile('4', { clientId: ids.sued });
  ids.noClientProfile = await profile('5', { clientId: null });
});

afterAll(async () => {
  await testDb.close();
});

const asCustomer = () => ({ userId: ids.customer, orgId: ids.customerOrg });

describe('Kunden-Org im Access-Layer', () => {
  it('sieht nur die nicht ausgeblendeten, nicht entfernten Profile des verknüpften Clients', async () => {
    expect(await visibleProfileIds(testDb.db, asCustomer())).toEqual([ids.nordProfile]);
    expect(await canSeeProfile(testDb.db, { ...asCustomer(), profileId: ids.nordProfile })).toBe(
      true,
    );
    for (const profileId of [
      ids.nordHidden,
      ids.nordRemoved,
      ids.suedProfile,
      ids.noClientProfile,
    ]) {
      expect(await canSeeProfile(testDb.db, { ...asCustomer(), profileId })).toBe(false);
    }
  });

  it('die Filterauswahl nennt genau den eigenen Client', async () => {
    const selection = await listVisibleClientsAndProfiles(testDb.db, asCustomer());
    expect(selection.clients).toEqual([{ id: ids.nord, name: 'Nordwind', slug: 'nordwind' }]);
    expect(selection.profiles.map((p) => p.id)).toEqual([ids.nordProfile]);
    expect(await visibleClientIds(testDb.db, asCustomer())).toEqual([ids.nord]);
  });

  it('includeHidden und includeRemoved sind nie erlaubt, auch nicht mit der Rolle admin', async () => {
    const asAdmin = { userId: ids.customerAdmin, orgId: ids.customerOrg };
    expect(await visibleProfileIds(testDb.db, asAdmin)).toEqual([ids.nordProfile]);
    expect(await visibleClientIds(testDb.db, asAdmin)).toEqual([ids.nord]);
    await expect(
      visibleProfileIds(testDb.db, { ...asAdmin, includeHidden: true }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
    await expect(
      visibleProfileIds(testDb.db, { ...asAdmin, includeRemoved: true }),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it('Mitglieder einer Kunden-Org gelten immer als viewer, auch mit falsch gesetzter Rolle', async () => {
    expect(await getOrgRole(testDb.db, ids.customerAdmin, ids.customerOrg)).toBe('viewer');
    expect(await listMemberships(testDb.db, ids.customerAdmin)).toEqual([
      {
        organizationId: ids.customerOrg,
        name: 'Nordwind GmbH',
        slug: 'nordwind-kunde',
        type: 'client',
        role: 'viewer',
      },
    ]);
  });

  it('der Kunde ist kein Mitglied der Eigentümer-Org', async () => {
    const input = { userId: ids.customer, orgId: ids.agency };
    expect(await visibleProfileIds(testDb.db, input)).toEqual([]);
    expect(await visibleClientIds(testDb.db, input)).toEqual([]);
  });

  it('eine Kunden-Org ohne verknüpften Client sieht nichts', async () => {
    const input = { userId: ids.unlinked, orgId: ids.unlinkedOrg };
    expect(await visibleProfileIds(testDb.db, input)).toEqual([]);
    expect(await visibleClientIds(testDb.db, input)).toEqual([]);
    expect(await listVisibleClientsAndProfiles(testDb.db, input)).toEqual({
      clients: [],
      profiles: [],
    });
  });

  it('nach dem Lösen der Verknüpfung sieht der Kunde nichts mehr', async () => {
    await testDb.db
      .update(clients)
      .set({ clientOrganizationId: null })
      .where(eq(clients.id, ids.nord));
    expect(await visibleProfileIds(testDb.db, asCustomer())).toEqual([]);
    await testDb.db
      .update(clients)
      .set({ clientOrganizationId: ids.customerOrg })
      .where(eq(clients.id, ids.nord));
  });

  it('eine Kunden-Org gehört zu genau einem Client', async () => {
    await expect(
      testDb.db
        .update(clients)
        .set({ clientOrganizationId: ids.customerOrg })
        .where(eq(clients.id, ids.sued)),
    ).rejects.toThrow();
  });
});
