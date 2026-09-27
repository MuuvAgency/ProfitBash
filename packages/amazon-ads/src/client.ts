import type { z } from 'zod';
import {
  createAccessTokenProvider,
  type ConnectionRef,
  type RefreshTokenStore,
} from './access-token';
import { downloadFile, type AmazonAdsDownload } from './download';
import { AmazonAdsHttpError } from './errors';
import {
  createHttpClient,
  type HttpClientOptions,
  type HttpMethod,
  type RequestMeter,
  type RequestPacing,
} from './http';
import { noopLogger, type Logger } from './logger';
import {
  createLwaClient,
  type AccountIdentity,
  type AmazonAdsCredentials,
  type TokenSet,
} from './lwa';
import { listPortfolios, type AmazonAdsPortfolio } from './portfolios';
import { normalizeProfiles, profileResponseSchema, type AmazonAdsProfile } from './profiles';
import { createProfileRateLimiter, type ProfileRateLimiterOptions } from './rate-limit';
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
  /** `string` für Endpunkte mit Beträgen (siehe `HttpRequest.decimals`). */
  decimals?: 'number' | 'string';
  retryServerErrors?: boolean;
  /** Zähler des aufrufenden Jobs (Anfragen, 429, Wiederholungen). */
  meter?: RequestMeter;
}

export interface RequestOptions {
  /** Zähler des aufrufenden Jobs (Anfragen, 429, Wiederholungen). */
  meter?: RequestMeter;
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
  listProfiles(connection: ConnectionRef, options?: RequestOptions): Promise<AmazonAdsProfile[]>;
  /**
   * Lädt eine Report- oder Export-Datei von der signierten URL aus der Status-Antwort (nur erlaubte Hosts,
   * ohne Token). Liefert den rohen gzip-Body; entpacken mit `decodeGzipJson`.
   */
  downloadFile(url: string): Promise<AmazonAdsDownload>;
  /** Alle Portfolios eines Profils (synchron, paginiert). */
  listPortfolios(
    connection: ConnectionRef,
    amazonProfileId: string,
    options?: RequestOptions,
  ): Promise<AmazonAdsPortfolio[]>;
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
  /**
   * Anfrage-Budget je Profil (gilt für Aufrufe mit `amazonProfileId`). Uhr und Warten kommen aus
   * `http`. Standard 2 Anfragen/s, siehe `rate-limit.ts`.
   */
  rateLimit?: Omit<ProfileRateLimiterOptions, 'now' | 'sleep'>;
  /** Standard: die echten Amazon-Endpunkte */
  regions?: Readonly<Record<AmazonAdsRegion, AmazonAdsRegionEndpoints>>;
}

/** Ein Download (bis zu 50 MB entpackt) darf länger dauern als eine API-Anfrage. */
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Höchstens ca. 25 s unter der Sperre: 3 Versuche à 10 s plus kurzer Backoff. */
export const LWA_HTTP_DEFAULTS = { timeoutMs: 10_000, maxAttempts: 3, maxRetryAfterMs: 5_000 };

/** Ein 401 erzwingt höchstens so oft einen Refresh je Connection (401 heißt auch „Profil gesperrt“). */
const FORCED_REFRESH_INTERVAL_MS = 60_000;

export function createAmazonAdsClient(options: AmazonAdsClientOptions): AmazonAdsClient {
  const logger = options.logger ?? noopLogger;
  const regions = options.regions ?? AMAZON_ADS_REGIONS;
  const now = options.http?.now ?? Date.now;
  const fetchImpl: typeof fetch =
    options.http?.fetch ?? ((input, init) => globalThis.fetch(input, init));
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
  const rateLimiter = createProfileRateLimiter({
    ...options.rateLimit,
    now,
    ...(options.http?.sleep && { sleep: options.http.sleep }),
  });

  /** Budget je Profil. Profil-IDs sind je Region vergeben, deshalb Region im Schlüssel. */
  function pacingFor(connection: ConnectionRef, amazonProfileId: string): RequestPacing {
    const key = `${connection.region}:${amazonProfileId}`;
    return {
      acquire: (maxPauseMs) => rateLimiter.acquire(key, { maxPauseMs }),
      onThrottled: (retryAfterMs) => rateLimiter.onThrottled(key, retryAfterMs),
      onSuccess: () => rateLimiter.onSuccess(key),
    };
  }

  async function request<S extends z.ZodType>(
    connection: ConnectionRef,
    req: AdsApiRequest<S>,
  ): Promise<z.output<S>> {
    const url = apiUrl(regions[connection.region].apiHost, req.path, req.query);
    const pacing =
      req.amazonProfileId === undefined ? undefined : pacingFor(connection, req.amazonProfileId);

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
        ...(req.decimals && { decimals: req.decimals }),
        ...(req.retryServerErrors !== undefined && { retryServerErrors: req.retryServerErrors }),
        ...(req.meter && { meter: req.meter }),
        ...(pacing && { pacing }),
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
        // Der Neuversand wiederholt denselben Aufruf; `send` zählt ihn als neue Anfrage.
        if (req.meter) req.meter.retries += 1;
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
    async listProfiles(connection, requestOptions = {}) {
      const response = await request(connection, {
        operation: 'profiles.list',
        method: 'GET',
        path: '/v2/profiles',
        schema: profileResponseSchema,
        ...(requestOptions.meter && { meter: requestOptions.meter }),
      });
      return normalizeProfiles(response, logger);
    },
    listPortfolios: (connection, amazonProfileId, requestOptions) =>
      listPortfolios({ request, logger }, connection, amazonProfileId, requestOptions),
    downloadFile: (url) =>
      downloadFile(url, { fetch: fetchImpl, logger, timeoutMs: DOWNLOAD_TIMEOUT_MS }),
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
