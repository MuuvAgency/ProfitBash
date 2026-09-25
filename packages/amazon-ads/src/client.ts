import type { z } from 'zod';
import {
  createAccessTokenProvider,
  type ConnectionRef,
  type RefreshTokenStore,
} from './access-token';
import { AmazonAdsHttpError } from './errors';
import { createHttpClient, type HttpClientOptions, type HttpMethod } from './http';
import { noopLogger, type Logger } from './logger';
import {
  createLwaClient,
  type AccountIdentity,
  type AmazonAdsCredentials,
  type TokenSet,
} from './lwa';
import { normalizeProfiles, profileResponseSchema, type AmazonAdsProfile } from './profiles';
import { AMAZON_ADS_REGIONS, type AmazonAdsRegion, type AmazonAdsRegionEndpoints } from './regions';

export interface AdsApiRequest<S extends z.ZodType> {
  operation: string;
  method: HttpMethod;
  /** Pfad relativ zum API-Host der Region, z. B. `/v2/profiles`. Keine vollständigen URLs. */
  path: string;
  query?: Record<string, string>;
  /** Setzt `Amazon-Advertising-API-Scope` (fast alle Endpunkte außer `/v2/profiles`). */
  amazonProfileId?: string;
  headers?: Record<string, string>;
  body?: string;
  schema: S;
  retryServerErrors?: boolean;
}

/**
 * Schnittstelle zu Amazon Ads. Echte API und Mock-Anbieter (`createMockAmazonAdsClient`) erfüllen
 * sie gleichermaßen.
 */
export interface AmazonAdsClient {
  buildAuthorizeUrl(input: { region: AmazonAdsRegion; state: string }): string;
  exchangeCode(input: { region: AmazonAdsRegion; code: string }): Promise<TokenSet>;
  getAccountIdentity(input: {
    region: AmazonAdsRegion;
    accessToken: string;
  }): Promise<AccountIdentity>;
  getAccessToken(connection: ConnectionRef): Promise<string>;
  /** Verwirft das gecachte Access-Token einer Connection (z. B. nach dem Neu-Verbinden). */
  invalidateAccessToken(connectionId: string): void;
  request<S extends z.ZodType>(
    connection: ConnectionRef,
    request: AdsApiRequest<S>,
  ): Promise<z.output<S>>;
  listProfiles(connection: ConnectionRef): Promise<AmazonAdsProfile[]>;
}

export interface AmazonAdsClientOptions {
  credentials: AmazonAdsCredentials;
  store: RefreshTokenStore;
  logger?: Logger;
  /** Retry, Timeout, `fetch` usw. (siehe `HttpClientOptions`) */
  http?: Omit<HttpClientOptions, 'logger'>;
  /**
   * Abweichende Limits für LWA (Code-Tausch, Refresh, Identität). Der Refresh läuft unter der
   * DB-Sperre der Connection und soll deshalb schnell scheitern statt lange zu warten.
   * Standard: `LWA_HTTP_DEFAULTS`.
   */
  lwaHttp?: Pick<HttpClientOptions, 'timeoutMs' | 'maxAttempts' | 'maxRetryAfterMs'>;
  /** Standard: die echten Amazon-Endpunkte */
  regions?: Readonly<Record<AmazonAdsRegion, AmazonAdsRegionEndpoints>>;
}

/** Höchstens ca. 25 s unter der Sperre: 3 Versuche à 10 s plus kurzer Backoff. */
export const LWA_HTTP_DEFAULTS = { timeoutMs: 10_000, maxAttempts: 3, maxRetryAfterMs: 5_000 };

/** Ein 401 erzwingt höchstens so oft einen Refresh je Connection (401 heißt auch „Profil gesperrt“). */
const FORCED_REFRESH_INTERVAL_MS = 60_000;

export function createAmazonAdsClient(options: AmazonAdsClientOptions): AmazonAdsClient {
  const logger = options.logger ?? noopLogger;
  const regions = options.regions ?? AMAZON_ADS_REGIONS;
  const now = options.http?.now ?? Date.now;
  const http = createHttpClient({ ...options.http, logger });
  const lwaHttp = createHttpClient({
    ...options.http,
    ...LWA_HTTP_DEFAULTS,
    ...options.lwaHttp,
    logger,
  });
  const lwa = createLwaClient({ credentials: options.credentials, http: lwaHttp, regions });
  const tokens = createAccessTokenProvider({ lwa, store: options.store, logger, now });
  const lastForcedRefresh = new Map<string, number>();

  async function request<S extends z.ZodType>(
    connection: ConnectionRef,
    req: AdsApiRequest<S>,
  ): Promise<z.output<S>> {
    const url = apiUrl(regions[connection.region].apiHost, req.path, req.query);

    const send = async () => {
      const accessToken = await tokens.getAccessToken(connection);
      return http.send({
        operation: req.operation,
        method: req.method,
        url,
        headers: {
          ...req.headers,
          Authorization: `Bearer ${accessToken}`,
          'Amazon-Advertising-API-ClientId': options.credentials.clientId,
          ...(req.amazonProfileId !== undefined && {
            'Amazon-Advertising-API-Scope': req.amazonProfileId,
          }),
        },
        ...(req.body !== undefined && { body: req.body }),
        schema: req.schema,
        ...(req.retryServerErrors !== undefined && { retryServerErrors: req.retryServerErrors }),
      });
    };

    try {
      return await send();
    } catch (error) {
      // Access-Token abgelaufen oder widerrufen: einmal mit frischem Token versuchen. Amazon meldet
      // 401 aber auch für nicht zugängliche Profile; deshalb höchstens ein erzwungener Refresh je
      // Minute und Connection, sonst gingen bei vielen gesperrten Profilen unnötige LWA-Aufrufe raus.
      if (error instanceof AmazonAdsHttpError && error.status === 401) {
        const last = lastForcedRefresh.get(connection.id);
        if (last !== undefined && now() - last < FORCED_REFRESH_INTERVAL_MS) throw error;
        lastForcedRefresh.set(connection.id, now());
        tokens.invalidate(connection.id);
        return send();
      }
      throw error;
    }
  }

  return {
    buildAuthorizeUrl: (input) => lwa.buildAuthorizeUrl(input),
    exchangeCode: (input) => lwa.exchangeCode(input),
    getAccountIdentity: (input) => lwa.getAccountIdentity(input),
    getAccessToken: (connection) => tokens.getAccessToken(connection),
    invalidateAccessToken: (connectionId) => tokens.invalidate(connectionId),
    request,
    async listProfiles(connection) {
      const response = await request(connection, {
        operation: 'profiles.list',
        method: 'GET',
        path: '/v2/profiles',
        schema: profileResponseSchema,
      });
      return normalizeProfiles(response, logger);
    },
  };
}

/** Baut die URL aus Host und Pfad. Vollständige URLs sind verboten: Tokens gehen nur an Amazon. */
function apiUrl(apiHost: string, path: string, query: Record<string, string> = {}): URL {
  if (!path.startsWith('/') || path.startsWith('//')) {
    throw new TypeError('request: path muss ein Pfad relativ zum API-Host sein (beginnt mit "/").');
  }
  const url = new URL(path, apiHost);
  if (url.origin !== new URL(apiHost).origin) {
    throw new TypeError('request: path darf den API-Host nicht verlassen.');
  }
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  return url;
}
