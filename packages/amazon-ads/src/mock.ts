import { randomBytes } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient, type AmazonAdsClient, type AmazonAdsClientOptions } from './client';
import { EXPORT_CONTENT_TYPES, type AmazonAdsExportType } from './exports';
import { parseJsonLossless } from './json';
import type { Logger } from './logger';
import { AMAZON_ADS_SCOPES } from './lwa';
import {
  mockAccount,
  mockExportRows,
  mockPortfolios,
  mockReportRows,
  toAmazonJson,
  type MockAccount,
  type MockProfile,
} from './mock-data';
import { LARGE_MOCK_PROFILES, largeMockAccount } from './mock-large';
import { createMockWrites, type MockWriteSimulation } from './mock-writes';
import { PORTFOLIOS_CONTENT_TYPE } from './portfolios';
import {
  REPORT_CREATE_CONTENT_TYPE,
  REPORT_DEFINITIONS,
  type AmazonAdsReportType,
} from './reports';
import { AMAZON_ADS_REGIONS, type AmazonAdsRegion, type AmazonAdsRegionEndpoints } from './regions';

/**
 * Mock-Anbieter (`AMAZON_ADS_USE_MOCK=true`): Phase 0 ist ohne Ads-API-Freigabe vorführbar.
 *
 * Es ist der echte Client mit zwei Unterschieden:
 * - Die Einwilligung führt auf eine simulierte Seite (`consentUrl`, die API rendert sie mit
 *   `renderMockConsentPage`), die mit einem Test-Code zum Callback zurückleitet.
 * - `fetch` beantwortet die Amazon-Endpunkte im Prozess. Kein Aufruf verlässt den Rechner.
 * Dadurch laufen Retry, verlustfreies Parsing, Validierung und Token-Store genau wie im Echtbetrieb.
 */

export const MOCK_AMAZON_ADS_AUTHORIZATION_CODE = 'mock-authorization-code';

export const MOCK_AMAZON_ADS_IDENTITY = {
  userId: 'amzn1.account.MOCKPROFITBASH0001',
  email: 'amazon-ads-mock@profitbash.test',
  name: 'Amazon Ads (Mock)',
} as const;

const MOCK_CLIENT_ID = 'amzn1.application-oa2-client.mock';
const ACCESS_PREFIX = 'Atza|mock-access-';
const REFRESH_PREFIX = 'Atzr|mock-refresh';

/**
 * Test-Profile als roher JSON-Text wie von Amazon. Die erste Profil-ID ist größer als
 * `Number.MAX_SAFE_INTEGER` und prüft das verlustfreie Parsing im Demo-Betrieb.
 */
const MOCK_PROFILES_JSON: Record<AmazonAdsRegion, string> = {
  eu: `[
    {"profileId": 9007199254740993, "countryCode": "DE", "currencyCode": "EUR", "dailyBudget": 999999999.99,
     "timezone": "Europe/Paris",
     "accountInfo": {"marketplaceStringId": "A1PA6795UKMFR9", "id": "A1MOCKSELLER01", "type": "seller",
                     "name": "Mock Seller DE", "validPaymentMethod": true}},
    {"profileId": 1234567890123456, "countryCode": "FR", "currencyCode": "EUR",
     "timezone": "Europe/Paris",
     "accountInfo": {"marketplaceStringId": "A13V1IB3VIYZZH", "id": "A1MOCKSELLER01", "type": "seller",
                     "name": "Mock Seller FR", "validPaymentMethod": true}},
    {"profileId": 2345678901234567, "countryCode": "UK", "currencyCode": "GBP",
     "timezone": "Europe/London",
     "accountInfo": {"marketplaceStringId": "A1F83G8C2ARO7P", "id": "ENTITY1MOCKVENDOR", "type": "vendor",
                     "name": "Mock Vendor UK", "validPaymentMethod": false}},
    {"profileId": 3456789012345678, "countryCode": "SE", "currencyCode": "SEK",
     "timezone": "Europe/Stockholm",
     "accountInfo": {"marketplaceStringId": "A2NODRKZP88ZB9", "id": "ENTITY2MOCKAGENCY", "type": "agency",
                     "name": "Mock Agency SE", "validPaymentMethod": true}}
  ]`,
  na: `[
    {"profileId": 4567890123456789, "countryCode": "US", "currencyCode": "USD",
     "timezone": "America/Los_Angeles",
     "accountInfo": {"marketplaceStringId": "ATVPDKIKX0DER", "id": "A1MOCKSELLER01", "type": "seller",
                     "name": "Mock Seller US", "validPaymentMethod": true}}
  ]`,
  fe: '[]',
};

