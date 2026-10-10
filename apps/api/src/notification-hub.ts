import {
  errorLogFields,
  getVisibleNotification,
  NOTIFICATION_CHANNEL,
  type Db,
  type NotificationEvent,
} from '@profitbash/db';
import type { Notification } from '@profitbash/shared';
import postgres from 'postgres';
import { z } from 'zod';
import type { Logger } from './logger';

/**
 * Verteilt neue Benachrichtigungen an verbundene SSE-Clients (`docs/tasks/phase-5.md` 5.2a). Eine eigene
 * Verbindung lauscht per `LISTEN` auf `pg_notify` aus den Transaktionen der Auslöser, egal ob der Worker im
 * selben Prozess oder getrennt läuft (`WORKER_MODE`). Je Ereignis prüft der Access-Layer für jeden Abonnenten
 * der Organisation, ob er die Benachrichtigung sehen darf; die Nutzlast nennt nur IDs.
 */

export interface NotificationSubscriber {
  userId: string;
  orgId: string;
  send(notification: Notification): void;
  /** Der Kanal war unterbrochen: Der Client soll seinen Stand neu laden. */
  resync(): void;
  /** Der Hub stoppt (Herunterfahren): Verbindung beenden, der Browser verbindet neu. */
  close(): void;
}

export interface NotificationHub {
  /** Abstand der Heartbeats im SSE-Kanal. */
  readonly heartbeatMs: number;
  start(): Promise<void>;
  /** Meldet einen Client an; liefert die Abmeldung. */
  subscribe(subscriber: NotificationSubscriber): () => void;
  /** Verbundene Clients (Log und Tests: hängengebliebene Abonnenten fallen so auf). */
  subscriberCount(): number;
  stop(): Promise<void>;
}

/** Hinter Proxys (Railway) schließen untätige Verbindungen nach etwa einer Minute. */
export const NOTIFICATION_HEARTBEAT_MS = 25_000;

const eventSchema = z.object({ id: z.uuid(), organizationId: z.uuid() });

export function createNotificationHub(options: {
  /** Direkte Verbindung (`DATABASE_URL_DIRECT`): `LISTEN` geht nicht über einen Transaction-Pooler. */
  listenUrl: string;
  db: Db;
  logger: Logger;
  heartbeatMs?: number;
}): NotificationHub {
  const { db, logger } = options;
  const subscribers = new Set<NotificationSubscriber>();
  let sql: postgres.Sql | null = null;
  let listens = 0;

  async function deliver(event: NotificationEvent) {
    for (const subscriber of subscribers) {
      if (subscriber.orgId !== event.organizationId) continue;
      try {
        const notification = await getVisibleNotification(db, {
          userId: subscriber.userId,
          orgId: subscriber.orgId,
          id: event.id,
        });
        if (notification) subscriber.send(notification);
      } catch (error) {
        logger({ level: 'error', msg: 'notifications.deliver_failed', ...errorLogFields(error) });
      }
    }
  }

  return {
    heartbeatMs: options.heartbeatMs ?? NOTIFICATION_HEARTBEAT_MS,
    async start() {
      sql = postgres(options.listenUrl, { max: 1, onnotice: () => {} });
      await sql.listen(
        NOTIFICATION_CHANNEL,
        (payload) => {
          const parsed = eventSchema.safeParse(safeJson(payload));
          if (!parsed.success) {
            logger({ level: 'warn', msg: 'notifications.invalid_payload' });
            return;
          }
          void deliver(parsed.data);
        },
        () => {
          // Nach einer Unterbrechung (postgres.js verbindet neu) können Ereignisse fehlen.
          listens += 1;
          if (listens === 1) return;
          logger({ level: 'warn', msg: 'notifications.listen_reconnected' });
          for (const subscriber of subscribers) subscriber.resync();
        },
      );
    },
    subscribe(subscriber) {
      subscribers.add(subscriber);
      return () => subscribers.delete(subscriber);
    },
    subscriberCount: () => subscribers.size,
    async stop() {
      for (const subscriber of subscribers) subscriber.close();
      subscribers.clear();
      await sql?.end({ timeout: 5 });
      sql = null;
    },
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
