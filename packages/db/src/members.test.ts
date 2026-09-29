import { and, eq, notInArray } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  addMember,
  findUserByEmail,
  inspectPasswordLink,
  listMembers,
  MemberError,
  redeemPasswordLink,
  regeneratePasswordLink,
  removeMember,
  updateMemberRole,
} from './members';
import {
  accounts,
  auditEvents,
  memberPasswordLinks,
  members,
  savedViews,
  sessions,
  users,
} from './schema';
import { createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Mitglieder und Einmal-Links (2.10, F9). */

let testDb: TestDatabase;
const ids = { org: '', otherOrg: '', admin: '', outsider: '' };
const NOW = new Date('2026-09-29T10:00:00Z');
const DAY = 86_400_000;

async function user(name: string, email: string) {
  const [row] = await testDb.db.insert(users).values({ name, email }).returning({ id: users.id });
  return row!.id;
}

async function errorCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof MemberError) return err.code;
    throw err;
  }
  return undefined;
}

async function session(userId: string) {
  await testDb.db.insert(sessions).values({
    userId,
    token: `t-${userId}-${Math.random()}`,
    expiresAt: new Date(NOW.getTime() + DAY),
    updatedAt: NOW,
  });
}

const admin = () => ({ orgId: ids.org, actorUserId: ids.admin });

beforeAll(async () => {
  testDb = await createTestDatabase();
  ids.org = await createTestOrganization(testDb.db, 'muuv');
  ids.otherOrg = await createTestOrganization(testDb.db, 'andere');
  ids.admin = await user('Ada', 'ada@muuv.test');
  ids.outsider = await user('Otto', 'otto@andere.test');
});

afterAll(async () => {
  await testDb?.close();
});

beforeEach(async () => {
  const { db } = testDb;
  await db.delete(auditEvents);
  await db.delete(savedViews);
  await db.delete(memberPasswordLinks);
  await db.delete(sessions);
  await db.delete(members);
  await db.delete(accounts);
  await db.delete(users).where(notInArray(users.id, [ids.admin, ids.outsider]));
  await db.insert(members).values([
    { organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: NOW },
    { organizationId: ids.otherOrg, userId: ids.outsider, role: 'admin', createdAt: NOW },
  ]);
  await db.insert(accounts).values({
    userId: ids.admin,
    accountId: ids.admin,
    providerId: 'credential',
    password: 'hash',
    updatedAt: NOW,
  });
});

async function newMember(email: string, role: 'admin' | 'editor' | 'viewer' = 'editor') {
  const userId = await user(email.split('@')[0]!, email);
  return { userId, ...(await addMember(testDb.db, { ...admin(), userId, role, now: NOW })) };
}

describe('Anlegen und Liste', () => {
  it('legt die Mitgliedschaft mit einem 7 Tage gültigen Link an, gespeichert nur als Hash', async () => {
    const { member, token, expiresAt, userId } = await newMember('emil@muuv.test');
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toEqual(new Date(NOW.getTime() + 7 * DAY));
    expect(member).toMatchObject({ userId, role: 'editor', status: 'pending', isSelf: false });
    const [link] = await testDb.db.select().from(memberPasswordLinks);
    expect(link?.tokenHash).not.toContain(token);
    expect(link?.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'member.create'));
    expect(event).toMatchObject({
      organizationId: ids.org,
      actorUserId: ids.admin,
      target: { type: 'member', id: member.id, userId, email: 'emil@muuv.test', role: 'editor' },
    });
    expect(JSON.stringify(event)).not.toContain(token);
  });

  it('listet nur die eigene Organisation, mit Status', async () => {
    await newMember('emil@muuv.test');
    const list = await listMembers(testDb.db, { ...admin(), now: NOW });
    expect(list.map((m) => [m.email, m.status, m.isSelf])).toEqual([
      ['ada@muuv.test', 'active', true],
      ['emil@muuv.test', 'pending', false],
    ]);
    const later = await listMembers(testDb.db, {
      ...admin(),
      now: new Date(NOW.getTime() + 8 * DAY),
    });
    expect(later.find((m) => m.email === 'emil@muuv.test')?.status).toBe('expired');
  });

  it('E-Mail mit Mitgliedschaft (hier oder anderswo) ist vergeben; ohne Mitgliedschaft wird der Nutzer wieder aufgenommen', async () => {
    expect(await findUserByEmail(testDb.db, 'otto@andere.test')).toEqual({
      id: ids.outsider,
      hasMemberships: true,
    });
    expect(
      await errorCode(
        addMember(testDb.db, { ...admin(), userId: ids.outsider, role: 'viewer', now: NOW }),
      ),
    ).toBe('EMAIL_TAKEN');
    expect(
      await errorCode(
        addMember(testDb.db, { ...admin(), userId: ids.admin, role: 'viewer', now: NOW }),
      ),
    ).toBe('EMAIL_TAKEN');
    const lonely = await user('Lone', 'lone@muuv.test');
    expect(await findUserByEmail(testDb.db, 'LONE@muuv.test')).toEqual({
      id: lonely,
      hasMemberships: false,
    });
    const { member } = await addMember(testDb.db, {
      ...admin(),
      userId: lonely,
      role: 'viewer',
      now: NOW,
    });
    expect(member.role).toBe('viewer');
  });
});

