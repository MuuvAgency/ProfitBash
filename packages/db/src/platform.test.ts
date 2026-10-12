import type { FeatureKey } from '@profitbash/shared';
import { asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { listAuditEvents } from './audit';
import {
  createPlatformOrganization,
  grantPlatformStaff,
  listPlatformOrganizations,
  listPlatformStaff,
  PlatformError,
  renamePlatformOrganization,
  revokePlatformStaff,
  setPlatformEntitlements,
} from './platform';
import { auditEvents, clients, members, orgEntitlements, organizations, users } from './schema';
import { createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Plattform-Admin (6.4, F5): Organisationen, Entitlements, Staff. Die Routen verlangen den Superadmin. */

let testDb: TestDatabase;
const ids = { agency: '', customerOrg: '', client: '', root: '', second: '', plain: '' };

async function user(name: string, email: string, role: string | null = null) {
  const [row] = await testDb.db
    .insert(users)
    .values({ name, email, role })
    .returning({ id: users.id });
  return row!.id;
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PlatformError) return err.code;
    throw err;
  }
  return undefined;
}

const audit = () =>
  testDb.db
    .select({
      organizationId: auditEvents.organizationId,
      actorUserId: auditEvents.actorUserId,
      action: auditEvents.action,
      target: auditEvents.target,
    })
    .from(auditEvents)
    .orderBy(asc(auditEvents.createdAt), asc(auditEvents.id));

const featureRows = async (orgId: string) =>
  (
    await testDb.db
      .select({ feature: orgEntitlements.feature })
      .from(orgEntitlements)
      .where(eq(orgEntitlements.organizationId, orgId))
      .orderBy(asc(orgEntitlements.feature))
  ).map((row) => row.feature);

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.agency = await createTestOrganization(db, 'muuv');
  const [customerOrg] = await db
    .insert(organizations)
    .values({
      name: 'Nordwind GmbH',
      slug: 'kunde-nordwind',
      type: 'client',
      createdAt: new Date(),
    })
    .returning({ id: organizations.id });
  ids.customerOrg = customerOrg!.id;
  const [client] = await db
    .insert(clients)
    .values({
      organizationId: ids.agency,
      name: 'Nordwind',
      slug: 'nordwind',
      clientOrganizationId: ids.customerOrg,
    })
    .returning({ id: clients.id });
  ids.client = client!.id;
  ids.root = await user('Ada', 'ada@muuv.test', 'superadmin');
  ids.plain = await user('Pia', 'pia@muuv.test');
  await db.insert(members).values([
    { organizationId: ids.agency, userId: ids.root, role: 'admin', createdAt: new Date() },
    { organizationId: ids.agency, userId: ids.plain, role: 'editor', createdAt: new Date() },
  ]);
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(auditEvents);
  await db.delete(orgEntitlements);
  await db.update(users).set({ role: null }).where(eq(users.id, ids.plain));
});

