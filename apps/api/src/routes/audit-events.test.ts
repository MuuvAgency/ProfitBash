import { schema } from '@profitbash/db';
import type { AuditEventFilters, AuditEventList, ErrorResponse } from '@profitbash/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

const { auditEvents, organizations } = schema;

/** Audit-Log (6.1): nur Org-Admins, nur die aktive Organisation. */

let ctx: TestContext;
let admin: string;
let editor: string;
let editorId: string;

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 11, 8, minutes));

beforeAll(async () => {
  ctx = await createTestContext();
  const orgId = ctx.seeded.organizationId;
  editorId = (
    await createUser(ctx, { email: 'editor@muuv.test', org: { id: orgId, role: 'editor' } })
  ).id;
  const { db } = ctx.testDb;
  const [other] = await db
    .insert(organizations)
    .values({ name: 'Andere', slug: 'andere', type: 'internal', createdAt: new Date() })
    .returning({ id: organizations.id });
  // Ausgangslage ohne die Ereignisse des Seeds, damit die Reihenfolge feststeht.
  await db.delete(auditEvents);
  await db.insert(auditEvents).values([
    {
      organizationId: orgId,
      actorUserId: editorId,
      action: 'tag.create',
      target: { type: 'tag', id: 't1', name: 'Hero' },
      createdAt: at(1),
    },
    {
      organizationId: orgId,
      actorUserId: null,
      action: 'file_import.create',
      target: { type: 'file_import', id: 'f1' },
      createdAt: at(2),
    },
    {
      organizationId: other!.id,
      actorUserId: null,
      action: 'tag.delete',
      target: { type: 'tag', id: 'fremd' },
      createdAt: at(3),
    },
    {
      organizationId: null,
      actorUserId: null,
      action: 'platform.cleanup',
      target: { type: 'platform', id: 'p1' },
      createdAt: at(4),
    },
  ]);
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
});

afterAll(async () => {
  await ctx?.close();
});

async function list(query = '') {
  const res = await request(ctx, `/api/audit-events${query}`, { cookie: admin });
  expect(res.status).toBe(200);
  return readJson<AuditEventList>(res);
}

describe('GET /api/audit-events', () => {
  it('verlangt eine Session und die Rolle admin', async () => {
    for (const path of ['/api/audit-events', '/api/audit-events/filters']) {
      expect((await request(ctx, path)).status).toBe(401);
      expect((await request(ctx, path, { cookie: editor })).status).toBe(403);
    }
  });

  it('listet die Ereignisse der aktiven Organisation, neueste zuerst, ohne fremde und plattformweite', async () => {
    const { events, nextCursor } = await list();
    expect(nextCursor).toBeNull();
    expect(events).toEqual([
      {
        id: expect.any(String),
        createdAt: at(2).toISOString(),
        action: 'file_import.create',
        actor: null,
        target: { type: 'file_import', id: 'f1' },
      },
      {
        id: expect.any(String),
        createdAt: at(1).toISOString(),
        action: 'tag.create',
        actor: { id: editorId, name: 'editor@muuv.test', email: 'editor@muuv.test' },
        target: { type: 'tag', id: 't1', name: 'Hero' },
      },
    ]);
  });

  it('filtert nach Bereich, Handelndem und Zeitraum', async () => {
    const actions = async (query: string) => (await list(query)).events.map((e) => e.action);
    expect(await actions('?area=tag')).toEqual(['tag.create']);
    expect(await actions(`?actorUserId=${editorId}`)).toEqual(['tag.create']);
    expect(await actions(`?from=${at(2).toISOString()}`)).toEqual(['file_import.create']);
    expect(await actions(`?to=${at(2).toISOString()}`)).toEqual(['tag.create']);
  });

  it('lehnt ungültige Filter ab', async () => {
    for (const query of ['?area=Tag%25', '?actorUserId=1', '?from=gestern', '?cursor=abc']) {
      const res = await request(ctx, `/api/audit-events${query}`, { cookie: admin });
      expect(res.status, query).toBe(400);
      expect((await readJson<ErrorResponse>(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });
});

describe('GET /api/audit-events/filters', () => {
  it('nennt Bereiche und Handelnde der aktiven Organisation', async () => {
    const res = await request(ctx, '/api/audit-events/filters', { cookie: admin });
    expect(res.status).toBe(200);
    expect(await readJson<AuditEventFilters>(res)).toEqual({
      areas: ['file_import', 'tag'],
      actors: [{ id: editorId, name: 'editor@muuv.test', email: 'editor@muuv.test' }],
    });
  });
});
