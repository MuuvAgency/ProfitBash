import { schema } from '@profitbash/db';
import {
  memberListSchema,
  memberWithLinkSchema,
  passwordLinkInfoSchema,
  type ErrorResponse,
  type Member,
} from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  TEST_APP_URL,
  TEST_PASSWORD,
  type TestContext,
} from '../testing';

/** Mitglieder über die API (2.10, F9): nur Org-Admins, Einmal-Link im Fragment, öffentliche Seite zum Setzen. */

let ctx: TestContext;
let orgId = '';
let admin = '';
let editor = '';

async function call<T>(method: string, path: string, cookie: string, json?: unknown) {
  const res = await request(ctx, `/api${path}`, { method, cookie, json });
  const body = res.status === 204 ? (undefined as T) : await readJson<T>(res);
  return { status: res.status, body, headers: res.headers };
}

const tokenOf = (url: string) => new URL(url).hash.slice(1);
const NEW_PASSWORD = 'ein-neues-passwort-456';

async function signInWith(email: string, password: string) {
  return request(ctx, '/api/auth/sign-in/email', { method: 'POST', json: { email, password } });
}

beforeAll(async () => {
  ctx = await createTestContext();
  orgId = ctx.seeded.organizationId;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: orgId, role: 'editor' } });
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
});

afterAll(async () => {
  await ctx?.close();
});

