import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  AmazonAdsError,
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
} from '@profitbash/amazon-ads';
import { AmazonSpRoleMissingError } from '@profitbash/amazon-sp';
import {
  canSeeSellerAccount,
  ConnectionReauthRequiredError,
  markConnectionReauthRequired,
  recordAuditEvent,
  saveSpConnection,
  schema,
  syncSellerAccounts,
  visibleSellerAccountsScope,
} from '@profitbash/db';
import {
  errorResponseSchema,
  idParamSchema,
  profilePatchSchema,
  sellerAccountSchema,
  sellerAccountsSyncSchema,
  sellerConnectionCreateSchema,
  sellerConnectionListSchema,
  type SellerAccount,
} from '@profitbash/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { orgAdminOnly } from '../middleware';
import { toIso } from './serialize';

const { amazonSpAccounts, clients, connections } = schema;

/**
 * SP-API-Connections und Seller-Konten (Phase 7, 7.2), Verwaltung unter „Clients & Connections“ hinter
 * `orgAdminOnly`. Connections filtern nach der aktiven Organisation (ADR 002: Verwaltung der Eigentümer-Org),
 * Seller-Konten laufen über den Access-Layer. Zugangsdaten werden nie ausgeliefert.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });
const error = (description: string) => ({ description, content: json(errorResponseSchema) });
const errors = {
  400: error('Ungültige Eingabe oder von Amazon abgelehnt.'),
  401: error('Nicht angemeldet.'),
  403: error('Keine Admin-Rolle.'),
  404: error('Nicht gefunden.'),
  409: error('Connection braucht ein Neu-Verbinden.'),
  502: error('Amazon nicht erreichbar.'),
};

const accountColumns = {
  id: amazonSpAccounts.id,
  connectionId: amazonSpAccounts.connectionId,
  clientId: amazonSpAccounts.clientId,
  amazonSellerId: amazonSpAccounts.amazonSellerId,
  marketplaceId: amazonSpAccounts.marketplaceId,
  storeName: amazonSpAccounts.storeName,
  countryCode: amazonSpAccounts.countryCode,
  currencyCode: amazonSpAccounts.currencyCode,
  timezone: amazonSpAccounts.timezone,
  isHidden: amazonSpAccounts.isHidden,
  removedAt: amazonSpAccounts.removedAt,
  syncedAt: amazonSpAccounts.syncedAt,
};
type AccountRow = Pick<typeof amazonSpAccounts.$inferSelect, keyof typeof accountColumns>;

const toAccount = (row: AccountRow): SellerAccount => ({
  ...row,
  removedAt: toIso(row.removedAt),
  syncedAt: toIso(row.syncedAt),
});

const listRoute = createRoute({
  method: 'get',
  path: '/seller-connections',
  tags: ['Seller-Konten'],
  summary: 'SP-API-Connections mit Seller-Konten inkl. ausgeblendeter und entfernter (nur Admin)',
  responses: {
    200: { description: 'Connections, älteste zuerst.', content: json(sellerConnectionListSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const createConnectionRoute = createRoute({
  method: 'post',
  path: '/seller-connections',
  tags: ['Seller-Konten'],
  summary: 'Seller-Konto über „Token eintragen“ verbinden oder neu verbinden (nur Admin)',
  request: { body: { required: true, content: json(sellerConnectionCreateSchema) } },
  responses: {
    200: { description: 'Neu verbunden.', content: json(sellerAccountsSyncSchema) },
    201: { description: 'Angelegt.', content: json(sellerAccountsSyncSchema) },
    400: errors[400],
    401: errors[401],
    403: errors[403],
    502: errors[502],
  },
});

const syncRoute = createRoute({
  method: 'post',
  path: '/seller-connections/{id}/sync',
  tags: ['Seller-Konten'],
  summary: 'Seller-Konten einer Connection mit Amazon abgleichen (nur Admin)',
  request: { params: idParamSchema },
  responses: {
    200: { description: 'Abgeglichen.', content: json(sellerAccountsSyncSchema) },
    ...errors,
  },
});

const patchAccountRoute = createRoute({
  method: 'patch',
  path: '/seller-accounts/{id}',
  tags: ['Seller-Konten'],
  summary: 'Seller-Konto einem Client zuordnen oder ausblenden (nur Admin)',
  request: { params: idParamSchema, body: { required: true, content: json(profilePatchSchema) } },
  responses: {
    200: { description: 'Geändertes Seller-Konto.', content: json(sellerAccountSchema) },
    400: errors[400],
    401: errors[401],
    403: errors[403],
    404: errors[404],
  },
});

/** Fehler des SP-Clients als API-Fehler; Meldungen ohne Details von Amazon (keine Secrets, keine Rohdaten). */
function toApiError(cause: unknown): unknown {
  if (cause instanceof AmazonSpRoleMissingError) {
    return new ApiError(
      400,
      'SP_ROLE_MISSING',
      'Amazon verweigert den Zugriff: Der App fehlt die Rolle für diese Abfrage.',
    );
  }
  if (cause instanceof AmazonAdsReauthRequiredError) {
    return new ApiError(400, 'SP_TOKEN_REJECTED', 'Amazon hat den Refresh-Token abgelehnt.');
  }
  if (cause instanceof AmazonAdsHttpError && cause.status >= 400 && cause.status < 500) {
    return new ApiError(
      400,
      'SP_CREDENTIALS_REJECTED',
      'Amazon hat die Zugangsdaten der App abgelehnt.',
    );
  }
  if (cause instanceof AmazonAdsError) {
    return new ApiError(502, 'AMAZON_ERROR', 'Amazon ist gerade nicht erreichbar.');
  }
  return cause;
}

