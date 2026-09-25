import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { healthResponseSchema } from '@profitbash/shared';
import { sql } from 'drizzle-orm';
import type { AppDeps, AppEnv } from '../context';

const healthRoute = createRoute({
  method: 'get',
  path: '/health',
  tags: ['Betrieb'],
  summary: 'Erreichbarkeit von API und Datenbank',
  responses: {
    200: {
      description: 'API und Datenbank sind erreichbar.',
      content: { 'application/json': { schema: healthResponseSchema } },
    },
    503: {
      description: 'Die Datenbank ist nicht erreichbar.',
      content: { 'application/json': { schema: healthResponseSchema } },
    },
  },
});

const DEFAULT_TIMEOUT_MS = 3000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`keine Antwort nach ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

export function registerHealthRoutes(
  app: OpenAPIHono<AppEnv>,
  { db, version, logger, healthTimeoutMs = DEFAULT_TIMEOUT_MS }: AppDeps,
) {
  app.openapi(healthRoute, async (c) => {
    try {
      await withTimeout(db.execute(sql`select 1`), healthTimeoutMs);
      return c.json({ status: 'ok' as const, db: 'ok' as const, version }, 200);
    } catch (error) {
      logger({
        level: 'warn',
        msg: 'health: Datenbank nicht erreichbar',
        requestId: c.get('requestId'),
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json({ status: 'error' as const, db: 'error' as const, version }, 503);
    }
  });
}
