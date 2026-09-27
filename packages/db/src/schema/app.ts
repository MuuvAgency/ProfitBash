import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  date,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { organizations, users } from './auth';

// ---------------------------------------------------------------------------
// Gemeinsame Spalten
// ---------------------------------------------------------------------------

const id = () => uuid('id').primaryKey().defaultRandom();
const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull();
const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date());
const organizationId = () =>
  uuid('organization_id')
    .notNull()
    .references(() => organizations.id, { onDelete: 'cascade' });

// ---------------------------------------------------------------------------
// Enums (stabile Wertemengen; neue Werte = Migration mit ALTER TYPE … ADD VALUE)
// ---------------------------------------------------------------------------

export const connectionProvider = pgEnum('connection_provider', ['amazon_ads']);
export const connectionRegion = pgEnum('connection_region', ['eu', 'na', 'fe']);
export const connectionStatus = pgEnum('connection_status', ['active', 'reauth_required', 'error']);
export const jobRunStatus = pgEnum('job_run_status', ['running', 'success', 'failed']);
export const amazonAdsRequestKind = pgEnum('amazon_ads_request_kind', ['report', 'export']);
export const amazonAdsRequestStatus = pgEnum('amazon_ads_request_status', [
  'pending_request',
  'requested',
  'completed',
  'imported',
  'failed',
]);

// ---------------------------------------------------------------------------
// Entitlements: welche Features eine Organisation gebucht hat
// ---------------------------------------------------------------------------

export const orgEntitlements = pgTable(
  'org_entitlements',
  {
    id: id(),
    organizationId: organizationId(),
    /** Feature-Key aus packages/shared/src/features.ts (Text, keine Enum-Migration nötig). */
    feature: text('feature').notNull(),
    enabled: boolean('enabled').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('org_entitlements_org_feature_uq').on(t.organizationId, t.feature)],
);

// ---------------------------------------------------------------------------
// Clients: zentrale Geschäftseinheit (bündelt Profile, später weitere Marktplätze)
// ---------------------------------------------------------------------------

