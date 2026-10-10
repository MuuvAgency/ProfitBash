import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  AccessDeniedError,
  countUnreadNotifications,
  listNotifications,
  listNotificationsAfter,
  markNotificationsRead,
} from '@profitbash/db';
import {
  errorResponseSchema,
  markNotificationsReadRequestSchema,
  markNotificationsReadResponseSchema,
  notificationListQuerySchema,
  notificationListResponseSchema,
  notificationUnreadCountResponseSchema,
  type Notification,
} from '@profitbash/shared';
import { streamSSE } from 'hono/streaming';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireSession } from '../middleware';

/**
 * Benachrichtigungen (`docs/tasks/phase-5.md` 5.2a), für alle Mitglieder (kein Feature-Key, `plan.md` §3). Was ein
 * Nutzer sieht, entscheidet der Access-Layer (`notifications.ts`). Dazu der SSE-Kanal `/notifications/stream`:
 * neue Benachrichtigungen live, Wiederaufnahme über `Last-Event-ID`, Heartbeat gegen Proxy-Timeouts.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const errors = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: { description: 'Keine aktive Organisation.', content: json(errorResponseSchema) },
};

const listRoute = createRoute({
  method: 'get',
  path: '/notifications',
  tags: ['Benachrichtigungen'],
  summary: 'Sichtbare Benachrichtigungen, neueste zuerst (Filter: ungelesen, Art, Profil; Seiten über `before`)',
  request: { query: notificationListQuerySchema },
  responses: {
    200: { description: 'Benachrichtigungen.', content: json(notificationListResponseSchema) },
    ...errors,
  },
});

const unreadCountRoute = createRoute({
  method: 'get',
  path: '/notifications/unread-count',
  tags: ['Benachrichtigungen'],
  summary: 'Zahl der ungelesenen, sichtbaren Benachrichtigungen',
  responses: {
    200: { description: 'Anzahl.', content: json(notificationUnreadCountResponseSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const readRoute = createRoute({
  method: 'post',
  path: '/notifications/read',
  tags: ['Benachrichtigungen'],
  summary: 'Benachrichtigungen für den angemeldeten Nutzer auf gelesen setzen (IDs oder alle)',
  description: 'Unsichtbare oder unbekannte IDs werden übergangen; `updated` zählt die neu gelesenen.',
  request: { body: { content: json(markNotificationsReadRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(markNotificationsReadResponseSchema) },
    ...errors,
  },
});

/** So viele verpasste Benachrichtigungen holt die Wiederaufnahme nach; bei mehr lädt der Client neu. */
const RESUME_LIMIT = 100;
/** Wartezeit des Browsers vor einem neuen Verbindungsversuch. */
const RETRY_MS = 5_000;

export function registerNotificationRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const session = requireSession(deps);
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    if (!auth.activeOrganization) {
      throw new ApiError(403, 'NO_ACTIVE_ORGANIZATION', 'Keine aktive Organisation.');
    }
    return { userId: auth.user.id, orgId: auth.activeOrganization.organizationId };
  };
  async function run<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof AccessDeniedError) {
        throw new ApiError(403, 'FORBIDDEN', error.message);
      }
      throw error;
    }
  }

  app.openapi({ ...listRoute, middleware: session }, async (c) => {
    const page = await run(() => listNotifications(db, { ...actor(c), ...c.req.valid('query') }));
    return c.json(page, 200);
  });

  app.openapi({ ...unreadCountRoute, middleware: session }, async (c) => {
    const count = await run(() => countUnreadNotifications(db, actor(c)));
    return c.json({ count }, 200);
  });

  app.openapi({ ...readRoute, middleware: session }, async (c) => {
    const updated = await run(() =>
      markNotificationsRead(db, { ...actor(c), ...c.req.valid('json') }),
    );
    return c.json({ updated }, 200);
  });

  app.get('/notifications/stream', session, async (c) => {
    const hub = deps.notifications;
    if (!hub) {
      throw new ApiError(503, 'NOTIFICATIONS_UNAVAILABLE', 'Der Live-Kanal ist nicht verfügbar.');
    }
    const who = actor(c);
    const lastEventId = Number(c.req.header('last-event-id') ?? '');
    // Kein Puffern durch Proxys (nginx-Konvention, Railway ignoriert sie unschädlich).
    c.header('X-Accel-Buffering', 'no');
    c.header('Cache-Control', 'no-cache, no-transform');
    return streamSSE(c, async (stream) => {
      let closed = false;
      let queue = Promise.resolve();
      /** Schreibt nacheinander (Live-Ereignisse und Nachholen dürfen sich nicht verschränken). */
      const write = (message: Parameters<typeof stream.writeSSE>[0]) => {
        queue = queue.then(() => (closed ? undefined : stream.writeSSE(message))).catch(() => {});
        return queue;
      };
      const send = (notification: Notification) =>
        write({
          event: 'notification',
          id: String(notification.seq),
          data: JSON.stringify(notification),
        });
      // Erst abonnieren, dann nachholen: Doppelte erkennt der Client an der Nummer.
      const unsubscribe = hub.subscribe({
        ...who,
        send: (notification) => void send(notification),
        resync: () => void write({ event: 'resync', data: '' }),
        close: () => {
          closed = true;
        },
      });
      const heartbeat = setInterval(() => void write({ event: 'ping', data: '' }), hub.heartbeatMs);
      stream.onAbort(() => {
        closed = true;
        clearInterval(heartbeat);
        unsubscribe();
      });

      await write({ event: 'ready', data: '', retry: RETRY_MS });
      if (Number.isSafeInteger(lastEventId) && lastEventId > 0) {
        const missed = await listNotificationsAfter(db, {
          ...who,
          afterSeq: lastEventId,
          limit: RESUME_LIMIT + 1,
        });
        for (const notification of missed.slice(0, RESUME_LIMIT)) await send(notification);
        if (missed.length > RESUME_LIMIT) await write({ event: 'resync', data: '' });
      }
      // Offen halten, bis der Client geht oder der Hub stoppt.
      while (!closed) await stream.sleep(200);
      clearInterval(heartbeat);
      unsubscribe();
    });
  });
}
