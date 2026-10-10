import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { seedAdChangeFixture, type AdChangeFixture } from './ad-change-fixture';
import { deleteGoal, getGoalsOverview, GoalError, setGoal } from './goals';
import { amazonAdsProfiles, auditEvents, clients, goals, productGroups, users } from './schema';
import { createTestDatabase, type TestDatabase } from './testing';

/** Ziele (`phase-5.md` 5.3): je Client, Profil oder Produktgruppe, nur an sichtbaren Objekten. */

let testDb: TestDatabase;
let f: AdChangeFixture;
let other: AdChangeFixture;
let client = '';
let emptyClient = '';
let otherClient = '';
let group = '';
let stranger = '';

const as = (userId: string, orgId = f.org) => ({ userId, orgId });
const code = async (promise: Promise<unknown>) => {
  try {
    await promise;
  } catch (err) {
    if (err instanceof GoalError) return err.code;
    throw err;
  }
  return null;
};
const set = (
  type: 'client' | 'profile' | 'productGroup',
  id: string,
  value = '25',
  metric: 'acos' | 'roas' = 'acos',
  actor = as(f.ada),
) => setGoal(testDb.db, { ...actor, scope: { type, id }, metric, value });

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  f = await seedAdChangeFixture(db);
  other = await seedAdChangeFixture(db, 'andere');
  const [kunde, leer, fremd] = await db
    .insert(clients)
    .values([
      { organizationId: f.org, name: 'Kunde', slug: 'kunde' },
      { organizationId: f.org, name: 'Leer', slug: 'leer' },
      { organizationId: other.org, name: 'Fremd', slug: 'fremd' },
    ])
    .returning({ id: clients.id });
  client = kunde!.id;
  emptyClient = leer!.id;
  otherClient = fremd!.id;
  await db
    .update(amazonAdsProfiles)
    .set({ clientId: client })
    .where(eq(amazonAdsProfiles.id, f.profile));
  await db
    .update(amazonAdsProfiles)
    .set({ clientId: otherClient })
    .where(eq(amazonAdsProfiles.id, other.profile));
  const [pg] = await db
    .insert(productGroups)
    .values({ organizationId: f.org, profileId: f.profile, name: 'Gruppe A' })
    .returning({ id: productGroups.id });
  group = pg!.id;
  const [niemand] = await db
    .insert(users)
    .values({ name: 'Niemand', email: 'niemand@nirgends.test' })
    .returning({ id: users.id });
  stranger = niemand!.id;
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(goals);
  await db.delete(auditEvents);
  await db.update(amazonAdsProfiles).set({ isHidden: false });
});

