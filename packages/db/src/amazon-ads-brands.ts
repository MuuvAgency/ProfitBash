import { and, asc, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { canSeeProfile } from './access';
import type { DbOrTx } from './audit';
import type { Db } from './client';
import type { EntityWriteScope } from './amazon-ads-entities';
import { amazonAdsBrands } from './schema';

/**
 * Marken eines Profils für Sponsored Brands (`docs/tasks/phase-4.md` 4.10): Der Bulk-Import liest sie aus dem Blatt
 * „Brand Assets Data“ (`Brand Entity ID`, `Brand Name`), der Assistent bietet sie zur Auswahl an. Die
 * `brandEntityId` braucht nur ein Seller; Vendoren lassen sie leer.
 */

export interface ProfileBrand {
  brandEntityId: string;
  name: string | null;
}

/**
 * Ersetzt die Marken des Profils durch die der Datei (in der Transaktion des Imports): neue anlegen, Namen
 * nachziehen, fehlende als entfernt markieren, wieder auftauchende zurückholen.
 */
export async function replaceProfileBrands(
  tx: DbOrTx,
  scope: EntityWriteScope,
  brands: readonly ProfileBrand[],
): Promise<void> {
  const unique = new Map(brands.map((brand) => [brand.brandEntityId, brand]));
  const ids = [...unique.keys()];
  if (ids.length > 0) {
    await tx
      .insert(amazonAdsBrands)
      .values(
        [...unique.values()].map((brand) => ({
          organizationId: scope.organizationId,
          profileId: scope.profileId,
          brandEntityId: brand.brandEntityId,
          name: brand.name,
        })),
      )
      .onConflictDoUpdate({
        target: [amazonAdsBrands.profileId, amazonAdsBrands.brandEntityId],
        set: { name: sql`excluded.name`, removedAt: null, updatedAt: scope.now },
      });
  }
  await tx
    .update(amazonAdsBrands)
    .set({ removedAt: scope.now, updatedAt: scope.now })
    .where(
      and(
        eq(amazonAdsBrands.profileId, scope.profileId),
        isNull(amazonAdsBrands.removedAt),
        ...(ids.length > 0 ? [notInArray(amazonAdsBrands.brandEntityId, ids)] : []),
      ),
    );
}

/** Nicht entfernte Marken eines sichtbaren Profils nach Name; `null` für Nicht-Mitglieder und unsichtbare Profile. */
export async function listProfileBrands(
  db: Db,
  input: { userId: string; orgId: string; profileId: string },
): Promise<ProfileBrand[] | null> {
  if (!(await canSeeProfile(db, input))) return null;
  return db
    .select({ brandEntityId: amazonAdsBrands.brandEntityId, name: amazonAdsBrands.name })
    .from(amazonAdsBrands)
    .where(and(eq(amazonAdsBrands.profileId, input.profileId), isNull(amazonAdsBrands.removedAt)))
    .orderBy(asc(sql`lower(${amazonAdsBrands.name})`), asc(amazonAdsBrands.brandEntityId));
}