describe('Organisationen', () => {
  it('listet alle mit Typ, Mitgliederzahl, verknüpftem Client und gebuchten Features', async () => {
    await testDb.db.insert(orgEntitlements).values([
      { organizationId: ids.agency, feature: 'tags', enabled: true },
      { organizationId: ids.agency, feature: 'goals', enabled: false },
    ]);
    const list = await listPlatformOrganizations(testDb.db);
    expect(list.find((org) => org.id === ids.agency)).toMatchObject({
      type: 'internal',
      customerOrg: false,
      memberCount: 2,
      client: null,
      features: ['tags'],
    });
    expect(list.find((org) => org.id === ids.customerOrg)).toMatchObject({
      name: 'Nordwind GmbH',
      type: 'client',
      customerOrg: true,
      memberCount: 0,
      client: { id: ids.client, name: 'Nordwind', ownerOrganizationId: ids.agency },
      features: [],
    });
  });

  it('legt eine Agentur-Org an: Slug aus dem Namen, der Anlegende wird Admin, Audit bei der neuen Org', async () => {
    const org = await createPlatformOrganization(testDb.db, {
      name: 'Zweite Agentur',
      actorUserId: ids.root,
    });
    expect(org).toMatchObject({
      name: 'Zweite Agentur',
      slug: 'zweite-agentur',
      type: 'internal',
      customerOrg: false,
      memberCount: 1,
      features: [],
    });
    expect(
      await testDb.db
        .select({ userId: members.userId, role: members.role })
        .from(members)
        .where(eq(members.organizationId, org.id)),
    ).toEqual([{ userId: ids.root, role: 'admin' }]);
    expect(await audit()).toEqual([
      {
        organizationId: org.id,
        actorUserId: ids.root,
        action: 'platform.organization_create',
        target: {
          type: 'organization',
          id: org.id,
          name: 'Zweite Agentur',
          slug: 'zweite-agentur',
        },
      },
    ]);

    expect(
      await errorCode(
        createPlatformOrganization(testDb.db, { name: 'Zweite  Agentur!', actorUserId: ids.root }),
      ),
    ).toBe('SLUG_TAKEN');
    expect(
      await errorCode(
        createPlatformOrganization(testDb.db, { name: '???', actorUserId: ids.root }),
      ),
    ).toBe('INVALID_NAME');
    expect(await audit()).toHaveLength(1);
  });

  it('benennt um (Slug bleibt), Audit nur bei einer Änderung; unbekannte Org → NOT_FOUND', async () => {
    const rename = (name: string, orgId = ids.customerOrg) =>
      renamePlatformOrganization(testDb.db, { orgId, name, actorUserId: ids.root });
    expect(await rename('Nordwind AG')).toMatchObject({
      name: 'Nordwind AG',
      slug: 'kunde-nordwind',
    });
    await rename('Nordwind AG');
    expect(await audit()).toEqual([
      {
        organizationId: ids.customerOrg,
        actorUserId: ids.root,
        action: 'platform.organization_rename',
        target: {
          type: 'organization',
          id: ids.customerOrg,
          name: 'Nordwind AG',
          previousName: 'Nordwind GmbH',
        },
      },
    ]);
    expect(await errorCode(rename('X', ids.client))).toBe('NOT_FOUND');
    await rename('Nordwind GmbH');
  });
});

describe('Entitlements', () => {
  const set = (orgId: string, features: FeatureKey[]) =>
    setPlatformEntitlements(testDb.db, { orgId, features, actorUserId: ids.root });

  it('ersetzt die gebuchten Features und schreibt vorher/nachher ins Audit, nur bei einer Änderung', async () => {
    expect((await set(ids.agency, ['tags', 'dashboard'])).features).toEqual(['dashboard', 'tags']);
    expect((await set(ids.agency, ['dashboard', 'goals'])).features).toEqual([
      'dashboard',
      'goals',
    ]);
    await set(ids.agency, ['goals', 'dashboard', 'goals']);
    expect(await audit()).toEqual([
      {
        organizationId: ids.agency,
        actorUserId: ids.root,
        action: 'platform.entitlements_update',
        target: { type: 'organization', id: ids.agency, before: [], after: ['dashboard', 'tags'] },
      },
      {
        organizationId: ids.agency,
        actorUserId: ids.root,
        action: 'platform.entitlements_update',
        target: {
          type: 'organization',
          id: ids.agency,
          before: ['dashboard', 'tags'],
          after: ['dashboard', 'goals'],
        },
      },
    ]);
    // Abgewählte bleiben als Zeile (enabled = false), es gibt je Feature höchstens eine.
    expect(await featureRows(ids.agency)).toEqual(['dashboard', 'goals', 'tags']);
  });

  it('Kunden-Orgs buchen nur, was für Kunden freigegeben ist', async () => {
    expect(await errorCode(set(ids.customerOrg, ['dashboard', 'tags']))).toBe(
      'FEATURE_NOT_FOR_CUSTOMERS',
    );
    expect((await set(ids.customerOrg, ['sp-explorer'])).features).toEqual(['sp-explorer']);
    expect(await errorCode(set(ids.client, ['dashboard']))).toBe('NOT_FOUND');
  });
});

