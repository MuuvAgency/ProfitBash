import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
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
export const amazonAccountType = pgEnum('amazon_account_type', ['seller', 'vendor', 'agency']);
export const jobRunStatus = pgEnum('job_run_status', ['running', 'success', 'failed']);

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
  (t) => [uniqueIndex('clients_org_slug_uq').on(t.organizationId, t.slug)],
);

// ---------------------------------------------------------------------------
// Connections: OAuth-Verbindungen zu externen APIs
// ---------------------------------------------------------------------------

export const connections = pgTable(
  'connections',
  {
    id: id(),
    organizationId: organizationId(),
    provider: connectionProvider('provider').notNull(),
    region: connectionRegion('region').notNull(),
    amazonAccountEmail: text('amazon_account_email'),
    /** Verschlüsselt mit packages/shared crypto (Format v1:<iv>:<tag>:<cipher>). Nie im Klartext. */
    refreshTokenEncrypted: text('refresh_token_encrypted').notNull(),
    status: connectionStatus('status').notNull().default('active'),
    lastRefreshedAt: timestamp('last_refreshed_at', { withTimezone: true, mode: 'date' }),
    createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('connections_org_idx').on(t.organizationId)],
);

// ---------------------------------------------------------------------------
// Amazon-Ads-Profile (je Marktplatz ein Profil)
// ---------------------------------------------------------------------------

export const amazonAdsProfiles = pgTable(
  'amazon_ads_profiles',
  {
    id: id(),
    organizationId: organizationId(),
    connectionId: uuid('connection_id')
      .notNull()
      .references(() => connections.id, { onDelete: 'cascade' }),
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    /** Amazon-Profil-ID. Immer Text, weil die Zahl JavaScripts sichere Ganzzahlgrenze überschreiten kann. */
    profileId: text('profile_id').notNull(),
    accountName: text('account_name').notNull(),
    countryCode: text('country_code').notNull(),
    currencyCode: text('currency_code').notNull(),
    timezone: text('timezone').notNull(),
    marketplaceId: text('marketplace_id'),
    accountType: amazonAccountType('account_type').notNull(),
    /** Vom Nutzer ausgeblendet. */
    isHidden: boolean('is_hidden').notNull().default(false),
    /** Amazon liefert das Profil nicht mehr. Wird beim erneuten Auftauchen zurückgesetzt. */
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('amazon_ads_profiles_connection_profile_uq').on(t.connectionId, t.profileId),
    index('amazon_ads_profiles_org_idx').on(t.organizationId),
    index('amazon_ads_profiles_client_idx').on(t.clientId),
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
