import {
  MAX_ADVERTISED_PRODUCTS,
  MAX_PRODUCT_GROUPS_PER_ORGANIZATION,
  productGroupItemKey,
  type ProductGroupItem,
} from '@profitbash/shared';
import { and, asc, count, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { listVisibleClientsAndProfiles, visibleProfilesScope } from './access';
import { recordAuditEvent } from './audit';
import { assertPresetKnown, StructureCatalogError } from './structure-catalog';
import type { Db } from './client';
import { amazonAdsProductAds, amazonAdsProfiles, productGroupItems, productGroups } from './schema';

/**
 * Produktgruppen (`docs/tasks/phase-4.md` 4.1, F2). Eine Gruppe gehört zu einem Profil (Marktplatz); sichtbar,
 * änderbar und löschbar nur, solange der Nutzer das Profil sieht (`visibleProfilesScope()`, ADR 002). Das Recht
 * (`write` bzw. `view` im Feature `tools`) prüft die API, die Eingaben `createProductGroupRequestSchema`.
 *
 * SKU-Regel: Seller bewerben über die SKU (Pflicht), Vendoren über die ASIN (keine SKU); andere Kontoarten frei.
 */

export type ProductGroupErrorCode =
  | 'NOT_FOUND'
  | 'NAME_TAKEN'
  | 'LIMIT_REACHED'
  | 'SKU_REQUIRED'
  | 'SKU_NOT_ALLOWED'
  | 'UNKNOWN_PRESET';

export class ProductGroupError extends Error {
  constructor(
    public readonly code: ProductGroupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'ProductGroupError';
  }
}

const NAME_CONSTRAINT = 'product_groups_profile_name_uq';
const nameTaken = () =>
  new ProductGroupError(
    'NAME_TAKEN',
    'Eine Produktgruppe mit diesem Namen gibt es im Profil schon.',
  );
const notFound = () =>
  new ProductGroupError('NOT_FOUND', 'Produktgruppe oder Profil nicht gefunden.');

function isUniqueViolation(error: unknown, constraint: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === 'object'; depth++) {
    const { code, constraint_name: name } = current as {
      code?: unknown;
      constraint_name?: unknown;
    };
    if (code === '23505' && name === constraint) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

export interface ProductGroupAccessInput {
  userId: string;
  orgId: string;
}

export interface ProductGroupRecord {
  id: string;
  profileId: string;
  name: string;
  /** Preset aus dem Struktur-Katalog; `null` = Preset des Clients bzw. Standard. */
  presetKey: string | null;
  items: ProductGroupItem[];
  createdAt: Date;
  updatedAt: Date;
}

export interface ProductGroupList {
  groups: ProductGroupRecord[];
  profiles: {
    id: string;
    accountName: string;
    countryCode: string;
    accountType: string;
    clientId: string | null;
  }[];
  clients: { id: string; name: string }[];
}

const groupColumns = {
  id: productGroups.id,
  profileId: productGroups.profileId,
  name: productGroups.name,
  presetKey: productGroups.presetKey,
  createdAt: productGroups.createdAt,
  updatedAt: productGroups.updatedAt,
};

type Tx = Parameters<Parameters<Db['transaction']>[0]>[0];
type Reader = Db | Tx;

async function loadItems(db: Reader, groupIds: string[]): Promise<Map<string, ProductGroupItem[]>> {
  const items = new Map<string, ProductGroupItem[]>(groupIds.map((id) => [id, []]));
  if (groupIds.length === 0) return items;
  const rows = await db
    .select({
      groupId: productGroupItems.productGroupId,
      asin: productGroupItems.asin,
      sku: productGroupItems.sku,
      isHero: productGroupItems.isHero,
    })
    .from(productGroupItems)
    .where(inArray(productGroupItems.productGroupId, groupIds))
    .orderBy(asc(productGroupItems.productGroupId), asc(productGroupItems.position));
  for (const { groupId, ...item } of rows) items.get(groupId)?.push(item);
  return items;
}

/** Sichtbares Profil mit Kontoart; `null` für Nicht-Mitglieder, `ProductGroupError` `NOT_FOUND` für unsichtbare. */
async function visibleProfile(
  db: Reader,
  input: ProductGroupAccessInput & { profileId: string },
): Promise<{ accountType: string } | null> {
  const scope = await visibleProfilesScope(db as Db, input);
  if (scope === null) return null;
  const [profile] = await db
    .select({ accountType: amazonAdsProfiles.accountType })
    .from(amazonAdsProfiles)
    .where(and(eq(amazonAdsProfiles.id, input.profileId), inArray(amazonAdsProfiles.id, scope.ids)))
    // Kontoart und Bestand bis zum Ende der Transaktion festhalten (beim Lesen außerhalb ohne Wirkung).
    .for('share');
  if (!profile) throw notFound();
  return profile;
}

/** Prüft den Preset-Schlüssel gegen den Katalog der Organisation (`UNKNOWN_PRESET`). */
async function checkPreset(
  db: Parameters<typeof assertPresetKnown>[0],
  orgId: string,
  key: string | null,
) {
  try {
    await assertPresetKnown(db, orgId, key);
  } catch (error) {
    if (error instanceof StructureCatalogError) {
      throw new ProductGroupError('UNKNOWN_PRESET', error.message);
    }
    throw error;
  }
}

function checkSkus(accountType: string, items: readonly ProductGroupItem[]) {
  if (accountType === 'seller' && items.some((item) => item.sku === null)) {
    throw new ProductGroupError(
      'SKU_REQUIRED',
      'Seller-Profile bewerben über die SKU: SKU angeben.',
    );
  }
  if (accountType === 'vendor' && items.some((item) => item.sku !== null)) {
    throw new ProductGroupError('SKU_NOT_ALLOWED', 'Vendor-Profile haben keine SKU.');
  }
}

async function insertItems(tx: Tx, groupId: string, items: readonly ProductGroupItem[]) {
  await tx.insert(productGroupItems).values(
    items.map((item, position) => ({
      productGroupId: groupId,
      position,
      asin: item.asin,
      sku: item.sku,
      isHero: item.isHero,
    })),
  );
}

/**
 * Gruppen der sichtbaren Profile nach Name, dazu die sichtbaren Profile und ihre Clients (Auswahl der Seite).
 * `null` für Nicht-Mitglieder.
 */
export async function listProductGroups(
  db: Db,
  input: ProductGroupAccessInput,
): Promise<ProductGroupList | null> {
  const scope = await visibleProfilesScope(db, input);
  if (scope === null) return null;
  const rows = await db
    .select(groupColumns)
    .from(productGroups)
    .where(
      and(
        eq(productGroups.organizationId, input.orgId),
        inArray(productGroups.profileId, scope.ids),
      ),
    )
    .orderBy(asc(sql`lower(${productGroups.name})`), asc(productGroups.id));
  const items = await loadItems(
    db,
    rows.map((row) => row.id),
  );
  const visible = await listVisibleClientsAndProfiles(db, input);
  return {
    groups: rows.map((row) => ({ ...row, items: items.get(row.id) ?? [] })),
    profiles: visible.profiles.map(({ id, accountName, countryCode, accountType, clientId }) => ({
      id,
      accountName,
      countryCode,
      accountType,
      clientId,
    })),
    clients: visible.clients.map(({ id, name }) => ({ id, name })),
  };
}

/**
 * Legt eine Gruppe in einem sichtbaren Profil an (Audit `product_group.create`). `ProductGroupError` `NOT_FOUND`,
 * `NAME_TAKEN`, `LIMIT_REACHED` (`MAX_PRODUCT_GROUPS_PER_ORGANIZATION`), `SKU_REQUIRED`, `SKU_NOT_ALLOWED`;
 * `null` für Nicht-Mitglieder.
 */
export async function createProductGroup(
  db: Db,
  input: ProductGroupAccessInput & {
    profileId: string;
    name: string;
    items: readonly ProductGroupItem[];
    presetKey?: string | null | undefined;
  },
): Promise<ProductGroupRecord | null> {
  try {
    return await db.transaction(async (tx) => {
      // Anlegen je Organisation nacheinander: Sonst kämen zwei gleichzeitige Anfragen beide unter der Höchstzahl durch.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`product-groups:${input.orgId}`}, 0))`,
      );
      // In der Transaktion: Profil und Kontoart können sich sonst zwischen Prüfung und Anlegen ändern.
      const profile = await visibleProfile(tx, input);
      if (profile === null) return null;
      checkSkus(profile.accountType, input.items);
      await checkPreset(tx, input.orgId, input.presetKey ?? null);
      const [{ existing } = { existing: 0 }] = await tx
        .select({ existing: count() })
        .from(productGroups)
        .where(eq(productGroups.organizationId, input.orgId));
      if (existing >= MAX_PRODUCT_GROUPS_PER_ORGANIZATION) {
        throw new ProductGroupError(
          'LIMIT_REACHED',
          'Die Organisation hat schon die Höchstzahl an Produktgruppen.',
        );
      }
      const [row] = await tx
        .insert(productGroups)
        .values({
          organizationId: input.orgId,
          profileId: input.profileId,
          name: input.name,
          presetKey: input.presetKey ?? null,
          createdBy: input.userId,
        })
        .returning(groupColumns);
      await insertItems(tx, row!.id, input.items);
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'product_group.create',
        target: {
          type: 'product_group',
          id: row!.id,
          profileId: input.profileId,
          name: row!.name,
          presetKey: row!.presetKey,
          items: input.items.length,
        },
      });
      return { ...row!, items: [...input.items] };
    });
  } catch (err) {
    if (isUniqueViolation(err, NAME_CONSTRAINT)) throw nameTaken();
    throw err;
  }
}

