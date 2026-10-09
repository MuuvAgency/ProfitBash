import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  getStructureCatalog,
  saveStructureCatalog,
  setClientPreset,
  StructureCatalogError,
} from '@profitbash/db';
import {
  errorResponseSchema,
  saveStructureCatalogRequestSchema,
  setClientPresetRequestSchema,
  structureCatalogResponseSchema,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';

/**
 * Struktur-Katalog (`docs/tasks/phase-4.md` 4.2, F11), Feature `tools`: lesen mit `view`; speichern nur Org-Admins
 * (prüft der Access-Layer, 403 `STRUCTURE_CATALOG_FORBIDDEN`); Presets je Client mit `write` (Admins und Editoren).
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

const getRoute = createRoute({
  method: 'get',
  path: '/ads/tools/catalog',
  tags: ['Tools'],
  summary:
    'Struktur-Katalog der Organisation (ohne gespeichertes Dokument die Startwerte), Presets je Client',
  responses: {
    200: { description: 'Katalog.', content: json(structureCatalogResponseSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const saveRoute = createRoute({
  method: 'put',
  path: '/ads/tools/catalog',
  tags: ['Tools'],
  summary: 'Struktur-Katalog speichern (nur Org-Admins)',
  description:
    '`version` ist die gelesene Version; wurde der Katalog inzwischen gespeichert, antwortet die API mit ' +
    '`409 STRUCTURE_CATALOG_VERSION_CONFLICT`.',
  request: { body: { content: json(saveStructureCatalogRequestSchema), required: true } },
  responses: {
    200: { description: 'Gespeichert.', content: json(structureCatalogResponseSchema) },
    ...errors,
    409: { description: 'Veraltete Version.', content: json(errorResponseSchema) },
  },
});

const clientPresetRoute = createRoute({
  method: 'put',
  path: '/ads/tools/client-presets/{clientId}',
  tags: ['Tools'],
  summary: 'Preset eines Clients setzen oder lösen (Recht „write“)',
  request: {
    params: z.object({ clientId: z.uuid() }),
    body: { content: json(setClientPresetRequestSchema), required: true },
  },
  responses: {
    204: { description: 'Gespeichert.' },
    ...errors,
    404: { description: 'Client nicht gefunden.', content: json(errorResponseSchema) },
  },
});

const STATUS_BY_CODE = {
  FORBIDDEN: [403, 'STRUCTURE_CATALOG_FORBIDDEN'],
  VERSION_CONFLICT: [409, 'STRUCTURE_CATALOG_VERSION_CONFLICT'],
  NOT_FOUND: [404, 'CLIENT_NOT_FOUND'],
  UNKNOWN_PRESET: [400, 'STRUCTURE_CATALOG_UNKNOWN_PRESET'],
} as const;

function toApiError(error: unknown): unknown {
  if (!(error instanceof StructureCatalogError)) return error;
  const [status, code] = STATUS_BY_CODE[error.code];
  return new ApiError(status, code, error.message);
}

export function registerStructureCatalogRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (permission: 'view' | 'write') => [
    requireSession(deps),
    requireFeature(deps, 'tools', permission),
  ];
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  const noMember = () => new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');
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
  async function view(input: { userId: string; orgId: string }) {
    const result = await run(() => getStructureCatalog(db, input));
    return { ...result, updatedAt: result.updatedAt?.toISOString() ?? null };
  }

  app.openapi({ ...getRoute, middleware: guard('view') }, async (c) =>
    c.json(await view(actor(c)), 200),
  );

  app.openapi({ ...saveRoute, middleware: guard('write') }, async (c) => {
    await run(() => saveStructureCatalog(db, { ...actor(c), ...c.req.valid('json') }));
    return c.json(await view(actor(c)), 200);
  });

  app.openapi({ ...clientPresetRoute, middleware: guard('write') }, async (c) => {
    await run(() =>
      setClientPreset(db, {
        ...actor(c),
        clientId: c.req.valid('param').clientId,
        presetKey: c.req.valid('json').presetKey,
      }),
    );
    return c.body(null, 204);
  });
}
