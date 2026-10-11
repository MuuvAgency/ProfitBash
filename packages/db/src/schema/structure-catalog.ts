import { foreignKey, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { amazonAdsCampaigns } from './amazon-ads-data';
import { amazonAdsProfiles, clients } from './app';
import { organizations, users } from './auth';
import { createdAt, updatedAt } from './columns';

/**
 * Struktur-Katalog je Organisation (`phase-4.md` 4.2): ein Dokument nach `structureCatalogSchema` aus
 * `@profitbash/shared`. Ohne Zeile gelten die Startwerte. `version` zählt jedes Speichern (gleichzeitige Änderungen
 * enden mit 409). Zugriffe nur über `structure-catalog.ts`.
 */
export const structureCatalogs = pgTable('structure_catalogs', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  catalog: jsonb('catalog').$type<unknown>().notNull(),
  version: integer('version').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/** Preset je Client (Schlüssel aus dem Katalog; ein gelöschtes Preset fällt auf den Standard zurück). */
export const clientPresets = pgTable(
  'client_presets',
  {
    clientId: uuid('client_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    presetKey: text('preset_key').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'client_presets_client_org_fk',
      columns: [t.clientId, t.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }).onDelete('cascade'),
  ],
);

/**
 * Von Hand bestätigter Baustein einer Kampagne (`phase-5.md` 5.11a). Kampagnen aus einem Setup kennen ihren Baustein
 * über den Entwurf (`campaign_setup_items`); eine Zeile hier geht dem vor. Zugriffe nur über `campaign-blocks.ts`.
 */
export const campaignBlocks = pgTable(
  'campaign_blocks',
  {
    campaignId: uuid('campaign_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    profileId: uuid('profile_id').notNull(),
    /** Schlüssel aus dem Katalog; ein gelöschter Baustein zählt nicht mehr. */
    blockKey: text('block_key').notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'campaign_blocks_campaign_fk',
      columns: [t.campaignId, t.profileId],
      foreignColumns: [amazonAdsCampaigns.id, amazonAdsCampaigns.profileId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'campaign_blocks_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    index('campaign_blocks_profile_idx').on(t.profileId),
  ],
);
