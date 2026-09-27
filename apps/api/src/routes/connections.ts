import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  canSeeProfile,
  recordAuditEvent,
  schema,
  visibleProfilesScope,
  type Db,
  type DbOrTx,
} from '@profitbash/db';
import {
  connectionListSchema,
  errorResponseSchema,
  idParamSchema,
  profileListSchema,
  profilePatchSchema,
  profileSchema,
  refreshTokenExpiresAt,
  syncQueuedSchema,
  type Connection,
  type Profile,
} from '@profitbash/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { orgAdminOnly } from '../middleware';
import { toIso } from './serialize';

const { amazonAdsProfiles, clients, connections } = schema;

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const errors = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: { description: 'Keine Admin-Rolle.', content: json(errorResponseSchema) },
  404: { description: 'Nicht gefunden.', content: json(errorResponseSchema) },
};

const connectionColumns = {
  id: connections.id,
  provider: connections.provider,
  region: connections.region,
  externalAccountId: connections.externalAccountId,
  externalAccountEmail: connections.externalAccountEmail,
  status: connections.status,
  lastRefreshedAt: connections.lastRefreshedAt,
  consentedAt: connections.consentedAt,
  createdAt: connections.createdAt,
  updatedAt: connections.updatedAt,
};

type ConnectionRow = Pick<typeof connections.$inferSelect, keyof typeof connectionColumns>;

/**
 * Connection der Organisation oder `null`. Connections sind keine Profile: Hier ist der Filter nach
 * Organisation die Zugriffsregel (Profile laufen über den Access-Layer).
 */
export async function findConnection(
  db: DbOrTx,
  organizationId: string,
  connectionId: string,
): Promise<ConnectionRow | null> {
  const [row] = await db
    .select(connectionColumns)
    .from(connections)
    .where(and(eq(connections.id, connectionId), eq(connections.organizationId, organizationId)))
    .limit(1);
  return row ?? null;
}

