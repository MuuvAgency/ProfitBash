import { sql } from 'drizzle-orm';
import {
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { adChanges } from './ad-changes';
import { amazonAdsProfiles, clients } from './app';
import { organizations, users } from './auth';
import { createdAt, id, organizationId, updatedAt } from './columns';

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

/**
 * Läufe der Automatik je Profil (`phase-5.md` 5.7): worauf gerechnet wurde (Datenstand), in welchem Modus und mit
 * welchem Ergebnis. Zugriffe nur über `automation-runs.ts`.
 */
export const automationRuns = pgTable(
  'automation_runs',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    jobRunId: uuid('job_run_id'),
    /** `shadow` | `cart`: der wirksame Modus des Laufs (nach der Prüfung des zuständigen Nutzers). */
    mode: text('mode').notNull(),
    responsibleUserId: uuid('responsible_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Datenstand: Zeitraum und Upload der Datei, auf der der Lauf gerechnet hat. */
    periodStart: date('period_start', { mode: 'string' }).notNull(),
    periodEnd: date('period_end', { mode: 'string' }).notNull(),
    metricsImportedAt: timestamp('metrics_imported_at', {
      withTimezone: true,
      mode: 'date',
    }).notNull(),
    /** Hash über Datenstand, Regeln, Ziele und Einstellungen: Ohne Änderung daran gibt es keinen neuen Lauf. */
    fingerprint: text('fingerprint').notNull(),
    /** Zähler: geprüfte Targets und Kampagnen, Vorschläge, im Warenkorb, Gründe ohne Vorschlag. */
    counts: jsonb('counts').$type<Record<string, number>>().notNull(),
    /** Hinweise zum Lauf, z. B. `olderPeriod` (der Zeitraum endet vor dem des vorigen Laufs). */
    warnings: jsonb('warnings').$type<string[]>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'automation_runs_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    check('automation_runs_mode_ck', sql`${t.mode} in ('shadow', 'cart')`),
    index('automation_runs_profile_created_idx').on(t.profileId, t.createdAt.desc()),
  ],
);

/**
 * Vorschläge eines Laufs: gewünschte Änderung an einem Target (Gebot, Zustand) oder einer Kampagne (Budget,
 * Zustand) mit Herkunft und Begründung. `open`: nur im Protokoll; `staged`: als Änderung im Warenkorb
 * (`ad_change_id`, leer, wenn sie dort verworfen wurde); `dismissed`: verworfen; `superseded`: von einem neueren
 * Lauf abgelöst. Entities ohne Fremdschlüssel wie in `ad_changes`.
 */
export const automationProposals = pgTable(
  'automation_proposals',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    runId: uuid('run_id')
      .notNull()
      .references(() => automationRuns.id, { onDelete: 'cascade' }),
    /** `target` | `campaign`. */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    campaignId: uuid('campaign_id').notNull(),
    adGroupId: uuid('ad_group_id'),
    /** `bid` | `budget` | `state`. */
    field: text('field').notNull(),
    /** Zustand vorher/nachher (`state`) bzw. Betrag in der Währung des Profils. */
    oldValue: text('old_value'),
    newValue: text('new_value'),
    oldAmount: numeric('old_amount', { mode: 'string' }),
    newAmount: numeric('new_amount', { mode: 'string' }),
    currencyCode: text('currency_code'),
    /** `rule` | `optimizer` | `budget_cap` (Enforcer, 5.9b). */
    source: text('source').notNull(),
    /** Regel, die gegriffen hat, mit ihrem Namen zum Zeitpunkt des Laufs (Regeln sind änderbar). */
    ruleId: uuid('rule_id'),
    ruleName: text('rule_name'),
    /** Leitplanken, die den Vorschlag begrenzt haben (`GuardrailReason`). */
    limitedBy: jsonb('limited_by').$type<string[]>().notNull(),
    /** Begründung: Kennzahlen des Zeitraums, Ziel, gewünschter Wert vor den Leitplanken. */
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    status: text('status').notNull(),
    adChangeId: uuid('ad_change_id').references(() => adChanges.id, { onDelete: 'set null' }),
    /** Wer den Vorschlag übernommen oder verworfen hat (5.8). */
    resolvedBy: uuid('resolved_by').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    foreignKey({
      name: 'automation_proposals_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    check('automation_proposals_entity_type_ck', sql`${t.entityType} in ('target', 'campaign')`),
    check('automation_proposals_field_ck', sql`${t.field} in ('bid', 'budget', 'state')`),
    check(
      'automation_proposals_source_ck',
      sql`${t.source} in ('rule', 'optimizer', 'budget_cap')`,
    ),
    check(
      'automation_proposals_status_ck',
      sql`${t.status} in ('open', 'staged', 'dismissed', 'superseded')`,
    ),
    index('automation_proposals_run_idx').on(t.runId),
    index('automation_proposals_profile_status_idx').on(t.profileId, t.status),
    index('automation_proposals_ad_change_idx').on(t.adChangeId),
  ],
);

/**
 * Einstellungen der Prüfungen je Organisation (`phase-5.md` 5.10): ein Dokument nach `checkSettingsSchema`. Ohne
 * Zeile gelten die Startwerte. Zugriffe nur über `automation-checks.ts`.
 */
export const automationCheckSettings = pgTable('automation_check_settings', {
  organizationId: uuid('organization_id')
    .primaryKey()
    .references(() => organizations.id, { onDelete: 'cascade' }),
  settings: jsonb('settings').$type<unknown>().notNull(),
  updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

/**
 * Aktuelle Befunde der Prüfungen je Profil: Jeder Lauf hält bestehende, legt neue an und löscht, was nicht mehr
 * auftritt (mit der Quittung; kommt der Befund zurück, ist er neu). Entities ohne Fremdschlüssel wie in
 * `automation_proposals`; bei Hinweisen je Profil ist `entity_id` das Profil.
 */
export const automationFindings = pgTable(
  'automation_findings',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    /** `CHECK_KINDS`. */
    kind: text('kind').notNull(),
    /** `campaign` | `target` | `profile`. */
    entityType: text('entity_type').notNull(),
    entityId: uuid('entity_id').notNull(),
    campaignId: uuid('campaign_id'),
    /** Unterscheidet Befunde einer Art an derselben Entity (Platzierung), sonst leer. */
    key: text('key').notNull(),
    detail: jsonb('detail').$type<Record<string, unknown>>().notNull(),
    firstSeenAt: timestamp('first_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }).notNull(),
    acknowledgedBy: uuid('acknowledged_by').references(() => users.id, { onDelete: 'set null' }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    foreignKey({
      name: 'automation_findings_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    uniqueIndex('automation_findings_key_uq').on(t.profileId, t.kind, t.entityId, t.key),
  ],
);
