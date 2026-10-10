import { createNotification, schema, type CreateNotificationInput } from '@profitbash/db';
import { seedAdChangeFixture, type AdChangeFixture } from '@profitbash/db/testing';
import type { ErrorResponse, Notification, NotificationListResponse } from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { createNotificationHub, type NotificationHub } from '../notification-hub';
import {
  createTestContext,
  createUser,
  readJson,
  request,
  signIn,
  TEST_APP_URL,
  type TestContext,
} from '../testing';

const { amazonAdsProfiles, auditEvents, notifications } = schema;

/**
 * Benachrichtigungen über die API (5.2a): Liste, Zähler, gelesen setzen, SSE mit Wiederaufnahme und Heartbeat.
 * Je Endpunkt: nicht angemeldet, fremde Organisation, ausgeblendetes Profil.
 */

let ctx: TestContext;
let f: AdChangeFixture;
let other: AdChangeFixture;
let hub: NotificationHub;
let liveApp: ReturnType<typeof createApp>;
let admin = '';
let editor = '';
let foreign = '';

async function call<T>(method: string, path: string, cookie?: string, json?: unknown) {
  const res = await request(ctx, `/api${path}`, { method, cookie, json });
  return { status: res.status, body: await readJson<T & ErrorResponse>(res) };
}

const notify = (overrides: Partial<CreateNotificationInput> = {}) =>
  createNotification(ctx.testDb.db, {
    organizationId: f.org,
    profileId: f.profile,
    audience: 'members',
    kind: 'bulk_file_stale',
    severity: 'warning',
    params: { days: 9 },
    ...overrides,
  });

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.testDb;
  const orgId = ctx.seeded.organizationId;
  const editorUser = await createUser(ctx, {
    email: 'editor@muuv.test',
    org: { id: orgId, role: 'editor' },
  });
  f = await seedAdChangeFixture(db, 'muuv-api', {
    org: orgId,
    ada: ctx.seeded.userId,
    emil: editorUser.id,
  });
  other = await seedAdChangeFixture(db, 'fremd-notifications');
  await createUser(ctx, { email: 'fremd@andere.test', org: { id: other.org, role: 'admin' } });
  await db
    .update(amazonAdsProfiles)
    .set({ isHidden: true })
    .where(eq(amazonAdsProfiles.id, f.fileProfile));
  admin = await signIn(ctx, ctx.seeded.email);
  editor = await signIn(ctx, 'editor@muuv.test');
  foreign = await signIn(ctx, 'fremd@andere.test');
  hub = createNotificationHub({
    listenUrl: ctx.testDb.url,
    db,
    logger: ctx.deps.logger,
    heartbeatMs: 100,
  });
  await hub.start();
  liveApp = createApp({ ...ctx.deps, notifications: hub });
});

afterAll(async () => {
  await hub?.stop();
  await ctx?.close();
});

beforeEach(async () => {
  await ctx.testDb.db.delete(notifications);
  await ctx.testDb.db.delete(auditEvents);
});

describe('GET /api/notifications', () => {
  it('liefert sichtbare Benachrichtigungen, neueste zuerst, mit Filtern und Seiten', async () => {
    const a = await notify();
    const b = await notify({ kind: 'file_import_failed', severity: 'error' });
    await notify({ profileId: f.fileProfile });

    const all = await call<NotificationListResponse>('GET', '/notifications?limit=1', editor);
    expect(all.status).toBe(200);
    expect(all.body.items.map((item) => item.id)).toEqual([b]);
    expect(all.body.items[0]).toMatchObject({
      kind: 'file_import_failed',
      profileId: f.profile,
      readAt: null,
    });
    const next = await call<NotificationListResponse>(
      'GET',
      `/notifications?limit=1&before=${all.body.nextBefore}`,
      editor,
    );
    expect(next.body.items.map((item) => item.id)).toEqual([a]);
    expect(next.body.nextBefore).toBeNull();

    const filtered = await call<NotificationListResponse>(
      'GET',
      '/notifications?kind=bulk_file_stale',
      admin,
    );
    // Admins sehen auch das ausgeblendete Profil.
    expect(filtered.body.items).toHaveLength(2);
  });

  it('401 ohne Anmeldung, 400 bei ungültigem Filter, nichts für fremde Organisationen', async () => {
    await notify();
    expect((await call('GET', '/notifications')).status).toBe(401);
    expect((await call('GET', '/notifications?kind=unbekannt', editor)).status).toBe(400);
    const list = await call<NotificationListResponse>('GET', '/notifications', foreign);
    expect(list.body.items).toEqual([]);
  });
});