describe('/api/members', () => {
  it('nur Org-Admins', async () => {
    expect((await call('GET', '/members', '')).status).toBe(401);
    expect((await call('GET', '/members', editor)).status).toBe(403);
    expect(
      (await call('POST', '/members', editor, { email: 'x@muuv.test', name: 'X', role: 'viewer' }))
        .status,
    ).toBe(403);
    // Auch Ändern, Entfernen und Link neu erzeugen nur für Admins. Ziel ist ein gewöhnliches Mitglied (kein Superadmin,
    // dessen Schutz sonst ebenfalls 403 ergäbe); geprüft wird der Fehlercode der Rollenprüfung.
    await createUser(ctx, { email: 'ziel@muuv.test', org: { id: orgId, role: 'viewer' } });
    const list = await call<{ members: Member[] }>('GET', '/members', admin);
    const target = list.body.members.find((m) => m.email === 'ziel@muuv.test')!;
    for (const [method, path, body] of [
      ['PATCH', `/members/${target.id}`, { role: 'editor' }],
      ['DELETE', `/members/${target.id}`, undefined],
      ['POST', `/members/${target.id}/password-link`, undefined],
    ] as const) {
      const res = await call<ErrorResponse>(method, path, editor, body);
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(res.body.error.code, `${method} ${path}`).toBe('FORBIDDEN');
    }
    // Gegenprobe: Der Admin darf es.
    expect((await call('PATCH', `/members/${target.id}`, admin, { role: 'editor' })).status).toBe(
      200,
    );
  });

  it('anlegen → Link im Fragment; Passwort setzen → Anmeldung; Link nur einmal; Token nie im Log', async () => {
    const created = await call<{ member: Member; link: { url: string; expiresAt: string } }>(
      'POST',
      '/members',
      admin,
      { email: 'Neu@Muuv.test', name: 'Nora Neu', role: 'viewer' },
    );
    expect(created.status).toBe(201);
    expect(memberWithLinkSchema.safeParse(created.body).error).toBeUndefined();
    expect(created.body.member).toMatchObject({ email: 'neu@muuv.test', status: 'pending' });
    const url = new URL(created.body.link.url);
    expect(`${url.origin}${url.pathname}`).toBe(`${TEST_APP_URL}/set-password`);
    expect(url.search).toBe('');
    const token = tokenOf(created.body.link.url);
    expect(token).toHaveLength(43);

    const list = await call<{ members: Member[] }>('GET', '/members', admin);
    expect(memberListSchema.safeParse(list.body).error).toBeUndefined();
    expect(list.body.members.find((m) => m.email === 'neu@muuv.test')?.status).toBe('pending');

    // Öffentlich, ohne Session: wem gehört der Link?
    const info = await call<unknown>('POST', '/password-links/inspect', '', { token });
    expect(info.status).toBe(200);
    expect(passwordLinkInfoSchema.parse(info.body)).toMatchObject({
      email: 'neu@muuv.test',
      name: 'Nora Neu',
    });

    const tooShort = await call<ErrorResponse>('POST', '/password-links/redeem', '', {
      token,
      password: 'kurz',
    });
    expect(tooShort.status).toBe(400);
    const redeemed = await call('POST', '/password-links/redeem', '', {
      token,
      password: NEW_PASSWORD,
    });
    expect(redeemed.status).toBe(204);
    expect((await signInWith('neu@muuv.test', NEW_PASSWORD)).status).toBe(200);

    const again = await call<ErrorResponse>('POST', '/password-links/redeem', '', {
      token,
      password: 'noch-ein-passwort-789',
    });
    expect(again.status).toBe(410);
    expect(again.body.error.code).toBe('PASSWORD_LINK_INVALID');
    expect((await call('POST', '/password-links/inspect', '', { token })).status).toBe(410);

    expect(JSON.stringify(ctx.logs)).not.toContain(token);
    const [link] = await ctx.testDb.db.select().from(schema.memberPasswordLinks);
    expect(JSON.stringify(link)).not.toContain(token);
  });

  it('E-Mail vergeben → 409; Rolle ändern; letzter Admin geschützt; sich selbst nicht entfernen', async () => {
    const taken = await call<ErrorResponse>('POST', '/members', admin, {
      email: 'editor@muuv.test',
      name: 'Doppelt',
      role: 'viewer',
    });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('MEMBER_EMAIL_TAKEN');

    const list = await call<{ members: Member[] }>('GET', '/members', admin);
    const self = list.body.members.find((m) => m.isSelf)!;
    const demote = await call<ErrorResponse>('PATCH', `/members/${self.id}`, admin, {
      role: 'editor',
    });
    expect(demote.status).toBe(409);
    expect(demote.body.error.code).toBe('MEMBER_LAST_ADMIN');
    const removeSelf = await call<ErrorResponse>('DELETE', `/members/${self.id}`, admin);
    expect(removeSelf.status).toBe(409);
    expect(removeSelf.body.error.code).toBe('MEMBER_SELF');

    const editorMember = list.body.members.find((m) => m.email === 'editor@muuv.test')!;
    const promoted = await call<Member>('PATCH', `/members/${editorMember.id}`, admin, {
      role: 'viewer',
    });
    expect(promoted.status).toBe(200);
    expect(promoted.body.role).toBe('viewer');
    const [event] = await ctx.testDb.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'member.role_update'));
    expect(event?.actorUserId).toBe(ctx.seeded.userId);
  });

  it('entfernen beendet die Sessions des Mitglieds', async () => {
    await createUser(ctx, { email: 'weg@muuv.test', org: { id: orgId, role: 'editor' } });
    const cookie = await signIn(ctx, 'weg@muuv.test');
    expect((await call('GET', '/me', cookie)).status).toBe(200);
    const list = await call<{ members: Member[] }>('GET', '/members', admin);
    const member = list.body.members.find((m) => m.email === 'weg@muuv.test')!;
    expect((await call('DELETE', `/members/${member.id}`, admin)).status).toBe(204);
    expect((await call('GET', '/me', cookie)).status).toBe(401);
    expect((await signInWith('weg@muuv.test', TEST_PASSWORD)).status).toBe(200);
  });

  it('Link neu erzeugen: der alte gilt nicht mehr; fremde Organisation: 404', async () => {
    const created = await call<{ member: Member; link: { url: string } }>(
      'POST',
      '/members',
      admin,
      {
        email: 'zwei@muuv.test',
        name: 'Zwei',
        role: 'editor',
      },
    );
    const renewed = await call<{ url: string; expiresAt: string }>(
      'POST',
      `/members/${created.body.member.id}/password-link`,
      admin,
    );
    expect(renewed.status).toBe(201);
    expect(
      (await call('POST', '/password-links/inspect', '', { token: tokenOf(created.body.link.url) }))
        .status,
    ).toBe(410);
    expect(
      (await call('POST', '/password-links/inspect', '', { token: tokenOf(renewed.body.url) }))
        .status,
    ).toBe(200);
    expect(JSON.stringify(ctx.logs)).not.toContain(tokenOf(renewed.body.url));

    const [other] = await ctx.testDb.db
      .insert(schema.organizations)
      .values({ name: 'Andere', slug: 'andere', type: 'internal', createdAt: new Date() })
      .returning({ id: schema.organizations.id });
    const { id: otherUser } = await createUser(ctx, {
      email: 'fremd@andere.test',
      org: { id: other!.id, role: 'admin' },
    });
    const [foreignMember] = await ctx.testDb.db
      .select({ id: schema.members.id })
      .from(schema.members)
      .where(eq(schema.members.userId, otherUser));
    for (const [method, path, body] of [
      ['PATCH', `/members/${foreignMember!.id}`, { role: 'viewer' }],
      ['DELETE', `/members/${foreignMember!.id}`, undefined],
      ['POST', `/members/${foreignMember!.id}/password-link`, undefined],
    ] as const) {
      expect((await call(method, path, admin, body)).status).toBe(404);
    }
  });

  it('Org-Admins ohne Plattform-Rolle können den Superadmin nicht übernehmen', async () => {
    await createUser(ctx, { email: 'orgadmin@muuv.test', org: { id: orgId, role: 'admin' } });
    const orgAdmin = await signIn(ctx, 'orgadmin@muuv.test');
    const list = await call<{ members: Member[] }>('GET', '/members', orgAdmin);
    const superadmin = list.body.members.find((m) => m.email === ctx.seeded.email)!;
    const link = await call<ErrorResponse>(
      'POST',
      `/members/${superadmin.id}/password-link`,
      orgAdmin,
    );
    expect(link.status).toBe(403);
    expect(link.body.error.code).toBe('MEMBER_PROTECTED');
    expect(
      (await call('PATCH', `/members/${superadmin.id}`, orgAdmin, { role: 'viewer' })).status,
    ).toBe(403);
    expect((await call('DELETE', `/members/${superadmin.id}`, orgAdmin)).status).toBe(403);
    // Der Superadmin selbst darf.
    expect((await call('POST', `/members/${superadmin.id}/password-link`, admin)).status).toBe(201);
  });

  it('ungültiges Token: gleiche Antwort wie abgelaufen, Format geprüft', async () => {
    expect(
      (await call('POST', '/password-links/inspect', '', { token: 'c'.repeat(43) })).status,
    ).toBe(410);
    expect((await call('POST', '/password-links/inspect', '', { token: 'kurz' })).status).toBe(400);
  });
});
