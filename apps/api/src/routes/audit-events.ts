import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { listAuditEventFilters, listAuditEvents } from '@profitbash/db';
import {
  AUDIT_EVENT_PAGE_SIZE,
  auditEventFiltersSchema,
  auditEventListQuerySchema,
  auditEventListSchema,
  errorResponseSchema,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { orgAdminOnly } from '../middleware';

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const errors = {
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: { description: 'Keine Admin-Rolle.', content: json(errorResponseSchema) },
};

const listAuditEventsRoute = createRoute({
  method: 'get',
  path: '/audit-events',
  tags: ['Betrieb'],
  summary: `Audit-Log der aktiven Organisation, je Seite ${AUDIT_EVENT_PAGE_SIZE} Ereignisse (nur Admin)`,
  request: { query: auditEventListQuerySchema },
  responses: {
    200: { description: 'Ereignisse, neueste zuerst.', content: json(auditEventListSchema) },
    400: { description: 'Ungültiger Filter.', content: json(errorResponseSchema) },
    ...errors,
  },
});

const auditEventFiltersRoute = createRoute({
  method: 'get',
  path: '/audit-events/filters',
  tags: ['Betrieb'],
  summary:
    'Bereiche und Handelnde, die im Audit-Log der aktiven Organisation vorkommen (nur Admin)',
  responses: {
    200: { description: 'Auswahl für die Filter.', content: json(auditEventFiltersSchema) },
    ...errors,
  },
});

export function registerAuditEventRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;

  app.openapi({ ...listAuditEventsRoute, middleware: orgAdminOnly(deps) }, async (c) => {
    // requireRole garantiert eine aktive Organisation.
    const orgId = c.get('auth').activeOrganization!.organizationId;
    const { from, to, ...query } = c.req.valid('query');
    const { events, nextCursor } = await listAuditEvents(db, {
      ...query,
      orgId,
      from: from === undefined ? undefined : new Date(from),
      to: to === undefined ? undefined : new Date(to),
      limit: AUDIT_EVENT_PAGE_SIZE,
    });
    return c.json(
      {
        events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
        nextCursor,
      },
      200,
    );
  });

  app.openapi({ ...auditEventFiltersRoute, middleware: orgAdminOnly(deps) }, async (c) =>
    c.json(await listAuditEventFilters(db, c.get('auth').activeOrganization!.organizationId), 200),
  );
}