export interface MockAmazonAdsClientOptions {
  /** Callback der App (wie `AMAZON_ADS_REDIRECT_URI`) */
  redirectUri: string;
  /** URL der simulierten Einwilligungsseite in der App */
  consentUrl: string;
  store: RefreshTokenStore;
  logger?: Logger;
  /** Anfrage-Budget je Profil wie beim echten Client. */
  rateLimit?: AmazonAdsClientOptions['rateLimit'];
  /** Verhalten der simulierten Reports und Exports (Verarbeitungszeit, Fehler auf Wunsch). */
  simulation?: MockAmazonAdsSimulation;
  /**
   * `AMAZON_ADS_MOCK_SCALE`: `default` (kleine Testdaten) oder `large` (Demo-Daten mit Volumen, nur Entwicklung;
   * statt der Test-Profile die 6 Demo-Profile aus `mock-large.ts`).
   */
  scale?: MockAmazonAdsScale;
}

export type MockAmazonAdsScale = 'default' | 'large';

export interface MockAmazonAdsSimulation extends MockWriteSimulation {
  /** Uhr des Mocks (Tests). Standard `Date.now`. */
  now?: () => number;
  /** So lange sind Reports und Exports in Arbeit. Standard 5 s. */
  processingMs?: number;
  /** Reports dieser Typen (`spSearchTerm` …) enden mit `FAILED`. */
  failingReportTypes?: readonly string[];
  /** 425 ohne Report-ID im Text (Amazon nennt sie nicht immer). */
  duplicatesWithoutId?: boolean;
}

export function createMockAmazonAdsClient(options: MockAmazonAdsClientOptions): AmazonAdsClient {
  const regions = Object.fromEntries(
    Object.entries(AMAZON_ADS_REGIONS).map(([region, endpoints]) => [
      region,
      { ...endpoints, authorizeUrl: options.consentUrl },
    ]),
  ) as Record<AmazonAdsRegion, AmazonAdsRegionEndpoints>;

  return createAmazonAdsClient({
    credentials: {
      clientId: MOCK_CLIENT_ID,
      clientSecret: 'mock-client-secret',
      redirectUri: options.redirectUri,
    },
    store: options.store,
    ...(options.logger && { logger: options.logger }),
    regions,
    http: {
      fetch: createMockFetch(
        options.redirectUri,
        options.simulation ?? {},
        options.scale ?? 'default',
      ),
    },
    ...(options.rateLimit && { rateLimit: options.rateLimit }),
  });
}

/**
 * Simulierte Amazon-Endpunkte für alle Regionen: LWA-Token, LWA-Profil, `/v2/profiles`, Portfolios, Exports,
 * Reporting v3, die S3-Downloads und die Schreib-Endpunkte für Sponsored Products (`mock-writes.ts`).
 */
function createMockFetch(
  redirectUri: string,
  simulation: MockAmazonAdsSimulation,
  scale: MockAmazonAdsScale,
): typeof fetch {
  const hosts = new Map<string, AmazonAdsRegion>();
  for (const [region, endpoints] of Object.entries(AMAZON_ADS_REGIONS)) {
    hosts.set(new URL(endpoints.apiHost).host, region as AmazonAdsRegion);
  }
  const data = MOCK_DATA[scale];
  const writes = createMockWrites(simulation);
  // Exports und Reports sehen die im Prozess gemerkten Änderungen (`mock-writes.ts`).
  const jobs = createMockJobs(simulation, {
    ...data,
    account: (profile) => writes.overlay(data.account(profile)),
  });
  const handleWrite = writes.handleWrite;

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const bearer = request.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';

    if (request.method === 'POST' && url.pathname === '/auth/o2/token') {
      const form = new URLSearchParams(await request.text());
      if (form.get('client_id') !== MOCK_CLIENT_ID) return lwaError('invalid_client');
      const grantType = form.get('grant_type');
      if (grantType === 'authorization_code') {
        if (
          form.get('code') !== MOCK_AMAZON_ADS_AUTHORIZATION_CODE ||
          form.get('redirect_uri') !== redirectUri
        ) {
          return lwaError('invalid_grant');
        }
        return tokenResponse(`${REFRESH_PREFIX}-${randomBytes(8).toString('hex')}`);
      }
      if (grantType === 'refresh_token') {
        const refreshToken = form.get('refresh_token') ?? '';
        // Wie bei Amazon: derselbe Refresh-Token kommt zurück. Fremde Tokens gelten als widerrufen.
        if (!refreshToken.startsWith(REFRESH_PREFIX)) return lwaError('invalid_grant');
        return tokenResponse(refreshToken);
      }
      return lwaError('unsupported_grant_type');
    }

    if (request.method === 'GET' && url.pathname === '/user/profile') {
      if (!bearer.startsWith(ACCESS_PREFIX)) return unauthorized();
      return Response.json({
        user_id: MOCK_AMAZON_ADS_IDENTITY.userId,
        email: MOCK_AMAZON_ADS_IDENTITY.email,
        name: MOCK_AMAZON_ADS_IDENTITY.name,
      });
    }

    const region = hosts.get(url.host);
    if (region && request.method === 'GET' && url.pathname === '/v2/profiles') {
      if (
        !bearer.startsWith(ACCESS_PREFIX) ||
        request.headers.get('amazon-advertising-api-clientid') !== MOCK_CLIENT_ID
      ) {
        return unauthorized();
      }
      return new Response(data.profilesJson[region], {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    if (region) {
      if (
        !bearer.startsWith(ACCESS_PREFIX) ||
        request.headers.get('amazon-advertising-api-clientid') !== MOCK_CLIENT_ID
      ) {
        return unauthorized();
      }
      const profile = data.profiles[region].find(
        (p) => p.amazonProfileId === request.headers.get('amazon-advertising-api-scope'),
      );
      const response =
        (await handleWrite(request, url, profile)) ??
        (await jobs.handleApi(request, url, region, profile));
      if (response) return response;
    }

    const download = jobs.handleDownload(request, url);
    if (download) return download;

    return Response.json(
      { code: 'NOT_FOUND', details: 'Im Mock nicht vorhanden.' },
      { status: 404 },
    );
  };
}

/** Demo-Profile als JSON wie von Amazon, nur in der EU. */
const LARGE_MOCK_PROFILES_JSON: Record<AmazonAdsRegion, string> = {
  eu: `[${LARGE_MOCK_PROFILES.map(
    (p) =>
      `{"profileId": ${p.amazonProfileId}, "countryCode": "${p.countryCode}", "currencyCode": "${p.currencyCode}",` +
      ` "timezone": "${p.timezone}", "accountInfo": {"marketplaceStringId": "${p.marketplaceId}",` +
      ` "id": "${p.accountId}", "type": "${p.accountType}", "name": "${p.accountName}", "validPaymentMethod": true}}`,
  ).join(',')}]`,
  na: '[]',
  fe: '[]',
};

interface MockData {
  profilesJson: Record<AmazonAdsRegion, string>;
  profiles: Record<AmazonAdsRegion, MockProfile[]>;
  account: (profile: MockProfile) => MockAccount;
}

const parseProfiles = (json: Record<AmazonAdsRegion, string>) =>
  Object.fromEntries(
    Object.entries(json).map(([region, text]) => [
      region,
      (
        parseJsonLossless(text) as Array<{
          profileId: string | number;
          currencyCode: string;
          accountInfo: { type: string };
        }>
      ).map((p) => ({
        amazonProfileId: String(p.profileId),
        currencyCode: p.currencyCode,
        accountType: p.accountInfo.type,
      })),
    ]),
  ) as Record<AmazonAdsRegion, MockProfile[]>;

const MOCK_DATA: Record<MockAmazonAdsScale, MockData> = {
  default: {
    profilesJson: MOCK_PROFILES_JSON,
    profiles: parseProfiles(MOCK_PROFILES_JSON),
    account: mockAccount,
  },
  large: {
    profilesJson: LARGE_MOCK_PROFILES_JSON,
    profiles: parseProfiles(LARGE_MOCK_PROFILES_JSON),
    account: largeMockAccount,
  },
};

/** S3-Regionen der simulierten Download-Hosts (passen zu `AMAZON_ADS_DOWNLOAD_HOST_PATTERNS`). */
const S3_REGIONS: Record<AmazonAdsRegion, string> = {
  eu: 'eu-west-1',
  na: 'us-east-1',
  fe: 'us-west-2',
};

const PORTFOLIO_PAGE_SIZE = 2;

/**
 * Auftrag im Mock. Die ID kodiert den ganzen Auftrag (Felder mit `_` getrennt): Auch ein neu gestarteter Prozess
 * kann einen laufenden Report abfragen und laden (Neustart-Szenario aus der DoD von Phase 1).
 */
type MockJob =
  | {
      kind: 'export';
      region: AmazonAdsRegion;
      profileId: string;
      exportType: AmazonAdsExportType;
      adProducts: string[];
      states: string[];
      createdAt: number;
    }
  | {
      kind: 'report';
      region: AmazonAdsRegion;
      profileId: string;
      reportType: AmazonAdsReportType;
      startDate: string;
      endDate: string;
      createdAt: number;
      fails: boolean;
    };

function encodeJob(job: MockJob): string {
  return job.kind === 'report'
    ? [
        'mock',
        'r',
        job.region,
        job.profileId,
        job.reportType,
        job.startDate,
        job.endDate,
        job.createdAt,
        job.fails ? 1 : 0,
      ].join('_')
    : [
        'mock',
        'e',
        job.region,
        job.profileId,
        job.exportType,
        job.adProducts.map(adProductCode).join('~'),
        job.states.join('~'),
        job.createdAt,
      ].join('_');
}

function decodeJob(id: string): MockJob | null {
  const parts = id.split('_');
  if (parts[0] !== 'mock') return null;
  const [, kind, region, profileId, type, a, b, createdAt, fails] = parts;
  if (!region || !Object.hasOwn(S3_REGIONS, region) || !profileId || !type || !a || !b) return null;
  const created = Number(createdAt);
  if (!Number.isSafeInteger(created)) return null;
  if (kind === 'r' && parts.length === 9 && Object.hasOwn(REPORT_DEFINITIONS, type)) {
    return {
      kind: 'report',
      region: region as AmazonAdsRegion,
      profileId,
      reportType: type as AmazonAdsReportType,
      startDate: a,
      endDate: b,
      createdAt: created,
      fails: fails === '1',
    };
  }
  if (kind === 'e' && parts.length === 8 && Object.hasOwn(EXPORT_CONTENT_TYPES, type)) {
    return {
      kind: 'export',
      region: region as AmazonAdsRegion,
      profileId,
      exportType: type as AmazonAdsExportType,
      adProducts: a.split('~').map(adProductFromCode),
      states: b.split('~'),
      createdAt: created,
    };
  }
  return null;
}

function createMockJobs(simulation: MockAmazonAdsSimulation, data: MockData) {
  const now = simulation.now ?? Date.now;
  const processingMs = simulation.processingMs ?? 5_000;
  const failing = new Set(simulation.failingReportTypes ?? []);
  /** Laufende Reports je identischer Anfrage (für 425), nur in diesem Prozess. */
  const running = new Map<string, { reportId: string; createdAt: number }>();

  const elapsed = (job: MockJob) => now() - job.createdAt;
  const accountFor = (job: MockJob) => {
    const profile = data.profiles[job.region].find((p) => p.amazonProfileId === job.profileId);
    return profile ? data.account(profile) : null;
  };
  const s3Region = (region: AmazonAdsRegion) => S3_REGIONS[region];

  function fileUrl(id: string, job: MockJob): string {
    const region = s3Region(job.region);
    return job.kind === 'report'
      ? `https://offline-report-storage-${region}-prod.s3.amazonaws.com/mock/${id}.json.gz?X-Amz-Expires=3600`
      : `https://snapshots-prod-${region}.s3.${region}.amazonaws.com/mock/${id}?X-Amz-Expires=3600`;
  }

  async function handleApi(
    request: Request,
    url: URL,
    region: AmazonAdsRegion,
    scopedProfile: MockProfile | undefined,
  ): Promise<Response | null> {
    if (!isMockApiRoute(request.method, url.pathname)) return null;
    // Wie Amazon: Endpunkte mit Profil-Scope nur für Profile, auf die das Token Zugriff hat.
    if (!scopedProfile) {
      return Response.json(
        { code: 'FORBIDDEN', details: 'Mock: Profil unbekannt.' },
        { status: 403 },
      );
    }
    const profile = scopedProfile;
    const contentType = request.headers.get('content-type');
    const accept = request.headers.get('accept');

    if (request.method === 'POST' && url.pathname === '/portfolios/list') {
      if (contentType !== PORTFOLIOS_CONTENT_TYPE) return unsupportedMediaType();
      const body = (await request.json()) as { nextToken?: string };
      const all = mockPortfolios(data.account(profile));
      const offset = Number(body.nextToken ?? '0');
      const next = offset + PORTFOLIO_PAGE_SIZE;
      return amazonJson(
        {
          portfolios: all.slice(offset, next),
          ...(next < all.length && { nextToken: String(next) }),
          totalResults: all.length,
        },
        PORTFOLIOS_CONTENT_TYPE,
      );
    }

    const exportMatch = /^\/(campaigns|adGroups|targets|ads)\/export$/.exec(url.pathname);
    if (request.method === 'POST' && exportMatch) {
      const exportType = exportMatch[1] as AmazonAdsExportType;
      const type = EXPORT_CONTENT_TYPES[exportType];
      if (contentType !== type) return unsupportedMediaType();
      const body = (await request.json()) as { adProductFilter?: string[]; stateFilter?: string[] };
      const exportId = encodeJob({
        kind: 'export',
        region,
        profileId: profile.amazonProfileId,
        exportType,
        adProducts: body.adProductFilter ?? [
          'SPONSORED_PRODUCTS',
          'SPONSORED_BRANDS',
          'SPONSORED_DISPLAY',
        ],
        states: body.stateFilter ?? ['ENABLED', 'PAUSED'],
        createdAt: now(),
      });
      return Response.json(
        { exportId, status: 'PROCESSING' },
        { status: 202, headers: { 'Content-Type': type } },
      );
    }

    const exportStatus = /^\/exports\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && exportStatus) {
      const id = decodeURIComponent(exportStatus[1]!);
      const job = decodeJob(id);
      if (!job || job.kind !== 'export' || job.profileId !== profile.amazonProfileId)
        return notFound();
      if (accept !== EXPORT_CONTENT_TYPES[job.exportType]) {
        return Response.json(
          { code: 'NOT_ACCEPTABLE', message: 'Mock: falscher Accept-Header.' },
          { status: 406 },
        );
      }
      const done = elapsed(job) >= processingMs;
      return Response.json({
        exportId: id,
        status: done ? 'COMPLETED' : 'PROCESSING',
        createdAt: new Date(job.createdAt).toISOString(),
        ...(done && {
          url: fileUrl(id, job),
          urlExpiresAt: new Date(now() + 3_600_000).toISOString(),
        }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/reporting/reports') {
      if (contentType !== REPORT_CREATE_CONTENT_TYPE) return unsupportedMediaType();
      const body = (await request.json()) as {
        startDate: string;
        endDate: string;
        configuration: { reportTypeId: string; groupBy: string[] };
      };
      const reportType = (Object.keys(REPORT_DEFINITIONS) as AmazonAdsReportType[]).find((key) => {
        const definition = REPORT_DEFINITIONS[key];
        return (
          definition.reportTypeId === body.configuration.reportTypeId &&
          JSON.stringify(definition.groupBy) === JSON.stringify(body.configuration.groupBy)
        );
      });
      if (!reportType) {
        return Response.json(
          { code: '400', detail: 'Mock: Report-Typ unbekannt.' },
          { status: 400 },
        );
      }
      const key = `${profile.amazonProfileId}|${reportType}|${body.startDate}|${body.endDate}`;
      const previous = running.get(key);
      if (previous && now() - previous.createdAt < processingMs) {
        const detail = simulation.duplicatesWithoutId
          ? 'Too early.'
          : `The Request is a duplicate of : ${previous.reportId}`;
        return Response.json({ code: '425', detail }, { status: 425 });
      }
      const reportId = encodeJob({
        kind: 'report',
        region,
        profileId: profile.amazonProfileId,
        reportType,
        startDate: body.startDate,
        endDate: body.endDate,
        createdAt: now(),
        fails: failing.has(reportType),
      });
      running.set(key, { reportId, createdAt: now() });
      return Response.json({ reportId, status: 'PENDING' });
    }

    const reportStatus = /^\/reporting\/reports\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && reportStatus) {
      const id = decodeURIComponent(reportStatus[1]!);
      const job = decodeJob(id);
      if (!job || job.kind !== 'report' || job.profileId !== profile.amazonProfileId)
        return notFound();
      const age = elapsed(job);
      const status =
        age < processingMs / 2
          ? 'PENDING'
          : age < processingMs
            ? 'PROCESSING'
            : job.fails
              ? 'FAILED'
              : 'COMPLETED';
      return Response.json({
        reportId: id,
        status,
        startDate: job.startDate,
        endDate: job.endDate,
        ...(status === 'FAILED' && { failureReason: 'Mock: Report auf Wunsch gescheitert.' }),
        ...(status === 'COMPLETED' && { url: fileUrl(id, job) }),
      });
    }
    return null;
  }

  function handleDownload(request: Request, url: URL): Response | null {
    const isMockS3 = Object.values(S3_REGIONS).some(
      (region) =>
        url.host === `offline-report-storage-${region}-prod.s3.amazonaws.com` ||
        url.host === `snapshots-prod-${region}.s3.${region}.amazonaws.com`,
    );
    if (!isMockS3 || request.method !== 'GET') return null;
    // Wie bei S3: Die signierte URL enthält kein Token; ein Authorization-Header wäre ein Fehler des Clients.
    if (request.headers.has('authorization'))
      return new Response('Mock: Authorization unerwartet.', { status: 400 });
    const match = /^\/mock\/([^/]+?)(\.json\.gz)?$/.exec(url.pathname);
    const job = match ? decodeJob(match[1]!) : null;
    const account = job ? accountFor(job) : null;
    if (!job || !account || elapsed(job) < processingMs) {
      return new Response('<Error><Code>NoSuchKey</Code></Error>', { status: 404 });
    }
    const rows =
      job.kind === 'report'
        ? mockReportRows(account, job.reportType, job.startDate, job.endDate)
        : mockExportRows(account, job.exportType, {
            adProducts: job.adProducts,
            states: job.states,
          });
    return new Response(gzipSync(Buffer.from(toAmazonJson(rows), 'utf8')), {
      headers: { 'Content-Type': 'application/octet-stream' },
    });
  }

  return { handleApi, handleDownload };
}

const MOCK_API_ROUTES: ReadonlyArray<[string, RegExp]> = [
  ['POST', /^\/portfolios\/list$/],
  ['POST', /^\/(campaigns|adGroups|targets|ads)\/export$/],
  ['GET', /^\/exports\/[^/]+$/],
  ['POST', /^\/reporting\/reports$/],
  ['GET', /^\/reporting\/reports\/[^/]+$/],
];

function isMockApiRoute(method: string, path: string): boolean {
  return MOCK_API_ROUTES.some(([m, pattern]) => m === method && pattern.test(path));
}

/** Ad-Typen in Mock-IDs kurz (die IDs trennen Felder mit `_`). */
const AD_PRODUCT_CODES: Readonly<Record<string, string>> = {
  SPONSORED_PRODUCTS: 'SP',
  SPONSORED_BRANDS: 'SB',
  SPONSORED_DISPLAY: 'SD',
};

function adProductCode(adProduct: string): string {
  return AD_PRODUCT_CODES[adProduct] ?? adProduct;
}

function adProductFromCode(code: string): string {
  return Object.entries(AD_PRODUCT_CODES).find(([, value]) => value === code)?.[0] ?? code;
}

function amazonJson(value: unknown, contentType: string): Response {
  return new Response(toAmazonJson(value), { headers: { 'Content-Type': contentType } });
}

function unsupportedMediaType(): Response {
  return Response.json(
    { code: 'UNSUPPORTED_MEDIA_TYPE', details: 'Mock: falscher Content-Type.' },
    { status: 415 },
  );
}

function notFound(): Response {
  return Response.json({ code: 'NOT_FOUND', details: 'Im Mock nicht vorhanden.' }, { status: 404 });
}

function tokenResponse(refreshToken: string): Response {
  return Response.json({
    access_token: `${ACCESS_PREFIX}${randomBytes(8).toString('hex')}`,
    refresh_token: refreshToken,
    token_type: 'bearer',
    expires_in: 3600,
  });
}

function lwaError(error: string): Response {
  return Response.json({ error, error_description: `Mock: ${error}` }, { status: 400 });
}

function unauthorized(): Response {
  return Response.json(
    { code: 'UNAUTHORIZED', details: 'Mock: ungültiges Token.' },
    { status: 401 },
  );
}

/**
 * Simulierte Einwilligungsseite. Leitet nur auf die konfigurierte Redirect-URI zurück (kein offener
 * Redirect aus Query-Parametern); `state` wird unverändert durchgereicht und HTML-escaped.
 */
export function renderMockConsentPage(input: { redirectUri: string; state: string }): string {
  const allow = new URL(input.redirectUri);
  allow.searchParams.set('code', MOCK_AMAZON_ADS_AUTHORIZATION_CODE);
  allow.searchParams.set('scope', AMAZON_ADS_SCOPES);
  allow.searchParams.set('state', input.state);

  const deny = new URL(input.redirectUri);
  deny.searchParams.set('error', 'access_denied');
  deny.searchParams.set('error_description', 'Mock: Einwilligung abgelehnt');
  deny.searchParams.set('state', input.state);

  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Amazon-Einwilligung (Mock)</title>
</head>
<body style="font-family: system-ui, sans-serif; max-width: 32rem; margin: 4rem auto; padding: 0 1rem; line-height: 1.5">
<h1>Amazon-Einwilligung (Mock)</h1>
<p>Simulierte Login-with-Amazon-Seite. Es wird keine Verbindung zu Amazon aufgebaut.</p>
<p>Konto: <strong>${escapeHtml(MOCK_AMAZON_ADS_IDENTITY.email)}</strong></p>
<p>Berechtigungen: <code>${escapeHtml(AMAZON_ADS_SCOPES)}</code></p>
<p>
<a href="${escapeHtml(allow.toString())}">Erlauben</a>
&nbsp;·&nbsp;
<a href="${escapeHtml(deny.toString())}">Ablehnen</a>
</p>
</body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
