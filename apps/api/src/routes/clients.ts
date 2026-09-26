import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { recordAuditEvent, schema } from '@profitbash/db';
import {
  clientCreateSchema,
  clientListSchema,
  clientPatchSchema,
  clientSchema,
  errorResponseSchema,
  idParamSchema,
  slugify,
  type Client,
} from '@profitbash/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { orgAdminOnly } from '../middleware';
import { isUniqueViolation } from './serialize';

const { clients } = schema;

/** Unique-Index auf (`organization_id`, `slug`), siehe `packages/db/src/schema/app.ts`. */
const SLUG_CONSTRAINT = 'clients_org_slug_uq';

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const errors = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: { description: 'Keine Admin-Rolle.', content: json(errorResponseSchema) },
};
const conflict = {
  409: { description: 'Slug in der Organisation vergeben.', content: json(errorResponseSchema) },
};

const clientColumns = {
  id: clients.id,
  name: clients.name,
  slug: clients.slug,
  createdAt: clients.createdAt,
  updatedAt: clients.updatedAt,
};

function toClient(row: {
  id: string;
  name: string;
  slug: string;
  createdAt: Date;
  updatedAt: Date;
}): Client {
  return { ...row, createdAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString() };
}

const slugTaken = () =>
  new ApiError(409, 'CLIENT_SLUG_TAKEN', 'Ein Client mit diesem Slug existiert bereits.');

const listClientsRoute = createRoute({
  method: 'get',
  path: '/clients',
  tags: ['Clients'],
  summary: 'Clients der aktiven Organisation (nur Admin)',
  responses: {
    200: { description: 'Clients nach Name.', content: json(clientListSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const createClientRoute = createRoute({
  method: 'post',
  path: '/clients',
  tags: ['Clients'],
  summary: 'Client anlegen (nur Admin)',
  request: { body: { required: true, content: json(clientCreateSchema) } },
  responses: {
    201: { description: 'Angelegter Client.', content: json(clientSchema) },
    ...errors,
    ...conflict,
  },
});

const patchClientRoute = createRoute({
  method: 'patch',
  path: '/clients/{id}',
  tags: ['Clients'],
  summary: 'Client umbenennen (nur Admin)',
  request: { params: idParamSchema, body: { required: true, content: json(clientPatchSchema) } },
  responses: {
    200: { description: 'Geänderter Client.', content: json(clientSchema) },
    ...errors,
    404: { description: 'Client nicht gefunden.', content: json(errorResponseSchema) },
    ...conflict,
  },
});

export function registerClientRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const middleware = orgAdminOnly(deps);
  // requireRole garantiert eine aktive Organisation.
  const orgOf = (auth: AppEnv['Variables']['auth']) => auth.activeOrganization!.organizationId;

  app.openapi({ ...listClientsRoute, middleware }, async (c) => {
    const rows = await db
      .select(clientColumns)
      .from(clients)
      .where(eq(clients.organizationId, orgOf(c.get('auth'))))
      .orderBy(asc(clients.name), asc(clients.id));
    return c.json({ clients: rows.map(toClient) }, 200);
  });

  app.openapi({ ...createClientRoute, middleware }, async (c) => {
    const auth = c.get('auth');
    const organizationId = orgOf(auth);
    const { name, slug: requestedSlug } = c.req.valid('json');
    const slug = requestedSlug ?? slugify(name);
    if (!slug) {
      throw new ApiError(
        400,
        'VALIDATION_ERROR',
        'slug: Aus dem Namen lässt sich kein Slug bilden, bitte angeben.',
      );
    }

    const created = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(clients)
        .values({ organizationId, name, slug })
        .onConflictDoNothing({ target: [clients.organizationId, clients.slug] })
        .returning(clientColumns);
      if (!row) throw slugTaken();
      await recordAuditEvent(tx, {
        organizationId,
        actorUserId: auth.user.id,
        action: 'client.create',
        target: { type: 'client', id: row.id, name, slug },
      });
      return row;
    });
    return c.json(toClient(created), 201);
  });

  app.openapi({ ...patchClientRoute, middleware }, async (c) => {
    const auth = c.get('auth');
    const organizationId = orgOf(auth);
    const { id } = c.req.valid('param');
    const patch = c.req.valid('json');

    try {
      const updated = await db.transaction(async (tx) => {
        const [before] = await tx
          .select(clientColumns)
          .from(clients)
          .where(and(eq(clients.id, id), eq(clients.organizationId, organizationId)))
          .for('update');
        if (!before) throw new ApiError(404, 'CLIENT_NOT_FOUND', 'Client nicht gefunden.');
        const [after] = await tx
          .update(clients)
          .set({
            ...(patch.name !== undefined && { name: patch.name }),
            ...(patch.slug !== undefined && { slug: patch.slug }),
          })
          .where(eq(clients.id, id))
          .returning(clientColumns);
        if (!after) throw new Error('Update des Clients lieferte keine Zeile.');
        await recordAuditEvent(tx, {
          organizationId,
          actorUserId: auth.user.id,
          action: 'client.update',
          target: {
            type: 'client',
            id,
            before: { name: before.name, slug: before.slug },
            after: { name: after.name, slug: after.slug },
          },
        });
        return after;
      });
      return c.json(toClient(updated), 200);
    } catch (error) {
      if (isUniqueViolation(error, SLUG_CONSTRAINT)) throw slugTaken();
      throw error;
    }
  });
}