export const clients = pgTable(
  'clients',
  {
    id: id(),
    organizationId: organizationId(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('clients_org_slug_uq').on(t.organizationId, t.slug),
    // Ziel der zusammengesetzten Fremdschlüssel (verhindert Zuordnungen über Org-Grenzen)
    unique('clients_id_org_uq').on(t.id, t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// Connections: OAuth-Verbindungen zu externen APIs (provider-neutral)
// ---------------------------------------------------------------------------

export const connections = pgTable(
  'connections',
  {
    id: id(),
    organizationId: organizationId(),
    provider: connectionProvider('provider').notNull(),
    /** API-Region (Amazon: eu | na | fe). Leer bei Anbietern ohne Regionen. */
    region: connectionRegion('region'),
    /**
     * Stabile ID des externen Kontos, mit dem verbunden wurde (Amazon: LWA-User-ID `amzn1.account…`).
     * Verhindert doppelte Connections beim erneuten Verbinden.
     */
    externalAccountId: text('external_account_id').notNull(),
    externalAccountEmail: text('external_account_email'),
    /** Verschlüsselt über `@profitbash/shared/crypto`. Nie im Klartext speichern oder loggen. */
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
    status: connectionStatus('status').notNull().default('active'),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true, mode: 'date' }),
    /**
     * Letzte Einwilligung beim Anbieter (Anlage oder Neu-Verbinden). Amazon-Refresh-Tokens laufen
     * 365 Tage danach ab (abgeleitet in der API, nicht gespeichert). Leer bei Bestandsdaten.
     */
    consentedAt: timestamp('consented_at', { withTimezone: true, mode: 'date' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('connections_account_uq')
      .on(t.organizationId, t.provider, t.region, t.externalAccountId)
      .nullsNotDistinct(),
    unique('connections_id_org_uq').on(t.id, t.organizationId),
    index('connections_org_idx').on(t.organizationId),
  ],
);

// ---------------------------------------------------------------------------
// Amazon-Ads-Profile (je Marktplatz ein Profil)
// ---------------------------------------------------------------------------

export const amazonAdsProfiles = pgTable(
  'amazon_ads_profiles',
  {
    /** Interne ID. In der App heißt sie `profileId`, die Amazon-ID immer `amazonProfileId`. */
    id: id(),
    organizationId: organizationId(),
    /** Aktueller Zugriffsweg. Gehört zwingend zur selben Organisation (zusammengesetzter FK). */
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    /** Zugeordneter Client derselben Organisation (zusammengesetzter FK). */
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    /** Amazon-Profil-ID. Immer Text, weil die Zahl JavaScripts sichere Ganzzahlgrenze überschreiten kann. */
    amazonProfileId: text('amazon_profile_id').notNull(),
    /** Amazon `accountInfo.id` (Seller-/Vendor-/Entity-ID), wird von späteren APIs gebraucht. */
    amazonAccountId: text('amazon_account_id'),
    accountName: text('account_name').notNull(),
    countryCode: text('country_code').notNull(),
    currencyCode: text('currency_code').notNull(),
    timezone: text('timezone').notNull(),
    marketplaceId: text('marketplace_id'),
    /** seller | vendor | agency. Text statt Enum: Ein neuer Wert von Amazon darf den Sync nicht brechen. */
    accountType: text('account_type').notNull(),
    /** Vom Nutzer ausgeblendet. */
    isHidden: boolean('is_hidden').notNull().default(false),
    /** Amazon liefert das Profil nicht mehr. Wird beim erneuten Auftauchen zurückgesetzt. */
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Ein Amazon-Profil gibt es pro Organisation nur einmal, egal über wie viele Connections es sichtbar ist.
    uniqueIndex('amazon_ads_profiles_org_amazon_profile_uq').on(
      t.organizationId,
      t.amazonProfileId,
    ),
    foreignKey({
      name: 'amazon_ads_profiles_connection_org_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }),
    foreignKey({
      name: 'amazon_ads_profiles_client_org_fk',
      columns: [t.clientId, t.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }),
    index('amazon_ads_profiles_org_idx').on(t.organizationId),
    index('amazon_ads_profiles_connection_idx').on(t.connectionId),
    index('amazon_ads_profiles_client_idx').on(t.clientId),
    // Ziel der zusammengesetzten Fremdschlüssel der Profildaten (Phase 1): keine Verknüpfung über Org-Grenzen
    unique('amazon_ads_profiles_id_org_uq').on(t.id, t.organizationId),
  ],
);

/** Offene Aufträge: höchstens einer je Schlüssel (siehe Index unten). */
const OPEN_AMAZON_REQUEST = sql`status in ('pending_request', 'requested', 'completed')`;

/**
 * Asynchrone Aufträge an Amazon (Phase 1, 1.4): Reports (Reporting v3) und Exports (Entities). Der
 * Zustand liegt in der DB, damit ein Neustart nichts verliert: Die Zeile entsteht **vor** dem Aufruf an
 * Amazon (`pending_request`), danach `requested` → `completed` → `imported`, oder `failed`. Die
 * Download-URL wird nie gespeichert (signiert, läuft ab). Zugriffe nur über `amazon-requests.ts`.
 * Abgeschlossene Aufträge löscht `job-runs-cleanup` nach 30 Tagen (F5).
 */
export const amazonAdsReportRequests = pgTable(
  'amazon_ads_report_requests',
  {
    id: id(),
    organizationId: organizationId(),
    profileId: uuid('profile_id').notNull(),
    kind: amazonAdsRequestKind('kind').notNull(),
    /** Genau ein Ad-Typ je Auftrag (`SPONSORED_PRODUCTS` …), auch bei Exports. */
    adProduct: text('ad_product').notNull(),
    /** Report-Typ (`spCampaigns` …) bzw. Export-Typ (`campaigns`, `adGroups`, `targets`, `ads`). */
    reportType: text('report_type').notNull(),
    /** Zeitraum (nur Reports), Tage in der Zeitzone des Profils. */
    startDate: date('start_date', { mode: 'string' }),
    endDate: date('end_date', { mode: 'string' }),
    /** Exports eines Entity-Syncs gehören zusammen und werden gemeinsam importiert (nur Exports). */
    batchId: uuid('batch_id'),
    /** Report- bzw. Export-ID von Amazon; leer bis zur Antwort. */
    amazonRequestId: text('amazon_request_id'),
    status: amazonAdsRequestStatus('status').notNull().default('pending_request'),
    /** Status-Abfragen seit dem (letzten) Anfordern. */
    attempts: integer('attempts').notNull().default(0),
    /** Gescheiterte Importversuche (bei Exports je Batch gezählt). */
    importAttempts: integer('import_attempts').notNull().default(0),
    /** Nächste Bearbeitung; `null` = wartet auf andere Exports des Batches. */
    nextPollAt: timestamp('next_poll_at', { withTimezone: true, mode: 'date' }),
    /** Letztes erfolgreiches Anfordern bei Amazon. */
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' }),
    /** Gekürzt, ohne URLs und Rohdaten. */
    failureReason: text('failure_reason'),
    rowCount: integer('row_count'),
    invalidRowCount: integer('invalid_row_count'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Betriebszustand, keine Historie: Die Aufträge verschwinden mit dem Profil.
    foreignKey({
      name: 'amazon_ads_report_requests_profile_org_fk',
      columns: [t.profileId, t.organizationId],
      foreignColumns: [amazonAdsProfiles.id, amazonAdsProfiles.organizationId],
    }).onDelete('cascade'),
    // Kein doppelter offener Auftrag, auch bei Exports (Daten leer) und nach einem Neustart. Die
    // Migration `0006_amazon_ads_report_requests_open_nulls_not_distinct` legt den Index mit
    // NULLS NOT DISTINCT neu an (Drizzle kennt die Option nur für Constraints, nicht für Indizes).
    uniqueIndex('amazon_ads_report_requests_open_uq')
      .on(t.profileId, t.kind, t.adProduct, t.reportType, t.startDate, t.endDate)
      .where(OPEN_AMAZON_REQUEST),
    index('amazon_ads_report_requests_profile_type_idx').on(
      t.profileId,
      t.kind,
      t.adProduct,
      t.reportType,
    ),
    index('amazon_ads_report_requests_batch_idx')
      .on(t.batchId)
      .where(sql`batch_id is not null`),
    check(
      'amazon_ads_report_requests_kind_ck',
      sql`(kind = 'report' and start_date is not null and end_date is not null and start_date <= end_date and batch_id is null)
        or (kind = 'export' and start_date is null and end_date is null and batch_id is not null)`,
    ),
  ],
);

// ---------------------------------------------------------------------------
// Betrieb: Jobläufe und Audit-Log
// ---------------------------------------------------------------------------

export const jobRuns = pgTable(
  'job_runs',
  {
    id: id(),
    /** null = plattformweiter Job */
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    job: text('job').notNull(),
    /** z. B. Connection-ID oder Profil-ID, auf die sich der Lauf bezieht */
    scope: text('scope'),
    status: jobRunStatus('status').notNull().default('running'),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }).defaultNow().notNull(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    error: text('error'),
    counters: jsonb('counters')
      .$type<Record<string, number>>()
      .notNull()
      .default(sql`'{}'::jsonb`),
  },
  (t) => [
    index('job_runs_started_idx').on(t.startedAt.desc()),
    index('job_runs_org_started_idx').on(t.organizationId, t.startedAt.desc()),
  ],
);

/**
 * Sperre je Connection für die Amazon-Datenjobs (Phase 1, 1.3): höchstens ein Datenjob je Connection
 * gleichzeitig, auch über Queues hinweg (pg-boss `stately` gilt nur je Queue). Die Lease läuft ab
 * (`expires_at`), damit ein abgestürzter Halter die Connection nicht dauerhaft sperrt. Zugriffe nur
 * über `connection-leases.ts`.
 */
export const connectionJobLeases = pgTable(
  'connection_job_leases',
  {
    connectionId: uuid('connection_id').primaryKey(),
    organizationId: organizationId(),
    /** Queue des Halters, z. B. `profiles-sync`. */
    job: text('job').notNull(),
    /** `job_runs.id` des Halters (ohne FK: die Lease entsteht vor dem Lauf, siehe Worker). */
    jobRunId: uuid('job_run_id').notNull(),
    acquiredAt: timestamp('acquired_at', { withTimezone: true, mode: 'date' }).notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
  },
  (t) => [
    foreignKey({
      name: 'connection_job_leases_connection_org_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }).onDelete('cascade'),
  ],
);

export const auditEvents = pgTable(
  'audit_events',
  {
    id: id(),
    organizationId: uuid('organization_id').references(() => organizations.id, {
      onDelete: 'cascade',
    }),
    actorUserId: uuid('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** z. B. `connection.create`, `profile.update` */
    action: text('action').notNull(),
    target: jsonb('target').$type<Record<string, unknown>>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('audit_events_org_created_idx').on(t.organizationId, t.createdAt.desc())],
);

// ---------------------------------------------------------------------------
// Nutzer-Einstellungen und UI-Zustand
// ---------------------------------------------------------------------------

export const userPreferences = pgTable(
  'user_preferences',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    theme: text('theme').notNull().default('system'),
    locale: text('locale').notNull().default('de-DE'),
    density: text('density').notNull().default('comfortable'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('user_preferences_user_uq').on(t.userId)],
);

export const uiState = pgTable(
  'ui_state',
  {
    id: id(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    key: text('key').notNull(),
    value: jsonb('value').$type<unknown>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [uniqueIndex('ui_state_user_scope_key_uq').on(t.userId, t.scope, t.key)],
);
