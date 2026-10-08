import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, numeric, pgTable, timestamp, uuid } from 'drizzle-orm/pg-core';
import { amazonAdsProfiles } from './app';
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

/**
 * Abweichende Regeln je Profil (`phase-2b.md` 2b.2g, Dominik 2026-10-08): je Feld ein eigener Wert oder leer = wie
 * die Organisation (`search_term_rules` bzw. Startwerte). Ein Profil ist ein Client auf einem Marktplatz; die
 * Spend-Grenze gilt in seiner Währung. Eine Zeile ohne Wert gibt es nicht (dann wird sie gelöscht).
 */
export const searchTermRuleOverrides = pgTable(
  'search_term_rule_overrides',
  {
    profileId: uuid('profile_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    harvestMinPurchases: integer('harvest_min_purchases'),
    harvestMaxAcos: numeric('harvest_max_acos', { mode: 'string' }),
    negateMinClicks: integer('negate_min_clicks'),
    negateMinCost: numeric('negate_min_cost', { mode: 'string' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      name: 'search_term_rule_overrides_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    check(
      'search_term_rule_overrides_not_empty_ck',
      sql`num_nonnulls(${t.harvestMinPurchases}, ${t.harvestMaxAcos}, ${t.negateMinClicks}, ${t.negateMinCost}) > 0`,
    ),
  ],
);
