import { randomBytes } from 'node:crypto';
import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { AmazonAdsError, renderMockConsentPage } from '@profitbash/amazon-ads';
import {
  AMAZON_ADS_OAUTH_NONCE_PREFIX,
  deleteExpiredOAuthNonces,
  errorLogFields,
  getOrgRole,
  recordAuditEvent,
  schema,
} from '@profitbash/db';
import {
  amazonOAuthRedirectSchema,
  amazonOAuthStartSchema,
  errorResponseSchema,
  type AmazonOAuthResult,
} from '@profitbash/shared';
import { connectionTokenAad, encrypt } from '@profitbash/shared/crypto';
import { and, eq, gt, sql } from 'drizzle-orm';
import type { Context } from 'hono';
import { MOCK_CONSENT_PATH } from '../amazon';
import type { AppDeps, AppEnv } from '../context';
import { AMAZON_OAUTH_CALLBACK_PATH } from '../env';
import { ApiError, errorResponse } from '../errors';
import { orgAdminOnly } from '../middleware';
import {
  MAX_OAUTH_STATE_LENGTH,
  signOAuthState,
  verifyOAuthState,
  type OAuthStatePayload,
} from '../oauth-state';
import { findConnection } from './connections';

const { connections, verifications } = schema;

/** Gültigkeit des `state` (Einwilligung bei Amazon inklusive Login). */
const STATE_TTL_MS = 10 * 60_000;
/** Präfix der Nonces in `verifications` (die Tabelle teilt sich die App mit better-auth). */
const NONCE_PREFIX = AMAZON_ADS_OAUTH_NONCE_PREFIX;

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const startRoute = createRoute({
  method: 'post',
  path: '/amazon/oauth/start',
  tags: ['Amazon'],
  summary: 'Amazon-Ads-Konto verbinden oder neu verbinden (nur Admin)',
  description:
    'Liefert die Einwilligungs-URL mit signiertem, einmal verwendbarem `state` (10 Minuten gültig). ' +
    'Amazon leitet danach auf `/api/amazon/oauth/callback` zurück, der Callback auf ' +
    '`/admin/connections?oauth=<Ergebnis>`.',
  request: { body: { required: true, content: json(amazonOAuthStartSchema) } },
  responses: {
    200: { description: 'Einwilligungs-URL.', content: json(amazonOAuthRedirectSchema) },
    400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
    401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
    403: { description: 'Keine Admin-Rolle.', content: json(errorResponseSchema) },
    404: { description: 'Connection nicht gefunden.', content: json(errorResponseSchema) },
  },
});

