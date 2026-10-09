import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { amazonAdsProfiles } from './app';
import { organizations, users } from './auth';
import { createdAt, id, organizationId } from './columns';

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

/**
 * Harvest-Merkliste je Profil (`phase-3.md` 3.8, F9): Suchbegriffe, aus denen später eine Exakt-Kampagne werden soll
 * (Phase 4, Kampagnen-Setup). Keine Änderung bei Amazon. Je Profil und Begriff (`term_key` = Vergleichsform:
 * klein, NFC, Leerraum zusammengefasst) ein Eintrag mit der Quelle (Zeile mit dem höchsten Spend, als Amazon-IDs
 * wie in den Suchbegriff-Blättern) und den Kennzahlen des Begriffs über alle seine Zeilen im Datei-Zeitraum, so wie
 * sie beim Vormerken galten. Zugriffe nur über `search-term-harvest.ts` (ADR 002).
 */
export const searchTermHarvestMarks = pgTable(
  'search_term_harvest_marks',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    /** Schreibweise der Quellzeile. */
    searchTerm: text('search_term').notNull(),
    termKey: text('term_key').notNull(),
    adProduct: text('ad_product').notNull(),
    amazonCampaignId: text('amazon_campaign_id').notNull(),
    amazonAdGroupId: text('amazon_ad_group_id').notNull(),
    amazonTargetId: text('amazon_target_id').notNull(),
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    /** Zeilen (Suchbegriff je Target), die in die Kennzahlen eingehen. */
    sourceRows: integer('source_rows').notNull(),
    currencyCode: text('currency_code').notNull(),
    impressions: bigint('impressions', { mode: 'number' }).notNull(),
    clicks: bigint('clicks', { mode: 'number' }).notNull(),
    cost: numeric('cost', { mode: 'string' }).notNull(),
    sales: numeric('sales', { mode: 'string' }).notNull(),
    purchases: bigint('purchases', { mode: 'number' }).notNull(),
    units: bigint('units', { mode: 'number' }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'search_term_harvest_marks_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    unique('search_term_harvest_marks_profile_term_uq').on(t.profileId, t.termKey),
    check('search_term_harvest_marks_period_ck', sql`${t.periodStart} <= ${t.periodEnd}`),
    index('search_term_harvest_marks_profile_created_idx').on(t.profileId, t.createdAt),
  ],
);
