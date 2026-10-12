import { AMAZON_MARKETPLACES } from '@profitbash/shared';
import { connectionTokenAad, decrypt, encrypt, type Keyring } from '@profitbash/shared/crypto';
import { and, eq, isNull, notInArray, sql } from 'drizzle-orm';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import { ConnectionNotFoundError } from './connection-tokens';
import { amazonSpAccounts, amazonSpCredentials, connections } from './schema';

/**
 * SP-API-Connections und Seller-Konten (Phase 7, 7.2). Verwaltung der Eigentümer-Org wie bei
 * Ads-Connections (ADR 002): Die Aufrufer stehen hinter `orgAdminOnly` bzw. sind Jobs, gebunden an
 * Organisation und Connection. Was Nutzer von Seller-Konten sehen, entscheidet der Access-Layer.
 */

type ConnectionKey = Parameters<typeof connectionTokenAad>[0];

/** Bindet das verschlüsselte App-Secret an seine Connection, getrennt vom Refresh-Token. */
export const spClientSecretAad = (connection: ConnectionKey) =>
  `${connectionTokenAad(connection)}:client-secret`;

/** Was der Sync von einer Marktplatz-Teilnahme braucht (`AmazonSpMarketplaceParticipation`). */
export interface SellerMarketplaceParticipation {
  marketplaceId: string;
  storeName: string;
  isParticipating: boolean;
}

export interface SellerAccountsSyncResult {
  /** Konten, die Amazon aktuell liefert. */
  accounts: number;
  created: number;
  removed: number;
  /** Teilnahmen an Marktplätzen, die ProfitBash nicht kennt (keine Zeitzone): nicht angelegt. */
  skippedMarketplaceIds: string[];
}

/**
 * Upsert über (`organization_id`, `amazon_seller_id`, `marketplace_id`): `connection_id` zeigt danach auf
 * diese Connection, `removed_at` wird zurückgesetzt; `client_id` und `is_hidden` bleiben. Konten der
 * Connection, die Amazon nicht mehr liefert, bekommen `removed_at`.
 */
export async function syncSellerAccounts(
  db: DbOrTx,
  input: {
    organizationId: string;
    connectionId: string;
    amazonSellerId: string;
    participations: readonly SellerMarketplaceParticipation[];
  },
): Promise<SellerAccountsSyncResult> {
  const { organizationId, connectionId, amazonSellerId } = input;
  const skippedMarketplaceIds: string[] = [];
  const now = new Date();
  const rows = input.participations.flatMap((participation) => {
    if (!participation.isParticipating) return [];
    const marketplace = AMAZON_MARKETPLACES.find(
      (m) => m.marketplaceId === participation.marketplaceId,
    );
    if (!marketplace) {
      skippedMarketplaceIds.push(participation.marketplaceId);
      return [];
    }
    return [
      {
        organizationId,
        connectionId,
        amazonSellerId,
        marketplaceId: marketplace.marketplaceId,
        storeName: participation.storeName,
        countryCode: marketplace.countryCode,
        currencyCode: marketplace.currencyCode,
        timezone: marketplace.timezone,
        syncedAt: now,
      },
    ];
  });

  let created = 0;
  if (rows.length > 0) {
    const upserted = await db
      .insert(amazonSpAccounts)
      .values(rows)
      .onConflictDoUpdate({
        target: [
          amazonSpAccounts.organizationId,
          amazonSpAccounts.amazonSellerId,
          amazonSpAccounts.marketplaceId,
        ],
        set: {
          connectionId,
          storeName: sql`excluded.store_name`,
          removedAt: null,
          syncedAt: now,
        },
      })
      .returning({ inserted: sql<boolean>`(xmax = 0)` });
    created = upserted.filter((row) => row.inserted).length;
  }
  const marketplaceIds = rows.map((row) => row.marketplaceId);
  const removed = await db
    .update(amazonSpAccounts)
    .set({ removedAt: now })
    .where(
      and(
        eq(amazonSpAccounts.organizationId, organizationId),
        eq(amazonSpAccounts.connectionId, connectionId),
        isNull(amazonSpAccounts.removedAt),
        ...(marketplaceIds.length > 0
          ? [notInArray(amazonSpAccounts.marketplaceId, marketplaceIds)]
          : []),
      ),
    )
    .returning({ id: amazonSpAccounts.id });
  return { accounts: rows.length, created, removed: removed.length, skippedMarketplaceIds };
}

