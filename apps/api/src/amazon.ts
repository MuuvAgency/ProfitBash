import {
  createAmazonAdsClient,
  createMockAmazonAdsClient,
  type AmazonAdsClient,
  type RefreshTokenStore,
} from '@profitbash/amazon-ads';
import { createConnectionTokenStore, type Db } from '@profitbash/db';
import type { Keyring } from '@profitbash/shared/crypto';
import type { Logger } from './logger';

/** Simulierte Einwilligungsseite, nur bei `AMAZON_ADS_USE_MOCK=true` gemountet. */
export const MOCK_CONSENT_PATH = '/api/amazon/oauth/mock-consent';

export interface AmazonAdsDeps {
  client: AmazonAdsClient;
  /** Nur im Mock-Modus: Die API rendert dann die simulierte Einwilligungsseite. */
  mockConsent: { redirectUri: string } | null;
}

export interface AmazonAdsEnv {
  APP_URL: string;
  AMAZON_ADS_REDIRECT_URI: string;
  AMAZON_ADS_USE_MOCK: boolean;
  AMAZON_ADS_CLIENT_ID?: string | undefined;
  AMAZON_ADS_CLIENT_SECRET?: string | undefined;
}

/** Wählt Mock oder echten Amazon-Client und verbindet ihn mit dem Token-Store der Datenbank. */
export function createAmazonAdsDeps(options: {
  env: AmazonAdsEnv;
  db: Db;
  keyring: Keyring;
  logger?: Logger;
}): AmazonAdsDeps {
  const { env, logger } = options;
  // Typ-Absicherung: Der Token-Store aus @profitbash/db muss die Schnittstelle des Clients erfüllen.
  const store: RefreshTokenStore = createConnectionTokenStore({
    db: options.db,
    keyring: options.keyring,
  });
  const redirectUri = env.AMAZON_ADS_REDIRECT_URI;

  if (env.AMAZON_ADS_USE_MOCK) {
    const consentUrl = new URL(MOCK_CONSENT_PATH, env.APP_URL).toString();
    return {
      client: createMockAmazonAdsClient({
        redirectUri,
        consentUrl,
        store,
        ...(logger && { logger }),
      }),
      mockConsent: { redirectUri },
    };
  }

  const { AMAZON_ADS_CLIENT_ID: clientId, AMAZON_ADS_CLIENT_SECRET: clientSecret } = env;
  if (!clientId || !clientSecret) {
    throw new Error(
      'AMAZON_ADS_CLIENT_ID und AMAZON_ADS_CLIENT_SECRET fehlen (oder AMAZON_ADS_USE_MOCK=true setzen).',
    );
  }
  return {
    client: createAmazonAdsClient({
      credentials: { clientId, clientSecret, redirectUri },
      store,
      ...(logger && { logger }),
    }),
    mockConsent: null,
  };
}
