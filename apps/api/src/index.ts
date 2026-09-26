import { serve } from '@hono/node-server';
import { createDb } from '@profitbash/db';
import { createAmazonAdsDeps } from './amazon';
import { createApp } from './app';
import { createAuth } from './auth';
import { loadApiEnv } from './env';
import { createUnavailableJobQueue } from './jobs';
import { consoleLogger } from './logger';

const env = loadApiEnv();
const { db, close: closeDb } = createDb(env.DATABASE_URL);
const auth = createAuth({
  db,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.APP_URL,
  trustedOrigins: [new URL(env.APP_URL).origin],
});
const app = createApp({
  db,
  auth,
  appUrl: env.APP_URL,
  version: env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 12) || 'dev',
  logger: consoleLogger,
  amazonAds: createAmazonAdsDeps({ env, db, keyring: env.keyring, logger: consoleLogger }),
  keyring: env.keyring,
  oauthStateSecret: env.OAUTH_STATE_SECRET,
  // pg-boss folgt in 0.7; bis dahin wird der Profil-Sync nur im Log gemeldet.
  jobs: createUnavailableJobQueue(consoleLogger),
});

const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  const mode = env.AMAZON_ADS_USE_MOCK ? 'Amazon-Mock' : 'Amazon';
  console.log(`API läuft auf http://localhost:${info.port} (${env.NODE_ENV}, ${mode})`);
});

function shutdown(signal: NodeJS.Signals) {
  console.log(`${signal} empfangen, API fährt herunter …`);
  server.close(() => {
    closeDb().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  });
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