/** Gruppe in einem sichtbaren Profil, gesperrt bis zum Ende der Transaktion; sonst `NOT_FOUND`. */
async function lockVisibleGroup(tx: Tx, input: ProductGroupAccessInput & { id: string }) {
  const scope = await visibleProfilesScope(tx as unknown as Db, input);
  if (scope === null) return null;
  const [row] = await tx
    .select({ ...groupColumns, accountType: amazonAdsProfiles.accountType })
    .from(productGroups)
    .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, productGroups.profileId))
    .where(
      and(
        eq(productGroups.id, input.id),
        eq(productGroups.organizationId, input.orgId),
        inArray(productGroups.profileId, scope.ids),
      ),
    )
    .for('update', { of: productGroups });
  if (!row) throw notFound();
  return row;
}

const sameItems = (a: readonly ProductGroupItem[], b: readonly ProductGroupItem[]) =>
  a.length === b.length &&
  a.every(
    (item, i) =>
      productGroupItemKey(item) === productGroupItemKey(b[i]!) && item.isHero === b[i]!.isHero,
  );

/**
 * Ändert den Namen und/oder ersetzt die Produkte (Audit `product_group.update` mit vorher/nachher, nur wenn sich
 * etwas ändert). `ProductGroupError` wie beim Anlegen; `null` für Nicht-Mitglieder.
 */
