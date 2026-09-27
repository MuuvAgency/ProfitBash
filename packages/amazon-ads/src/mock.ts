import { randomBytes } from 'node:crypto';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient, type AmazonAdsClient, type AmazonAdsClientOptions } from './client';
import type { Logger } from './logger';
import { AMAZON_ADS_SCOPES } from './lwa';
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
    http: { fetch: createMockFetch(options.redirectUri) },
    ...(options.rateLimit && { rateLimit: options.rateLimit }),
  });
}

/** Simulierte Amazon-Endpunkte (LWA-Token, LWA-Profil, `/v2/profiles`) für alle Regionen. */
function createMockFetch(redirectUri: string): typeof fetch {
  const hosts = new Map<string, AmazonAdsRegion>();
  for (const [region, endpoints] of Object.entries(AMAZON_ADS_REGIONS)) {
    hosts.set(new URL(endpoints.apiHost).host, region as AmazonAdsRegion);
  }

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
      return new Response(MOCK_PROFILES_JSON[region], {
        headers: { 'Content-Type': 'application/json' },
      });
    }

    return Response.json(
      { code: 'NOT_FOUND', details: 'Im Mock nicht vorhanden.' },
      { status: 404 },
    );
  };
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
