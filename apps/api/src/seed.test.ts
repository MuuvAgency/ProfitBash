import { schema } from '@profitbash/db';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { FEATURE_KEYS } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAuth, type Auth } from './auth';
import { seed, SEED_ORG } from './seed';

const admin = { email: 'Admin@Muuv.Test', password: 'ein-sicheres-passwort-123' };

let testDb: TestDatabase;
let auth: Auth;

beforeAll(async () => {
  testDb = await createTestDatabase();
  auth = createAuth({
    db: testDb.db,
    secret: 'test-secret-mit-mindestens-32-zeichen-000',
    baseURL: 'http://localhost:5173',
  });
});

afterAll(async () => {
  await testDb?.close();
});

describe('seed', () => {
  it('legt Admin, Organisation Muuv, Mitgliedschaft und Entitlements an', async () => {
    const result = await seed({ db: testDb.db, auth, admin });
    expect(result.createdUser).toBe(true);
    expect(result.createdOrganization).toBe(true);

    const [user] = await testDb.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, result.userId));
    expect(user?.email).toBe('admin@muuv.test');
    expect(user?.role).toBe('superadmin');

    const [org] = await testDb.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, result.organizationId));
    expect(org).toMatchObject({ name: SEED_ORG.name, slug: SEED_ORG.slug, type: 'internal' });

    const memberships = await testDb.db
      .select({ role: schema.members.role })
      .from(schema.members)
      .where(eq(schema.members.organizationId, result.organizationId));
    expect(memberships).toEqual([{ role: 'admin' }]);

    const entitlements = await testDb.db
      .select({ feature: schema.orgEntitlements.feature, enabled: schema.orgEntitlements.enabled })
      .from(schema.orgEntitlements)
      .where(eq(schema.orgEntitlements.organizationId, result.organizationId));
    expect(entitlements.map((e) => e.feature).sort()).toEqual([...FEATURE_KEYS].sort());
    expect(entitlements.every((e) => e.enabled)).toBe(true);
  });

  it('ist idempotent: ein zweiter Lauf legt nichts doppelt an', async () => {
    const result = await seed({ db: testDb.db, auth, admin });
    expect(result.createdUser).toBe(false);
    expect(result.createdOrganization).toBe(false);

    expect(await testDb.db.select().from(schema.users)).toHaveLength(1);
    expect(await testDb.db.select().from(schema.organizations)).toHaveLength(1);
    expect(await testDb.db.select().from(schema.members)).toHaveLength(1);
    expect(await testDb.db.select().from(schema.orgEntitlements)).toHaveLength(FEATURE_KEYS.length);
  });

  it('der Admin kann sich mit E-Mail und Passwort anmelden', async () => {
    const res = await auth.api.signInEmail({
      body: { email: admin.email, password: admin.password },
    });
    expect(res.user.email).toBe('admin@muuv.test');
  });

  it('ein falsches Passwort wird abgelehnt', async () => {
    await expect(
      auth.api.signInEmail({ body: { email: admin.email, password: 'falsches-passwort-999' } }),
    ).rejects.toThrow();
  });

  it('die öffentliche Registrierung ist deaktiviert', async () => {
    await expect(
      auth.api.signUpEmail({
        body: { email: 'neu@example.test', password: 'noch-ein-passwort-123', name: 'Neu' },
      }),
    ).rejects.toThrow();
    expect(await testDb.db.select().from(schema.users)).toHaveLength(1);
  });
});
