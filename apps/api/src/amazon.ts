import {
  createAmazonAdsClientFromConfig,
  type AmazonAdsClient,
  type RefreshTokenStore,
} from '@profitbash/amazon-ads';
import { createConnectionTokenStore, type Db } from '@profitbash/db';
import { AMAZON_ADS_MOCK_CONSENT_PATH } from '@profitbash/shared';
import type { Keyring } from '@profitbash/shared/crypto';
import type { Logger } from './logger';

/** Simulierte Einwilligungsseite, nur bei `AMAZON_ADS_USE_MOCK=true` gemountet. */
export const MOCK_CONSENT_PATH = AMAZON_ADS_MOCK_CONSENT_PATH;

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
  AMAZON_ADS_REQUESTS_PER_SECOND?: number | undefined;
}

/** Konfiguration des Amazon-Clients aus der Umgebung. */
function amazonAdsClientConfig(env: AmazonAdsEnv) {
  return {
    useMock: env.AMAZON_ADS_USE_MOCK,
    clientId: env.AMAZON_ADS_CLIENT_ID,
    clientSecret: env.AMAZON_ADS_CLIENT_SECRET,
    redirectUri: env.AMAZON_ADS_REDIRECT_URI,
    mockConsentUrl: new URL(MOCK_CONSENT_PATH, env.APP_URL).toString(),
    requestsPerSecond: env.AMAZON_ADS_REQUESTS_PER_SECOND,
  };
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
  return {
    client: createAmazonAdsClientFromConfig({
      config: amazonAdsClientConfig(env),
      store,
      ...(logger && { logger }),
    }),
    mockConsent: env.AMAZON_ADS_USE_MOCK ? { redirectUri: env.AMAZON_ADS_REDIRECT_URI } : null,
  };
}
