import {
  AMAZON_ADS_REGIONS,
  AmazonAdsHttpError,
  AmazonAdsResponseError,
  collectDownload,
  createAccessTokenProvider,
  createHttpClient,
  createLwaClient,
  createProfileRateLimiter,
  downloadFile,
  LWA_HTTP_DEFAULTS,
  type AccessTokenProvider,
  type AmazonAdsRegion,
  type ConnectionRef,
  type HttpClientOptions,
  type HttpMethod,
  type Logger,
  type RefreshTokenStore,
  type RequestOptions,
} from '@profitbash/amazon-ads';
import { z } from 'zod';
import { AmazonSpRoleMissingError } from './errors';
import { AMAZON_SP_REGIONS, type AmazonSpRegionEndpoints } from './regions';

/**
 * Client für die Selling Partner API. LwA, Token-Cache, HTTP-Kern (Retry, verlustfreies JSON, zod) und
 * Anfrage-Budget kommen aus `@profitbash/amazon-ads` (ADR 007). Unterschiede zur Ads-API: das Token steht
 * in `x-amz-access-token`, die Zugangsdaten der App gehören zur Connection (`credentialsFor`, phase-7 F1),
 * und das Budget gilt je Operation.
 */

/** Client-ID und Secret der SP-API-App, über die diese Connection autorisiert wurde. */
export interface AmazonSpCredentials {
  clientId: string;
  clientSecret: string;
}

export interface AmazonSpMarketplaceParticipation {
  marketplaceId: string;
  countryCode: string;
  currencyCode: string;
  domainName: string;
  storeName: string;
  isParticipating: boolean;
}

export interface CreateSpReportInput {
  /** z. B. `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL` */
  reportType: string;
  /** 1–25 Marktplätze */
  marketplaceIds: readonly string[];
  /** ISO 8601 */
  dataStartTime: string;
  dataEndTime: string;
}

/** `CANCELLED` meldet Amazon auch, wenn der Bericht keine Daten enthält. */
export type AmazonSpReportStatus =
  | { status: 'IN_QUEUE' | 'IN_PROGRESS' | 'FATAL' | 'CANCELLED' }
  | { status: 'DONE'; reportDocumentId: string }
  /** Amazon kennt die ID nicht (mehr), HTTP 404. */
  | { status: 'NOT_FOUND' };

export interface AmazonSpReportDocument {
  /** Signierte URL, läuft nach 5 Minuten ab: nie speichern oder loggen. */
  url: string;
  compressionAlgorithm: 'GZIP' | null;
}

export type AmazonSpReportFile = { status: 'ok'; text: string } | { status: 'expired' };

export interface AmazonSpClient {
  /** Marktplätze des Verkäuferkontos (Rolle „Selling Partner Insights“). Enthält keine Seller-ID. */
  getMarketplaceParticipations(
    connection: ConnectionRef,
    options?: RequestOptions,
  ): Promise<AmazonSpMarketplaceParticipation[]>;
  createReport(
    connection: ConnectionRef,
    input: CreateSpReportInput,
    options?: RequestOptions,
  ): Promise<{ reportId: string }>;
  getReport(
    connection: ConnectionRef,
    input: { reportId: string },
    options?: RequestOptions,
  ): Promise<AmazonSpReportStatus>;
  getReportDocument(
    connection: ConnectionRef,
    input: { reportDocumentId: string },
    options?: RequestOptions,
  ): Promise<AmazonSpReportDocument>;
  /** Lädt und entpackt ein Dokument (ohne Token, nur S3-Hosts) und liest es im Zeichensatz der Datei. */
  downloadReportDocument(
    document: AmazonSpReportDocument,
    options: { maxBytes: number },
  ): Promise<AmazonSpReportFile>;
  /** Verwirft Token und Zugangsdaten einer Connection (nach Neu-Verbinden oder Trennen). */
  invalidateAccessToken(connectionId: string): void;
}

export interface AmazonSpClientOptions {
  credentialsFor: (connection: ConnectionRef) => Promise<AmazonSpCredentials>;
  store: RefreshTokenStore;
  logger?: Logger;
  http?: Omit<HttpClientOptions, 'logger'>;
  regions?: Readonly<Record<AmazonAdsRegion, AmazonSpRegionEndpoints>>;
}

/**
 * Standardraten je Operation (Anfragen/s) aus der API-Referenz, Stand 2026-10-12. Der Header
 * `x-amzn-RateLimit-Limit` ist laut Amazon nicht verlässlich und wird nicht ausgewertet.
 * shortcut: kein Burst (Amazon erlaubt 10–15 Anfragen am Stück), die zweite Anfrage wartet schon;
 * anpassen, wenn Jobs dadurch zu langsam werden.
 */
const RATES = {
  'sellers.marketplace_participations': 0.016,
  'reports.create': 0.0167,
  'reports.get': 2,
  'reports.get_document': 0.0167,
} as const;
type Operation = keyof typeof RATES;

/**
 * Signierte Dokument-URLs zeigen auf S3. Die Doku nennt keinen festen Host; Downloads senden nie
 * Zugangsdaten, deshalb genügt „S3 unter amazonaws.com“ (beim ersten echten Lauf, 7.12, eingrenzen).
 */
