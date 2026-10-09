import { z } from 'zod';

/**
 * Eigene Tags (`docs/tasks/phase-3.md` 3.7, F7): je Organisation, mit Name und Farbe, für Kampagnen, Ad Groups,
 * Targets und Product Ads. Getrennt von den Tags, die Amazon an Kampagnen kennt (die werden nur angezeigt).
 */

/** Feste Palette aus den Design-Tokens (Dominik, 2026-10-09: kein freier Farbwähler). */
export const TAG_COLORS = ['violet', 'lime', 'amber', 'red', 'ink', 'grey'] as const;
export type TagColor = (typeof TAG_COLORS)[number];

export const TAG_ENTITY_TYPES = ['campaign', 'ad_group', 'target', 'product_ad'] as const;
export type TagEntityType = (typeof TAG_ENTITY_TYPES)[number];

export const MAX_TAG_NAME_LENGTH = 40;
export const MAX_TAGS_PER_ORGANIZATION = 200;
/** Entities je Anfrage (Body-Limit 64 KB); die Oberfläche schickt eine größere Markierung in Stücken. */
export const MAX_TAG_ASSIGN_ENTITIES = 1000;
export const MAX_TAG_ASSIGN_TAGS = 50;
/** Tags in der Filterleiste (`analyticsSelectionSchema.tagIds`). */
export const MAX_TAG_FILTER_IDS = 50;

/** Ränder weg, Leerraum zusammengefasst, Unicode NFC; die Schreibung bleibt (eindeutig ohne Groß/Klein). */
export function normalizeTagName(name: string): string {
  return name.normalize('NFC').split(/\s+/u).filter(Boolean).join(' ');
}

const tagNameSchema = z
  .string()
  .transform(normalizeTagName)
  .pipe(z.string().min(1).max(MAX_TAG_NAME_LENGTH));

export const tagColorSchema = z.enum(TAG_COLORS);

export const tagSchema = z
  .object({
    id: z.uuid(),
    name: z.string(),
    color: tagColorSchema,
    /** Zuweisungen in den sichtbaren Profilen, je Art der Entity. */
    counts: z.object({
      campaign: z.number().int(),
      ad_group: z.number().int(),
      target: z.number().int(),
      product_ad: z.number().int(),
    }),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'Tag' });
export type Tag = z.infer<typeof tagSchema>;

export const tagListResponseSchema = z
  .object({ tags: z.array(tagSchema), maxTags: z.number().int() })
  .meta({ id: 'TagListResponse' });
export type TagListResponse = z.infer<typeof tagListResponseSchema>;

export const createTagRequestSchema = z
  .strictObject({ name: tagNameSchema, color: tagColorSchema })
  .meta({ id: 'CreateTagRequest' });

export const updateTagRequestSchema = z
  .strictObject({ name: tagNameSchema.optional(), color: tagColorSchema.optional() })
  .refine((body) => body.name !== undefined || body.color !== undefined, {
    message: 'Name oder Farbe angeben',
  })
  .meta({ id: 'UpdateTagRequest' });

const tagIds = z.array(z.uuid()).max(MAX_TAG_ASSIGN_TAGS);

/** Tags an Entities einer Art hängen und von ihnen lösen (viele IDs, deshalb im Body). */
export const assignTagsRequestSchema = z
  .strictObject({
    entityType: z.enum(TAG_ENTITY_TYPES),
    /** Interne IDs der Entities. */
    entityIds: z.array(z.uuid()).min(1).max(MAX_TAG_ASSIGN_ENTITIES),
    addTagIds: tagIds.optional(),
    removeTagIds: tagIds.optional(),
  })
  .refine((body) => (body.addTagIds?.length ?? 0) + (body.removeTagIds?.length ?? 0) > 0, {
    message: 'Mindestens ein Tag angeben',
  })
  .meta({ id: 'AssignTagsRequest' });

export const assignTagsResponseSchema = z
  .object({
    /** Neue Zuweisungen bzw. gelöste (schon vorhandene bzw. nicht vorhandene zählen nicht). */
    added: z.number().int(),
    removed: z.number().int(),
    /** Genannte Entities, die es nicht gibt oder die der Nutzer nicht sieht. */
    skippedEntities: z.number().int(),
  })
  .meta({ id: 'AssignTagsResponse' });
export type AssignTagsResponse = z.infer<typeof assignTagsResponseSchema>;
