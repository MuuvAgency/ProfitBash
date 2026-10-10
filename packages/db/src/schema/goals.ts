import { sql } from 'drizzle-orm';
import { check, foreignKey, numeric, pgTable, text, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { amazonAdsProfiles, clients } from './app';
import { users } from './auth';
import { createdAt, id, organizationId, updatedAt } from './columns';
import { productGroups } from './product-groups';

/**
 * Ziele (`phase-5.md` 5.3, F4): Ziel-ACoS (Prozent) bzw. -ROAS (Faktor) an genau einem Client, Profil oder einer
 * Produktgruppe, je Objekt höchstens eines. Zugriffe nur über `goals.ts` (Sichtbarkeit am Profil, ADR 002).
 */
export const goals = pgTable(
  'goals',
  {
    id: id(),
    organizationId: organizationId(),
    clientId: uuid('client_id'),
    profileId: uuid('profile_id'),
    productGroupId: uuid('product_group_id'),
    /** `GOAL_METRICS`: `acos` | `roas`. */
    metric: text('metric').notNull(),
    value: numeric('value', { precision: 5, scale: 2 }).notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'goals_client_org_fk',
      columns: [t.clientId, t.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'goals_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'goals_product_group_org_fk',
      columns: [t.productGroupId, t.organizationId],
      foreignColumns: [productGroups.id, productGroups.organizationId],
    }).onDelete('cascade'),
    check(
      'goals_scope_ck',
      sql`num_nonnulls(${t.clientId}, ${t.profileId}, ${t.productGroupId}) = 1`,
    ),
    check('goals_metric_ck', sql`${t.metric} in ('acos', 'roas')`),
    // Je Objekt höchstens ein Ziel (NULL zählt nicht) und Ziel des Upserts.
    uniqueIndex('goals_client_uq').on(t.clientId),
    uniqueIndex('goals_profile_uq').on(t.profileId),
    uniqueIndex('goals_product_group_uq').on(t.productGroupId),
  ],
);
