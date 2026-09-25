import { z } from 'zod';
import { AmazonAdsHttpError, AmazonAdsReauthRequiredError } from './errors';
import type { HttpClient } from './http';
import { AMAZON_ADS_REGIONS, type AmazonAdsRegion, type AmazonAdsRegionEndpoints } from './regions';

/**
 * Login with Amazon (LWA): Einwilligung, Code-Tausch, Refresh und Identität des verbundenen Kontos.
 * `advertising::campaign_management` für die Ads-API, `profile` für `user_id` und E-Mail
 * (→ `connections.external_account_id` / `external_account_email`).
 */
export const AMAZON_ADS_SCOPES = 'advertising::campaign_management profile';

export interface AmazonAdsCredentials {
  /** LWA-Client-ID des Security Profiles */
  clientId: string;
  clientSecret: string;
  /** Muss exakt in den „Allowed Return URLs“ des Security Profiles stehen. */
  redirectUri: string;
}

export interface TokenSet {
  accessToken: string;
  refreshToken: string;
  expiresInSeconds: number;
}

export interface RefreshedToken {
  accessToken: string;
  /** Amazon schickt normalerweise denselben Refresh-Token zurück; ein anderer Wert ersetzt den alten. */
  refreshToken: string | null;
  expiresInSeconds: number;
}

export interface AccountIdentity {
  /** LWA `user_id` (`amzn1.account.…`), stabil je Amazon-Konto */
  userId: string;
  email: string | null;
  name: string | null;
}

export interface LwaClient {
  buildAuthorizeUrl(input: { region: AmazonAdsRegion; state: string }): string;
  exchangeCode(input: { region: AmazonAdsRegion; code: string }): Promise<TokenSet>;
  refreshAccessToken(input: {
    region: AmazonAdsRegion;
    refreshToken: string;
  }): Promise<RefreshedToken>;
  getAccountIdentity(input: {
    region: AmazonAdsRegion;
    accessToken: string;
  }): Promise<AccountIdentity>;
}

export interface LwaClientOptions {
  credentials: AmazonAdsCredentials;
  http: HttpClient;
  /** Standard: die echten Amazon-Endpunkte. Der Mock-Anbieter ersetzt die Einwilligungsseite. */
  regions?: Readonly<Record<AmazonAdsRegion, AmazonAdsRegionEndpoints>>;
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  token_type: z.string().optional(),
  expires_in: z.number().int().positive(),
});

const codeExchangeResponseSchema = tokenResponseSchema.extend({
  refresh_token: z.string().min(1),
});

const userProfileSchema = z.object({
  user_id: z.string().min(1),
  email: z.string().optional(),
  name: z.string().optional(),
});

const FORM_HEADERS = { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' };

export function createLwaClient(options: LwaClientOptions): LwaClient {
  const { credentials, http } = options;
  const regions = options.regions ?? AMAZON_ADS_REGIONS;

  return {
    buildAuthorizeUrl({ region, state }) {
      if (!state) throw new TypeError('buildAuthorizeUrl: state darf nicht leer sein.');
      const url = new URL(regions[region].authorizeUrl);
      url.searchParams.set('client_id', credentials.clientId);
      url.searchParams.set('scope', AMAZON_ADS_SCOPES);
      url.searchParams.set('response_type', 'code');
      url.searchParams.set('redirect_uri', credentials.redirectUri);
      url.searchParams.set('state', state);
      return url.toString();
    },

    async exchangeCode({ region, code }) {
      const body = await http.send({
        operation: 'lwa.exchange_code',
        method: 'POST',
        url: regions[region].tokenUrl,
        headers: FORM_HEADERS,
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: credentials.redirectUri,
          client_id: credentials.clientId,
          client_secret: credentials.clientSecret,
        }),
        // Der Code ist nur einmal gültig: Nach einem 5xx ist unklar, ob er schon verbraucht ist.
        retryServerErrors: false,
        schema: codeExchangeResponseSchema,
      });
      return {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresInSeconds: body.expires_in,
      };
    },

    async refreshAccessToken({ region, refreshToken }) {
      try {
        const body = await http.send({
          operation: 'lwa.refresh',
          method: 'POST',
          url: regions[region].tokenUrl,
          headers: FORM_HEADERS,
          body: new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: refreshToken,
            client_id: credentials.clientId,
            client_secret: credentials.clientSecret,
          }),
          retryServerErrors: true,
          schema: tokenResponseSchema,
        });
        return {
          accessToken: body.access_token,
          refreshToken: body.refresh_token ?? null,
          expiresInSeconds: body.expires_in,
        };
      } catch (error) {
        if (error instanceof AmazonAdsHttpError && error.code === 'invalid_grant') {
          throw new AmazonAdsReauthRequiredError(
            error.operation,
            error.status,
            error.amazonRequestId,
          );
        }
        throw error;
      }
    },

    async getAccountIdentity({ region, accessToken }) {
      const body = await http.send({
        operation: 'lwa.user_profile',
        method: 'GET',
        url: regions[region].userProfileUrl,
        headers: { Authorization: `Bearer ${accessToken}` },
        schema: userProfileSchema,
      });
      return { userId: body.user_id, email: body.email ?? null, name: body.name ?? null };
    },
  };
}
