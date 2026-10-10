import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { clients } from './app';
import { organizations, users } from './auth';
import { createdAt, updatedAt } from './columns';

/**
 * Leitplanken der Organisation (`phase-5.md` 5.4): ein Dokument nach `guardrailsSchema` aus `@profitbash/shared`.
 * Ohne Zeile gelten die Startwerte. Zugriffe nur über `automation.ts`.
 */
export const automationDefaults = pgTable('automation_defaults', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  guardrails: jsonb('guardrails').$type<unknown>().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Automatik je Client: Modus, zuständiger Nutzer für `cart` und überschriebene Leitplanken
 * (`guardrailOverridesSchema`). Ohne Zeile: Modus `shadow`, nichts überschrieben.
 */
export const clientAutomationSettings = pgTable(
  'client_automation_settings',
  {
    clientId: uuid('client_id').primaryKey(),
    organizationId: uuid('organization_id').notNull(),
    /** `AUTOMATION_MODES`. */
    mode: text('mode').notNull(),
    // Kein Check „cart braucht einen Nutzer“: Das Löschen des Nutzers leert die Spalte, der Lauf (5.7) fällt dann
    // auf `shadow` zurück.
    responsibleUserId: uuid('responsible_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    overrides: jsonb('overrides').$type<unknown>().notNull(),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'client_automation_settings_client_org_fk',
      columns: [t.clientId, t.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }).onDelete('cascade'),
    check('client_automation_settings_mode_ck', sql`${t.mode} in ('off', 'shadow', 'cart')`),
  ],
);

/**
 * Regeln der Automatik je Organisation (`phase-5.md` 5.6a): eine geordnete Liste nach `automationRulesSchema`. Ohne
 * Zeile gelten die Startregeln. `version` zählt jedes Speichern (gleichzeitige Änderungen enden mit 409).
 */
export const automationRules = pgTable('automation_rules', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  rules: jsonb('rules').$type<unknown>().notNull(),
  version: integer('version').notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
