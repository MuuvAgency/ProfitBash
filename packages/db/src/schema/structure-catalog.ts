import { foreignKey, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { clients } from './app';
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
