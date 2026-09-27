import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient, type AmazonAdsClient } from './client';
import type { Logger } from './logger';
import { createMockAmazonAdsClient } from './mock';

/** Konfiguration aus der Umgebung (`AMAZON_ADS_*`), gemeinsam für API und Worker. */
export interface AmazonAdsClientConfig {
  /** `AMAZON_ADS_USE_MOCK` */
  useMock: boolean;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  redirectUri: string;
  /** Simulierte Einwilligungsseite der App; nur im Mock-Modus benutzt. */
  mockConsentUrl: string;
  /** `AMAZON_ADS_REQUESTS_PER_SECOND`: Anfrage-Budget je Profil. Standard 2/s. */
  requestsPerSecond?: number | undefined;
}

/** Wählt Mock oder echten Amazon-Client. Ohne Mock sind Client-ID und Secret Pflicht. */
export function createAmazonAdsClientFromConfig(options: {
  config: AmazonAdsClientConfig;
  store: RefreshTokenStore;
  logger?: Logger;
}): AmazonAdsClient {
  const { config, store, logger } = options;
  const rateLimit =
    config.requestsPerSecond === undefined
      ? undefined
      : { requestsPerSecond: config.requestsPerSecond };
  if (config.useMock) {
    return createMockAmazonAdsClient({
      redirectUri: config.redirectUri,
      consentUrl: config.mockConsentUrl,
      store,
      ...(logger && { logger }),
      ...(rateLimit && { rateLimit }),
    });
  }
  const { clientId, clientSecret, redirectUri } = config;
  if (!clientId || !clientSecret) {
    throw new Error(
      'AMAZON_ADS_CLIENT_ID und AMAZON_ADS_CLIENT_SECRET fehlen (oder AMAZON_ADS_USE_MOCK=true setzen).',
    );
  }
  return createAmazonAdsClient({
    credentials: { clientId, clientSecret, redirectUri },
    store,
    ...(logger && { logger }),
    ...(rateLimit && { rateLimit }),
  });
}
