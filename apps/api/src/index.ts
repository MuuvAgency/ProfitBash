import { serve } from '@hono/node-server';
import { createDb } from '@profitbash/db';
import { createApp } from './app';
import { createAuth } from './auth';
import { loadApiEnv } from './env';
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
});

const server = serve({ fetch: app.fetch, port: env.API_PORT }, (info) => {
  console.log(`API läuft auf http://localhost:${info.port} (${env.NODE_ENV})`);
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