describe('setGoal und getGoalsOverview', () => {
  it('setzt ein Ziel je Client, Profil und Produktgruppe und zeigt die Übersicht', async () => {
    await set('client', client, '25');
    await set('profile', f.profile, '4', 'roas');
    await set('productGroup', group, '12.5');

    const overview = (await getGoalsOverview(testDb.db, as(f.emil)))!;
    expect(overview.clients).toHaveLength(1);
    const [kunde] = overview.clients;
    expect(kunde).toMatchObject({
      id: client,
      name: 'Kunde',
      goal: { metric: 'acos', value: '25', acos: '25', roas: '4' },
    });
    expect(kunde!.profiles).toHaveLength(1);
    expect(kunde!.profiles[0]).toMatchObject({
      id: f.profile,
      goal: { metric: 'roas', value: '4', acos: '25', roas: '4' },
      productGroups: [{ id: group, name: 'Gruppe A', goal: { acos: '12.5', roas: '8' } }],
    });
    // Profil ohne Client: eigener Abschnitt, ohne Ziel.
    expect(overview.unassignedProfiles).toMatchObject([
      { id: f.fileProfile, goal: null, productGroups: [] },
    ]);
  });

  it('ersetzt das Ziel desselben Objekts und schreibt je Änderung ein Audit-Event', async () => {
    const first = (await set('client', client, '25'))!;
    const second = (await set('client', client, '5', 'roas', as(f.emil)))!;

    expect(second.id).toBe(first.id);
    expect(second).toMatchObject({ metric: 'roas', value: '5', acos: '20', roas: '5' });
    expect(await testDb.db.select().from(goals)).toHaveLength(1);
    const events = await testDb.db.select().from(auditEvents).orderBy(auditEvents.createdAt);
    expect(events.map((e) => [e.action, e.actorUserId])).toEqual([
      ['goal.set', f.ada],
      ['goal.set', f.emil],
    ]);
    expect(events[1]!.target).toMatchObject({
      type: 'goal',
      id: first.id,
      scope: { type: 'client', id: client },
      before: { metric: 'acos', value: '25' },
      after: { metric: 'roas', value: '5' },
    });
    expect(events[0]!.target).toMatchObject({ before: null });
  });

  it('lehnt Objekte fremder Organisationen ab', async () => {
    expect(await code(set('client', otherClient))).toBe('NOT_FOUND');
    expect(await code(set('profile', other.profile))).toBe('NOT_FOUND');
    expect(await code(set('client', client, '25', 'acos', as(other.ada, other.org)))).toBe(
      'NOT_FOUND',
    );
    expect(await testDb.db.select().from(goals)).toHaveLength(0);
    expect(await testDb.db.select().from(auditEvents)).toHaveLength(0);
  });

  it('lehnt ausgeblendete Profile, ihre Produktgruppen und Clients ohne sichtbares Profil ab', async () => {
    await set('productGroup', group);
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));

    expect(await code(set('profile', f.profile))).toBe('NOT_FOUND');
    expect(await code(set('productGroup', group, '30'))).toBe('NOT_FOUND');
    expect(await code(set('client', client))).toBe('NOT_FOUND');
    expect(await code(set('client', emptyClient))).toBe('NOT_FOUND');
    const overview = (await getGoalsOverview(testDb.db, as(f.ada)))!;
    expect(overview.clients).toEqual([]);
    expect(overview.unassignedProfiles.map((p) => p.id)).toEqual([f.fileProfile]);
  });

  it('gibt Nicht-Mitgliedern nichts', async () => {
    expect(await getGoalsOverview(testDb.db, as(stranger))).toBeNull();
    expect(await set('client', client, '25', 'acos', as(stranger))).toBeNull();
  });
});

describe('deleteGoal', () => {
  it('löscht ein Ziel mit Audit-Event', async () => {
    const goal = (await set('profile', f.profile))!;
    await testDb.db.delete(auditEvents);

    expect(await deleteGoal(testDb.db, { ...as(f.emil), id: goal.id })).toBe(true);

    expect(await testDb.db.select().from(goals)).toHaveLength(0);
    const [event] = await testDb.db.select().from(auditEvents);
    expect(event).toMatchObject({ action: 'goal.delete', actorUserId: f.emil });
    expect(event!.target).toMatchObject({
      id: goal.id,
      scope: { type: 'profile', id: f.profile },
      before: { metric: 'acos', value: '25' },
    });
  });

  it('findet Ziele fremder Organisationen und ausgeblendeter Profile nicht', async () => {
    const goal = (await set('profile', f.profile))!;

    expect(await code(deleteGoal(testDb.db, { ...as(other.ada, other.org), id: goal.id }))).toBe(
      'NOT_FOUND',
    );
    await testDb.db
      .update(amazonAdsProfiles)
      .set({ isHidden: true })
      .where(eq(amazonAdsProfiles.id, f.profile));
    expect(await code(deleteGoal(testDb.db, { ...as(f.emil), id: goal.id }))).toBe('NOT_FOUND');
    expect(await testDb.db.select().from(goals)).toHaveLength(1);
  });
});

describe('Tabelle goals', () => {
  it('verlangt genau ein Ziel-Objekt und verschwindet mit ihm', async () => {
    const base = { organizationId: f.org, metric: 'acos', value: '25' };
    await expect(testDb.db.insert(goals).values(base)).rejects.toThrow();
    await expect(
      testDb.db.insert(goals).values({ ...base, clientId: client, profileId: f.profile }),
    ).rejects.toThrow();
    // Kein Ziel über Org-Grenzen.
    await expect(
      testDb.db.insert(goals).values({ ...base, clientId: otherClient }),
    ).rejects.toThrow();

    const [temp] = await testDb.db
      .insert(productGroups)
      .values({ organizationId: f.org, profileId: f.profile, name: 'Kurz' })
      .returning({ id: productGroups.id });
    await set('productGroup', temp!.id);
    await testDb.db.delete(productGroups).where(eq(productGroups.id, temp!.id));
    expect(await testDb.db.select().from(goals)).toHaveLength(0);
  });
});