describe('Staff', () => {
  const staff = () => listPlatformStaff(testDb.db, { actorUserId: ids.root });

  it('vergibt die Rolle über die E-Mail und entzieht sie wieder, Audit plattformweit', async () => {
    expect(await staff()).toEqual([
      { id: ids.root, name: 'Ada', email: 'ada@muuv.test', isSelf: true },
    ]);
    await grantPlatformStaff(testDb.db, { email: ' Pia@Muuv.test ', actorUserId: ids.root });
    // Schon Superadmin: nichts zu tun, kein zweites Ereignis.
    await grantPlatformStaff(testDb.db, { email: 'pia@muuv.test', actorUserId: ids.root });
    expect((await staff()).map((s) => s.email)).toEqual(['ada@muuv.test', 'pia@muuv.test']);
    await revokePlatformStaff(testDb.db, { userId: ids.plain, actorUserId: ids.root });
    expect((await staff()).map((s) => s.email)).toEqual(['ada@muuv.test']);
    const target = { type: 'user', id: ids.plain, email: 'pia@muuv.test' };
    expect(await audit()).toEqual([
      { organizationId: null, actorUserId: ids.root, action: 'platform.staff_grant', target },
      { organizationId: null, actorUserId: ids.root, action: 'platform.staff_revoke', target },
    ]);
  });

  it('unbekannte E-Mail und Nutzer ohne die Rolle → NOT_FOUND', async () => {
    expect(
      await errorCode(
        grantPlatformStaff(testDb.db, { email: 'niemand@muuv.test', actorUserId: ids.root }),
      ),
    ).toBe('NOT_FOUND');
    expect(
      await errorCode(revokePlatformStaff(testDb.db, { userId: ids.plain, actorUserId: ids.root })),
    ).toBe('NOT_FOUND');
  });

  it('der letzte Superadmin behält die Rolle', async () => {
    expect(
      await errorCode(revokePlatformStaff(testDb.db, { userId: ids.root, actorUserId: ids.root })),
    ).toBe('LAST_SUPERADMIN');
    expect(await audit()).toEqual([]);
    // Mit einem zweiten darf er sie abgeben.
    await grantPlatformStaff(testDb.db, { email: 'pia@muuv.test', actorUserId: ids.root });
    await revokePlatformStaff(testDb.db, { userId: ids.root, actorUserId: ids.root });
    expect(
      await errorCode(
        revokePlatformStaff(testDb.db, { userId: ids.plain, actorUserId: ids.plain }),
      ),
    ).toBe('LAST_SUPERADMIN');
    await testDb.db.update(users).set({ role: 'superadmin' }).where(eq(users.id, ids.root));
  });
});

describe('plattformweites Audit', () => {
  it('listAuditEvents mit orgId null liefert nur Ereignisse ohne Organisation', async () => {
    await testDb.db.insert(auditEvents).values([
      {
        organizationId: null,
        actorUserId: ids.root,
        action: 'platform.staff_grant',
        target: { type: 'user', id: 'u1' },
      },
      {
        organizationId: null,
        actorUserId: ids.root,
        action: 'settings.update',
        target: { type: 'user', id: 'u1' },
      },
      {
        organizationId: ids.agency,
        actorUserId: ids.root,
        action: 'platform.entitlements_update',
        target: { type: 'organization', id: ids.agency },
      },
    ]);
    const { events } = await listAuditEvents(testDb.db, {
      orgId: null,
      area: 'platform',
      limit: 10,
    });
    expect(events.map((event) => event.action)).toEqual(['platform.staff_grant']);
  });
});
