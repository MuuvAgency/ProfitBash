import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { amazonAdsProfiles, connections } from './app';
import { users } from './auth';
import { createdAt, id, organizationId } from './columns';

/**
 * Benachrichtigungen in der App (`docs/tasks/phase-5.md` 5.2a). Eine Zeile je Ereignis, gelesen wird je Nutzer
 * (`notification_reads`). Wer sie sieht, entscheidet `notifications.ts` über den Access-Layer (Profil sichtbar,
 * dazu `audience`). Zugriffe nur über `notifications.ts`.
 */
export const notifications = pgTable(
  'notifications',
  {
    id: id(),
    /** Fortlaufend: Reihenfolge, Seiten und `Last-Event-ID` des SSE-Kanals. */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    organizationId: organizationId(),
    /** Betroffenes Profil; leer bei Meldungen ohne Profil (z. B. Einwilligung einer Connection). */
    profileId: uuid('profile_id'),
    /** Betroffene Connection (Einwilligung); verschwindet mit ihr. */
    connectionId: uuid('connection_id'),
    /** `members` | `admins` | `recipient` (`NOTIFICATION_AUDIENCES`). */
    audience: text('audience').notNull(),
    /** Auslöser (Upload, Übermittlung); sieht die Meldung auch bei `admins`. */
    recipientUserId: uuid('recipient_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** `NOTIFICATION_KINDS`, Text statt Enum (neue Arten ohne Migration). */
    kind: text('kind').notNull(),
    severity: text('severity').notNull(),
    params: jsonb('params')
      .$type<Record<string, string | number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
    link: text('link'),
    /** Schutz gegen Dubletten je Organisation (z. B. `file_import:<id>`); leer = keiner. */
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'notifications_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'notifications_connection_org_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }).onDelete('cascade'),
    check('notifications_audience_ck', sql`${t.audience} in ('members', 'admins', 'recipient')`),
    check(
      'notifications_severity_ck',
      sql`${t.severity} in ('info', 'success', 'warning', 'error')`,
    ),
    unique('notifications_dedupe_uq').on(t.organizationId, t.dedupeKey),
    index('notifications_org_seq_idx').on(t.organizationId, t.seq.desc()),
    index('notifications_created_idx').on(t.createdAt),
  ],
);

/** Lesestatus je Nutzer. */
export const notificationReads = pgTable(
  'notification_reads',
  {
    notificationId: uuid('notification_id')
      .notNull()
      .references(() => notifications.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.notificationId, t.userId] }),
    index('notification_reads_user_idx').on(t.userId),
  ],
);
