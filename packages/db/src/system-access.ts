import { and, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import type { DbOrTx } from './audit';
import { amazonAdsProfiles, connections } from './schema';

/**
 * Systemzugriff des Workers (Jobs je Connection, Profil-Sync). Kein Nutzerkontext: Sichtbarkeit für
 * Nutzer regelt weiterhin `access.ts`. Abfragen sind an Organisation und Connection gebunden; nur die
 * Planung der Jobs (`listActiveConnections`) ist plattformweit.
 */

export interface JobConnection {
  id: string;
  organizationId: string;
  region: 'eu' | 'na' | 'fe' | null;
  status: 'active' | 'reauth_required' | 'error';
  /** Gespeicherter (verschlüsselter) Refresh-Token; bindet `markConnectionReauthRequired` an genau ihn. */
  refreshTokenEncrypted: string;
}

/** Connection eines Jobs im Org-Kontext oder `null`. */
export async function findJobConnection(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string },
): Promise<JobConnection | null> {
  const [row] = await db
    .select({
      id: connections.id,
      organizationId: connections.organizationId,
      region: connections.region,
      status: connections.status,
      refreshTokenEncrypted: connections.refreshTokenEncrypted,
    })
    .from(connections)
    .where(
      and(
        eq(connections.id, input.connectionId),
        eq(connections.organizationId, input.organizationId),
      ),
    );
  return row ?? null;
}

export interface SyncedProfile {
  amazonProfileId: string;
  amazonAccountId: string | null;
  accountName: string;
  countryCode: string;
  currencyCode: string;
  timezone: string;
  marketplaceId: string | null;
  accountType: string;
}

/**
 * Upsert über (`organization_id`, `amazon_profile_id`): `connection_id` zeigt danach auf die
 * synchronisierende Connection, `removed_at` wird zurückgesetzt. `is_hidden` und `client_id` bleiben
 * unberührt. Liefert die Zahl neu angelegter Profile.
 */
export async function upsertSyncedProfiles(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string; profiles: SyncedProfile[]; now: Date },
): Promise<{ created: number }> {
  if (input.profiles.length === 0) return { created: 0 };
  const rows = await db
    .insert(amazonAdsProfiles)
    .values(
      input.profiles.map((profile) => ({
        ...profile,
        organizationId: input.organizationId,
        connectionId: input.connectionId,
        syncedAt: input.now,
      })),
    )
    .onConflictDoUpdate({
      target: [amazonAdsProfiles.organizationId, amazonAdsProfiles.amazonProfileId],
      set: {
        connectionId: sql`excluded.connection_id`,
        amazonAccountId: sql`excluded.amazon_account_id`,
        accountName: sql`excluded.account_name`,
        countryCode: sql`excluded.country_code`,
        currencyCode: sql`excluded.currency_code`,
        timezone: sql`excluded.timezone`,
        marketplaceId: sql`excluded.marketplace_id`,
        accountType: sql`excluded.account_type`,
        removedAt: null,
        syncedAt: input.now,
      },
    })
    // xmax = 0 nur bei frisch eingefügten Zeilen (Postgres-Systemspalte).
    .returning({ inserted: sql<boolean>`(xmax = 0)` });
  return { created: rows.filter((row) => row.inserted).length };
}

/** Amazon-Profil-IDs der Connection, die nicht (mehr) in `seen` stehen und noch nicht entfernt sind. */
export async function findUnseenProfiles(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string; seenAmazonProfileIds: string[] },
): Promise<string[]> {
  const rows = await db
    .select({ amazonProfileId: amazonAdsProfiles.amazonProfileId })
    .from(amazonAdsProfiles)
    .where(
      and(
        eq(amazonAdsProfiles.organizationId, input.organizationId),
        eq(amazonAdsProfiles.connectionId, input.connectionId),
        isNull(amazonAdsProfiles.removedAt),
        input.seenAmazonProfileIds.length > 0
          ? notInArray(amazonAdsProfiles.amazonProfileId, input.seenAmazonProfileIds)
          : undefined,
      ),
    );
  return rows.map((row) => row.amazonProfileId);
}

