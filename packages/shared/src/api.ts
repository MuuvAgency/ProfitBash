import { z } from 'zod';
import { FEATURE_KEYS } from './features';
import { ORG_ROLES, PLATFORM_ROLES } from './roles';

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
    features: z.record(z.enum(FEATURE_KEYS), featureAccessSchema),
    preferences: settingsSchema,
  })
  .meta({ id: 'Me' });
export type MeResponse = z.infer<typeof meResponseSchema>;
