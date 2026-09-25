import { serve } from '@hono/node-server';
import { createApp } from './app';
import { loadApiEnv } from './env';

const env = loadApiEnv();

const server = serve({ fetch: createApp().fetch, port: env.API_PORT }, (info) => {
  console.log(`API läuft auf http://localhost:${info.port} (${env.NODE_ENV})`);
});

function shutdown(signal: NodeJS.Signals) {
  console.log(`${signal} empfangen, API fährt herunter …`);
  server.close(() => process.exit(0));
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
