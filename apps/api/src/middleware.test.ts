import { schema } from '@profitbash/db';
import { and, eq } from 'drizzle-orm';
import { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AppEnv } from './context';
import { createErrorHandler } from './errors';
import { requireRole, requireSession, requireSuperadmin } from './middleware';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  TEST_APP_URL,
  type TestContext,
} from './testing';

let ctx: TestContext;
let guarded: Hono<AppEnv>;
const cookies = { admin: '', editor: '', viewer: '', loner: '' };

beforeAll(async () => {
  ctx = await createTestContext();
  const muuv = ctx.seeded.organizationId;
  await createUser(ctx, { email: 'editor@muuv.test', org: { id: muuv, role: 'editor' } });
  await createUser(ctx, { email: 'viewer@muuv.test', org: { id: muuv, role: 'viewer' } });
  await createUser(ctx, { email: 'loner@muuv.test' });
  cookies.admin = await signIn(ctx, ctx.seeded.email);
  cookies.editor = await signIn(ctx, 'editor@muuv.test');
  cookies.viewer = await signIn(ctx, 'viewer@muuv.test');
  cookies.loner = await signIn(ctx, 'loner@muuv.test');

  // Eigene kleine App mit denselben Middlewares, um die Guards isoliert zu prüfen.
  const deps = {
    db: ctx.testDb.db,
    auth: ctx.auth,
    appUrl: TEST_APP_URL,
    version: 'test',
    logger: () => {},
  };
  guarded = new Hono<AppEnv>();
  guarded.onError(createErrorHandler(deps.logger));
  guarded.use(requireSession(deps));
  guarded.get('/admin', requireRole('admin'), (c) => c.text('ok'));
  guarded.get('/editor', requireRole('editor'), (c) => c.text('ok'));
  guarded.get('/super', requireSuperadmin(), (c) => c.text('ok'));
});

afterAll(async () => {
  await ctx?.close();
});

async function call(path: string, cookie?: string) {
  const res = await guarded.request(path, { headers: cookie ? { cookie } : {} });
  return { status: res.status, body: res.status === 200 ? await res.text() : await res.json() };
}

describe('better-auth unter /api/auth', () => {
  it('meldet an und setzt die älteste Organisation als aktive Organisation der Session', async () => {
    const res = await request(ctx, '/api/auth/get-session', { cookie: cookies.admin });
    expect(res.status).toBe(200);
    const body = await readJson<{
      user: { email: string };
      session: { activeOrganizationId: string | null };
    }>(res);
    expect(body.user.email).toBe(ctx.seeded.email);
    expect(body.session.activeOrganizationId).toBe(ctx.seeded.organizationId);
  });

  it('die öffentliche Registrierung bleibt über HTTP deaktiviert', async () => {
    const res = await request(ctx, '/api/auth/sign-up/email', {
      method: 'POST',
      json: { email: 'neu@example.test', password: 'noch-ein-passwort-123', name: 'Neu' },
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const rows = await ctx.testDb.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'neu@example.test'));
    expect(rows).toHaveLength(0);
  });
});

describe('better-auth über HTTP: nur freigegebene Endpunkte', () => {
  async function editorRow() {
    const [row] = await ctx.testDb.db
      .select({ id: schema.users.id, role: schema.users.role, name: schema.users.name })
      .from(schema.users)
      .where(eq(schema.users.email, 'editor@muuv.test'));
    return row!;
  }

  it('sperrt die Admin-Plugin-Endpunkte auch für Superadmins (Plattform-Admin kommt in Phase 6)', async () => {
    const editor = await editorRow();
    const res = await request(ctx, '/api/auth/admin/set-role', {
      method: 'POST',
      cookie: cookies.admin,
      json: { userId: editor.id, role: 'superadmin' },
    });
    expect(res.status).toBe(404);
    expect(await readJson(res)).toEqual({
      error: { code: 'NOT_FOUND', message: expect.any(String) },
    });
    expect((await editorRow()).role).toBe('user');
  });

  it('sperrt nicht freigegebene Konto-Endpunkte (Passwort, Profil, Sessions)', async () => {
    const changePassword = await request(ctx, '/api/auth/change-password', {
      method: 'POST',
      cookie: cookies.editor,
      json: {
        currentPassword: 'ein-sicheres-passwort-123',
        newPassword: 'ganz-neues-passwort-456',
      },
    });
    expect(changePassword.status).toBe(404);

    const updateUser = await request(ctx, '/api/auth/update-user', {
      method: 'POST',
      cookie: cookies.editor,
      json: { name: 'Umbenannt' },
    });
    expect(updateUser.status).toBe(404);
    expect((await editorRow()).name).toBe('editor@muuv.test');

    const revoke = await request(ctx, '/api/auth/revoke-sessions', {
      method: 'POST',
      cookie: cookies.editor,
      json: {},
    });
    expect(revoke.status).toBe(404);
  });

  it('Abmelden bleibt möglich', async () => {
    const cookie = await signIn(ctx, 'viewer@muuv.test');
    const res = await request(ctx, '/api/auth/sign-out', { method: 'POST', cookie, json: {} });
    expect(res.status).toBe(200);
    expect((await call('/editor', cookie)).status).toBe(401);
  });
});

