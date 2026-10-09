import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  pgTable,
  primaryKey,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { amazonAdsProfiles } from './app';
import { users } from './auth';
import { createdAt, id, organizationId, updatedAt } from './columns';

/**
 * Eigene Tags je Organisation (`phase-3.md` 3.7, F7): Name und Farbe (`TAG_COLORS` in `@profitbash/shared`, feste
 * Palette; als Text, damit eine neue Farbe keine Migration braucht). Getrennt von den Tags, die Amazon an Kampagnen
 * kennt (`extra.tags`). Zugriffe nur über `tags.ts`.
 */
export const tags = pgTable(
  'tags',
  {
    id: id(),
    organizationId: organizationId(),
    name: text('name').notNull(),
    color: text('color').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Ein Name je Organisation (ohne Groß-/Kleinschreibung).
    uniqueIndex('tags_org_name_uq').on(t.organizationId, sql`lower(${t.name})`),
    // Ziel des zusammengesetzten Fremdschlüssels der Zuweisungen (keine Zuweisung über Org-Grenzen).
    unique('tags_id_org_uq').on(t.id, t.organizationId),
  ],
);

/**
 * Zuweisung eines Tags an eine Kampagne, Ad Group, ein Target oder eine Product Ad. `entity_id` ohne Fremdschlüssel
 * (vier Tabellen, Entities werden nie gelöscht); das Profil der Entity steht dabei, damit Sichtbarkeit und Löschen
 * am Profil hängen.
 */
export const tagAssignments = pgTable(
  'tag_assignments',
  {
    tagId: uuid('tag_id').notNull(),
    organizationId: uuid('organization_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    /** `TAG_ENTITY_TYPES`: `campaign` | `ad_group` | `target` | `product_ad`. */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ name: 'tag_assignments_pk', columns: [t.tagId, t.entityType, t.entityId] }),
    foreignKey({
      name: 'tag_assignments_tag_org_fk',
      columns: [t.tagId, t.organizationId],
      foreignColumns: [tags.id, tags.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'tag_assignments_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    check(
      'tag_assignments_entity_type_ck',
      sql`${t.entityType} in ('campaign', 'ad_group', 'target', 'product_ad')`,
    ),
    // Tags einer Entity (Explorer-Zeilen, Filter) und Zuweisungen je Profil (Zähler der sichtbaren Profile).
    index('tag_assignments_entity_idx').on(t.entityId, t.entityType),
    index('tag_assignments_profile_idx').on(t.profileId),
  ],
);
