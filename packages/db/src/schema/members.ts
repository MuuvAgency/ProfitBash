import { sql } from 'drizzle-orm';
import {
  foreignKey,
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { clients } from './app';
import { members, users } from './auth';
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

/**
 * Freigaben je Mitglied und Client (`phase-6.md` 6.2, F2). Ein Mitglied **mit** Freigaben sieht nur die Profile dieser
 * Clients, eines ohne Freigaben alle; Admins immer alle. Ausgewertet nur im Access-Layer (`access.ts`), gepflegt über
 * `members.ts`. Der Client lässt sich nicht löschen, solange Freigaben auf ihn zeigen (kein `cascade`): Sonst sähe ein
 * eingeschränktes Mitglied nach dem Löschen seines letzten Clients alles.
 */
export const memberClientGrants = pgTable(
  'member_client_grants',
  {
    id: id(),
    organizationId: organizationId(),
    memberId: uuid('member_id')
      .notNull()
      .references(() => members.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('member_client_grants_member_client_uq').on(t.memberId, t.clientId),
    // Client derselben Organisation (wie bei den Profilen).
    foreignKey({
      name: 'member_client_grants_client_org_fk',
      columns: [t.clientId, t.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }),
  ],
);
