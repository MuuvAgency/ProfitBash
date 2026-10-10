import type {
  CampaignSetupItemPayload,
  PlannedCampaign,
  SetupInputs,
  SourceNegative,
} from '@profitbash/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { adChangeSubmissions } from './ad-changes';
import { amazonAdsProfiles } from './app';
import { users } from './auth';
import { createdAt, id, organizationId, updatedAt } from './columns';
import { productGroups } from './product-groups';

/**
 * Kampagnen-Setup (`docs/tasks/phase-4.md` 4.4, F5): Entwürfe und was ihre Übermittlung anlegt. Zugriffe nur über
 * `campaign-setup.ts` (Sichtbarkeit am Profil, ADR 002). Entwürfe gehören dem Team (F13): Alle mit Schreibrecht sehen
 * und ändern die Entwürfe eines Profils.
 *
 * - `campaign_setup_drafts`: der geprüfte, noch nicht übermittelte Plan (`campaigns`) mit den Eingaben des Assistenten
 *   (`inputs`), um neu zu planen. Mit dem Übermitteln hängt er an genau einer Übermittlung (ein Entwurf = eine
 *   Bulk-Datei, F13) und bleibt als Verlauf stehen.
 * - `campaign_setup_items`: je neuer Entity eine Zeile (Kampagne, Gebotsanpassung, Ad Group, Anzeige, Keyword,
 *   Produkt-Target, Negative) mit Status wie `ad_changes` und der echten Amazon-ID nach der Bestätigung.
 */

export const campaignSetupDrafts = pgTable(
  'campaign_setup_drafts',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    /** Die Gruppe kann später gelöscht werden; der Plan bleibt. */
    productGroupId: uuid('product_group_id').references(() => productGroups.id, {
      onDelete: 'set null',
    }),
    presetKey: text('preset_key').notNull(),
    name: text('name').notNull(),
    /** `draft` → `submitted` | `discarded` (`CAMPAIGN_SETUP_DRAFT_STATUSES`). */
    status: text('status').notNull().default('draft'),
    /** Zustand aller neuen Kampagnen: `ENABLED` (Standard, F6) | `PAUSED`. */
    campaignState: text('campaign_state').notNull().default('ENABLED'),
    inputs: jsonb('inputs').$type<SetupInputs>().notNull(),
    campaigns: jsonb('campaigns').$type<PlannedCampaign[]>().notNull(),
    /** Negativ-Vorschläge für die Quellen der Harvest-Begriffe (4.6, F7), mit Auswahl. */
    sourceNegatives: jsonb('source_negatives')
      .$type<SourceNegative[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    /**
     * Bestehendes Portfolio für alle neuen Kampagnen (4.7, F9), interne ID. Ohne Fremdschlüssel: Das Übermitteln
     * prüft, ob es im Profil noch besteht.
     */
    portfolioId: uuid('portfolio_id'),
    /** Zählt jedes Speichern (gleichzeitige Änderungen enden mit 409). */
    version: integer('version').notNull().default(1),
    submissionId: uuid('submission_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    updatedBy: uuid('updated_by').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'campaign_setup_drafts_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }),
    foreignKey({
      name: 'campaign_setup_drafts_submission_fk',
      columns: [t.submissionId, t.profileId],
      foreignColumns: [adChangeSubmissions.id, adChangeSubmissions.profileId],
    }),
    check(
      'campaign_setup_drafts_status_ck',
      sql`${t.status} in ('draft', 'submitted', 'discarded')`,
    ),
    check(
      'campaign_setup_drafts_campaign_state_ck',
      sql`${t.campaignState} in ('ENABLED', 'PAUSED')`,
    ),
    check(
      'campaign_setup_drafts_submission_ck',
      sql`(${t.status} = 'submitted') = (${t.submissionId} is not null)`,
    ),
    index('campaign_setup_drafts_profile_idx').on(t.profileId, t.updatedAt.desc()),
    index('campaign_setup_drafts_submission_idx').on(t.submissionId),
  ],
);

export const campaignSetupItems = pgTable(
  'campaign_setup_items',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    submissionId: uuid('submission_id').notNull(),
    /** Leer nur bei Portfolios (4.7), die ohne Entwurf angelegt werden. */
    draftId: uuid('draft_id').references(() => campaignSetupDrafts.id),
    /** Reihenfolge der Anlage (Eltern vor Kindern) und der Zeilen in der Bulk-Datei. */
    position: integer('position').notNull(),
    /** `CAMPAIGN_SETUP_ITEM_ENTITIES`. */
    entityType: text('entity_type').notNull(),
    /** Vorläufige Text-ID der Kampagne (ihr Name). */
    campaignRef: text('campaign_ref').notNull(),
    /** Vorläufige Text-ID der Ad Group (ihr Name); leer bei Kampagne und Gebotsanpassung. */
    adGroupRef: text('ad_group_ref'),
    payload: jsonb('payload').$type<CampaignSetupItemPayload>().notNull(),
    /** `submitted` → `applied` | `failed`; `dismissed` = nicht angelegt und verworfen (wie `ad_changes`). */
    status: text('status').notNull().default('submitted'),
    /** Echte ID nach der Anlage (API) bzw. der Bestätigung durch den Bulk-Import. */
    amazonEntityId: text('amazon_entity_id'),
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'campaign_setup_items_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }),
    foreignKey({
      name: 'campaign_setup_items_submission_fk',
      columns: [t.submissionId, t.profileId],
      foreignColumns: [adChangeSubmissions.id, adChangeSubmissions.profileId],
    }),
    check(
      'campaign_setup_items_status_ck',
      sql`${t.status} in ('submitted', 'applied', 'failed', 'dismissed')`,
    ),
    check(
      'campaign_setup_items_entity_type_ck',
      sql`${t.entityType} in ('campaign', 'placement', 'ad_group', 'product_ad', 'sb_ad', 'keyword', 'product_target', 'audience_target', 'negative_keyword', 'negative_product_target', 'source_negative', 'portfolio')`,
    ),
    check(
      'campaign_setup_items_parent_ck',
      sql`(${t.entityType} in ('campaign', 'placement', 'portfolio')) = (${t.adGroupRef} is null)`,
    ),
    check(
      'campaign_setup_items_draft_ck',
      sql`(${t.entityType} = 'portfolio') = (${t.draftId} is null)`,
    ),
    index('campaign_setup_items_submission_idx').on(t.submissionId, t.position),
    // Offene Zeilen und angelegte ohne echte ID (Bestätigung durch den nächsten Bulk-Import).
    index('campaign_setup_items_unresolved_profile_idx')
      .on(t.profileId)
      .where(
        sql`${t.status} = 'submitted' or (${t.status} = 'applied' and ${t.amazonEntityId} is null and ${t.entityType} <> 'placement')`,
      ),
  ],
);
