import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createSavedView,
  deleteSavedView,
  getSavedView,
  listEnabledFeatures,
  listSavedViews,
  SavedViewError,
  updateSavedView,
  type SavedViewRecord,
} from '@profitbash/db';
import {
  errorResponseSchema,
  idParamSchema,
  resolveFeatureAccess,
  savedViewCreateSchema,
  savedViewListQuerySchema,
  savedViewListSchema,
  savedViewPatchSchema,
  savedViewSchema,
  type FeatureKey,
  type SavedView,
  type SavedViewArea,
} from '@profitbash/shared';
import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireSession } from '../middleware';

/**
 * Gespeicherte Ansichten (`docs/tasks/phase-2.md` F8, 2.9). Lesen und persönliche Ansichten: Recht `view` im Feature des
 * Bereichs (`dashboard` bzw. `sp-explorer`), auch Viewer. Freigeben: Recht `write`. Ändern und löschen: Besitzer und
 * Org-Admins (`packages/db/src/saved-views.ts`). Clients, Profile und Drill-Down-IDs filtert der Access-Layer.
 */

const FEATURE_OF: Record<SavedViewArea, FeatureKey> = {
  dashboard: 'dashboard',
  explorer: 'sp-explorer',
};

const json = <T>(schema: T) => ({ 'application/json': { schema } });
const error = (description: string) => ({ description, content: json(errorResponseSchema) });

const errors = {
  400: error('Ungültige Eingabe.'),
  401: error('Nicht angemeldet.'),
  403: error('Feature nicht gebucht, kein Recht oder nicht änderbar.'),
};
const notFound = { 404: error('Ansicht nicht gefunden (oder persönliche Ansicht eines anderen).') };
const conflict = { 409: error('Name vergeben oder zu viele eigene Ansichten.') };

const listRoute = createRoute({
  method: 'get',
  path: '/saved-views',
  tags: ['Gespeicherte Ansichten'],
  summary: 'Eigene und freigegebene Ansichten eines Bereichs',
  request: { query: savedViewListQuerySchema },
  responses: {
    200: { description: 'Eigene zuerst, dann nach Name.', content: json(savedViewListSchema) },
    ...errors,
  },
});

const getRoute = createRoute({
  method: 'get',
  path: '/saved-views/{id}',
  tags: ['Gespeicherte Ansichten'],
  summary: 'Eine Ansicht (eigene oder freigegebene)',
  request: { params: idParamSchema },
  responses: {
    200: { description: 'Ansicht.', content: json(savedViewSchema) },
    ...errors,
    ...notFound,
  },
});

const createViewRoute = createRoute({
  method: 'post',
  path: '/saved-views',
  tags: ['Gespeicherte Ansichten'],
  summary: 'Ansicht speichern',
  request: { body: { required: true, content: json(savedViewCreateSchema) } },
  responses: {
    201: { description: 'Gespeicherte Ansicht.', content: json(savedViewSchema) },
    ...errors,
    ...conflict,
  },
});

const patchRoute = createRoute({
  method: 'patch',
  path: '/saved-views/{id}',
  tags: ['Gespeicherte Ansichten'],
  summary: 'Umbenennen, freigeben oder aktuellen Zustand übernehmen',
  request: { params: idParamSchema, body: { required: true, content: json(savedViewPatchSchema) } },
  responses: {
    200: { description: 'Geänderte Ansicht.', content: json(savedViewSchema) },
    ...errors,
    ...notFound,
    ...conflict,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/saved-views/{id}',
  tags: ['Gespeicherte Ansichten'],
  summary: 'Ansicht löschen',
  request: { params: idParamSchema },
  responses: { 204: { description: 'Gelöscht.' }, ...errors, ...notFound },
});

const ERROR_STATUS: Record<SavedViewError['code'], [ContentfulStatusCode, string]> = {
  NOT_FOUND: [404, 'SAVED_VIEW_NOT_FOUND'],
  FORBIDDEN: [403, 'SAVED_VIEW_FORBIDDEN'],
  SHARE_FORBIDDEN: [403, 'SAVED_VIEW_SHARE_FORBIDDEN'],
  NAME_TAKEN: [409, 'SAVED_VIEW_NAME_TAKEN'],
  LIMIT_REACHED: [409, 'SAVED_VIEW_LIMIT_REACHED'],
  INVALID_STATE: [400, 'VALIDATION_ERROR'],
};

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SavedViewError) {
      const [status, code] = ERROR_STATUS[err.code];
      throw new ApiError(status, code, err.message);
    }
    throw err;
  }
}

