import type { AdChangeNegative } from '@profitbash/shared';
import { sql } from 'drizzle-orm';
import {
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { amazonAdsAdGroups, amazonAdsCampaigns } from './amazon-ads-data';
import { amazonAdsProfiles } from './app';
import { users } from './auth';
import { createdAt, id, organizationId, updatedAt } from './columns';

/**
 * Änderungen an Amazon-Werbung (`docs/tasks/phase-3.md` 3.1). Zugriffe nur über `ad-changes.ts`.
 *
 * - `ad_changes`: eine Zeile je geändertem Feld einer Entity (vorher/nachher) bzw. je neuem Negative. Der Warenkorb
 *   eines Nutzers sind seine Zeilen im Status `pending`; mit dem Übermitteln hängen sie an einer Übermittlung und
 *   bleiben als Verlauf stehen (nie löschen).
 * - `ad_change_submissions`: Übermittlung der Änderungen **eines Profils** über einen Weg (`api` | `bulk_file`).
 * - Die Daten gehören der Organisation des Profils (ADR 002). Verweise auf Profil, Kampagne und Ad Group mit
 *   `ON DELETE NO ACTION` wie die Entities (1.5): Verlauf ist nicht wiederbeschaffbar.
 */

export const adChangeSubmissions = pgTable(
  'ad_change_submissions',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    /** `api` | `bulk_file` (`AD_CHANGE_CHANNELS`). */
    channel: text('channel').notNull(),
    /** `pending` → `running` → `finished` | `failed` (`AD_CHANGE_SUBMISSION_STATUSES`). */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    /** Grund, wenn die Übermittlung als Ganzes gescheitert ist (für die Anzeige, ohne Secrets). */
    error: text('error'),
    /** Lauf des Jobs, der die Übermittlung zuletzt bearbeitet hat (3.3). */
    jobRunId: uuid('job_run_id'),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'ad_change_submissions_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }),
    check('ad_change_submissions_channel_ck', sql`${t.channel} in ('api', 'bulk_file')`),
    check(
      'ad_change_submissions_status_ck',
      sql`${t.status} in ('pending', 'running', 'finished', 'failed')`,
    ),
    unique('ad_change_submissions_id_profile_uq').on(t.id, t.profileId),
    index('ad_change_submissions_profile_created_idx').on(t.profileId, t.createdAt.desc()),
    index('ad_change_submissions_open_idx')
      .on(t.profileId, t.createdAt)
      .where(sql`${t.status} in ('pending', 'running')`),
  ],
);