export interface JobProfile {
  id: string;
  amazonProfileId: string;
  timezone: string;
  removedAt: Date | null;
}

/**
 * Alle Profile, die an der Connection hängen, auch ausgeblendete (F14) und entfernte (offene Aufträge
 * entfernter Profile laufen noch aus). Die Datenjobs filtern entfernte selbst.
 */
export async function listJobProfiles(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string },
): Promise<JobProfile[]> {
  return db
    .select({
      id: amazonAdsProfiles.id,
      amazonProfileId: amazonAdsProfiles.amazonProfileId,
      timezone: amazonAdsProfiles.timezone,
      removedAt: amazonAdsProfiles.removedAt,
    })
    .from(amazonAdsProfiles)
    .where(
      and(
        eq(amazonAdsProfiles.organizationId, input.organizationId),
        eq(amazonAdsProfiles.connectionId, input.connectionId),
      ),
    )
    .orderBy(amazonAdsProfiles.createdAt, amazonAdsProfiles.id);
}

/**
 * Alle aktiven Connections aller Organisationen (Planung der Jobs je Connection). Plattformweiter
 * Systemzugriff, nur für den Worker.
 */
export async function listActiveConnections(
  db: DbOrTx,
): Promise<Array<{ id: string; organizationId: string }>> {
  return db
    .select({ id: connections.id, organizationId: connections.organizationId })
    .from(connections)
    .where(eq(connections.status, 'active'))
    .orderBy(connections.createdAt, connections.id);
}

/** Aktive Connections der Organisation außer `exceptConnectionId` (weitere Zugriffswege). */
export async function listOtherActiveConnections(
  db: DbOrTx,
  input: { organizationId: string; exceptConnectionId: string },
): Promise<Array<{ id: string; region: 'eu' | 'na' | 'fe' | null }>> {
  return db
    .select({ id: connections.id, region: connections.region })
    .from(connections)
    .where(
      and(
        eq(connections.organizationId, input.organizationId),
        eq(connections.status, 'active'),
        ne(connections.id, input.exceptConnectionId),
      ),
    );
}

/**
 * Hängt Profile an eine andere Connection um. Nur Profile, die noch an `fromConnectionId` hängen:
 * Hat ein paralleler Sync sie inzwischen übernommen, bleibt dessen Stand.
 */
export async function reassignProfiles(
  db: DbOrTx,
  input: {
    organizationId: string;
    fromConnectionId: string;
    toConnectionId: string;
    amazonProfileIds: string[];
  },
): Promise<number> {
  if (input.amazonProfileIds.length === 0) return 0;
  const rows = await db
    .update(amazonAdsProfiles)
    .set({ connectionId: input.toConnectionId })
    .where(
      and(
        eq(amazonAdsProfiles.organizationId, input.organizationId),
        eq(amazonAdsProfiles.connectionId, input.fromConnectionId),
        inArray(amazonAdsProfiles.amazonProfileId, input.amazonProfileIds),
      ),
    )
    .returning({ id: amazonAdsProfiles.id });
  return rows.length;
}

/** Setzt `removed_at` (nichts wird gelöscht). Nur Profile, die noch an der Connection hängen. */
export async function markProfilesRemoved(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string; amazonProfileIds: string[]; now: Date },
): Promise<number> {
  if (input.amazonProfileIds.length === 0) return 0;
  const rows = await db
    .update(amazonAdsProfiles)
    .set({ removedAt: input.now })
    .where(
      and(
        eq(amazonAdsProfiles.organizationId, input.organizationId),
        eq(amazonAdsProfiles.connectionId, input.connectionId),
        isNull(amazonAdsProfiles.removedAt),
        inArray(amazonAdsProfiles.amazonProfileId, input.amazonProfileIds),
      ),
    )
    .returning({ id: amazonAdsProfiles.id });
  return rows.length;
}