export async function updateProductGroup(
  db: Db,
  input: ProductGroupAccessInput & {
    id: string;
    name?: string | undefined;
    presetKey?: string | null | undefined;
    items?: readonly ProductGroupItem[] | undefined;
  },
): Promise<ProductGroupRecord | null> {
  try {
    return await db.transaction(async (tx) => {
      const locked = await lockVisibleGroup(tx, input);
      if (locked === null) return null;
      const { accountType, ...row } = locked;
      const before = {
        name: row.name,
        presetKey: row.presetKey,
        items: (await loadItems(tx, [row.id])).get(row.id) ?? [],
      };
      const name = input.name ?? before.name;
      const presetKey = input.presetKey === undefined ? before.presetKey : input.presetKey;
      if (presetKey !== before.presetKey) await checkPreset(tx, input.orgId, presetKey);
      const items = input.items ? [...input.items] : before.items;
      if (input.items) checkSkus(accountType, items);
      if (
        name === before.name &&
        presetKey === before.presetKey &&
        sameItems(items, before.items)
      ) {
        return { ...row, ...before };
      }

      const [updated] = await tx
        .update(productGroups)
        .set({ name, presetKey, updatedAt: new Date() })
        .where(eq(productGroups.id, row.id))
        .returning(groupColumns);
      if (!sameItems(items, before.items)) {
        await tx.delete(productGroupItems).where(eq(productGroupItems.productGroupId, row.id));
        await insertItems(tx, row.id, items);
      }
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'product_group.update',
        target: {
          type: 'product_group',
          id: row.id,
          profileId: row.profileId,
          before,
          after: { name, presetKey, items },
        },
      });
      return { ...updated!, items };
    });
  } catch (err) {
    if (isUniqueViolation(err, NAME_CONSTRAINT)) throw nameTaken();
    throw err;
  }
}