export const adChanges = pgTable(
  'ad_changes',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    /** `pending` → `submitted` → `applied` | `failed`; `dismissed` = fehlgeschlagen und verworfen. */
    status: text('status').notNull().default('pending'),
    /** Leer genau im Warenkorb (`pending`). */
    submissionId: uuid('submission_id'),
    /** `explorer` | `search_terms` | `revert` | `retry` (`AD_CHANGE_ORIGINS`). */
    origin: text('origin').notNull(),
    /** Bei `revert` und `retry`: die Änderung, die zurückgenommen bzw. wiederholt wird (3.3). */
    originChangeId: uuid('origin_change_id').references((): AnyPgColumn => adChanges.id),
    /** `update` (Feld einer Entity) | `create` (neues Negative). */
    operation: text('operation').notNull(),
    /** `campaign` | `ad_group` | `target` | `product_ad` | `negative_target`. */
    entityType: text('entity_type').notNull(),
    /**
     * Interne ID der geänderten Entity; leer beim Anlegen. Ohne Fremdschlüssel (fünf Tabellen): Entities werden nie
     * gelöscht (`removed_at`), und `ad-changes.ts` löst die ID beim Vormerken im Profil auf. Kampagne und Ad Group
     * sind über `campaign_id`/`ad_group_id` hart gebunden.
     */
    entityId: uuid('entity_id'),
    /** Kampagne der Entity (bzw. die Kampagne selbst). */
    campaignId: uuid('campaign_id').notNull(),
    /** Ad Group der Entity (bzw. die Ad Group selbst); leer auf Kampagnenebene. */
    adGroupId: uuid('ad_group_id'),
    /** Feld bei `update` (`AD_CHANGE_FIELDS`), leer bei `create`. */
    field: text('field'),
    /** Zustand bzw. Gebotsstrategie vorher/nachher. */
    oldValue: text('old_value'),
    newValue: text('new_value'),
    /** Betrag (Budget, Gebot) bzw. Prozentsatz (Platzierung) vorher/nachher. */
    oldAmount: numeric('old_amount', { mode: 'string' }),
    newAmount: numeric('new_amount', { mode: 'string' }),
    /** Währung der Beträge; leer bei Prozentsätzen und Texten. */
    currencyCode: text('currency_code'),
    /** Bei `create`: das neue Negative (`adChangeNegativeSchema`). */
    payload: jsonb('payload').$type<AdChangeNegative>(),
    /** Bei `create`: die von Amazon vergebene ID nach Erfolg (3.3). */
    amazonEntityId: text('amazon_entity_id'),
    /** Ergebnis von Amazon bei `failed` (3.3). */
    errorCode: text('error_code'),
    errorMessage: text('error_message'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'ad_changes_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }),
    foreignKey({
      name: 'ad_changes_campaign_fk',
      columns: [t.campaignId, t.profileId],
      foreignColumns: [amazonAdsCampaigns.id, amazonAdsCampaigns.profileId],
    }),
    foreignKey({
      name: 'ad_changes_ad_group_fk',
      columns: [t.adGroupId, t.profileId],
      foreignColumns: [amazonAdsAdGroups.id, amazonAdsAdGroups.profileId],
    }),
    foreignKey({
      name: 'ad_changes_submission_fk',
      columns: [t.submissionId, t.profileId],
      foreignColumns: [adChangeSubmissions.id, adChangeSubmissions.profileId],
    }),
    check(
      'ad_changes_status_ck',
      sql`${t.status} in ('pending', 'submitted', 'applied', 'failed', 'dismissed')`,
    ),
    check('ad_changes_pending_ck', sql`(${t.status} = 'pending') = (${t.submissionId} is null)`),
    check(
      'ad_changes_origin_ck',
      sql`${t.origin} in ('explorer', 'search_terms', 'revert', 'retry')`,
    ),
    check(
      'ad_changes_entity_type_ck',
      sql`${t.entityType} in ('campaign', 'ad_group', 'target', 'product_ad', 'negative_target')`,
    ),
    check(
      'ad_changes_entity_parent_ck',
      sql`(${t.entityType} <> 'campaign' or (${t.entityId} = ${t.campaignId} and ${t.adGroupId} is null)) and (${t.entityType} <> 'ad_group' or ${t.entityId} = ${t.adGroupId})`,
    ),
    // `update`: Entity, Feld und genau ein neuer Wert (Text oder Zahl); `create`: nur das neue Negative.
    check(
      'ad_changes_operation_ck',
      sql`(${t.operation} = 'update' and ${t.entityId} is not null and ${t.field} is not null and ${t.payload} is null and num_nonnulls(${t.newValue}, ${t.newAmount}) = 1 and num_nonnulls(${t.oldValue}, ${t.oldAmount}) <= 1) or (${t.operation} = 'create' and ${t.entityType} = 'negative_target' and ${t.entityId} is null and ${t.field} is null and ${t.payload} is not null and num_nonnulls(${t.newValue}, ${t.newAmount}, ${t.oldValue}, ${t.oldAmount}, ${t.currencyCode}) = 0)`,
    ),
    // Text-Felder tragen Text, alle anderen eine Zahl (Währung nur bei Beträgen, nie bei Platzierungen).
    check(
      'ad_changes_value_kind_ck',
      sql`${t.operation} <> 'update' or (${t.field} in ('state', 'bidding_strategy') and ${t.newValue} is not null and ${t.oldAmount} is null and ${t.currencyCode} is null) or (${t.field} in ('budget', 'default_bid', 'bid') and ${t.newAmount} is not null and ${t.oldValue} is null and ${t.currencyCode} is not null) or (${t.field} like 'placement\\_%' and ${t.newAmount} is not null and ${t.oldValue} is null and ${t.currencyCode} is null)`,
    ),
    // Warenkorb: je Nutzer, Entity und Feld höchstens eine offene Änderung (Upsert beim Vormerken).
    uniqueIndex('ad_changes_pending_uq')
      .on(t.createdBy, t.entityType, t.entityId, t.field)
      .where(sql`${t.status} = 'pending' and ${t.operation} = 'update'`),
    index('ad_changes_entity_idx').on(t.entityId, t.entityType),
    index('ad_changes_submission_idx').on(t.submissionId),
    index('ad_changes_campaign_idx').on(t.campaignId),
    index('ad_changes_ad_group_idx').on(t.adGroupId),
    // Offene Änderungen je Profil (Anzeige im Grid) und Verlauf je Profil, jeweils neueste zuerst (3.4).
    index('ad_changes_open_profile_idx')
      .on(t.profileId, t.createdAt.desc())
      .where(sql`${t.status} in ('pending', 'submitted')`),
    index('ad_changes_profile_created_idx').on(t.profileId, t.createdAt.desc()),
    index('ad_changes_pending_user_idx')
      .on(t.createdBy)
      .where(sql`${t.status} = 'pending'`),
  ],
);
