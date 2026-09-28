import { and, count, eq, isNull } from 'drizzle-orm';
import type { DbOrTx } from './audit';
import { amazonAdsBackfills, amazonAdsProfiles } from './schema';

/**
 * Merker der Historie (F4, Phase 1, 1.7). Systemzugriff des Workers ohne Nutzerkontext, an die
 * Organisation gebunden.
 */

export type AmazonAdsBackfill = typeof amazonAdsBackfills.$inferSelect;

/**
 * Liefert den Merker für Profil, Ad-Typ und Report-Typ und legt ihn beim ersten Aufruf mit `fromDate`
 * an. Ein vorhandener Merker bleibt unverändert (sein Beginn ist fest).
 */
export async function ensureBackfill(
  db: DbOrTx,
  input: {
    organizationId: string;
    profileId: string;
    adProduct: string;
    reportType: string;
    fromDate: string;
  },
): Promise<AmazonAdsBackfill> {
  await db.insert(amazonAdsBackfills).values(input).onConflictDoNothing();
  const [row] = await db
    .select()
    .from(amazonAdsBackfills)
    .where(
      and(
        eq(amazonAdsBackfills.organizationId, input.organizationId),
        eq(amazonAdsBackfills.profileId, input.profileId),
        eq(amazonAdsBackfills.adProduct, input.adProduct),
        eq(amazonAdsBackfills.reportType, input.reportType),
      ),
    );
  if (!row) throw new Error('Merker der Historie fehlt.');
  return row;
}

export async function completeBackfill(
  db: DbOrTx,
  input: { organizationId: string; id: string; now: Date },
): Promise<void> {
  await db
    .update(amazonAdsBackfills)
    .set({ completedAt: input.now })
    .where(
      and(
        eq(amazonAdsBackfills.id, input.id),
        eq(amazonAdsBackfills.organizationId, input.organizationId),
      ),
    );
}

/** Offene Merker (ohne `completed_at`) der Profile einer Connection, gebunden an die Organisation. */
export async function countOpenBackfills(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string },
): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(amazonAdsBackfills)
    .innerJoin(amazonAdsProfiles, eq(amazonAdsProfiles.id, amazonAdsBackfills.profileId))
    .where(
      and(
        eq(amazonAdsBackfills.organizationId, input.organizationId),
        eq(amazonAdsProfiles.organizationId, input.organizationId),
        eq(amazonAdsProfiles.connectionId, input.connectionId),
        isNull(amazonAdsBackfills.completedAt),
      ),
    );
  return row?.n ?? 0;
}
