import { sql } from 'drizzle-orm';
import {
  boolean,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { amazonAdsProfiles } from './app';
import { users } from './auth';
import { createdAt, id, organizationId, updatedAt } from './columns';

/**
 * Produktgruppen (`phase-4.md` 4.1, F2): beworbene Einheiten eines Profils (Marktplatz). Der Client kommt über das
 * Profil. Zugriffe nur über `product-groups.ts` (Sichtbarkeit am Profil, ADR 002).
 */
export const productGroups = pgTable(
  'product_groups',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    name: text('name').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'product_groups_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    // Ein Name je Profil (ohne Groß-/Kleinschreibung).
    uniqueIndex('product_groups_profile_name_uq').on(t.profileId, sql`lower(${t.name})`),
    index('product_groups_org_idx').on(t.organizationId),
  ],
);

/** Produkte einer Gruppe in der eingegebenen Reihenfolge; ASIN Pflicht, SKU leer bei Vendoren. */
export const productGroupItems = pgTable(
  'product_group_items',
  {
    id: id(),
    productGroupId: uuid('product_group_id')
      .notNull()
      .references(() => productGroups.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
    asin: text('asin').notNull(),
    sku: text('sku'),
    isHero: boolean('is_hero').notNull().default(false),
  },
  (t) => [
    unique('product_group_items_product_uq').on(t.productGroupId, t.asin, t.sku).nullsNotDistinct(),
    // Höchstens ein Hero je Gruppe.
    uniqueIndex('product_group_items_hero_uq')
      .on(t.productGroupId)
      .where(sql`${t.isHero}`),
    // Gruppen eines Produkts (Auswahl der beworbenen Produkte zeigt die Zugehörigkeit).
    index('product_group_items_asin_idx').on(t.asin),
  ],
);
