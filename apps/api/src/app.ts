import { Hono } from 'hono';

/** Baut die Hono-App. Getrennt vom Serverstart, damit Tests sie ohne Port nutzen können. */
export function createApp() {
  const app = new Hono().basePath('/api');

  // Minimaler Health-Check. Der DB-Check folgt in Aufgabe 0.4.
  app.get('/health', (c) => c.json({ status: 'ok' }));

  return app;
}