function toConnection(row: ConnectionRow): Connection {
  return {
    ...row,
    lastRefreshedAt: toIso(row.lastRefreshedAt),
    consentedAt: toIso(row.consentedAt),
    // Die 365-Tage-Regel gilt für Amazon-Ads-Tokens; andere Anbieter bringen eigene Regeln mit.
    refreshTokenExpiresAt:
      row.provider === 'amazon_ads' ? toIso(refreshTokenExpiresAt(row.consentedAt)) : null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

const profileColumns = {
  id: amazonAdsProfiles.id,
  connectionId: amazonAdsProfiles.connectionId,
  clientId: amazonAdsProfiles.clientId,
  amazonProfileId: amazonAdsProfiles.amazonProfileId,
  amazonAccountId: amazonAdsProfiles.amazonAccountId,
  accountName: amazonAdsProfiles.accountName,
  countryCode: amazonAdsProfiles.countryCode,
  currencyCode: amazonAdsProfiles.currencyCode,
  timezone: amazonAdsProfiles.timezone,
  marketplaceId: amazonAdsProfiles.marketplaceId,
  accountType: amazonAdsProfiles.accountType,
  isHidden: amazonAdsProfiles.isHidden,
  removedAt: amazonAdsProfiles.removedAt,
  syncedAt: amazonAdsProfiles.syncedAt,
};

type ProfileRow = Pick<typeof amazonAdsProfiles.$inferSelect, keyof typeof profileColumns>;

function toProfile(row: ProfileRow): Profile {
  return { ...row, removedAt: toIso(row.removedAt), syncedAt: toIso(row.syncedAt) };
}

const listConnectionsRoute = createRoute({
  method: 'get',
  path: '/connections',
  tags: ['Connections'],
  summary: 'Connections der aktiven Organisation (nur Admin)',
  responses: {
    200: { description: 'Connections, älteste zuerst.', content: json(connectionListSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const syncConnectionRoute = createRoute({
  method: 'post',
  path: '/connections/{id}/sync',
  tags: ['Connections'],
  summary: 'Profil-Sync jetzt einplanen (nur Admin)',
  request: { params: idParamSchema },
  responses: {
    202: { description: 'Sync eingeplant.', content: json(syncQueuedSchema) },
    ...errors,
    409: {
      description: 'Connection braucht zuerst ein Neu-Verbinden.',
      content: json(errorResponseSchema),
    },
  },
});

const listProfilesRoute = createRoute({
  method: 'get',
  path: '/connections/{id}/profiles',
  tags: ['Connections'],
  summary: 'Profile einer Connection inkl. ausgeblendeter und entfernter (nur Admin)',
  request: { params: idParamSchema },
  responses: {
    200: { description: 'Profile nach Land und Name.', content: json(profileListSchema) },
    ...errors,
  },
});

const patchProfileRoute = createRoute({
  method: 'patch',
  path: '/profiles/{id}',
  tags: ['Connections'],
  summary: 'Profil einem Client zuordnen oder ausblenden (nur Admin)',
  request: {
    params: idParamSchema,
    body: { required: true, content: json(profilePatchSchema) },
  },
  responses: {
    200: { description: 'Geändertes Profil.', content: json(profileSchema) },
    ...errors,
  },
});

async function requireConnection(db: Db, organizationId: string, connectionId: string) {
  const connection = await findConnection(db, organizationId, connectionId);
  if (!connection) throw new ApiError(404, 'CONNECTION_NOT_FOUND', 'Connection nicht gefunden.');
  return connection;
}

export function registerConnectionRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const middleware = orgAdminOnly(deps);
  // requireRole garantiert eine aktive Organisation.
  const orgOf = (auth: AppEnv['Variables']['auth']) => auth.activeOrganization!.organizationId;

  app.openapi({ ...listConnectionsRoute, middleware }, async (c) => {
    const rows = await db
      .select(connectionColumns)
      .from(connections)
      .where(eq(connections.organizationId, orgOf(c.get('auth'))))
      .orderBy(asc(connections.createdAt), asc(connections.id));
    return c.json({ connections: rows.map(toConnection) }, 200);
  });

  app.openapi({ ...syncConnectionRoute, middleware }, async (c) => {
    const auth = c.get('auth');
    const organizationId = orgOf(auth);
    const connection = await requireConnection(db, organizationId, c.req.valid('param').id);
    if (connection.status === 'reauth_required') {
      throw new ApiError(
        409,
        'CONNECTION_REAUTH_REQUIRED',
        'Die Connection muss zuerst neu verbunden werden.',
      );
    }
    // Audit-Event und Job in einer Transaktion (pg-boss schreibt über `tx`): Scheitert das
    // Einplanen, fehlt auch das Audit-Event, und ein Job ohne Audit-Event kann nicht entstehen.
    await db.transaction(async (tx) => {
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: auth.user.id,
        action: 'connection.sync_request',
        target: { type: 'connection', id: connection.id },
      });
      // Kette (1.7): Profile → Entities → Reports.
      await deps.jobs.enqueueProfilesSync(
        { organizationId, connectionId: connection.id, chain: true },
        { tx },
      );
    });
    return c.json({ status: 'queued' as const }, 202);
  });

  app.openapi({ ...listProfilesRoute, middleware }, async (c) => {
    const auth = c.get('auth');
    const organizationId = orgOf(auth);
    const connection = await requireConnection(db, organizationId, c.req.valid('param').id);
    const scope = await visibleProfilesScope(db, {
      userId: auth.user.id,
      orgId: organizationId,
      includeHidden: true,
      includeRemoved: true,
    });
    const rows = scope
      ? await db
          .select(profileColumns)
          .from(amazonAdsProfiles)
          .where(
            and(
              inArray(amazonAdsProfiles.id, scope.ids),
              eq(amazonAdsProfiles.connectionId, connection.id),
            ),
          )
          .orderBy(
            asc(amazonAdsProfiles.countryCode),
            asc(amazonAdsProfiles.accountName),
            asc(amazonAdsProfiles.id),
          )
      : [];
    return c.json({ profiles: rows.map(toProfile) }, 200);
  });

  app.openapi({ ...patchProfileRoute, middleware }, async (c) => {
    const auth = c.get('auth');
    const organizationId = orgOf(auth);
    const profileId = c.req.valid('param').id;
    const patch = c.req.valid('json');

    const visible = await canSeeProfile(db, {
      userId: auth.user.id,
      orgId: organizationId,
      profileId,
      includeHidden: true,
      includeRemoved: true,
    });
    if (!visible) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Profil nicht gefunden.');

    if (patch.clientId) {
      const [client] = await db
        .select({ id: clients.id })
        .from(clients)
        .where(and(eq(clients.id, patch.clientId), eq(clients.organizationId, organizationId)))
        .limit(1);
      if (!client) {
        throw new ApiError(400, 'CLIENT_NOT_FOUND', 'Client nicht gefunden.');
      }
    }

    const updated = await db.transaction(async (tx) => {
      const [before] = await tx
        .select(profileColumns)
        .from(amazonAdsProfiles)
        .where(eq(amazonAdsProfiles.id, profileId))
        .for('update');
      if (!before) throw new ApiError(404, 'PROFILE_NOT_FOUND', 'Profil nicht gefunden.');
      const [after] = await tx
        .update(amazonAdsProfiles)
        .set({
          ...(patch.clientId !== undefined && { clientId: patch.clientId }),
          ...(patch.isHidden !== undefined && { isHidden: patch.isHidden }),
        })
        .where(eq(amazonAdsProfiles.id, profileId))
        .returning(profileColumns);
      if (!after) throw new Error('Update des Profils lieferte keine Zeile.');
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: auth.user.id,
        action: 'profile.update',
        target: {
          type: 'amazon_ads_profile',
          id: profileId,
          amazonProfileId: before.amazonProfileId,
          before: { clientId: before.clientId, isHidden: before.isHidden },
          after: { clientId: after.clientId, isHidden: after.isHidden },
        },
      });
      return after;
    });
    return c.json(toProfile(updated), 200);
  });
}
