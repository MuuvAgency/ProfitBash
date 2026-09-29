import { z } from 'zod';
import {
  adProductSchema,
  attributionSettingSchema,
  COMPARISON_MODES,
  PERIOD_PRESETS,
} from './analytics';
import {
  CHANGE_KEYS,
  dateRangeSchema,
  displayCurrencySchema,
  EXPLORER_LEVELS,
} from './analytics-api';

/**
 * Gespeicherte Ansichten (`docs/tasks/phase-2.md` F8, 2.9): Zustand der Filterleiste und im Explorer zusätzlich Ebene,
 * Drill-Down, Spalten, Sortierung und Chart-Kennzahlen. Persönlich oder für die Organisation freigegeben. Beim Laden
 * filtert der Server die genannten Clients, Profile und Drill-Down-IDs über den Access-Layer (ADR 002).
 */

export const SAVED_VIEW_AREAS = ['dashboard', 'explorer'] as const;
export type SavedViewArea = (typeof SAVED_VIEW_AREAS)[number];
export const savedViewAreaSchema = z.enum(SAVED_VIEW_AREAS);

export const MAX_SAVED_VIEW_NAME_LENGTH = 80;
/** Höchstzahl eigener Ansichten je Bereich (Schutz vor Missbrauch, nicht als Arbeitsgrenze gedacht). */
export const MAX_SAVED_VIEWS_PER_OWNER = 200;

const orNull = <T extends z.ZodType>(schema: T) => z.union([schema, z.null()]);
const uuid = z.uuid();
/** Spalten-IDs des Explorers (`apps/web/src/explorer/columns.ts`), nur als Form geprüft. */
const columnId = z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,39}$/);

export const savedViewFiltersSchema = z
  .object({
    clientIds: z.array(uuid).max(500),
    withoutClient: z.boolean(),
    /** `null` = alle Profile der gewählten Clients. */
    profileIds: orNull(z.array(uuid).max(1000)),
    period: z
      .object({ preset: z.enum(PERIOD_PRESETS), range: dateRangeSchema.optional() })
      .refine((p) => (p.preset === 'custom') === (p.range !== undefined), {
        message: '`range` genau bei `custom`',
      }),
    comparison: z.enum(COMPARISON_MODES),
    currency: displayCurrencySchema,
    attribution: attributionSettingSchema,
  })
  .meta({ id: 'SavedViewFilters' });
export type SavedViewFilters = z.infer<typeof savedViewFiltersSchema>;

export const savedViewExplorerSchema = z
  .object({
    level: z.enum(EXPLORER_LEVELS),
    drill: z.object({
      portfolioId: orNull(uuid),
      campaignId: orNull(uuid),
      adGroupId: orNull(uuid),
    }),
    includeRemoved: z.boolean(),
    /** Leer = alle Ad-Typen. */
    adProducts: z.array(adProductSchema).max(3),
    // Array statt Tupel: OpenAPI-Typen kennen keine Tupel (Web und Server hätten sonst verschiedene Typen).
    chartMetrics: z.array(z.enum(CHANGE_KEYS)).length(2),
    /** Sichtbare Spalten der Ebene; `null` = Standard. */
    columns: orNull(z.array(columnId).max(80)),
    /** `null` = Standard (Spend absteigend vom Server). */
    sort: orNull(z.object({ column: columnId, direction: z.enum(['asc', 'desc']) })),
  })
  .meta({ id: 'SavedViewExplorer' });
export type SavedViewExplorer = z.infer<typeof savedViewExplorerSchema>;

export const savedViewStateSchema = z
  .object({ filters: savedViewFiltersSchema, explorer: savedViewExplorerSchema.optional() })
  .meta({ id: 'SavedViewState' });
export type SavedViewState = z.infer<typeof savedViewStateSchema>;

const nameSchema = z.string().trim().min(1).max(MAX_SAVED_VIEW_NAME_LENGTH);

/** Der Explorer-Teil gehört genau zum Bereich `explorer`. */
export function stateMatchesArea(area: SavedViewArea, state: SavedViewState): boolean {
  return (area === 'explorer') === (state.explorer !== undefined);
}

export const savedViewCreateSchema = z
  .object({
    name: nameSchema,
    area: savedViewAreaSchema,
    /** Für die Organisation freigeben (nur Rollen mit Schreibrecht). Standard nein. */
    shared: z.boolean().optional(),
    state: savedViewStateSchema,
  })
  .refine((v) => stateMatchesArea(v.area, v.state), {
    message: 'state.explorer genau im Bereich „explorer“',
    path: ['state'],
  })
  .meta({ id: 'SavedViewCreate' });

export const savedViewPatchSchema = z
  .object({
    name: nameSchema.optional(),
    shared: z.boolean().optional(),
    /** Aktuellen Zustand übernehmen („Ansicht aktualisieren“). */
    state: savedViewStateSchema.optional(),
  })
  .refine((v) => Object.values(v).some((value) => value !== undefined), {
    message: 'Mindestens ein Feld angeben',
  })
  .meta({ id: 'SavedViewPatch' });

export const savedViewListQuerySchema = z.object({ area: savedViewAreaSchema });

export const savedViewSchema = z
  .object({
    id: uuid,
    name: z.string(),
    area: savedViewAreaSchema,
    shared: z.boolean(),
    owner: z.object({ id: uuid, name: z.string() }),
    /** Eigene Ansicht des angemeldeten Nutzers. */
    own: z.boolean(),
    /** Umbenennen, Zustand übernehmen, löschen (Besitzer und Org-Admins). */
    canEdit: z.boolean(),
    /** Freigeben (Schreibrecht im Feature des Bereichs, dazu `canEdit`). */
    canShare: z.boolean(),
    /** Unsichtbare Clients, Profile und Drill-Down-IDs sind bereits entfernt. */
    state: savedViewStateSchema,
    /** Anzahl entfernter Clients, Profile und Drill-Down-IDs, die der Nutzer nicht (mehr) sieht. */
    hiddenItems: z.number().int().min(0),
    createdAt: z.iso.datetime(),
    updatedAt: z.iso.datetime(),
  })
  .meta({ id: 'SavedView' });
export type SavedView = z.infer<typeof savedViewSchema>;

export const savedViewListSchema = z
  .object({ views: z.array(savedViewSchema) })
  .meta({ id: 'SavedViewList' });
