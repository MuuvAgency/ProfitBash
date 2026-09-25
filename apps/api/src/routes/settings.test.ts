import { schema } from '@profitbash/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ErrorResponse } from '@profitbash/shared';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  type TestContext,
} from '../testing';

let ctx: TestContext;
let admin: string;
let other: string;
let otherUserId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  const user = await createUser(ctx, {
    email: 'editor@muuv.test',
    org: { id: ctx.seeded.organizationId, role: 'editor' },
  });
  otherUserId = user.id;
  admin = await signIn(ctx, ctx.seeded.email);
  other = await signIn(ctx, 'editor@muuv.test');
});

afterAll(async () => {
  await ctx?.close();
});

const dark = { theme: 'dark', locale: 'en-US', density: 'compact' };

describe('/api/settings', () => {
  it('verlangt eine Session', async () => {
    expect((await request(ctx, '/api/settings')).status).toBe(401);
    const put = await request(ctx, '/api/settings', { method: 'PUT', json: dark });
    expect(put.status).toBe(401);
  });

  it('liefert Defaults, solange nichts gespeichert ist', async () => {
    const res = await request(ctx, '/api/settings', { cookie: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ theme: 'system', locale: 'de-DE', density: 'comfortable' });
  });

  it('speichert die Einstellungen serverseitig und schreibt ein Audit-Event', async () => {
    const put = await request(ctx, '/api/settings', { method: 'PUT', cookie: admin, json: dark });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual(dark);

    const get = await request(ctx, '/api/settings', { cookie: admin });
    expect(await get.json()).toEqual(dark);

    const events = await ctx.testDb.db
      .select()
      .from(schema.auditEvents)
      .where(eq(schema.auditEvents.action, 'settings.update'));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: ctx.seeded.userId,
      organizationId: null,
      target: {
        type: 'user_preferences',
        id: ctx.seeded.userId,
        before: { theme: 'system', locale: 'de-DE', density: 'comfortable' },
        after: dark,
      },
    });
  });

  it('überschreibt beim zweiten Speichern, statt eine zweite Zeile anzulegen', async () => {
    const light = { theme: 'light', locale: 'de-DE', density: 'comfortable' };
    await request(ctx, '/api/settings', { method: 'PUT', cookie: admin, json: light });
    const get = await request(ctx, '/api/settings', { cookie: admin });
    expect(await get.json()).toEqual(light);
    const rows = await ctx.testDb.db
      .select()
      .from(schema.userPreferences)
      .where(eq(schema.userPreferences.userId, ctx.seeded.userId));
    expect(rows).toHaveLength(1);
  });

  it('Einstellungen gelten nur für den eigenen Nutzer', async () => {
    const res = await request(ctx, '/api/settings', { cookie: other });
    expect(await res.json()).toEqual({ theme: 'system', locale: 'de-DE', density: 'comfortable' });
  });

  it('lehnt ungültige Werte mit 400 VALIDATION_ERROR ab und speichert nichts', async () => {
    const res = await request(ctx, '/api/settings', {
      method: 'PUT',
      cookie: other,
      json: { ...dark, theme: 'pink' },
    });
    expect(res.status).toBe(400);
    const body = await readJson<ErrorResponse>(res);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toContain('theme');
    const rows = await ctx.testDb.db
      .select()
      .from(schema.userPreferences)
      .where(eq(schema.userPreferences.userId, otherUserId));
    expect(rows).toHaveLength(0);
  });

  it('lehnt ungültiges JSON mit 400 ab', async () => {
    const res = await ctx.app.request('/api/settings', {
      method: 'PUT',
      headers: {
        cookie: other,
        origin: 'http://localhost:5173',
        'content-type': 'application/json',
      },
      body: '{kaputt',
    });
    expect(res.status).toBe(400);
    expect((await readJson<ErrorResponse>(res)).error.code).toBe('BAD_REQUEST');
  });
});

describe('/api/settings/ui-state/:scope/:key', () => {
  const path = '/api/settings/ui-state/explorer/grid.columns';
  const value = { columns: ['name', 'spend'], widths: { name: 240 } };

  it('verlangt eine Session', async () => {
    expect((await request(ctx, path)).status).toBe(401);
  });

  it('liefert value = null, solange nichts gespeichert ist', async () => {
    const res = await request(ctx, path, { cookie: admin });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ value: null });
  });

  it('speichert und überschreibt den Wert je Nutzer, Scope und Key', async () => {
    const put = await request(ctx, path, { method: 'PUT', cookie: admin, json: { value } });
    expect(put.status).toBe(200);
    expect(await put.json()).toEqual({ value });

    await request(ctx, path, { method: 'PUT', cookie: admin, json: { value: [1, 2, 3] } });
    expect(await (await request(ctx, path, { cookie: admin })).json()).toEqual({
      value: [1, 2, 3],
    });

    // Anderer Key und anderer Nutzer sind unabhängig.
    const otherKey = await request(ctx, '/api/settings/ui-state/explorer/filter', {
      cookie: admin,
    });
    expect(await otherKey.json()).toEqual({ value: null });
    const otherUser = await request(ctx, path, { cookie: other });
    expect(await otherUser.json()).toEqual({ value: null });
  });

  it('lehnt ungültige Keys und zu große Werte mit 400 ab', async () => {
    const badKey = await request(ctx, '/api/settings/ui-state/explorer/mit%20leerzeichen', {
      cookie: admin,
    });
    expect(badKey.status).toBe(400);
    expect((await readJson<ErrorResponse>(badKey)).error.code).toBe('VALIDATION_ERROR');

    const tooBig = await request(ctx, path, {
      method: 'PUT',
      cookie: admin,
      json: { value: 'x'.repeat(17 * 1024) },
    });
    expect(tooBig.status).toBe(400);
    expect((await readJson<ErrorResponse>(tooBig)).error.code).toBe('VALIDATION_ERROR');
  });

  it('lehnt null und einen fehlenden Wert ab', async () => {
    for (const json of [{ value: null }, {}]) {
      const res = await request(ctx, path, { method: 'PUT', cookie: admin, json });
      expect(res.status).toBe(400);
      expect((await readJson<ErrorResponse>(res)).error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('lehnt Request-Bodies über 64 KB schon vor dem Parsen mit 413 ab', async () => {
    const res = await request(ctx, path, {
      method: 'PUT',
      cookie: admin,
      json: { value: 'x'.repeat(100 * 1024) },
    });
    expect(res.status).toBe(413);
    expect((await readJson<ErrorResponse>(res)).error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
