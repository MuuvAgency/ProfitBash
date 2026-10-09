import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createProductGroup,
  deleteProductGroup,
  listAdvertisedProducts,
  listProductGroups,
  ProductGroupError,
  updateProductGroup,
  type ProductGroupRecord,
} from '@profitbash/db';
import {
  advertisedProductsResponseSchema,
  createProductGroupRequestSchema,
  errorResponseSchema,
  MAX_PRODUCT_GROUP_ITEMS,
  MAX_PRODUCT_GROUPS_PER_ORGANIZATION,
  productGroupListResponseSchema,
  productGroupSchema,
  updateProductGroupRequestSchema,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';

/**
 * Produktgruppen (`docs/tasks/phase-4.md` 4.1, F2), Feature `tools`: Gruppen der sichtbaren Profile verwalten und die
 * schon beworbenen Produkte eines Profils als Auswahl. Lesen mit `view`, alles andere mit `write`.
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
const notFound = {
  description: 'Produktgruppe oder Profil nicht gefunden.',
  content: json(errorResponseSchema),
};
const conflict = {
  description: 'Name im Profil vergeben oder Höchstzahl erreicht.',
  content: json(errorResponseSchema),
};
const idParam = z.object({ id: z.uuid() });

const listRoute = createRoute({
  method: 'get',
  path: '/ads/tools/product-groups',
  tags: ['Tools'],
  summary:
    'Produktgruppen der sichtbaren Profile nach Name, mit den sichtbaren Profilen und Clients',
  responses: {
    200: { description: 'Produktgruppen.', content: json(productGroupListResponseSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const createGroupRoute = createRoute({
  method: 'post',
  path: '/ads/tools/product-groups',
  tags: ['Tools'],
  summary: 'Produktgruppe in einem sichtbaren Profil anlegen (Recht „write“)',
  description:
    'Seller-Profile verlangen je Produkt eine SKU, Vendor-Profile erlauben keine (`400 PRODUCT_GROUP_SKU_REQUIRED` ' +
    'bzw. `PRODUCT_GROUP_SKU_NOT_ALLOWED`).',
  request: { body: { content: json(createProductGroupRequestSchema), required: true } },
  responses: {
    201: { description: 'Angelegt.', content: json(productGroupSchema) },
    ...errors,
    404: notFound,
    409: conflict,
  },
});

const updateRoute = createRoute({
  method: 'patch',
  path: '/ads/tools/product-groups/{id}',
  tags: ['Tools'],
  summary: 'Namen ändern und/oder Produkte ersetzen (Recht „write“)',
  request: {
    params: idParam,
    body: { content: json(updateProductGroupRequestSchema), required: true },
  },
  responses: {
    200: { description: 'Geändert.', content: json(productGroupSchema) },
    ...errors,
    404: notFound,
    409: conflict,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/ads/tools/product-groups/{id}',
  tags: ['Tools'],
  summary: 'Produktgruppe löschen (Recht „write“)',
  request: { params: idParam },
  responses: {
    204: { description: 'Gelöscht.' },
    ...errors,
    404: notFound,
  },
});

const advertisedRoute = createRoute({
  method: 'get',
  path: '/ads/tools/advertised-products',
  tags: ['Tools'],
  summary: 'Schon beworbene Produkte eines sichtbaren Profils (Auswahl für Produktgruppen)',
  request: { query: z.object({ profileId: z.uuid() }) },
  responses: {
    200: {
      description: 'Produkte je ASIN und SKU.',
      content: json(advertisedProductsResponseSchema),
    },
    ...errors,
    404: notFound,
  },
});

const STATUS_BY_CODE = {
  NOT_FOUND: [404, 'PRODUCT_GROUP_NOT_FOUND'],
  NAME_TAKEN: [409, 'PRODUCT_GROUP_NAME_TAKEN'],
  LIMIT_REACHED: [409, 'PRODUCT_GROUP_LIMIT_REACHED'],
  SKU_REQUIRED: [400, 'PRODUCT_GROUP_SKU_REQUIRED'],
  SKU_NOT_ALLOWED: [400, 'PRODUCT_GROUP_SKU_NOT_ALLOWED'],
  UNKNOWN_PRESET: [400, 'PRODUCT_GROUP_UNKNOWN_PRESET'],
} as const;

function toApiError(error: unknown): unknown {
  if (!(error instanceof ProductGroupError)) return error;
  const [status, code] = STATUS_BY_CODE[error.code];
  return new ApiError(status, code, error.message);
}

function serialize(group: ProductGroupRecord) {
  return {
    ...group,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

export function registerProductGroupRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (permission: 'view' | 'write') => [
    requireSession(deps),
    requireFeature(deps, 'tools', permission),
  ];
  /** Nutzer und aktive Organisation (die Guards garantieren beides). */
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  const noMember = () => new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');
  /** Führt eine Aktion aus; `ProductGroupError` wird zum API-Fehler, `null` heißt „kein Mitglied“. */
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
    const result = await run(() => listProductGroups(db, actor(c)));
    return c.json(
      {
        ...result,
        groups: result.groups.map(serialize),
        maxGroups: MAX_PRODUCT_GROUPS_PER_ORGANIZATION,
        maxItems: MAX_PRODUCT_GROUP_ITEMS,
      },
      200,
    );
  });

  app.openapi({ ...createGroupRoute, middleware: guard('write') }, async (c) => {
    const group = await run(() => createProductGroup(db, { ...actor(c), ...c.req.valid('json') }));
    return c.json(serialize(group), 201);
  });

  app.openapi({ ...updateRoute, middleware: guard('write') }, async (c) => {
    const group = await run(() =>
      updateProductGroup(db, { ...actor(c), id: c.req.valid('param').id, ...c.req.valid('json') }),
    );
    return c.json(serialize(group), 200);
  });

  app.openapi({ ...deleteRoute, middleware: guard('write') }, async (c) => {
    await run(() => deleteProductGroup(db, { ...actor(c), id: c.req.valid('param').id }));
    return c.body(null, 204);
  });

  app.openapi({ ...advertisedRoute, middleware: guard('view') }, async (c) => {
    const result = await run(() =>
      listAdvertisedProducts(db, { ...actor(c), profileId: c.req.valid('query').profileId }),
    );
    return c.json(result, 200);
  });
}
