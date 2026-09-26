import { z } from 'zod';
import { FEATURE_KEYS, type FeatureKey } from './features';
import { ORG_ROLES, PLATFORM_ROLES } from './roles';
import { isSlug, SLUG_MAX_LENGTH } from './slug';

/**
 * zod-Schemas der eigenen API (`/api/*` außer `/api/auth/*`). Die API validiert damit Ein- und
 * Ausgaben und erzeugt daraus `/api/openapi.json`; das Web nutzt dieselben Typen.
 * `.meta({ id })` benennt das Schema als Komponente im OpenAPI-Dokument.
 */

// ---------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------

export const errorResponseSchema = z
  .object({
    error: z.object({
      /** Maschinenlesbarer Code, z. B. `UNAUTHORIZED`, `VALIDATION_ERROR`. */
      code: z.string(),
      message: z.string(),
    }),
  })
  .meta({ id: 'ErrorResponse' });
export type ErrorResponse = z.infer<typeof errorResponseSchema>;

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export const healthResponseSchema = z
  .object({
    status: z.enum(['ok', 'error']),
    db: z.enum(['ok', 'error']),
    version: z.string(),
  })
  .meta({ id: 'HealthResponse' });
export type HealthResponse = z.infer<typeof healthResponseSchema>;

// ---------------------------------------------------------------------------
// Einstellungen
// ---------------------------------------------------------------------------

export const THEMES = ['system', 'light', 'dark'] as const;
export type Theme = (typeof THEMES)[number];

/** Locales für Zahlen-, Währungs- und Datumsformat. Die UI-Sprache bleibt davon unberührt. */
export const LOCALES = ['de-DE', 'en-GB', 'en-US'] as const;
export type Locale = (typeof LOCALES)[number];

export const DENSITIES = ['comfortable', 'compact'] as const;
export type Density = (typeof DENSITIES)[number];

export const settingsSchema = z
  .object({
    theme: z.enum(THEMES),
    locale: z.enum(LOCALES),
    density: z.enum(DENSITIES),
  })
  .meta({ id: 'Settings' });
export type Settings = z.infer<typeof settingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  locale: 'de-DE',
  density: 'comfortable',
};

// ---------------------------------------------------------------------------
// UI-Zustand (Spaltenbreiten, Filter, eingeklappte Bereiche …)
// ---------------------------------------------------------------------------

const uiStateIdentifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/, {
  message: '1–64 Zeichen: Buchstaben, Ziffern, Punkt, Doppelpunkt, Binde- oder Unterstrich',
});

export const uiStateParamsSchema = z.object({ scope: uiStateIdentifier, key: uiStateIdentifier });

export const UI_STATE_MAX_BYTES = 16 * 1024;

/**
 * Beliebiger JSON-Wert. Bewusst `z.unknown()` statt `z.json()`: Das rekursive `z.json()` lässt sich
 * nicht in OpenAPI übersetzen, und Request-Bodies stammen ohnehin aus `JSON.parse`.
 */
const jsonValue = z.unknown().meta({ description: 'Beliebiger JSON-Wert' });

export const uiStatePutSchema = z
  .object({
    value: jsonValue
      .refine((value) => value !== undefined && value !== null, {
        message: 'fehlt oder ist null',
      })
      .refine(
        (value) => new TextEncoder().encode(JSON.stringify(value)).length <= UI_STATE_MAX_BYTES,
        { message: `höchstens ${UI_STATE_MAX_BYTES / 1024} KB` },
      ),
  })
  .meta({ id: 'UiStatePut' });

export const uiStateResponseSchema = z
  .object({
    /** `null`, wenn für diesen Key noch nichts gespeichert ist. */
    value: jsonValue,
  })
  .meta({ id: 'UiState' });

// ---------------------------------------------------------------------------
// /api/me
// ---------------------------------------------------------------------------

const featureAccessSchema = z.object({
  view: z.boolean(),
  write: z.boolean(),
  entitled: z.boolean(),
});

/**
 * Alle Feature-Keys als Pflichtfelder. Bewusst `z.object` statt `z.record(z.enum(…))`:
 * Die Record-Variante verliert bei der Übersetzung nach OpenAPI die Pflichtangabe, und der
 * generierte Client müsste jeden Key als optional behandeln.
 */
const featuresSchema = z.object(
  Object.fromEntries(FEATURE_KEYS.map((key) => [key, featureAccessSchema])) as Record<
    FeatureKey,
    typeof featureAccessSchema
  >,
);

