import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { createDb } from '@profitbash/db';
import { healthcheckUrls, startJobQueue, startWorker } from '@profitbash/worker';
import { createAmazonAdsDeps } from './amazon';
import { createApp } from './app';
import { createAuth } from './auth';
import { loadApiEnv } from './env';
import { consoleLogger } from './logger';
import { createServerApp } from './web';

const env = loadApiEnv();
const { db, close: closeDb } = createDb(env.DATABASE_URL);
const auth = createAuth({
  db,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.APP_URL,
  trustedOrigins: [new URL(env.APP_URL).origin],
});
const amazonAds = createAmazonAdsDeps({ env, db, keyring: env.keyring, logger: consoleLogger });

// inline: Der Worker läuft in diesem Prozess (ein Railway-Service) und teilt sich den Amazon-Client.
// separate: Die API plant Jobs nur ein, ausgeführt werden sie im eigenen Worker-Prozess.
const background =
  env.WORKER_MODE === 'inline'
    ? await startWorker({
        connectionString: env.DATABASE_URL_DIRECT,
        db,
        amazonAds: amazonAds.client,
        logger: consoleLogger,
        healthchecks: healthcheckUrls(env),
      })
    : await startJobQueue({ connectionString: env.DATABASE_URL_DIRECT, logger: consoleLogger });

const app = createApp({
  db,
  auth,
  appUrl: env.APP_URL,
  version: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || 'dev',
  logger: consoleLogger,
  amazonAds,
  keyring: env.keyring,
  oauthStateSecret: env.OAUTH_STATE_SECRET,
  jobs: background.jobs,
});

// Produktion: dieselbe Origin liefert das gebaute Web (apps/web/dist, relativ zu apps/api/dist/index.js).
// Entwicklung: Vite liefert das Web und leitet /api hierher weiter.
const webDistDir =
  env.NODE_ENV === 'production'
    ? fileURLToPath(new URL('../../web/dist', import.meta.url))
    : undefined;
const server = createServerApp({ api: app, webDistDir });

const httpServer = serve({ fetch: server.fetch, port: env.port }, (info) => {
  const mode = env.AMAZON_ADS_USE_MOCK ? 'Amazon-Mock' : 'Amazon';
  console.log(
    `API läuft auf http://localhost:${info.port} (${env.NODE_ENV}, ${mode}, Worker ${env.WORKER_MODE})`,
  );
});

let stopping = false;
function shutdown(signal: NodeJS.Signals) {
  if (stopping) return;
  stopping = true;
  console.log(`${signal} empfangen, API fährt herunter …`);
  // Erst keine neuen Anfragen, dann laufende Jobs abwarten, zuletzt die Datenbank schließen.
  httpServer.close(() => {
    background
      .stop()
      .then(() => closeDb())
      .then(
        () => process.exit(0),
        () => process.exit(1),
      );
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
