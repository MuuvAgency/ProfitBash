import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { listEnabledFeatures } from '@profitbash/db';
import { errorResponseSchema, meResponseSchema, resolveFeatureAccess } from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { requireSession } from '../middleware';
import { loadSettings } from './settings';

const meRoute = createRoute({
  method: 'get',
  path: '/me',
  tags: ['Konto'],
  summary: 'Angemeldeter Nutzer mit Organisationen, Rechten und Einstellungen',
  responses: {
    200: {
      description: 'Nutzerkontext für die App-Shell.',
      content: { 'application/json': { schema: meResponseSchema } },
    },
    401: {
      description: 'Nicht angemeldet.',
      content: { 'application/json': { schema: errorResponseSchema } },
    },
  },
});

export function registerMeRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  app.use('/me', requireSession(deps));
  app.openapi(meRoute, async (c) => {
    const { user, memberships, activeOrganization, orgRole } = c.get('auth');
    const [enabledFeatures, preferences] = await Promise.all([
      activeOrganization ? listEnabledFeatures(deps.db, activeOrganization.organizationId) : [],
      loadSettings(deps.db, user.id),
    ]);
    return c.json(
      {
        user,
        organizations: memberships.map(({ organizationId, ...rest }) => ({
          id: organizationId,
          ...rest,
        })),
        activeOrganizationId: activeOrganization?.organizationId ?? null,
        features: resolveFeatureAccess(orgRole, enabledFeatures),
        preferences,
      },
      200,
    );
  });
}
