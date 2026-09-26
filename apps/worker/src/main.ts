import { createAmazonAdsClientFromConfig } from '@profitbash/amazon-ads';
import { createConnectionTokenStore, createDb } from '@profitbash/db';
import { AMAZON_ADS_MOCK_CONSENT_PATH, consoleLogger } from '@profitbash/shared';
import { loadEnv, workerModeSchema } from '@profitbash/shared/env';
import { healthcheckUrls, loadWorkerEnv } from './env';
import { startWorker } from './worker';

// Eigenständiger Worker-Prozess (`WORKER_MODE=separate`). Bei `inline` läuft der Worker im
// API-Prozess; ohne diesen Ausstieg liefe er in `pnpm dev` doppelt.
if (loadEnv(workerModeSchema).WORKER_MODE === 'inline') {
  console.log(
    'WORKER_MODE=inline: Die Jobs laufen im API-Prozess. Der eigenständige Worker startet nur bei WORKER_MODE=separate.',
  );
  process.exit(0);
}

const env = loadWorkerEnv();
const logger = consoleLogger;
const { db, close: closeDb } = createDb(env.DATABASE_URL);
const amazonAds = createAmazonAdsClientFromConfig({
  config: {
    useMock: env.AMAZON_ADS_USE_MOCK,
    clientId: env.AMAZON_ADS_CLIENT_ID,
    clientSecret: env.AMAZON_ADS_CLIENT_SECRET,
    redirectUri: env.AMAZON_ADS_REDIRECT_URI,
    mockConsentUrl: new URL(AMAZON_ADS_MOCK_CONSENT_PATH, env.APP_URL).toString(),
  },
  store: createConnectionTokenStore({ db, keyring: env.keyring }),
  logger,
});

const worker = await startWorker({
  connectionString: env.DATABASE_URL_DIRECT,
  db,
  amazonAds,
  logger,
  healthchecks: healthcheckUrls(env),
});
console.log(
  `Worker läuft (${env.NODE_ENV}, ${env.AMAZON_ADS_USE_MOCK ? 'Amazon-Mock' : 'Amazon'}).`,
);

let stopping = false;
function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} empfangen, Worker wartet auf laufende Jobs und fährt herunter …`);
  worker
    .stop()
    .then(() => closeDb())
    .then(
      () => process.exit(0),
      () => process.exit(1),
    );
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
