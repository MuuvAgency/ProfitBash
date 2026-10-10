import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  cleanupNotifications,
  countUnreadNotifications,
  createNotification,
  getVisibleNotification,
  listNotifications,
  listNotificationsAfter,
  markNotificationsRead,
  NOTIFICATION_CHANNEL,
  type CreateNotificationInput,
} from './notifications';
import {
  amazonAdsProfiles,
  auditEvents,
  members,
  notificationReads,
  notifications,
  users,
} from './schema';
import { createTestConnection, createTestOrganization, createTestProfile } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Benachrichtigungen (5.2a): Dubletten, NOTIFY, Sichtbarkeit über den Access-Layer, Lesestatus, Aufräumen. */

let testDb: TestDatabase;
const ids = {
  org: '',
  otherOrg: '',
  admin: '',
  editor: '',
  viewer: '',
  outsider: '',
  profile: '',
  hidden: '',
  foreign: '',
};

const as = (userId: string) => ({ userId, orgId: ids.org });

const input = (overrides: Partial<CreateNotificationInput> = {}): CreateNotificationInput => ({
  organizationId: ids.org,
  profileId: ids.profile,
  audience: 'members',
  kind: 'bulk_file_stale',
  severity: 'warning',
  params: { days: 9 },
  link: '/admin/connections',
  ...overrides,
});

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const [admin, editor, viewer, outsider] = await db
    .insert(users)
    .values([
      { name: 'Ada', email: 'ada@muuv.test' },
      { name: 'Emil', email: 'emil@muuv.test' },
      { name: 'Vera', email: 'vera@muuv.test' },
      { name: 'Otto', email: 'otto@andere.test' },
    ])
    .returning({ id: users.id });
  ids.admin = admin!.id;
  ids.editor = editor!.id;
  ids.viewer = viewer!.id;
  ids.outsider = outsider!.id;
  await db.insert(members).values([
    { organizationId: ids.org, userId: ids.admin, role: 'admin', createdAt: new Date() },
    { organizationId: ids.org, userId: ids.editor, role: 'editor', createdAt: new Date() },
    { organizationId: ids.org, userId: ids.viewer, role: 'viewer', createdAt: new Date() },
    { organizationId: ids.otherOrg, userId: ids.outsider, role: 'admin', createdAt: new Date() },
  ]);
  const connection = await createTestConnection(db, ids.org, 'amzn1.account.MUUV');
  const otherConnection = await createTestConnection(db, ids.otherOrg, 'amzn1.account.OTHER');
  ids.profile = await createTestProfile(db, {
    organizationId: ids.org,
    connectionId: connection,
    amazonProfileId: '1',
  });
  ids.hidden = await createTestProfile(db, {
    organizationId: ids.org,
    connectionId: connection,
    amazonProfileId: '2',
  });
  await db
    .update(amazonAdsProfiles)
    .set({ isHidden: true })
    .where(eq(amazonAdsProfiles.id, ids.hidden));
  ids.foreign = await createTestProfile(db, {
    organizationId: ids.otherOrg,
    connectionId: otherConnection,
    amazonProfileId: '3',
  });
});

afterAll(async () => {
  await testDb.close();
});

beforeEach(async () => {
  await testDb.db.delete(notifications);
  await testDb.db.delete(auditEvents);
});

describe('createNotification', () => {
  it('legt eine Benachrichtigung an und ignoriert Dubletten je Schlüssel', async () => {
    const first = await createNotification(testDb.db, input({ dedupeKey: 'stale:1:0' }));
    const second = await createNotification(testDb.db, input({ dedupeKey: 'stale:1:0' }));
    expect(first).toEqual(expect.any(String));
    expect(second).toBeNull();
    expect(await testDb.db.select().from(notifications)).toHaveLength(1);
    // Derselbe Schlüssel in einer anderen Organisation ist keine Dublette.
    const foreign = await createNotification(
      testDb.db,
      input({ organizationId: ids.otherOrg, profileId: ids.foreign, dedupeKey: 'stale:1:0' }),
    );
    expect(foreign).toEqual(expect.any(String));
  });

  it('meldet neue Benachrichtigungen per NOTIFY erst nach dem Commit', async () => {
    const listener = postgres(testDb.url, { max: 1, onnotice: () => {} });
    const received: string[] = [];
    try {
      await listener.listen(NOTIFICATION_CHANNEL, (payload) => received.push(payload));
      let id: string | null = null;
      await testDb.db.transaction(async (tx) => {
        id = await createNotification(tx, input());
        await new Promise((resolve) => setTimeout(resolve, 100));
        expect(received).toHaveLength(0);
      });
      await expect.poll(() => received.length).toBe(1);
      expect(JSON.parse(received[0]!)).toEqual({ id, organizationId: ids.org });

      // Zurückgerollt: keine Meldung.
      await testDb.db
        .transaction(async (tx) => {
          await createNotification(tx, input());
          throw new Error('abbrechen');
        })
        .catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(received).toHaveLength(1);
    } finally {
      await listener.end();
    }
  });
});

