import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { schema } from '@profitbash/db';
import {
  errorResponseSchema,
  JOB_RUN_LIST_LIMIT,
  jobRunListQuerySchema,
  jobRunListSchema,
  type JobRun,
} from '@profitbash/shared';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { AppDeps, AppEnv } from '../context';
import { orgAdminOnly } from '../middleware';
import { toIso } from './serialize';

const { connections, jobRuns } = schema;

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const listJobRunsRoute = createRoute({
  method: 'get',
  path: '/job-runs',
  tags: ['Betrieb'],
  summary: `Letzte ${JOB_RUN_LIST_LIMIT} Jobläufe der aktiven Organisation (Sync-Status, nur Admin)`,
  request: { query: jobRunListQuerySchema },
  responses: {
    200: { description: 'Jobläufe, neueste zuerst.', content: json(jobRunListSchema) },
    400: { description: 'Ungültiger Filter.', content: json(errorResponseSchema) },
    401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
    403: { description: 'Keine Admin-Rolle.', content: json(errorResponseSchema) },
  },
});

export function registerJobRunRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;

  app.openapi({ ...listJobRunsRoute, middleware: orgAdminOnly(deps) }, async (c) => {
    // requireRole garantiert eine aktive Organisation.
    const organizationId = c.get('auth').activeOrganization!.organizationId;
    const { job, status } = c.req.valid('query');

    // Jobläufe sind keine Profildaten: Die Organisation ist hier die Zugriffsregel. Plattformweite
    // Läufe (`organization_id` null) fallen dadurch heraus. Die Connection nur aus derselben Org.
    const rows = await db
      .select({
        id: jobRuns.id,
        job: jobRuns.job,
        scope: jobRuns.scope,
        status: jobRuns.status,
        startedAt: jobRuns.startedAt,
        finishedAt: jobRuns.finishedAt,
        error: jobRuns.error,
        counters: jobRuns.counters,
        connectionId: connections.id,
        externalAccountId: connections.externalAccountId,
        externalAccountEmail: connections.externalAccountEmail,
      })
      .from(jobRuns)
      .leftJoin(
        connections,
        and(
          eq(connections.organizationId, jobRuns.organizationId),
          eq(sql`${connections.id}::text`, jobRuns.scope),
        ),
      )
      .where(
        and(
          eq(jobRuns.organizationId, organizationId),
          job && eq(jobRuns.job, job),
          status && eq(jobRuns.status, status),
        ),
      )
      .orderBy(desc(jobRuns.startedAt), desc(jobRuns.id))
      .limit(JOB_RUN_LIST_LIMIT);

    const result: JobRun[] = rows.map(
      ({ connectionId, externalAccountId, externalAccountEmail, ...row }) => ({
        ...row,
        connection:
          connectionId !== null && externalAccountId !== null
            ? { id: connectionId, externalAccountId, externalAccountEmail }
            : null,
        startedAt: row.startedAt.toISOString(),
        finishedAt: toIso(row.finishedAt),
      }),
    );
    return c.json({ jobRuns: result }, 200);
  });
}