/** Löscht eine Gruppe samt Produkten (Audit `product_group.delete`). `true`, `NOT_FOUND`; `null` für Nicht-Mitglieder. */
export async function deleteProductGroup(
  db: Db,
  input: ProductGroupAccessInput & { id: string },
): Promise<true | null> {
  return db.transaction(async (tx) => {
    const row = await lockVisibleGroup(tx, input);
    if (row === null) return null;
    const items = (await loadItems(tx, [row.id])).get(row.id) ?? [];
    await tx.delete(productGroups).where(eq(productGroups.id, row.id));
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'product_group.delete',
      target: {
        type: 'product_group',
        id: row.id,
        profileId: row.profileId,
        name: row.name,
        items,
      },
    });
    return true as const;
  });
}

export interface AdvertisedProductRecord {
  asin: string;
  sku: string | null;
  adProducts: string[];
  enabled: boolean;
  groupIds: string[];
}

/**
 * Schon beworbene Produkte eines sichtbaren Profils (Product Ads aus Sync oder Import) je ASIN und SKU, ohne
 * entfernte Anzeigen und Platzhalter ohne ASIN; dazu die Gruppen des Profils, die das Produkt enthalten. Höchstens
 * `MAX_ADVERTISED_PRODUCTS` (`truncated`). Bei Seller-Profilen nur Anzeigen mit SKU (SKU-Regel). `NOT_FOUND` für unsichtbare Profile, `null` für Nicht-Mitglieder.
 */
export async function listAdvertisedProducts(
  db: Db,
  input: ProductGroupAccessInput & { profileId: string },
): Promise<{ products: AdvertisedProductRecord[]; truncated: boolean } | null> {
  const profile = await visibleProfile(db, input);
  if (profile === null) return null;
  const ads = amazonAdsProductAds;
  const rows = await db
    .select({
      asin: sql<string>`${ads.asin}`,
      sku: ads.sku,
      adProducts: sql<string[]>`array_agg(distinct ${ads.adProduct} order by ${ads.adProduct})`,
      enabled: sql<boolean>`bool_or(${ads.state} = 'ENABLED')`,
    })
    .from(ads)
    .where(
      and(
        eq(ads.profileId, input.profileId),
        isNotNull(ads.asin),
        isNull(ads.removedAt),
        // Seller bewerben über die SKU: Zeilen ohne SKU (SB/SD aus Reports) wären in einer Gruppe nicht speicherbar.
        profile.accountType === 'seller' ? isNotNull(ads.sku) : undefined,
      ),
    )
    .groupBy(ads.asin, ads.sku)
    .orderBy(asc(ads.asin), sql`${ads.sku} asc nulls first`)
    .limit(MAX_ADVERTISED_PRODUCTS + 1);
  const truncated = rows.length > MAX_ADVERTISED_PRODUCTS;
  const products = rows.slice(0, MAX_ADVERTISED_PRODUCTS);

  const memberships = await db
    .select({
      groupId: productGroupItems.productGroupId,
      asin: productGroupItems.asin,
      sku: productGroupItems.sku,
    })
    .from(productGroupItems)
    .innerJoin(productGroups, eq(productGroups.id, productGroupItems.productGroupId))
    .where(eq(productGroups.profileId, input.profileId))
    .orderBy(asc(productGroups.name), asc(productGroups.id));
  const groupsByProduct = new Map<string, string[]>();
  for (const { groupId, ...product } of memberships) {
    const key = productGroupItemKey(product);
    groupsByProduct.set(key, [...(groupsByProduct.get(key) ?? []), groupId]);
  }
  return {
    truncated,
    products: products.map((row) => ({
      ...row,
      enabled: row.enabled === true,
      groupIds: groupsByProduct.get(productGroupItemKey(row)) ?? [],
    })),
  };
}
