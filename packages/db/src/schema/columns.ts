import { timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations } from './auth';

// Gemeinsame Spalten der App-Tabellen.

export const id = () => uuid('id').primaryKey().defaultRandom();
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull();
export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());
export const organizationId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });
