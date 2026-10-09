import { z } from 'zod';
import { presetKeySchema } from './structure-catalog';

/**
 * Produktgruppen (`docs/tasks/phase-4.md` 4.1, F2): beworbene Einheiten eines Profils (Marktplatz) aus ASIN und SKU,
 * ein Produkt als Hero markierbar. Auswahl aus den schon beworbenen Produkten des Profils oder von Hand. Der Client
 * kommt über das Profil (keine eigene Spalte, damit nichts auseinanderläuft).
 */

export const MAX_PRODUCT_GROUP_NAME_LENGTH = 80;
export const MAX_PRODUCT_GROUP_ITEMS = 100;
export const MAX_PRODUCT_GROUPS_PER_ORGANIZATION = 2000;
/** Längste SKU, die Amazon in der Werbekonsole annimmt. */
export const MAX_SKU_LENGTH = 40;
/** Höchstzahl der beworbenen Produkte in der Auswahl je Profil. */
export const MAX_ADVERTISED_PRODUCTS = 5000;

/** Ränder weg, Leerraum zusammengefasst, Unicode NFC; die Schreibung bleibt (eindeutig ohne Groß/Klein). */
export function normalizeProductGroupName(name: string): string {
  return name.normalize('NFC').split(/\s+/u).filter(Boolean).join(' ');
}

export const asinSchema = z
  .string()
  .transform((asin) => asin.trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z0-9]{10}$/));

/** SKUs unterscheiden Groß und Klein; nur die Ränder fallen weg. Leer heißt „keine SKU“ (Vendor). */
const skuSchema = z
  .string()
  .transform((sku) => sku.trim())
  .pipe(z.string().max(MAX_SKU_LENGTH))
  .transform((sku) => (sku === '' ? null : sku))
  .nullish()
  .transform((sku) => sku ?? null);

const nameSchema = z
  .string()
  .transform(normalizeProductGroupName)
  .pipe(z.string().min(1).max(MAX_PRODUCT_GROUP_NAME_LENGTH));

export const productGroupItemSchema = z
  .strictObject({
    asin: asinSchema,
    sku: skuSchema,
    isHero: z.boolean().default(false),
  })
  .meta({ id: 'ProductGroupItemInput' });
export type ProductGroupItemInput = z.input<typeof productGroupItemSchema>;
export type ProductGroupItem = z.output<typeof productGroupItemSchema>;

/** Schlüssel eines Produkts in der Gruppe (ASIN und SKU). */
export const productGroupItemKey = (item: { asin: string; sku: string | null }) =>
  `${item.asin}\u0000${item.sku ?? ''}`;

const itemsSchema = z
  .array(productGroupItemSchema)
  .min(1)
  .max(MAX_PRODUCT_GROUP_ITEMS)
  .refine((items) => items.filter((item) => item.isHero).length <= 1, {
    message: 'Höchstens ein Hero je Gruppe',
  })
  .refine((items) => new Set(items.map(productGroupItemKey)).size === items.length, {
    message: 'Jedes Produkt (ASIN und SKU) nur einmal',
  });

export const createProductGroupRequestSchema = z
  .strictObject({
    profileId: z.uuid(),
    name: nameSchema,
    items: itemsSchema,
    /** Preset aus dem Struktur-Katalog (4.2); leer = Preset des Clients bzw. Standard. */
    presetKey: presetKeySchema.nullable().optional(),
  })
  .meta({ id: 'CreateProductGroupRequest' });
export type CreateProductGroupRequest = z.output<typeof createProductGroupRequestSchema>;

export const updateProductGroupRequestSchema = z
  .strictObject({
    name: nameSchema.optional(),
    items: itemsSchema.optional(),
    presetKey: presetKeySchema.nullable().optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.items !== undefined || body.presetKey !== undefined,
    { message: 'Name, Produkte oder Preset angeben' },
  )
  .meta({ id: 'UpdateProductGroupRequest' });
export type UpdateProductGroupRequest = z.output<typeof updateProductGroupRequestSchema>;

export const productGroupSchema = z
  .object({
    id: z.uuid(),
    profileId: z.uuid(),
    name: z.string(),
    presetKey: z.string().nullable(),
    items: z.array(z.object({ asin: z.string(), sku: z.string().nullable(), isHero: z.boolean() })),
    createdAt: z.string(),
    updatedAt: z.string(),
  })
  .meta({ id: 'ProductGroup' });
export type ProductGroup = z.infer<typeof productGroupSchema>;

/** Sichtbare Profile und ihre Clients, damit die Seite ohne weitere Abfrage auswählen und gruppieren kann. */
export const productGroupListResponseSchema = z
  .object({
    groups: z.array(productGroupSchema),
    profiles: z.array(
      z.object({
        id: z.uuid(),
        accountName: z.string(),
        countryCode: z.string(),
        accountType: z.string(),
        clientId: z.uuid().nullable(),
      }),
    ),
    clients: z.array(z.object({ id: z.uuid(), name: z.string() })),
    maxGroups: z.number().int(),
    maxItems: z.number().int(),
  })
  .meta({ id: 'ProductGroupListResponse' });
export type ProductGroupListResponse = z.infer<typeof productGroupListResponseSchema>;

export const advertisedProductSchema = z
  .object({
    asin: z.string(),
    sku: z.string().nullable(),
    /** Anzeigentypen, in denen das Produkt beworben wird (`SPONSORED_PRODUCTS` …). */
    adProducts: z.array(z.string()),
    /** Mindestens eine aktive Anzeige. */
    enabled: z.boolean(),
    /** Gruppen dieses Profils, in denen das Produkt schon steckt. */
    groupIds: z.array(z.uuid()),
  })
  .meta({ id: 'AdvertisedProduct' });
export type AdvertisedProduct = z.infer<typeof advertisedProductSchema>;

export const advertisedProductsResponseSchema = z
  .object({ products: z.array(advertisedProductSchema), truncated: z.boolean() })
  .meta({ id: 'AdvertisedProductsResponse' });
export type AdvertisedProductsResponse = z.infer<typeof advertisedProductsResponseSchema>;