export function registerSellerConnectionRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db, amazonSp } = deps;
  const middleware = orgAdminOnly(deps);
  // requireRole garantiert eine aktive Organisation.
  const orgOf = (auth: AppEnv['Variables']['auth']) => auth.activeOrganization!.organizationId;

  app.openapi({ ...listRoute, middleware }, async (c) => {
    const auth = c.get('auth');
    const organizationId = orgOf(auth);
    const rows = await db
      .select({
        id: connections.id,
        region: connections.region,
        amazonSellerId: connections.externalAccountId,
        status: connections.status,
        consentedAt: connections.consentedAt,
      })
      .from(connections)
      .where(
        and(eq(connections.organizationId, organizationId), eq(connections.provider, 'amazon_sp')),
      )
      .orderBy(asc(connections.createdAt), asc(connections.id));
    const scope = await visibleSellerAccountsScope(db, {
      userId: auth.user.id,
      orgId: organizationId,
      includeHidden: true,
      includeRemoved: true,
    });
    const accounts = scope
      ? await db
          .select(accountColumns)
          .from(amazonSpAccounts)
          .where(inArray(amazonSpAccounts.id, scope.ids))
          .orderBy(asc(amazonSpAccounts.countryCode), asc(amazonSpAccounts.id))
      : [];
    return c.json(
      {
        connections: rows.map((row) => ({
          ...row,
          // SP-Connections haben immer eine Region (Eingabe ist Pflicht).
          region: row.region!,
          consentedAt: toIso(row.consentedAt),
          accounts: accounts.filter((a) => a.connectionId === row.id).map(toAccount),
        })),
      },
      200,
    );
  });

  app.openapi({ ...createConnectionRoute, middleware }, async (c) => {
    const auth = c.get('auth');
    const input = c.req.valid('json');
    const participations = await amazonSp.verify(input).catch((cause: unknown) => {
      throw toApiError(cause);
    });
    const saved = await saveSpConnection(db, {
      ...input,
      keyring: deps.keyring,
      organizationId: orgOf(auth),
      userId: auth.user.id,
      participations,
    });
    // Ein noch gecachtes Token gehört zu den alten Zugangsdaten.
    amazonSp.client.invalidateAccessToken(saved.connectionId);
    const { connectionId, accounts, skippedMarketplaceIds } = saved;
    return c.json({ connectionId, accounts, skippedMarketplaceIds }, saved.created ? 201 : 200);
  });

  app.openapi({ ...syncRoute, middleware }, async (c) => {
    const auth = c.get('auth');
    const organizationId = orgOf(auth);
    const [connection] = await db
      .select({
        id: connections.id,
        region: connections.region,
        amazonSellerId: connections.externalAccountId,
        status: connections.status,
        refreshTokenEncrypted: connections.refreshTokenEncrypted,
      })
      .from(connections)
      .where(
        and(
          eq(connections.id, c.req.valid('param').id),
          eq(connections.organizationId, organizationId),
          eq(connections.provider, 'amazon_sp'),
        ),
      );
    if (!connection?.region) {
      throw new ApiError(404, 'CONNECTION_NOT_FOUND', 'Connection nicht gefunden.');
    }
    const reauth = new ApiError(
      409,
      'CONNECTION_REAUTH_REQUIRED',
      'Die Connection muss zuerst neu verbunden werden.',
    );
    const ref = { id: connection.id, organizationId, region: connection.region };
    // shortcut: ein Aufruf an Amazon direkt in der Anfrage statt als Job; mit dem täglichen Import (7.3)
    // läuft der Abgleich zusätzlich über `runJob`.
    const participations = await amazonSp.client
      .getMarketplaceParticipations(ref)
      .catch(async (cause: unknown) => {
        if (cause instanceof ConnectionReauthRequiredError) throw reauth;
        if (cause instanceof AmazonAdsReauthRequiredError) {
          await markConnectionReauthRequired(db, {
            id: connection.id,
            organizationId,
            rejectedRefreshTokenEncrypted: connection.refreshTokenEncrypted,
          });
          throw reauth;
        }
        throw toApiError(cause);
      });
    const synced = await db.transaction(async (tx) => {
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: auth.user.id,
        action: 'connection.sync_request',
        target: { type: 'connection', id: connection.id, provider: 'amazon_sp' },
      });
      return syncSellerAccounts(tx, {
        organizationId,
        connectionId: connection.id,
        amazonSellerId: connection.amazonSellerId,
        participations,
      });
    });
    return c.json(
      {
        connectionId: connection.id,
        accounts: synced.accounts,
        skippedMarketplaceIds: synced.skippedMarketplaceIds,
      },
      200,
    );
  });

  app.openapi({ ...patchAccountRoute, middleware }, async (c) => {
    const auth = c.get('auth');
    const organizationId = orgOf(auth);
    const sellerAccountId = c.req.valid('param').id;
    const patch = c.req.valid('json');

    const visible = await canSeeSellerAccount(db, {
      userId: auth.user.id,
      orgId: organizationId,
      sellerAccountId,
      includeHidden: true,
      includeRemoved: true,
    });
    const notFound = new ApiError(404, 'SELLER_ACCOUNT_NOT_FOUND', 'Seller-Konto nicht gefunden.');
    if (!visible) throw notFound;

    if (patch.clientId) {
      const [client] = await db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, patch.clientId), eq(clients.organizationId, organizationId)))
        .limit(1);
      if (!client) throw new ApiError(400, 'CLIENT_NOT_FOUND', 'Client nicht gefunden.');
    }

    const updated = await db.transaction(async (tx) => {
      const [before] = await tx
        .select(accountColumns)
        .from(amazonSpAccounts)
        .where(eq(amazonSpAccounts.id, sellerAccountId))
        .for('update');
      if (!before) throw notFound;
      const [after] = await tx
        .update(amazonSpAccounts)
        .set({
          ...(patch.clientId !== undefined && { clientId: patch.clientId }),
          ...(patch.isHidden !== undefined && { isHidden: patch.isHidden }),
        })
        .where(eq(amazonSpAccounts.id, sellerAccountId))
        .returning(accountColumns);
      if (!after) throw new Error('Update des Seller-Kontos lieferte keine Zeile.');
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: auth.user.id,
        action: 'seller_account.update',
        target: {
          type: 'amazon_sp_account',
          id: sellerAccountId,
          amazonSellerId: before.amazonSellerId,
          marketplaceId: before.marketplaceId,
          before: { clientId: before.clientId, isHidden: before.isHidden },
          after: { clientId: after.clientId, isHidden: after.isHidden },
        },
      });
      return after;
    });
    return c.json(toAccount(updated), 200);
  });
}
