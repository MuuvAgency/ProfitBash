import { schema } from '@profitbash/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  signIn,
  TEST_APP_URL,
  type TestContext,
} from './testing';

let ctx: TestContext;
let adminCookie: string;
const users = { editor: '', viewer: '', leaver: '' };

beforeAll(async () => {
  ctx = await createTestContext();
  const org = ctx.seeded.organizationId;
  users.editor = (
    await createUser(ctx, { email: 'editor@muuv.test', org: { id: org, role: 'editor' } })
  ).id;
  users.viewer = (
    await createUser(ctx, { email: 'viewer@muuv.test', org: { id: org, role: 'viewer' } })
  ).id;
  users.leaver = (
    await createUser(ctx, { email: 'leaver@muuv.test', org: { id: org, role: 'viewer' } })
  ).id;
  adminCookie = await signIn(ctx, ctx.seeded.email);
});

afterAll(async () => {
  await ctx?.close();
});

/**
 * Direkt an better-auth (ohne die Allowlist der App, `app.ts`): Die Organisations-Endpunkte sind per HTTP gesperrt, die
 * Audit-Hooks gelten aber für jeden Aufruf (z. B. künftige serverseitige Aufrufe über `auth.api.*`).
 */
function authRequest(path: string, options: { method: string; cookie?: string; json?: unknown }) {
  const headers = new Headers({ origin: TEST_APP_URL, 'content-type': 'application/json' });
  if (options.cookie) headers.set('cookie', options.cookie);
  return ctx.auth.handler(
    new Request(`${TEST_APP_URL}${path}`, {
      method: options.method,
      headers,
      body: JSON.stringify(options.json ?? {}),
    }),
  );
}

async function eventsFor(action: string) {
  return ctx.testDb.db
    .select()
    .from(schema.auditEvents)
    .where(eq(schema.auditEvents.action, action));
}

async function memberId(userId: string) {
  const [row] = await ctx.testDb.db
    .select({ id: schema.members.id })
    .from(schema.members)
    .where(
      and(
        eq(schema.members.userId, userId),
        eq(schema.members.organizationId, ctx.seeded.organizationId),
      ),
    );
  return row!.id;
}