describe('Rolle und letzter Admin', () => {
  it('ändert die Rolle mit Audit (vorher/nachher)', async () => {
    const { member } = await newMember('emil@muuv.test');
    const updated = await updateMemberRole(testDb.db, {
      ...admin(),
      memberId: member.id,
      role: 'viewer',
      now: NOW,
    });
    expect(updated.role).toBe('viewer');
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'member.role_update'));
    expect(event).toMatchObject({
      actorUserId: ids.admin,
      target: { id: member.id, previousRole: 'editor', role: 'viewer' },
    });
  });

  it('der letzte Admin kann weder herabgestuft noch entfernt werden', async () => {
    const [self] = await testDb.db
      .select({ id: members.id })
      .from(members)
      .where(and(eq(members.userId, ids.admin), eq(members.organizationId, ids.org)));
    expect(
      await errorCode(
        updateMemberRole(testDb.db, { ...admin(), memberId: self!.id, role: 'editor', now: NOW }),
      ),
    ).toBe('LAST_ADMIN');
    const { member: second } = await newMember('zweit@muuv.test', 'admin');
    // Mit zweitem Admin geht das Herabstufen.
    await updateMemberRole(testDb.db, { ...admin(), memberId: self!.id, role: 'editor', now: NOW });
    expect(
      await errorCode(
        removeMember(testDb.db, { orgId: ids.org, actorUserId: ids.admin, memberId: second.id }),
      ),
    ).toBe('LAST_ADMIN');
  });

  it('fremde Mitgliedschaften sind nicht auffindbar', async () => {
    const [foreign] = await testDb.db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.userId, ids.outsider));
    expect(
      await errorCode(
        updateMemberRole(testDb.db, {
          ...admin(),
          memberId: foreign!.id,
          role: 'viewer',
          now: NOW,
        }),
      ),
    ).toBe('NOT_FOUND');
    expect(await errorCode(removeMember(testDb.db, { ...admin(), memberId: foreign!.id }))).toBe(
      'NOT_FOUND',
    );
    expect(
      await errorCode(
        regeneratePasswordLink(testDb.db, { ...admin(), memberId: foreign!.id, now: NOW }),
      ),
    ).toBe('NOT_FOUND');
  });
});

describe('Entfernen', () => {
  it('beendet Sessions, sperrt Links, löscht persönliche Ansichten, behält freigegebene', async () => {
    const { member, userId, token } = await newMember('emil@muuv.test');
    await session(userId);
    await session(ids.admin);
    const view = (name: string, shared: boolean) => ({
      organizationId: ids.org,
      ownerUserId: userId,
      name,
      area: 'dashboard',
      shared,
      state: {},
    });
    await testDb.db.insert(savedViews).values([view('Privat', false), view('Team', true)]);

    await removeMember(testDb.db, { ...admin(), memberId: member.id });
    expect(await testDb.db.select().from(members).where(eq(members.id, member.id))).toEqual([]);
    expect(await testDb.db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([]);
    expect(
      await testDb.db.select().from(sessions).where(eq(sessions.userId, ids.admin)),
    ).toHaveLength(1);
    expect(
      (await testDb.db.select({ name: savedViews.name }).from(savedViews)).map((v) => v.name),
    ).toEqual(['Team']);
    expect(await inspectPasswordLink(testDb.db, token, NOW)).toBeNull();
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'member.remove'));
    expect(event).toMatchObject({ actorUserId: ids.admin, target: { id: member.id, userId } });
  });

  it('sich selbst entfernt man hier nicht', async () => {
    await newMember('zweit@muuv.test', 'admin');
    const [self] = await testDb.db
      .select({ id: members.id })
      .from(members)
      .where(eq(members.userId, ids.admin));
    expect(await errorCode(removeMember(testDb.db, { ...admin(), memberId: self!.id }))).toBe(
      'SELF',
    );
  });
});