export const meResponseSchema = z
  .object({
    user: z.object({
      id: z.string(),
      email: z.string(),
      name: z.string(),
      /** Plattform-Rolle (`superadmin` = Muuv-intern). */
      role: z.enum(PLATFORM_ROLES),
    }),
    organizations: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        type: z.string(),
        role: z.enum(ORG_ROLES),
      }),
    ),
    /** `null`, wenn der Nutzer keiner Organisation angehört. */
    activeOrganizationId: z.string().nullable(),
    /** Rechte je Feature-Key in der aktiven Organisation. */
    features: featuresSchema,
    preferences: settingsSchema,
  })
  .meta({ id: 'Me' });
export type MeResponse = z.infer<typeof meResponseSchema>;

// ---------------------------------------------------------------------------
// Gemeinsame Bausteine
// ---------------------------------------------------------------------------

/** Pfad-Parameter `{id}` (interne UUID). */
export const idParamSchema = z.object({ id: z.uuid() });

const timestamp = z.iso.datetime();

// ---------------------------------------------------------------------------
// Amazon-OAuth
// ---------------------------------------------------------------------------

export const CONNECTION_REGIONS = ['eu', 'na', 'fe'] as const;
export type ConnectionRegion = (typeof CONNECTION_REGIONS)[number];

export const amazonOAuthStartSchema = z
  .object({
    /** Standard `eu`. Bei `connectionId` gilt die Region der Connection. */
    region: z.enum(CONNECTION_REGIONS).optional(),
    /** „Neu verbinden“: bestehende Connection der aktiven Organisation. */
    connectionId: z.uuid().optional(),
  })
  .meta({ id: 'AmazonOAuthStart' });
export type AmazonOAuthStart = z.infer<typeof amazonOAuthStartSchema>;

export const amazonOAuthRedirectSchema = z
  .object({
    /** Einwilligungsseite von Amazon (bzw. des Mocks). Der Browser navigiert dorthin. */
    url: z.string(),
  })
  .meta({ id: 'AmazonOAuthRedirect' });

/**
 * Simulierte Einwilligungsseite (nur bei `AMAZON_ADS_USE_MOCK=true`). API und Worker bauen daraus die
 * Authorize-URL des Mock-Clients.
 */
export const AMAZON_ADS_MOCK_CONSENT_PATH = '/api/amazon/oauth/mock-consent';

/**
 * Ergebnis des OAuth-Callbacks. Die API leitet auf `/admin/connections?oauth=<Ergebnis>` zurück,
 * die Seite zeigt es als Hinweis an.
 */
export const AMAZON_OAUTH_RESULTS = [
  'connected',
  /** Verbunden, aber der Profil-Sync ließ sich nicht einplanen („Jetzt synchronisieren“ nutzen). */
  'connected_sync_failed',
  /** Einwilligung bei Amazon abgelehnt. */
  'access_denied',
  'invalid_state',
  'state_expired',
  'state_used',
  /** Keine oder eine andere Session als beim Start. */
  'session_mismatch',
  /** Nicht (mehr) Admin der Organisation. */
  'forbidden',
  'connection_not_found',
  /** Beim Neu-Verbinden mit einem anderen Amazon-Konto angemeldet. */
  'account_mismatch',
  'amazon_error',
  /** Unerwarteter Fehler in der App (Details im Server-Log unter der Request-ID). */
  'internal_error',
] as const;
export type AmazonOAuthResult = (typeof AMAZON_OAUTH_RESULTS)[number];

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export const CONNECTION_STATUSES = ['active', 'reauth_required', 'error'] as const;