export interface SaveSpConnectionInput {
  keyring: Keyring;
  organizationId: string;
  userId: string;
  region: 'eu' | 'na' | 'fe';
  amazonSellerId: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  /** Ergebnis der Prüfung der Zugangsdaten; daraus entstehen die Seller-Konten. */
  participations: readonly SellerMarketplaceParticipation[];
}

/**
 * Legt eine SP-API-Connection an oder verbindet sie neu („Token eintragen“): Upsert über den natürlichen
 * Schlüssel (Organisation, Anbieter, Region, Seller-ID), Zugangsdaten verschlüsselt, Seller-Konten und
 * Audit-Event in derselben Transaktion. Secrets stehen nie im Audit.
 */
export async function saveSpConnection(
  db: Db,
  input: SaveSpConnectionInput,
): Promise<SellerAccountsSyncResult & { connectionId: string; created: boolean }> {
  const { keyring, organizationId } = input;
  const naturalKey = {
    organizationId,
    provider: 'amazon_sp' as const,
    region: input.region,
    externalAccountId: input.amazonSellerId,
  };
  const refreshTokenEncrypted = encrypt(input.refreshToken, {
    keyring,
    aad: connectionTokenAad(naturalKey),
  });
  const clientSecretEncrypted = encrypt(input.clientSecret, {
    keyring,
    aad: spClientSecretAad(naturalKey),
  });
  const consentedAt = new Date();
  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(connections)
      .values({
        ...naturalKey,
        refreshTokenEncrypted,
        status: 'active',
        lastRefreshedAt: consentedAt,
        consentedAt,
        createdBy: input.userId,
      })
      .onConflictDoUpdate({
        target: [
          connections.organizationId,
          connections.provider,
          connections.region,
          connections.externalAccountId,
        ],
        set: { refreshTokenEncrypted, status: 'active', lastRefreshedAt: consentedAt, consentedAt },
      })
      .returning({ id: connections.id, inserted: sql<boolean>`(xmax = 0)` });
    if (!row) throw new Error('Upsert der Connection lieferte keine Zeile.');
    await tx
      .insert(amazonSpCredentials)
      .values({
        connectionId: row.id,
        organizationId,
        clientId: input.clientId,
        clientSecretEncrypted,
      })
      .onConflictDoUpdate({
        target: amazonSpCredentials.connectionId,
        set: { clientId: input.clientId, clientSecretEncrypted },
      });
    const synced = await syncSellerAccounts(tx, {
      organizationId,
      connectionId: row.id,
      amazonSellerId: input.amazonSellerId,
      participations: input.participations,
    });
    await recordAuditEvent(tx, {
      organizationId,
      actorUserId: input.userId,
      action: row.inserted ? 'connection.create' : 'connection.reconnect',
      target: {
        type: 'connection',
        id: row.id,
        provider: naturalKey.provider,
        region: naturalKey.region,
        externalAccountId: naturalKey.externalAccountId,
        consentedAt: consentedAt.toISOString(),
        accounts: synced.accounts,
      },
    });
    return { ...synced, connectionId: row.id, created: row.inserted };
  });
}

/** Client-ID und entschlüsseltes Secret der App einer SP-Connection (Systemzugriff für den Client). */
export async function getSpCredentials(
  db: DbOrTx,
  keyring: Keyring,
  connection: { id: string; organizationId: string },
): Promise<{ clientId: string; clientSecret: string }> {
  const [row] = await db
    .select({
      organizationId: connections.organizationId,
      provider: connections.provider,
      region: connections.region,
      externalAccountId: connections.externalAccountId,
      clientId: amazonSpCredentials.clientId,
      clientSecretEncrypted: amazonSpCredentials.clientSecretEncrypted,
    })
    .from(amazonSpCredentials)
    .innerJoin(connections, eq(connections.id, amazonSpCredentials.connectionId))
    .where(
      and(
        eq(amazonSpCredentials.connectionId, connection.id),
        eq(amazonSpCredentials.organizationId, connection.organizationId),
      ),
    );
  if (!row) throw new ConnectionNotFoundError();
  return {
    clientId: row.clientId,
    clientSecret: decrypt(row.clientSecretEncrypted, { keyring, aad: spClientSecretAad(row) }),
  };
}
