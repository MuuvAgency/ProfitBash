import { sql } from 'drizzle-orm';
import { index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './auth';
import { createdAt, id, organizationId } from './columns';

/**
 * Einmalige Links zum Setzen des Passworts (`phase-2.md` F9, 2.10). Gespeichert wird nur der SHA-256-Hash des Tokens;
 * ein Link gilt 7 Tage, einmal, und verfällt beim Neu-Erzeugen und beim Entfernen des Mitglieds. Zugriffe nur über
 * `packages/db/src/members.ts`.
 */
export const memberPasswordLinks = pgTable(
  'member_password_links',
  {
    id: id(),
    organizationId: organizationId(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Hex-SHA-256 des Tokens (32 Zufallsbytes). Das Token selbst steht nirgends. */
    tokenHash: text('token_hash').notNull(),
    /** Admin, der den Link erzeugt hat. */
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('member_password_links_token_hash_uq').on(t.tokenHash),
    index('member_password_links_org_user_idx')
      .on(t.organizationId, t.userId)
      .where(sql`used_at is null and revoked_at is null`),
  ],
);