export const connectionSchema = z
  .object({
    id: z.uuid(),
    provider: z.enum(['amazon_ads']),
    region: z.enum(CONNECTION_REGIONS).nullable(),
    /** Amazon: LWA-User-ID des verbundenen Kontos. */
    externalAccountId: z.string(),
    externalAccountEmail: z.string().nullable(),
    status: z.enum(CONNECTION_STATUSES),
    lastRefreshedAt: timestamp.nullable(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'Connection' });
export type Connection = z.infer<typeof connectionSchema>;

export const connectionListSchema = z
  .object({ connections: z.array(connectionSchema) })
  .meta({ id: 'ConnectionList' });

export const syncQueuedSchema = z
  .object({ status: z.literal('queued') })
  .meta({ id: 'SyncQueued' });

// ---------------------------------------------------------------------------
// Amazon-Ads-Profile
// ---------------------------------------------------------------------------

export const profileSchema = z
  .object({
    /** Interne ID (`profileId`). */
    id: z.uuid(),
    connectionId: z.uuid(),
    clientId: z.uuid().nullable(),
    /** Amazons Profil-ID, immer als String. */
    amazonProfileId: z.string(),
    amazonAccountId: z.string().nullable(),
    accountName: z.string(),
    countryCode: z.string(),
    currencyCode: z.string(),
    timezone: z.string(),
    marketplaceId: z.string().nullable(),
    /** `seller` | `vendor` | `agency` oder ein neuer Amazon-Wert. */
    accountType: z.string(),
    isHidden: z.boolean(),
    /** Gesetzt, wenn Amazon das Profil nicht mehr liefert. */
    removedAt: timestamp.nullable(),
    syncedAt: timestamp.nullable(),
  })
  .meta({ id: 'Profile' });
export type Profile = z.infer<typeof profileSchema>;

export const profileListSchema = z
  .object({ profiles: z.array(profileSchema) })
  .meta({ id: 'ProfileList' });

export const profilePatchSchema = z
  .strictObject({
    /** Client derselben Organisation oder `null` (Zuordnung lösen). */
    clientId: z.uuid().nullable().optional(),
    isHidden: z.boolean().optional(),
  })
  .refine((patch) => patch.clientId !== undefined || patch.isHidden !== undefined, {
    message: 'mindestens clientId oder isHidden angeben',
  })
  .meta({ id: 'ProfilePatch' });
export type ProfilePatch = z.infer<typeof profilePatchSchema>;

// ---------------------------------------------------------------------------
// Clients
// ---------------------------------------------------------------------------

const clientName = z.string().trim().min(1).max(120);
const clientSlug = z.string().max(SLUG_MAX_LENGTH).refine(isSlug, {
  message: 'nur Kleinbuchstaben, Ziffern und einzelne Bindestriche',
});

export const clientSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    slug: z.string(),
    createdAt: timestamp,
    updatedAt: timestamp,
  })
  .meta({ id: 'Client' });
export type Client = z.infer<typeof clientSchema>;

export const clientListSchema = z
  .object({ clients: z.array(clientSchema) })
  .meta({ id: 'ClientList' });

export const clientCreateSchema = z
  .strictObject({
    name: clientName,
    /** Standard: aus dem Namen gebildet (`slugify`). */
    slug: clientSlug.optional(),
  })
  .meta({ id: 'ClientCreate' });

export const clientPatchSchema = z
  .strictObject({ name: clientName.optional(), slug: clientSlug.optional() })
  .refine((patch) => patch.name !== undefined || patch.slug !== undefined, {
    message: 'mindestens name oder slug angeben',
  })
  .meta({ id: 'ClientPatch' });

// ---------------------------------------------------------------------------
// Sync-Status (Jobläufe)
// ---------------------------------------------------------------------------

/**
 * Jobs je Connection (Worker-Queues). Nur ihre Läufe gehören einer Organisation; Cron-Auslöser und
 * Cleanup laufen plattformweit (`organization_id` null) und fehlen in der Org-Sicht.
 */
export const CONNECTION_JOB_NAMES = ['token-refresh', 'profiles-sync'] as const;
export type ConnectionJobName = (typeof CONNECTION_JOB_NAMES)[number];

export const JOB_RUN_STATUSES = ['running', 'success', 'failed'] as const;
export type JobRunStatus = (typeof JOB_RUN_STATUSES)[number];

/** So viele Läufe zeigt der Sync-Status höchstens (die neuesten). */
export const JOB_RUN_LIST_LIMIT = 100;

/** Filter als Query-Parameter (je ein Enum-Wert). */
export const jobRunListQuerySchema = z.object({
  job: z.enum(CONNECTION_JOB_NAMES).optional(),
  status: z.enum(JOB_RUN_STATUSES).optional(),
});
export type JobRunListQuery = z.infer<typeof jobRunListQuerySchema>;

export const jobRunSchema = z
  .object({
    id: z.uuid(),
    /** Name des Jobs; neue Jobs erscheinen unverändert. */
    job: z.string(),
    /** Worauf sich der Lauf bezieht, bei Connection-Jobs die Connection-ID. */
    scope: z.string().nullable(),
    /** Connection der Organisation, auf die `scope` zeigt, sonst `null`. */
    connection: z
      .object({
        id: z.uuid(),
        externalAccountId: z.string(),
        externalAccountEmail: z.string().nullable(),
      })
      .nullable(),
    status: z.enum(JOB_RUN_STATUSES),
    startedAt: timestamp,
    finishedAt: timestamp.nullable(),
    /** Für die Anzeige gedachter Fehlertext (ohne Secrets, gekürzt). */
    error: z.string().nullable(),
    /** Zähler des Laufs, z. B. `profiles`, `created`, `removed`. */
    counters: z.record(z.string(), z.number()),
  })
  .meta({ id: 'JobRun' });
export type JobRun = z.infer<typeof jobRunSchema>;

export const jobRunListSchema = z
  .object({ jobRuns: z.array(jobRunSchema) })
  .meta({ id: 'JobRunList' });