describe('GET /api/notifications/unread-count und POST /api/notifications/read', () => {
  it('zählt ungelesene, setzt einzelne und alle auf gelesen (je Nutzer, mit Audit)', async () => {
    const a = (await notify())!;
    await notify();
    await notify({ profileId: f.fileProfile });
    const count = (cookie: string) =>
      call<{ count: number }>('GET', '/notifications/unread-count', cookie).then(
        (res) => res.body.count,
      );
    expect(await count(editor)).toBe(2);
    expect(await count(admin)).toBe(3);
    expect(await count(foreign)).toBe(0);

    const one = await call<{ updated: number }>('POST', '/notifications/read', editor, {
      ids: [a],
    });
    expect(one).toMatchObject({ status: 200, body: { updated: 1 } });
    expect(await count(editor)).toBe(1);
    expect(await count(admin)).toBe(3);

    // Fremde Organisation: setzt nichts.
    const foreignRead = await call<{ updated: number }>('POST', '/notifications/read', foreign, {
      ids: [a],
    });
    expect(foreignRead.body.updated).toBe(0);

    const all = await call<{ updated: number }>('POST', '/notifications/read', admin, {
      all: true,
    });
    expect(all.body.updated).toBe(3);
    expect(await count(admin)).toBe(0);
    const audits = await ctx.testDb.db.select().from(auditEvents);
    expect(audits.map((event) => event.action)).toEqual(['notification.read', 'notification.read']);
  });

  it('400 bei leerer Anfrage, 401 ohne Anmeldung', async () => {
    expect((await call('POST', '/notifications/read', editor, {})).status).toBe(400);
    expect((await call('POST', '/notifications/read', undefined, { all: true })).status).toBe(401);
    expect((await call('GET', '/notifications/unread-count')).status).toBe(401);
  });
});

/** Liest SSE-Ereignisse aus dem Body, bis `until` erfüllt ist (oder die Zeit abläuft). */
async function readEvents(
  res: Response,
  until: (events: Array<{ event: string; id?: string; data: string }>) => boolean,
  timeoutMs = 3000,
) {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: Array<{ event: string; id?: string; data: string }> = [];
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  try {
    while (!until(events) && Date.now() < deadline) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
      ]);
      if (chunk === null || chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let end: number;
      while ((end = buffer.indexOf('\n\n')) >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const event: { event: string; id?: string; data: string } = { event: 'message', data: '' };
        for (const line of block.split('\n')) {
          const [field, ...rest] = line.split(':');
          const value = rest.join(':').replace(/^ /, '');
          if (field === 'event') event.event = value;
          else if (field === 'id') event.id = value;
          else if (field === 'data') event.data += value;
        }
        if (block.split('\n').some((line) => line.startsWith('event') || line.startsWith('data'))) {
          events.push(event);
        }
      }
    }
  } finally {
    await reader.cancel();
  }
  return events;
}

const openStream = (cookie: string | undefined, headers: Record<string, string> = {}) =>
  liveApp.request('/api/notifications/stream', {
    headers: { origin: TEST_APP_URL, ...(cookie && { cookie }), ...headers },
  });

describe('GET /api/notifications/stream', () => {
  it('schiebt neue, sichtbare Benachrichtigungen live, mit Nummer als Ereignis-ID', async () => {
    const res = await openStream(editor);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Erst verbinden lassen, dann erzeugen.
    setTimeout(() => {
      void (async () => {
        await notify({ profileId: f.fileProfile });
        await notify({ params: { days: 12 } });
      })();
    }, 150);
    const events = await readEvents(res, (list) =>
      list.some((event) => event.event === 'notification'),
    );
    const delivered = events.filter((event) => event.event === 'notification');
    expect(delivered).toHaveLength(1);
    const notification = JSON.parse(delivered[0]!.data) as Notification;
    expect(notification).toMatchObject({ kind: 'bulk_file_stale', params: { days: 12 } });
    expect(delivered[0]!.id).toBe(String(notification.seq));
  });

  it('holt nach `Last-Event-ID` Verpasstes nach und sendet einen Heartbeat', async () => {
    const first = (await notify())!;
    await notify({ params: { days: 10 } });
    const [row] = await ctx.testDb.db
      .select({ seq: notifications.seq })
      .from(notifications)
      .where(eq(notifications.id, first));
    const res = await openStream(editor, { 'last-event-id': String(row!.seq) });
    const events = await readEvents(res, (list) => list.some((event) => event.event === 'ping'));
    const delivered = events.filter((event) => event.event === 'notification');
    expect(delivered.map((event) => (JSON.parse(event.data) as Notification).params)).toEqual([
      { days: 10 },
    ]);
    expect(events.some((event) => event.event === 'ping')).toBe(true);
  });

  it('meldet den Abonnenten ab, sobald der Client trennt', async () => {
    const before = hub.subscriberCount();
    const res = await openStream(editor);
    await readEvents(res, (list) => list.some((event) => event.event === 'ready'));
    await expect.poll(() => hub.subscriberCount()).toBe(before);
  });

  it('beendet offene Kanäle, wenn der Hub stoppt (Herunterfahren)', async () => {
    const ownHub = createNotificationHub({
      listenUrl: ctx.testDb.url,
      db: ctx.testDb.db,
      logger: ctx.deps.logger,
    });
    await ownHub.start();
    const ownApp = createApp({ ...ctx.deps, notifications: ownHub });
    const res = await ownApp.request('/api/notifications/stream', {
      headers: { origin: TEST_APP_URL, cookie: editor },
    });
    setTimeout(() => void ownHub.stop(), 100);
    const started = Date.now();
    await readEvents(res, () => false, 5000);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('nichts für fremde Organisationen; 401 ohne Anmeldung; 503 ohne Kanal', async () => {
    const res = await openStream(foreign);
    setTimeout(() => void notify(), 150);
    const events = await readEvents(res, () => false, 600);
    expect(events.filter((event) => event.event === 'notification')).toEqual([]);

    expect((await openStream(undefined)).status).toBe(401);
    const withoutHub = await request(ctx, '/api/notifications/stream', { cookie: editor });
    expect(withoutHub.status).toBe(503);
  });
});