describe('Einmal-Link', () => {
  it('setzt das Passwort genau einmal, beendet Sessions, Audit mit dem Mitglied als Handelndem', async () => {
    const { token, userId } = await newMember('emil@muuv.test');
    expect(await inspectPasswordLink(testDb.db, token, NOW)).toMatchObject({
      email: 'emil@muuv.test',
      name: 'emil',
    });
    await session(userId);
    expect(await redeemPasswordLink(testDb.db, { token, passwordHash: 'neu', now: NOW })).toBe(
      true,
    );
    const [account] = await testDb.db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(account).toMatchObject({ providerId: 'credential', accountId: userId, password: 'neu' });
    expect(await testDb.db.select().from(sessions).where(eq(sessions.userId, userId))).toEqual([]);
    expect(await redeemPasswordLink(testDb.db, { token, passwordHash: 'nochmal', now: NOW })).toBe(
      false,
    );
    expect(await inspectPasswordLink(testDb.db, token, NOW)).toBeNull();
    const [event] = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'member.password_set'));
    expect(event).toMatchObject({ organizationId: ids.org, actorUserId: userId });
    const list = await listMembers(testDb.db, { ...admin(), now: NOW });
    expect(list.find((m) => m.userId === userId)?.status).toBe('active');
  });

  it('abgelaufene und unbekannte Links gelten nicht', async () => {
    const { token } = await newMember('emil@muuv.test');
    const later = new Date(NOW.getTime() + 7 * DAY + 1);
    expect(await inspectPasswordLink(testDb.db, token, later)).toBeNull();
    expect(await redeemPasswordLink(testDb.db, { token, passwordHash: 'x', now: later })).toBe(
      false,
    );
    expect(await inspectPasswordLink(testDb.db, 'b'.repeat(43), NOW)).toBeNull();
  });

  it('neu erzeugen macht den alten Link ungültig, ersetzt ein bestehendes Passwort', async () => {
    const { token: first, member, userId } = await newMember('emil@muuv.test');
    await redeemPasswordLink(testDb.db, { token: first, passwordHash: 'alt', now: NOW });
    const { token: second } = await regeneratePasswordLink(testDb.db, {
      ...admin(),
      memberId: member.id,
      now: NOW,
    });
    const { token: third } = await regeneratePasswordLink(testDb.db, {
      ...admin(),
      memberId: member.id,
      now: NOW,
    });
    expect(await inspectPasswordLink(testDb.db, second, NOW)).toBeNull();
    expect(
      await redeemPasswordLink(testDb.db, { token: third, passwordHash: 'neu', now: NOW }),
    ).toBe(true);
    const rows = await testDb.db.select().from(accounts).where(eq(accounts.userId, userId));
    expect(rows.map((r) => r.password)).toEqual(['neu']);
    const events = await testDb.db
      .select()
      .from(auditEvents)
      .where(eq(auditEvents.action, 'member.link_create'));
    expect(events).toHaveLength(2);
    expect(events[0]?.actorUserId).toBe(ids.admin);
  });

  it('kein Link für Nutzer, die auch in einer anderen Organisation Mitglied sind', async () => {
    const { member, userId } = await newMember('emil@muuv.test');
    await testDb.db
      .insert(members)
      .values({ organizationId: ids.otherOrg, userId, role: 'viewer', createdAt: NOW });
    expect(
      await errorCode(
        regeneratePasswordLink(testDb.db, { ...admin(), memberId: member.id, now: NOW }),
      ),
    ).toBe('OTHER_ORGANIZATION');
  });
});
