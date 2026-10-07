import { integer, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { organizations, users } from './auth';

/**
 * Regeln der Suchbegriff-Einstufung je Organisation (`phase-2b.md` 2b.2): Harvest ab `harvest_min_purchases`
 * Käufen und ACoS ≤ `harvest_max_acos` (Bruch), Negieren ab `negate_min_clicks` Klicks ohne Kauf und Spend ≥
 * `negate_min_cost` (Währung des jeweiligen Profils). Ohne Zeile gelten die Startwerte
 * (`DEFAULT_SEARCH_TERM_RULES` in `@profitbash/shared`).
 */
export const searchTermRules = pgTable('search_term_rules', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  harvestMinPurchases: integer('harvest_min_purchases').notNull(),
  harvestMaxAcos: numeric('harvest_max_acos', { mode: 'string' }).notNull(),
  negateMinClicks: integer('negate_min_clicks').notNull(),
  negateMinCost: numeric('negate_min_cost', { mode: 'string' }).notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
});
