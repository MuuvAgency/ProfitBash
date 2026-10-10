import {
  NOTIFICATION_MAX_AGE_DAYS,
  NOTIFICATION_READ_RETENTION_DAYS,
  type Notification,
  type NotificationAudience,
  type NotificationKind,
  type NotificationSeverity,
} from '@profitbash/shared';
import {
  and,
  asc,
  desc,
  eq,
  exists,
  gt,
  inArray,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { AccessDeniedError, getOrgRole, visibleProfilesScope } from './access';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import { amazonAdsProfiles, notificationReads, notifications } from './schema';

/**
 * Benachrichtigungen (`docs/tasks/phase-5.md` 5.2a). Erzeugt werden sie in der Transaktion des Auslösers
 * (Systemzugriff, an die Organisation gebunden); `pg_notify` meldet sie nach dem Commit an die API, die sie per SSE
 * verteilt. Gelesen wird nur über den Access-Layer (ADR 002): Das Profil muss sichtbar sein (Admins auch
 * ausgeblendete), dazu entscheidet `audience`.
 */

/** Kanal für `LISTEN`/`NOTIFY`; Nutzlast `{ id, organizationId }` (JSON), nie Inhalte. */
export const NOTIFICATION_CHANNEL = 'profitbash_notifications';

export interface NotificationEvent {
  id: string;
  organizationId: string;
}

export interface CreateNotificationInput {
  organizationId: string;
  profileId?: string | null;
  connectionId?: string | null;
  audience: NotificationAudience;
  recipientUserId?: string | null;
  kind: NotificationKind;
  severity: NotificationSeverity;
  params?: Record<string, string | number>;
  link?: string | null;
  /** Schutz gegen Dubletten je Organisation; mit Schlüssel entsteht höchstens eine Zeile. */
  dedupeKey?: string | null;
}

/** Legt eine Benachrichtigung an (in der Transaktion des Auslösers). `null`, wenn der Schlüssel schon vergeben ist. */
export async function createNotification(
  db: DbOrTx,
  input: CreateNotificationInput,
): Promise<string | null> {
  const [row] = await db
    .insert(notifications)
    .values({
      organizationId: input.organizationId,
      profileId: input.profileId ?? null,
      connectionId: input.connectionId ?? null,
      audience: input.audience,
      recipientUserId: input.recipientUserId ?? null,
      kind: input.kind,
      severity: input.severity,
      params: input.params ?? {},
      link: input.link ?? null,
      dedupeKey: input.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: notifications.id });
  if (!row) return null;
  const payload: NotificationEvent = { id: row.id, organizationId: input.organizationId };
  await db.execute(sql`select pg_notify(${NOTIFICATION_CHANNEL}, ${JSON.stringify(payload)})`);
  return row.id;
}

interface Actor {
  userId: string;
  orgId: string;
}

/** Bedingung „für diesen Nutzer sichtbar“ oder `null`, wenn er kein Mitglied der Organisation ist. */
async function visibleCondition(db: Db, actor: Actor): Promise<SQL | null> {
  const role = await getOrgRole(db, actor.userId, actor.orgId);
  if (role === null) return null;
  const scope = await visibleProfilesScope(db, { ...actor, includeHidden: role === 'admin' });
  if (scope === null) return null;
  const n = notifications;
  return and(
    eq(n.organizationId, actor.orgId),
    or(isNull(n.profileId), inArray(n.profileId, scope.ids)),
    or(
      eq(n.audience, 'members'),
      eq(n.recipientUserId, actor.userId),
      role === 'admin' ? eq(n.audience, 'admins') : sql`false`,
    ),
  )!;
}

async function requireVisibleCondition(db: Db, actor: Actor): Promise<SQL> {
  const condition = await visibleCondition(db, actor);
  if (condition === null) throw new AccessDeniedError('Kein Mitglied dieser Organisation.');
  return condition;
}

function selectNotifications(db: Db, userId: string) {
  const n = notifications;
  return db
    .select({
      id: n.id,
      seq: n.seq,
      kind: n.kind,
      severity: n.severity,
      profileId: n.profileId,
      profileName: amazonAdsProfiles.accountName,
      params: n.params,
      link: n.link,
      createdAt: n.createdAt,
      readAt: notificationReads.readAt,
    })
    .from(n)
    .leftJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, n.profileId))
    .leftJoin(
      notificationReads,
      and(eq(notificationReads.notificationId, n.id), eq(notificationReads.userId, userId)),
    );
}

type Row = Awaited<ReturnType<typeof selectNotifications>>[number];

function toNotification(row: Row): Notification {
  return {
    ...row,
    kind: row.kind as NotificationKind,
    severity: row.severity as NotificationSeverity,
    profileName: row.profileName ?? null,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
  };
}

const unreadBy = (userId: string) =>
  sql`not exists (select 1 from ${notificationReads} where ${notificationReads.notificationId} = ${notifications.id} and ${notificationReads.userId} = ${userId})`;

/** Eine sichtbare Benachrichtigung oder `null` (auch für Nicht-Mitglieder). */
export async function getVisibleNotification(
  db: Db,
  input: Actor & { id: string },
): Promise<Notification | null> {
  const condition = await visibleCondition(db, input);
  if (condition === null) return null;
  const [row] = await selectNotifications(db, input.userId).where(
    and(condition, eq(notifications.id, input.id)),
  );
  return row ? toNotification(row) : null;
}

export interface ListNotificationsInput extends Actor {
  unread: boolean;
  kind?: NotificationKind | undefined;
  profileId?: string | undefined;
  before?: number | undefined;
  limit: number;
}

/** Neueste zuerst, seitenweise über `before` (Nummer der letzten Zeile). */
export async function listNotifications(
  db: Db,
  input: ListNotificationsInput,
): Promise<{ items: Notification[]; nextBefore: number | null }> {
  const n = notifications;
  const conditions = [await requireVisibleCondition(db, input)];
  if (input.unread) conditions.push(unreadBy(input.userId));
  if (input.kind) conditions.push(eq(n.kind, input.kind));
  if (input.profileId) conditions.push(eq(n.profileId, input.profileId));
  if (input.before !== undefined) conditions.push(lt(n.seq, input.before));
  const rows = await selectNotifications(db, input.userId)
    .where(and(...conditions))
    .orderBy(desc(n.seq))
    .limit(input.limit + 1);
  const items = rows.slice(0, input.limit).map(toNotification);
  return {
    items,
    nextBefore: rows.length > input.limit ? (items.at(-1)?.seq ?? null) : null,
  };
}

/** Sichtbare Benachrichtigungen nach `afterSeq`, älteste zuerst (Wiederaufnahme des SSE-Kanals). */
export async function listNotificationsAfter(
  db: Db,
  input: Actor & { afterSeq: number; limit: number },
): Promise<Notification[]> {
  const condition = await visibleCondition(db, input);
  if (condition === null) return [];
  const rows = await selectNotifications(db, input.userId)
    .where(and(condition, gt(notifications.seq, input.afterSeq)))
    .orderBy(asc(notifications.seq))
    .limit(input.limit);
  return rows.map(toNotification);
}

export async function countUnreadNotifications(db: Db, input: Actor): Promise<number> {
  const condition = await requireVisibleCondition(db, input);
  const [row] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(notifications)
    .where(and(condition, unreadBy(input.userId)));
  return row?.count ?? 0;
}

/** Setzt sichtbare Benachrichtigungen für den Nutzer auf gelesen; liefert, wie viele neu gelesen sind. */
export async function markNotificationsRead(
  db: Db,
  input: Actor & ({ ids: string[] } | { all: true }),
): Promise<number> {
  const condition = await requireVisibleCondition(db, input);
  const conditions = [condition, unreadBy(input.userId)];
  if ('ids' in input) conditions.push(inArray(notifications.id, input.ids));
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(notificationReads)
      .select(
        tx
          .select({
            notificationId: notifications.id,
            userId: sql<string>`${input.userId}::uuid`.as('user_id'),
            readAt: sql<Date>`now()`.as('read_at'),
          })
          .from(notifications)
          .where(and(...conditions)),
      )
      .onConflictDoNothing()
      .returning({ id: notificationReads.notificationId });
    if (rows.length > 0) {
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'notification.read',
        target: {
          type: 'notification',
          id: 'ids' in input && rows.length === 1 ? rows[0]!.id : 'many',
          count: rows.length,
          all: 'all' in input,
        },
      });
    }
    return rows.length;
  });
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Wartung (plattformweit): gelesene nach 90 Tagen, alle nach 365 Tagen. Liefert die Zahl der gelöschten. */
export async function cleanupNotifications(db: Db, input: { now: Date }): Promise<number> {
  const readBefore = new Date(input.now.getTime() - NOTIFICATION_READ_RETENTION_DAYS * DAY_MS);
  const maxBefore = new Date(input.now.getTime() - NOTIFICATION_MAX_AGE_DAYS * DAY_MS);
  const rows = await db
    .delete(notifications)
    .where(
      or(
        lt(notifications.createdAt, maxBefore),
        and(
          lt(notifications.createdAt, readBefore),
          exists(
            db
              .select({ one: sql`1` })
              .from(notificationReads)
              .where(eq(notificationReads.notificationId, notifications.id)),
          ),
        ),
      ),
    )
    .returning({ id: notifications.id });
  return rows.length;
}