describe('Sichtbarkeit', () => {
  const visibleTo = async (id: string) => {
    const result: string[] = [];
    for (const [name, userId] of Object.entries({
      admin: ids.admin,
      editor: ids.editor,
      viewer: ids.viewer,
    })) {
      if (await getVisibleNotification(testDb.db, { ...as(userId), id })) result.push(name);
    }
    if (
      await getVisibleNotification(testDb.db, { userId: ids.outsider, orgId: ids.otherOrg, id })
    ) {
      result.push('outsider');
    }
    return result;
  };

  it('`members`: alle Mitglieder, die das Profil sehen', async () => {
    const id = (await createNotification(testDb.db, input()))!;
    expect(await visibleTo(id)).toEqual(['admin', 'editor', 'viewer']);
  });

  it('ausgeblendetes Profil: nur Admins', async () => {
    const id = (await createNotification(testDb.db, input({ profileId: ids.hidden })))!;
    expect(await visibleTo(id)).toEqual(['admin']);
  });

  it('`recipient`: nur der Empfänger', async () => {
    const id = (await createNotification(
      testDb.db,
      input({ audience: 'recipient', recipientUserId: ids.viewer }),
    ))!;
    expect(await visibleTo(id)).toEqual(['viewer']);
  });

  it('`admins`: Org-Admins und der Empfänger', async () => {
    const id = (await createNotification(
      testDb.db,
      input({ audience: 'admins', recipientUserId: ids.editor }),
    ))!;
    expect(await visibleTo(id)).toEqual(['admin', 'editor']);
  });

  it('ohne Profil: nach `audience` für die Mitglieder der Organisation', async () => {
    const id = (await createNotification(
      testDb.db,
      input({ profileId: null, audience: 'admins' }),
    ))!;
    expect(await visibleTo(id)).toEqual(['admin']);
  });

  it('der Empfänger sieht ein Profil, das er nicht sehen darf, trotzdem nicht', async () => {
    const id = (await createNotification(
      testDb.db,
      input({ profileId: ids.hidden, audience: 'recipient', recipientUserId: ids.editor }),
    ))!;
    expect(await visibleTo(id)).toEqual([]);
  });

  it('fremde Organisation: nichts', async () => {
    const id = (await createNotification(testDb.db, input()))!;
    expect(
      await getVisibleNotification(testDb.db, { userId: ids.outsider, orgId: ids.org, id }),
    ).toBeNull();
  });
});

describe('listNotifications', () => {
  it('liefert die neuesten zuerst mit Profilname, Lesestatus und Seiten', async () => {
    const a = (await createNotification(testDb.db, input({ params: { n: 1 } })))!;
    const b = (await createNotification(
      testDb.db,
      input({ kind: 'file_import_imported', severity: 'success' }),
    ))!;
    const c = (await createNotification(testDb.db, input({ profileId: null })))!;
    await markNotificationsRead(testDb.db, { ...as(ids.editor), ids: [b] });

    const page1 = await listNotifications(testDb.db, {
      ...as(ids.editor),
      unread: false,
      limit: 2,
    });
    expect(page1.items.map((item) => item.id)).toEqual([c, b]);
    expect(page1.items[0]).toMatchObject({ profileId: null, profileName: null, readAt: null });
    expect(page1.items[1]).toMatchObject({
      kind: 'file_import_imported',
      severity: 'success',
      profileId: ids.profile,
      profileName: 'Konto 1',
      readAt: expect.any(String),
    });
    expect(page1.nextBefore).toBe(page1.items[1]!.seq);

    const page2 = await listNotifications(testDb.db, {
      ...as(ids.editor),
      unread: false,
      limit: 2,
      before: page1.nextBefore!,
    });
    expect(page2.items.map((item) => item.id)).toEqual([a]);
    expect(page2.items[0]!.params).toEqual({ n: 1 });
    expect(page2.nextBefore).toBeNull();
  });

  it('filtert nach ungelesen, Art und Profil', async () => {
    const a = (await createNotification(testDb.db, input()))!;
    const b = (await createNotification(testDb.db, input({ kind: 'file_import_failed' })))!;
    const c = (await createNotification(testDb.db, input({ profileId: null })))!;
    await markNotificationsRead(testDb.db, { ...as(ids.admin), ids: [a] });
    const list = (query: Partial<Parameters<typeof listNotifications>[1]>) =>
      listNotifications(testDb.db, { ...as(ids.admin), unread: false, limit: 50, ...query }).then(
        (page) => page.items.map((item) => item.id),
      );
    expect(await list({ unread: true })).toEqual([c, b]);
    expect(await list({ kind: 'file_import_failed' })).toEqual([b]);
    expect(await list({ profileId: ids.profile })).toEqual([b, a]);
  });

  it('Nicht-Mitglied: Fehler', async () => {
    await expect(
      listNotifications(testDb.db, {
        userId: ids.outsider,
        orgId: ids.org,
        unread: false,
        limit: 5,
      }),
    ).rejects.toThrow();
  });
});