const DOWNLOAD_HOSTS = [
  /^[a-z0-9.-]+\.s3[.-][a-z0-9.-]*amazonaws\.com$/,
  /^[a-z0-9.-]+\.s3\.amazonaws\.com$/,
];
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const FORCED_REFRESH_INTERVAL_MS = 60_000;
const USER_AGENT = 'ProfitBash/1.0 (Language=TypeScript)';

const participationsSchema = z.object({
  payload: z.array(
    z.object({
      marketplace: z.object({
        id: z.string().min(1),
        countryCode: z.string().min(1),
        defaultCurrencyCode: z.string().min(1),
        domainName: z.string(),
      }),
      participation: z.object({ isParticipating: z.boolean() }),
      storeName: z.string(),
    }),
  ),
});

const createReportSchema = z.object({ reportId: z.string().min(1) });

const reportSchema = z.object({
  processingStatus: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'DONE', 'FATAL', 'CANCELLED']),
  reportDocumentId: z.string().min(1).optional(),
});

const reportDocumentSchema = z.object({
  url: z.string().min(1),
  compressionAlgorithm: z.literal('GZIP').optional(),
});

export function createAmazonSpClient(options: AmazonSpClientOptions): AmazonSpClient {
  const logger: Logger = options.logger ?? (() => {});
  const regions = options.regions ?? AMAZON_SP_REGIONS;
  const now = options.http?.now ?? Date.now;
  const fetchImpl: typeof fetch =
    options.http?.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const http = createHttpClient({ ...options.http, logger });
  const lwaHttp = createHttpClient({ ...options.http, ...LWA_HTTP_DEFAULTS, logger });
  // `createLwaClient` erwartet die Endpunkte im Ads-Format; benutzt wird hier nur `tokenUrl`.
  const lwaRegions = {
    eu: { ...AMAZON_ADS_REGIONS.eu, ...regions.eu },
    na: { ...AMAZON_ADS_REGIONS.na, ...regions.na },
    fe: { ...AMAZON_ADS_REGIONS.fe, ...regions.fe },
  };
  const tokens = new Map<string, Promise<AccessTokenProvider>>();
  const lastForcedRefresh = new Map<string, number>();
  const limiters = new Map<Operation, ReturnType<typeof createProfileRateLimiter>>();

  /** Je Connection ein eigener Token-Cache, weil jede ihre eigenen App-Zugangsdaten haben kann. */
  function tokensFor(connection: ConnectionRef): Promise<AccessTokenProvider> {
    let provider = tokens.get(connection.id);
    if (!provider) {
      provider = options.credentialsFor(connection).then((credentials) =>
        createAccessTokenProvider({
          lwa: createLwaClient({
            credentials: { ...credentials, redirectUri: '' },
            http: lwaHttp,
            regions: lwaRegions,
          }),
          store: options.store,
          logger,
          now,
        }),
      );
      tokens.set(connection.id, provider);
      // Ein Fehler beim Lesen der Zugangsdaten darf nicht im Cache bleiben.
      provider.catch(() => tokens.delete(connection.id));
    }
    return provider;
  }

  /** Budget je Operation und Connection (Amazon zählt je Verkäufer und App). */
  function pacingFor(operation: Operation, connection: ConnectionRef) {
    let limiter = limiters.get(operation);
    if (!limiter) {
      const rate = RATES[operation];
      limiter = createProfileRateLimiter({
        requestsPerSecond: rate,
        minRequestsPerSecond: rate / 4,
        increasePerSuccess: rate / 20,
        now,
        ...(options.http?.sleep && { sleep: options.http.sleep }),
      });
      limiters.set(operation, limiter);
    }
    const active = limiter;
    return {
      acquire: (maxPauseMs: number) => active.acquire(connection.id, { maxPauseMs }),
      onThrottled: (retryAfterMs: number | null) => active.onThrottled(connection.id, retryAfterMs),
      onSuccess: () => active.onSuccess(connection.id),
    };
  }

  async function request<S extends z.ZodType>(
    connection: ConnectionRef,
    req: {
      operation: Operation;
      method: HttpMethod;
      path: string;
      body?: string;
      schema: S;
      meter?: RequestOptions['meter'];
    },
  ): Promise<z.output<S>> {
    const url = new URL(req.path, regions[connection.region].apiHost);
    const pacing = pacingFor(req.operation, connection);
    const send = async () => {
      const accessToken = await (await tokensFor(connection)).getAccessToken(connection);
      return http.send({
        operation: req.operation,
        method: req.method,
        url,
        headers: {
          'x-amz-access-token': accessToken,
          'x-amz-date': new Date(now()).toISOString().replace(/[-:]|\.\d{3}/g, ''),
          'user-agent': USER_AGENT,
          ...(req.body !== undefined && { 'Content-Type': 'application/json' }),
        },
        ...(req.body !== undefined && { body: req.body }),
        schema: req.schema,
        ...(req.meter && { meter: req.meter }),
        pacing,
      });
    };

    try {
      return await send();
    } catch (error) {
      if (
        !(error instanceof AmazonAdsHttpError) ||
        (error.status !== 401 && error.status !== 403)
      ) {
        throw error;
      }
      // Die SP-API meldet ein abgelaufenes Token wie eine fehlende Rolle (403 „Unauthorized“): einmal mit
      // frischem Token versuchen, höchstens einmal je Minute und Connection.
      const last = lastForcedRefresh.get(connection.id);
      if (last === undefined || now() - last >= FORCED_REFRESH_INTERVAL_MS) {
        lastForcedRefresh.set(connection.id, now());
        (await tokensFor(connection)).invalidate(connection.id);
        if (req.meter) req.meter.retries += 1;
        try {
          return await send();
        } catch (retryError) {
          throw asRoleMissing(retryError);
        }
      }
      throw asRoleMissing(error);
    }
  }

  return {
    async getMarketplaceParticipations(connection, requestOptions = {}) {
      const response = await request(connection, {
        operation: 'sellers.marketplace_participations',
        method: 'GET',
        path: '/sellers/v1/marketplaceParticipations',
        schema: participationsSchema,
        ...(requestOptions.meter && { meter: requestOptions.meter }),
      });
      return response.payload.map((entry) => ({
        marketplaceId: entry.marketplace.id,
        countryCode: entry.marketplace.countryCode,
        currencyCode: entry.marketplace.defaultCurrencyCode,
        domainName: entry.marketplace.domainName,
        storeName: entry.storeName,
        isParticipating: entry.participation.isParticipating,
      }));
    },

    createReport: (connection, input, requestOptions = {}) =>
      request(connection, {
        operation: 'reports.create',
        method: 'POST',
        path: '/reports/2021-06-30/reports',
        body: JSON.stringify({
          reportType: input.reportType,
          marketplaceIds: input.marketplaceIds,
          dataStartTime: input.dataStartTime,
          dataEndTime: input.dataEndTime,
        }),
        schema: createReportSchema,
        ...(requestOptions.meter && { meter: requestOptions.meter }),
      }),

    async getReport(connection, input, requestOptions = {}) {
      const operation = 'reports.get';
      let report: z.output<typeof reportSchema>;
      try {
        report = await request(connection, {
          operation,
          method: 'GET',
          path: `/reports/2021-06-30/reports/${encodeURIComponent(input.reportId)}`,
          schema: reportSchema,
          ...(requestOptions.meter && { meter: requestOptions.meter }),
        });
      } catch (error) {
        if (error instanceof AmazonAdsHttpError && error.status === 404) {
          return { status: 'NOT_FOUND' };
        }
        throw error;
      }
      if (report.processingStatus !== 'DONE') return { status: report.processingStatus };
      if (!report.reportDocumentId) {
        throw new AmazonAdsResponseError(
          `${operation}: Der Bericht ist fertig, aber Amazon nennt kein Dokument.`,
          operation,
        );
      }
      return { status: 'DONE', reportDocumentId: report.reportDocumentId };
    },

    async getReportDocument(connection, input, requestOptions = {}) {
      const document = await request(connection, {
        operation: 'reports.get_document',
        method: 'GET',
        path: `/reports/2021-06-30/documents/${encodeURIComponent(input.reportDocumentId)}`,
        schema: reportDocumentSchema,
        ...(requestOptions.meter && { meter: requestOptions.meter }),
      });
      return { url: document.url, compressionAlgorithm: document.compressionAlgorithm ?? null };
    },

    async downloadReportDocument(document, { maxBytes }) {
      const operation = 'reports.download';
      const download = await downloadFile(document.url, {
        fetch: fetchImpl,
        logger,
        timeoutMs: DOWNLOAD_TIMEOUT_MS,
        allowedHosts: DOWNLOAD_HOSTS,
      });
      if (download.status === 'expired') return download;
      const bytes = await collectDownload(download.body, {
        maxBytes,
        gzip: document.compressionAlgorithm === 'GZIP',
        operation,
      });
      return { status: 'ok', text: decodeText(bytes, download.contentType, operation) };
    },

    invalidateAccessToken(connectionId) {
      tokens.delete(connectionId);
    },
  };
}

function asRoleMissing(error: unknown): unknown {
  return error instanceof AmazonAdsHttpError && error.status === 403
    ? new AmazonSpRoleMissingError(error.operation, error.amazonRequestId, error.details)
    : error;
}

/** Zeichensatz aus dem `Content-Type` der Datei (Amazon nennt z. B. `Cp1252`); ohne Angabe UTF-8. */
function decodeText(bytes: Buffer, contentType: string | null, operation: string): string {
  const charset =
    /charset=([^;\s]+)/i.exec(contentType ?? '')?.[1]?.replace(/^"|"$/g, '') ?? 'utf-8';
  try {
    return new TextDecoder(charset.replace(/^cp(\d+)$/i, 'windows-$1')).decode(bytes);
  } catch {
    throw new AmazonAdsResponseError(`${operation}: Unbekannter Zeichensatz der Datei.`, operation);
  }
}