describe('Audit-Events für Schreibvorgänge über better-auth', () => {
  it('Seed: Anlegen der Organisation und des Admin-Mitglieds ohne handelnden Nutzer', async () => {
    const [created] = await eventsFor('organization.create');
    expect(created).toMatchObject({
      organizationId: ctx.seeded.organizationId,
      actorUserId: null,
      target: { type: 'organization', id: ctx.seeded.organizationId, name: 'Muuv', slug: 'muuv' },
    });
    const added = await eventsFor('member.add');
    expect(added).toHaveLength(1);
    expect(added[0]).toMatchObject({
      organizationId: ctx.seeded.organizationId,
      target: { type: 'member', userId: ctx.seeded.userId, role: 'admin' },
    });
  });

  it('Organisation umbenennen', async () => {
    const res = await authRequest('/api/auth/organization/update', {
      method: 'POST',
      cookie: adminCookie,
      json: { organizationId: ctx.seeded.organizationId, data: { name: 'Muuv GmbH' } },
    });
    expect(res.status).toBe(200);

    expect(await eventsFor('organization.update')).toEqual([
      expect.objectContaining({
        organizationId: ctx.seeded.organizationId,
        actorUserId: ctx.seeded.userId,
        target: {
          type: 'organization',
          id: ctx.seeded.organizationId,
          name: 'Muuv GmbH',
          slug: 'muuv',
        },
      }),
    ]);
  });

  it('Rolle eines Mitglieds ändern (mit vorheriger Rolle)', async () => {
    const id = await memberId(users.viewer);
    const res = await authRequest('/api/auth/organization/update-member-role', {
      method: 'POST',
      cookie: adminCookie,
      json: { memberId: id, role: 'editor', organizationId: ctx.seeded.organizationId },
    });
    expect(res.status).toBe(200);

    expect(await eventsFor('member.role_update')).toEqual([
      expect.objectContaining({
        organizationId: ctx.seeded.organizationId,
        actorUserId: ctx.seeded.userId,
        target: {
          type: 'member',
          id,
          userId: users.viewer,
          previousRole: 'viewer',
          role: 'editor',
        },
      }),
    ]);
  });

  it('abgelehnte Änderungen erzeugen kein Audit-Event', async () => {
    const editorCookie = await signIn(ctx, 'editor@muuv.test');
    const before = await eventsFor('member.role_update');
    const res = await authRequest('/api/auth/organization/update-member-role', {
      method: 'POST',
      cookie: editorCookie,
      json: { memberId: await memberId(users.leaver), role: 'admin' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await eventsFor('member.role_update')).toHaveLength(before.length);
  });

  it('Mitglied entfernen', async () => {
    const id = await memberId(users.editor);
    const res = await authRequest('/api/auth/organization/remove-member', {
      method: 'POST',
      cookie: adminCookie,
      json: { memberIdOrEmail: id, organizationId: ctx.seeded.organizationId },
    });
    expect(res.status).toBe(200);

    expect(await eventsFor('member.remove')).toEqual([
      expect.objectContaining({
        organizationId: ctx.seeded.organizationId,
        actorUserId: ctx.seeded.userId,
        target: { type: 'member', id, userId: users.editor, role: 'editor' },
      }),
    ]);
  });

  it('Organisation selbst verlassen', async () => {
    const id = await memberId(users.leaver);
    const res = await authRequest('/api/auth/organization/leave', {
      method: 'POST',
      cookie: await signIn(ctx, 'leaver@muuv.test'),
      json: { organizationId: ctx.seeded.organizationId },
    });
    expect(res.status).toBe(200);

    expect(await eventsFor('member.leave')).toEqual([
      expect.objectContaining({
        organizationId: ctx.seeded.organizationId,
        actorUserId: users.leaver,
        target: { type: 'member', id, userId: users.leaver, role: 'viewer' },
      }),
    ]);
  });

  it('Einladung anlegen und zurückziehen', async () => {
    const invite = await authRequest('/api/auth/organization/invite-member', {
      method: 'POST',
      cookie: adminCookie,
      json: { email: 'neu@muuv.test', role: 'viewer', organizationId: ctx.seeded.organizationId },
    });
    expect(invite.status).toBe(200);
    const { id } = await readJson<{ id: string }>(invite);

    const cancel = await authRequest('/api/auth/organization/cancel-invitation', {
      method: 'POST',
      cookie: adminCookie,
      json: { invitationId: id },
    });
    expect(cancel.status).toBe(200);

    const target = { type: 'invitation', id, email: 'neu@muuv.test', role: 'viewer' };
    expect(await eventsFor('invitation.create')).toEqual([
      expect.objectContaining({ actorUserId: ctx.seeded.userId, target }),
    ]);
    expect(await eventsFor('invitation.cancel')).toEqual([
      expect.objectContaining({ actorUserId: ctx.seeded.userId, target }),
    ]);
  });
});

describe('Einladung annehmen', () => {
  it('der Eingeladene ist der Handelnde', async () => {
    const invitee = await createUser(ctx, { email: 'gast@muuv.test' });
    const invite = await authRequest('/api/auth/organization/invite-member', {
      method: 'POST',
      cookie: adminCookie,
      json: { email: 'gast@muuv.test', role: 'viewer', organizationId: ctx.seeded.organizationId },
    });
    const { id } = await readJson<{ id: string }>(invite);

    const accept = await authRequest('/api/auth/organization/accept-invitation', {
      method: 'POST',
      cookie: await signIn(ctx, 'gast@muuv.test'),
      json: { invitationId: id },
    });
    expect(accept.status).toBe(200);

    expect(await eventsFor('invitation.accept')).toEqual([
      expect.objectContaining({
        organizationId: ctx.seeded.organizationId,
        actorUserId: invitee.id,
        target: { type: 'invitation', id, email: 'gast@muuv.test', role: 'viewer' },
      }),
    ]);
  });
});

describe('Org-Admins können ihre Organisation nicht löschen (Rollenrechte)', () => {
  it('lehnt das Löschen ab, die Organisation bleibt bestehen', async () => {
    const res = await authRequest('/api/auth/organization/delete', {
      method: 'POST',
      cookie: adminCookie,
      json: { organizationId: ctx.seeded.organizationId },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await ctx.testDb.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, ctx.seeded.organizationId));
    expect(rows).toHaveLength(1);
  });
});