describe('countUnreadNotifications und markNotificationsRead', () => {
  it('zählt nur sichtbare, ungelesene; gelesen setzen wirkt je Nutzer, mit Audit', async () => {
    const a = (await createNotification(testDb.db, input()))!;
    const b = (await createNotification(testDb.db, input()))!;
    const hidden = (await createNotification(testDb.db, input({ profileId: ids.hidden })))!;
    expect(await countUnreadNotifications(testDb.db, as(ids.editor))).toBe(2);
    expect(await countUnreadNotifications(testDb.db, as(ids.admin))).toBe(3);

    // Unsichtbare IDs zählen nicht und werden nicht gesetzt.
    const updated = await markNotificationsRead(testDb.db, {
      ...as(ids.editor),
      ids: [a, hidden],
    });
    expect(updated).toBe(1);
    expect(await countUnreadNotifications(testDb.db, as(ids.editor))).toBe(1);
    expect(await countUnreadNotifications(testDb.db, as(ids.admin))).toBe(3);
    // Zweimal gelesen setzen ändert nichts.
    expect(await markNotificationsRead(testDb.db, { ...as(ids.editor), ids: [a] })).toBe(0);

    expect(await markNotificationsRead(testDb.db, { ...as(ids.admin), all: true })).toBe(3);
    expect(await countUnreadNotifications(testDb.db, as(ids.admin))).toBe(0);
    expect(
      await testDb.db
        .select()
        .from(notificationReads)
        .where(eq(notificationReads.notificationId, b)),
    ).toHaveLength(1);

    const audits = await testDb.db.select().from(auditEvents);
    expect(audits.map((event) => [event.action, event.actorUserId])).toEqual(
      expect.arrayContaining([
        ['notification.read', ids.editor],
        ['notification.read', ids.admin],
      ]),
    );
    expect(audits).toHaveLength(2);
  });
});

describe('listNotificationsAfter', () => {
  it('liefert sichtbare Benachrichtigungen nach einer Nummer, älteste zuerst (Wiederaufnahme)', async () => {
    const a = (await createNotification(testDb.db, input()))!;
    const b = (await createNotification(testDb.db, input()))!;
    await createNotification(testDb.db, input({ profileId: ids.hidden }));
    const c = (await createNotification(testDb.db, input()))!;
    const [first] = await listNotificationsAfter(testDb.db, {
      ...as(ids.editor),
      afterSeq: 0,
      limit: 1,
    });
    expect(first!.id).toBe(a);
    const rest = await listNotificationsAfter(testDb.db, {
      ...as(ids.editor),
      afterSeq: first!.seq,
      limit: 10,
    });
    expect(rest.map((item) => item.id)).toEqual([b, c]);
  });
});

describe('cleanupNotifications', () => {
  it('löscht gelesene nach 90 Tagen und alle nach 365 Tagen', async () => {
    const now = new Date('2099-12-31T00:00:00Z');
    const daysAgo = (days: number) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
    const readOld = (await createNotification(testDb.db, input()))!;
    const unreadOld = (await createNotification(testDb.db, input()))!;
    const readNew = (await createNotification(testDb.db, input()))!;
    const ancient = (await createNotification(testDb.db, input()))!;
    const set = (id: string, createdAt: Date) =>
      testDb.db.update(notifications).set({ createdAt }).where(eq(notifications.id, id));
    await set(readOld, daysAgo(91));
    await set(unreadOld, daysAgo(200));
    await set(readNew, daysAgo(30));
    await set(ancient, daysAgo(366));
    await markNotificationsRead(testDb.db, { ...as(ids.viewer), ids: [readOld, readNew] });

    expect(await cleanupNotifications(testDb.db, { now })).toBe(2);
    const left = await testDb.db.select({ id: notifications.id }).from(notifications);
    expect(left.map((row) => row.id).sort()).toEqual([unreadOld, readNew].sort());
  });
});
