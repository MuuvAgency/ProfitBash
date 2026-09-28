import { createMockAmazonAdsClient, LARGE_MOCK_CLIENTS } from '@profitbash/amazon-ads';
import { createConnectionTokenStore, createDb } from '@profitbash/db';
import { consoleLogger } from '@profitbash/shared';
import { parseKeyring } from '@profitbash/shared/crypto';
import {
  databaseUrlSchema,
  encryptionEnvSchema,
  loadEnv,
  nodeEnvSchema,
  refineKeyring,
} from '@profitbash/shared/env';
import { loadDemoData } from './demo';

// `pnpm demo:load`: Demo-Daten mit Volumen in die lokale Datenbank (nur Entwicklung, docs/development.md).
const env = loadEnv(
  nodeEnvSchema
    .extend(databaseUrlSchema.shape)
    .extend(encryptionEnvSchema.shape)
    .superRefine((value, ctx) => refineKeyring(value, ctx)),
);
// Nur Entwicklung: nie in Produktion und nur, wenn die App ohnehin mit dem Mock läuft (schützt davor,
// Demo-Daten mit einer echten DATABASE_URL in die Organisation „muuv“ zu schreiben).
if (env.NODE_ENV === 'production' || process.env.AMAZON_ADS_USE_MOCK !== 'true') {
  console.error(
    'demo:load ist nur für die Entwicklung gedacht (verlangt AMAZON_ADS_USE_MOCK=true, nicht NODE_ENV=production).',
  );
  process.exit(1);
}
if (process.env.AMAZON_ADS_MOCK_SCALE !== 'large') {
  console.warn(
    'Hinweis: AMAZON_ADS_MOCK_SCALE=large in .env setzen, sonst entfernt der nächste Sync von pnpm dev die Demo-Profile wieder.',
  );
}

const keyring = parseKeyring(env);
const { db, close } = createDb(env.DATABASE_URL, { max: 4 });
const started = Date.now();
try {
  const result = await loadDemoData({
    db,
    keyring,
    amazonAds: createMockAmazonAdsClient({
      redirectUri: 'http://localhost/demo',
      consentUrl: 'http://localhost/demo',
      store: createConnectionTokenStore({ db, keyring }),
      rateLimit: { requestsPerSecond: 50 },
      scale: 'large',
      simulation: { processingMs: 0 },
    }),
    clients: LARGE_MOCK_CLIENTS,
    clock: {
      now: () => Date.now(),
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    logger: (entry) => {
      if (entry.level !== 'info') consoleLogger(entry);
    },
    progress: (message) => console.log(message),
  });
  const minutes = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(
    `Demo-Daten geladen: ${result.profiles} Profile, ${result.reportRounds} Report-Runden, ${minutes} Min.`,
  );
} finally {
  await close();
}
