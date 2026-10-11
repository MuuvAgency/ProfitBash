import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditEventFilters, listAuditEvents } from './audit';
import { auditEvents, users } from './schema';
import { createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

/** Audit-Log lesen (6.1): nur die eigene Organisation, neueste zuerst, seitenweise. */

let testDb: TestDatabase;
const ids = { org: '', otherOrg: '', anna: '', ben: '' };

/** `minutes` Minuten nach einem festen Zeitpunkt (größer = neuer). */
const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 8, minutes));

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.otherOrg = await createTestOrganization(db, 'andere');
  const [anna, ben] = await db
    .insert(users)
    .values([
      { name: 'Anna', email: 'anna@muuv.test' },
      { name: 'Ben', email: 'ben@muuv.test' },
    ])
    .returning({ id: users.id });
  ids.anna = anna!.id;
  ids.ben = ben!.id;

  const event = (
    minutes: number,
    action: string,
    actorUserId: string | null,
    organizationId: string | null = ids.org,
  ) => ({
    organizationId,
    actorUserId,
    action,
    target: { type: action.split('.')[0]!, id: `t${minutes}` },
    createdAt: at(minutes),
  });
  await db
    .insert(auditEvents)
    .values([
      event(1, 'tag.create', ids.anna),
      event(2, 'member.create', ids.ben),
      event(3, 'tag.delete', ids.anna),
      event(4, 'file_import.create', null),
      event(5, 'tag.create', ids.ben, ids.otherOrg),
      event(6, 'platform.cleanup', null, null),
    ]);
});

afterAll(async () => {
  await testDb.close();
});

const actions = (events: { action: string }[]) => events.map((e) => e.action);

describe('listAuditEvents', () => {
  it('liefert nur Ereignisse der Organisation, neueste zuerst, mit dem Handelnden', async () => {
    const page = await listAuditEvents(testDb.db, { orgId: ids.org, limit: 10 });
    expect(actions(page.events)).toEqual([
      'file_import.create',
      'tag.delete',
      'member.create',
      'tag.create',
    ]);
    expect(page.nextCursor).toBeNull();
    expect(page.events[0]).toMatchObject({
      actor: null,
      target: { type: 'file_import', id: 't4' },
    });
    expect(page.events[1]!.actor).toEqual({ id: ids.anna, name: 'Anna', email: 'anna@muuv.test' });
    expect(page.events[1]!.createdAt).toEqual(at(3));
  });

  it('blättert über den Cursor, ohne Zeilen zu wiederholen oder auszulassen', async () => {
    const first = await listAuditEvents(testDb.db, { orgId: ids.org, limit: 3 });
    expect(first.events).toHaveLength(3);
    expect(first.nextCursor).toBe(first.events[2]!.id);
    const second = await listAuditEvents(testDb.db, {
      orgId: ids.org,
      limit: 3,
      cursor: first.nextCursor!,
    });
    expect(actions(second.events)).toEqual(['tag.create']);
    expect(second.nextCursor).toBeNull();
  });

  it('nimmt keinen Cursor einer anderen Organisation an', async () => {
    const other = await listAuditEvents(testDb.db, { orgId: ids.otherOrg, limit: 10 });
    const page = await listAuditEvents(testDb.db, {
      orgId: ids.org,
      limit: 10,
      cursor: other.events[0]!.id,
    });
    expect(page.events).toEqual([]);
  });

  it('filtert nach Handelndem, Bereich und Zeitraum', async () => {
    const by = (filter: Partial<Parameters<typeof listAuditEvents>[1]>) =>
      listAuditEvents(testDb.db, { orgId: ids.org, limit: 10, ...filter }).then((p) =>
        actions(p.events),
      );
    expect(await by({ actorUserId: ids.anna })).toEqual(['tag.delete', 'tag.create']);
    expect(await by({ area: 'tag' })).toEqual(['tag.delete', 'tag.create']);
    // `from` einschließlich, `to` ausschließlich
    expect(await by({ from: at(2), to: at(4) })).toEqual(['tag.delete', 'member.create']);
    // Der Bereich ist ein ganzer Präfix bis zum Punkt, kein Muster.
    expect(await by({ area: 'ta' })).toEqual([]);
    expect(await by({ area: '%' })).toEqual([]);
  });
});

describe('listAuditEvents: Secrets', () => {
  it('liefert keine Felder, deren Name nach Token, Passwort oder Secret klingt, auch verschachtelt', async () => {
    const orgId = await createTestOrganization(testDb.db, 'secrets');
    await testDb.db.insert(auditEvents).values({
      organizationId: orgId,
      actorUserId: null,
      action: 'connection.create',
      target: {
        type: 'connection',
        id: 'c1',
        refreshToken: 'Atzr|geheim',
        after: { name: 'Konto', clientSecret: 'geheim', list: [{ password: 'geheim', ok: 1 }] },
      },
    });
    const { events } = await listAuditEvents(testDb.db, { orgId, limit: 10 });
    expect(events[0]!.target).toEqual({
      type: 'connection',
      id: 'c1',
      after: { name: 'Konto', list: [{ ok: 1 }] },
    });
  });
});

describe('listAuditEventFilters', () => {
  it('nennt Bereiche und Handelnde der Organisation', async () => {
    const filters = await listAuditEventFilters(testDb.db, ids.org);
    expect(filters.areas).toEqual(['file_import', 'member', 'tag']);
    expect(filters.actors).toEqual([
      { id: ids.anna, name: 'Anna', email: 'anna@muuv.test' },
      { id: ids.ben, name: 'Ben', email: 'ben@muuv.test' },
    ]);
  });
});