export function registerAmazonOAuthRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db, logger, amazonAds, keyring, oauthStateSecret } = deps;
  const resultUrl = (result: AmazonOAuthResult) => {
    const url = new URL('/admin/connections', deps.appUrl);
    url.searchParams.set('oauth', result);
    return url.toString();
  };

  app.openapi({ ...startRoute, middleware: orgAdminOnly(deps) }, async (c) => {
    const { user, activeOrganization } = c.get('auth');
    // requireRole garantiert eine aktive Organisation.
    const organizationId = activeOrganization!.organizationId;
    const body = c.req.valid('json');

    let region = body.region ?? 'eu';
    let connectionId: string | null = null;
    if (body.connectionId) {
      const connection = await findConnection(db, organizationId, body.connectionId);
      if (!connection) {
        throw new ApiError(404, 'CONNECTION_NOT_FOUND', 'Connection nicht gefunden.');
      }
      if (!connection.region || (body.region && body.region !== connection.region)) {
        throw new ApiError(
          400,
          'VALIDATION_ERROR',
          'region: passt nicht zur Region der Connection.',
        );
      }
      region = connection.region;
      connectionId = connection.id;
    }

    const payload: OAuthStatePayload = {
      organizationId,
      userId: user.id,
      connectionId,
      region,
      nonce: randomBytes(24).toString('base64url'),
      expiresAt: Date.now() + STATE_TTL_MS,
    };
    // Abgelaufene Nonces nebenbei aufräumen (zusätzlich täglich im Job `job-runs-cleanup`).
    await deleteExpiredOAuthNonces(db, new Date());
    await db.insert(verifications).values({
      identifier: `${NONCE_PREFIX}${payload.nonce}`,
      value: user.id,
      expiresAt: new Date(payload.expiresAt),
    });

    const state = signOAuthState(payload, oauthStateSecret);
    return c.json({ url: amazonAds.client.buildAuthorizeUrl({ region, state }) }, 200);
  });

  // Browser-Redirect von Amazon, kein JSON-Endpunkt: Ergebnisse und Fehler gehen als Hinweis an die
  // Connections-Seite. Bewusst nicht im OpenAPI-Dokument. Der Request-Logger loggt nur den Pfad.
  app.get(AMAZON_OAUTH_CALLBACK_PATH.slice('/api'.length), async (c) => {
    try {
      return c.redirect(resultUrl(await handleCallback(c)), 302);
    } catch (error) {
      // Auch unerwartete Fehler (z. B. Datenbank) landen als Hinweis auf der Connections-Seite.
      logger({
        level: 'error',
        msg: 'amazon_oauth.callback_error',
        requestId: c.get('requestId'),
        ...errorLogFields(error),
      });
      return c.redirect(resultUrl('internal_error'), 302);
    }
  });

  async function handleCallback(c: Context<AppEnv>): Promise<AmazonOAuthResult> {
    const query = c.req.query();
    const verified = verifyOAuthState(query.state ?? '', { secret: oauthStateSecret });
    if (!verified.ok) {
      if (query.error) return query.error === 'access_denied' ? 'access_denied' : 'amazon_error';
      return verified.reason === 'expired' ? 'state_expired' : 'invalid_state';
    }
    const state = verified.payload;

    const userId = await sessionUserId(c, deps);
    if (userId !== state.userId) return 'session_mismatch';

    // Einmal verwendbar: Die Nonce wird gelöscht, bevor irgendetwas anderes passiert.
    const consumed = await db
      .delete(verifications)
      .where(
        and(
          eq(verifications.identifier, `${NONCE_PREFIX}${state.nonce}`),
          eq(verifications.value, state.userId),
          gt(verifications.expiresAt, new Date()),
        ),
      )
      .returning({ id: verifications.id });
    if (consumed.length === 0) return 'state_used';

    if (query.error) return query.error === 'access_denied' ? 'access_denied' : 'amazon_error';
    if ((await getOrgRole(db, state.userId, state.organizationId)) !== 'admin') {
      return 'forbidden';
    }

    const existing = state.connectionId
      ? await findConnection(db, state.organizationId, state.connectionId)
      : null;
    if (state.connectionId && !existing) return 'connection_not_found';
    if (!query.code) return 'amazon_error';

    let refreshToken: string;
    let identity: { userId: string; email: string | null };
    try {
      const tokens = await amazonAds.client.exchangeCode({
        region: state.region,
        code: query.code,
      });
      refreshToken = tokens.refreshToken;
      identity = await amazonAds.client.getAccountIdentity({
        region: state.region,
        accessToken: tokens.accessToken,
      });
    } catch (error) {
      if (!(error instanceof AmazonAdsError)) throw error;
      logger({
        level: 'warn',
        msg: 'amazon_oauth.callback_failed',
        requestId: c.get('requestId'),
        organizationId: state.organizationId,
        operation: error.operation,
        error: error.name,
        ...('status' in error && { status: error.status }),
      });
      return 'amazon_error';
    }

    if (existing && existing.externalAccountId !== identity.userId) return 'account_mismatch';

    const naturalKey = {
      organizationId: state.organizationId,
      provider: 'amazon_ads' as const,
      region: state.region,
      externalAccountId: identity.userId,
    };
    const refreshTokenEncrypted = encrypt(refreshToken, {
      keyring,
      aad: connectionTokenAad(naturalKey),
    });
    const connection = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(connections)
        .values({
          ...naturalKey,
          externalAccountEmail: identity.email,
          refreshTokenEncrypted,
          status: 'active',
          lastRefreshedAt: new Date(),
          createdBy: state.userId,
        })
        .onConflictDoUpdate({
          target: [
            connections.organizationId,
            connections.provider,
            connections.region,
            connections.externalAccountId,
          ],
          set: {
            externalAccountEmail: identity.email,
            refreshTokenEncrypted,
            status: 'active',
            lastRefreshedAt: new Date(),
          },
        })
        // xmax = 0 nur bei frisch eingefügten Zeilen (Postgres-Systemspalte).
        .returning({ id: connections.id, inserted: sql<boolean>`(xmax = 0)` });
      if (!row) throw new Error('Upsert der Connection lieferte keine Zeile.');
      await recordAuditEvent(tx, {
        organizationId: state.organizationId,
        actorUserId: state.userId,
        action: row.inserted ? 'connection.create' : 'connection.reconnect',
        target: {
          type: 'connection',
          id: row.id,
          provider: naturalKey.provider,
          region: naturalKey.region,
          externalAccountId: naturalKey.externalAccountId,
        },
      });
      return row;
    });

    // Ein noch gecachtes Access-Token gehört zum alten Refresh-Token.
    amazonAds.client.invalidateAccessToken(connection.id);

    try {
      await deps.jobs.enqueueProfilesSync({
        organizationId: state.organizationId,
        connectionId: connection.id,
      });
    } catch (error) {
      logger({
        level: 'error',
        msg: 'amazon_oauth.profiles_sync_not_queued',
        requestId: c.get('requestId'),
        connectionId: connection.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return 'connected_sync_failed';
    }
    return 'connected';
  }

  // Simulierte Einwilligungsseite, nur im Mock-Modus. Nicht im OpenAPI-Dokument (modusabhängig).
  const { mockConsent } = amazonAds;
  if (mockConsent) {
    app.get(MOCK_CONSENT_PATH.slice('/api'.length), (c) => {
      const state = c.req.query('state');
      if (!state || state.length > MAX_OAUTH_STATE_LENGTH) {
        return errorResponse(c, 400, 'VALIDATION_ERROR', 'state: fehlt oder ist zu lang.');
      }
      c.header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'none'",
      );
      c.header('Referrer-Policy', 'no-referrer');
      return c.html(renderMockConsentPage({ redirectUri: mockConsent.redirectUri, state }));
    });
  }
}

/**
 * Nutzer der Session oder `null`. Wie `requireSession`, aber ohne 401: Der Callback antwortet immer
 * mit einem Redirect. Eine von better-auth verlängerte Session wird an den Browser weitergereicht.
 */
async function sessionUserId(c: Context<AppEnv>, { auth }: Pick<AppDeps, 'auth'>) {
  const { headers, response } = await auth.api.getSession({
    headers: c.req.raw.headers,
    returnHeaders: true,
  });
  for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
  return response?.user.id ?? null;
}