function toResponse(record: SavedViewRecord, canWrite: boolean): SavedView {
  return {
    id: record.id,
    name: record.name,
    area: record.area,
    shared: record.shared,
    owner: record.owner,
    own: record.own,
    canEdit: record.canEdit,
    canShare: record.canEdit && canWrite,
    state: record.state,
    hiddenItems: record.hiddenItems,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

export function registerSavedViewRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  app.use('/saved-views', requireSession(deps));
  app.use('/saved-views/*', requireSession(deps));

  /** Nutzer, Organisation und Rechte im Feature des Bereichs; ohne `view` → 403. */
  async function access(c: Context<AppEnv>, area: SavedViewArea) {
    const { user, activeOrganization, orgRole } = c.get('auth');
    if (!activeOrganization) {
      throw new ApiError(403, 'NO_ACTIVE_ORGANIZATION', 'Keine aktive Organisation.');
    }
    const orgId = activeOrganization.organizationId;
    const feature = FEATURE_OF[area];
    const rights = resolveFeatureAccess(orgRole, await listEnabledFeatures(db, orgId))[feature];
    if (!rights.view) {
      throw new ApiError(403, 'FEATURE_FORBIDDEN', `Kein Recht „view“ für „${feature}“.`);
    }
    return { userId: user.id, orgId, canWrite: rights.write };
  }

  /** Ansicht laden und das Feature ihres Bereichs prüfen. */
  async function loadVisible(c: Context<AppEnv>, id: string) {
    const { user, activeOrganization } = c.get('auth');
    if (!activeOrganization) {
      throw new ApiError(403, 'NO_ACTIVE_ORGANIZATION', 'Keine aktive Organisation.');
    }
    const record = await getSavedView(db, {
      userId: user.id,
      orgId: activeOrganization.organizationId,
      id,
    });
    if (!record) throw new ApiError(404, 'SAVED_VIEW_NOT_FOUND', 'Ansicht nicht gefunden.');
    return { record, ...(await access(c, record.area)) };
  }

  app.openapi(listRoute, async (c) => {
    const { area } = c.req.valid('query');
    const who = await access(c, area);
    const views = await listSavedViews(db, { ...who, area });
    return c.json({ views: views.map((v) => toResponse(v, who.canWrite)) }, 200);
  });

  app.openapi(getRoute, async (c) => {
    const { record, canWrite } = await loadVisible(c, c.req.valid('param').id);
    return c.json(toResponse(record, canWrite), 200);
  });

  app.openapi(createViewRoute, async (c) => {
    const body = c.req.valid('json');
    const who = await access(c, body.area);
    const record = await mapErrors(() =>
      createSavedView(db, {
        userId: who.userId,
        orgId: who.orgId,
        name: body.name,
        area: body.area,
        shared: body.shared ?? false,
        state: body.state,
        canShare: who.canWrite,
      }),
    );
    return c.json(toResponse(record, who.canWrite), 201);
  });

  app.openapi(patchRoute, async (c) => {
    const { id } = c.req.valid('param');
    const who = await loadVisible(c, id);
    const record = await mapErrors(() =>
      updateSavedView(db, {
        userId: who.userId,
        orgId: who.orgId,
        id,
        patch: c.req.valid('json'),
        canShare: who.canWrite,
      }),
    );
    return c.json(toResponse(record, who.canWrite), 200);
  });

  app.openapi(deleteRoute, async (c) => {
    const { id } = c.req.valid('param');
    const who = await loadVisible(c, id);
    await mapErrors(() => deleteSavedView(db, { userId: who.userId, orgId: who.orgId, id }));
    return c.body(null, 204);
  });
}
