import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  assignTags,
  createTag,
  deleteTag,
  listTags,
  TagError,
  updateTag,
  type TagRecord,
} from '@profitbash/db';
import {
  assignTagsRequestSchema,
  assignTagsResponseSchema,
  createTagRequestSchema,
  errorResponseSchema,
  MAX_TAGS_PER_ORGANIZATION,
  tagListResponseSchema,
  tagSchema,
  updateTagRequestSchema,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';

/**
 * Eigene Tags (`docs/tasks/phase-3.md` 3.7, F7), Feature `tags`: Tags der Organisation verwalten und Kampagnen,
 * Ad Groups, Targets und Product Ads zuweisen. Lesen mit `view`, alles andere mit `write`. Den Filter nach Tags
 * nehmen die Auswertungen (`routes/analytics.ts`, `tagIds`).
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const errors = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: {
    description: 'Feature nicht gebucht oder kein Recht.',
    content: json(errorResponseSchema),
  },
};
const notFound = { description: 'Tag nicht gefunden.', content: json(errorResponseSchema) };
const conflict = {
  description: 'Name vergeben oder Höchstzahl erreicht.',
  content: json(errorResponseSchema),
};
const idParam = z.object({ id: z.uuid() });

const listRoute = createRoute({
  method: 'get',
  path: '/ads/tags',
  tags: ['Tags'],
  summary: 'Tags der Organisation nach Name, mit den Zuweisungen in sichtbaren Profilen',
  responses: {
    200: { description: 'Tags.', content: json(tagListResponseSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const createTagRoute = createRoute({
  method: 'post',
  path: '/ads/tags',
  tags: ['Tags'],
  summary: 'Tag anlegen (Recht „write“)',
  request: { body: { content: json(createTagRequestSchema), required: true } },
  responses: {
    201: { description: 'Angelegt.', content: json(tagSchema) },
    ...errors,
    409: conflict,
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/ads/tags/{id}',
  tags: ['Tags'],
  summary: 'Name und/oder Farbe eines Tags ändern (Recht „write“)',
  request: {
    params: idParam,
    body: { content: json(updateTagRequestSchema), required: true },
  },
  responses: {
    200: { description: 'Geändert.', content: json(tagSchema) },
    ...errors,
    404: notFound,
    409: conflict,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/ads/tags/{id}',
  tags: ['Tags'],
  summary: 'Tag samt allen Zuweisungen löschen (Recht „write“)',
  request: { params: idParam },
  responses: {
    204: { description: 'Gelöscht.' },
    ...errors,
    404: notFound,
  },
});

const assignRoute = createRoute({
  method: 'post',
  path: '/ads/tags/assign',
  tags: ['Tags'],
  summary: 'Tags an Entities einer Art hängen und von ihnen lösen (Recht „write“)',
  description:
    'Nur Entities sichtbarer Profile; unbekannte und unsichtbare zählt `skippedEntities`. Nennt die Anfrage ein Tag, ' +
    'das nicht der Organisation gehört, wird nichts geändert (`404 TAG_NOT_FOUND`).',
  request: { body: { content: json(assignTagsRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(assignTagsResponseSchema) },
    ...errors,
    404: notFound,
  },
});

const STATUS_BY_CODE = {
  NOT_FOUND: [404, 'TAG_NOT_FOUND'],
  NAME_TAKEN: [409, 'TAG_NAME_TAKEN'],
  LIMIT_REACHED: [409, 'TAG_LIMIT_REACHED'],
} as const;

function toApiError(error: unknown): unknown {
  if (!(error instanceof TagError)) return error;
  const [status, code] = STATUS_BY_CODE[error.code];
  return new ApiError(status, code, error.message);
}

function serialize(tag: TagRecord) {
  return {
    ...tag,
    createdAt: tag.createdAt.toISOString(),
    updatedAt: tag.updatedAt.toISOString(),
  };
}

export function registerTagRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (permission: 'view' | 'write') => [
    requireSession(deps),
    requireFeature(deps, 'tags', permission),
  ];
  /** Nutzer und aktive Organisation (die Guards garantieren beides). */
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  const noMember = () => new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');
  /** Führt eine Aktion aus; `TagError` wird zum API-Fehler, `null` heißt „kein Mitglied“. */
  async function run<T>(action: () => Promise<T | null>): Promise<T> {
    let result: T | null;
    try {
      result = await action();
    } catch (error) {
      throw toApiError(error);
    }
    if (result === null) throw noMember();
    return result;
  }

  app.openapi({ ...listRoute, middleware: guard('view') }, async (c) => {
    const tags = await run(() => listTags(db, actor(c)));
    return c.json({ tags: tags.map(serialize), maxTags: MAX_TAGS_PER_ORGANIZATION }, 200);
  });

  app.openapi({ ...createTagRoute, middleware: guard('write') }, async (c) => {
    const tag = await run(() => createTag(db, { ...actor(c), ...c.req.valid('json') }));
    return c.json(serialize(tag), 201);
  });

  app.openapi({ ...updateRoute, middleware: guard('write') }, async (c) => {
    const { name, color } = c.req.valid('json');
    const tag = await run(() =>
      updateTag(db, {
        ...actor(c),
        id: c.req.valid('param').id,
        ...(name !== undefined && { name }),
        ...(color !== undefined && { color }),
      }),
    );
    return c.json(serialize(tag), 200);
  });

  app.openapi({ ...deleteRoute, middleware: guard('write') }, async (c) => {
    await run(() => deleteTag(db, { ...actor(c), id: c.req.valid('param').id }));
    return c.body(null, 204);
  });

  app.openapi({ ...assignRoute, middleware: guard('write') }, async (c) => {
    const result = await run(() => assignTags(db, { ...actor(c), ...c.req.valid('json') }));
    return c.json(result, 200);
  });
}