describe('requireSession', () => {
  it('lehnt Anfragen ohne Session mit 401 ab', async () => {
    expect(await call('/editor')).toEqual({
      status: 401,
      body: { error: { code: 'UNAUTHORIZED', message: expect.any(String) } },
    });
  });

  it('lehnt einen ungültigen Session-Cookie mit 401 ab', async () => {
    const { status } = await call('/editor', 'better-auth.session_token=kaputt');
    expect(status).toBe(401);
  });
});

describe('requireRole', () => {
  it('lässt Rollen ab der geforderten Stufe durch', async () => {
    expect((await call('/admin', cookies.admin)).status).toBe(200);
    expect((await call('/editor', cookies.admin)).status).toBe(200);
    expect((await call('/editor', cookies.editor)).status).toBe(200);
  });

  it('lehnt niedrigere Rollen mit 403 ab', async () => {
    expect(await call('/admin', cookies.editor)).toEqual({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: expect.any(String) } },
    });
    expect((await call('/editor', cookies.viewer)).status).toBe(403);
  });

  it('lehnt Nutzer ohne aktive Organisation mit 403 NO_ACTIVE_ORGANIZATION ab', async () => {
    expect(await call('/editor', cookies.loner)).toEqual({
      status: 403,
      body: { error: { code: 'NO_ACTIVE_ORGANIZATION', message: expect.any(String) } },
    });
  });

  it('prüft die Rolle nach jeder Anfrage neu (entzogene Rechte gelten sofort)', async () => {
    const cookie = await signIn(ctx, 'editor@muuv.test');
    expect((await call('/editor', cookie)).status).toBe(200);

    const [editor] = await ctx.testDb.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, 'editor@muuv.test'));
    const membership = and(
      eq(schema.members.userId, editor!.id),
      eq(schema.members.organizationId, ctx.seeded.organizationId),
    );
    await ctx.testDb.db.update(schema.members).set({ role: 'viewer' }).where(membership);
    try {
      expect((await call('/editor', cookie)).status).toBe(403);
    } finally {
      await ctx.testDb.db.update(schema.members).set({ role: 'editor' }).where(membership);
    }
  });
});

describe('requireSuperadmin', () => {
  it('lässt nur Plattform-Superadmins durch, unabhängig von der Org-Rolle', async () => {
    expect((await call('/super', cookies.admin)).status).toBe(200);
    expect(await call('/super', cookies.editor)).toEqual({
      status: 403,
      body: { error: { code: 'FORBIDDEN', message: expect.any(String) } },
    });
  });
});

describe('CSRF-Schutz eigener Endpunkte', () => {
  it('lehnt Formular-Requests einer fremden Origin mit 403 im Fehlerformat ab', async () => {
    const res = await request(ctx, '/api/settings', {
      method: 'PUT',
      cookie: cookies.admin,
      headers: {
        origin: 'https://angreifer.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
    });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: { code: 'FORBIDDEN', message: expect.any(String) },
    });
  });

  it('lehnt Formular-Requests ohne Origin-Header ab', async () => {
    const res = await ctx.app.request('/api/settings', {
      method: 'PUT',
      headers: { cookie: cookies.admin, 'content-type': 'text/plain' },
      body: '{"theme":"dark","locale":"de-DE","density":"compact"}',
    });
    expect(res.status).toBe(403);
  });
});
