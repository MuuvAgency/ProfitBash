import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { createPortfolioRequest, listProfilePortfolios, PortfolioError } from '@profitbash/db';
import {
  createPortfolioRequestSchema,
  createPortfolioResponseSchema,
  errorResponseSchema,
  portfolioListResponseSchema,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';
import { toIso } from './serialize';

/**
 * Portfolios (`docs/tasks/phase-4.md` 4.7, F9), Feature `tools`: Portfolios eines Profils lesen (`view`) und ein
 * neues anlegen (`write`). Ein neues Portfolio ist eine Übermittlung per Bulk-Datei (Blatt „Portfolios“) auf der
 * Seite „Änderungen“; seine ID kennt erst der nächste Import, danach lässt es sich im Setup zuordnen.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });
const errors = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: {
    description: 'Feature nicht gebucht oder kein Recht.',
    content: json(errorResponseSchema),
  },
  404: { description: 'Profil nicht gefunden.', content: json(errorResponseSchema) },
};
const TAGS = ['Tools'];

const listRoute = createRoute({
  method: 'get',
  path: '/ads/tools/portfolios',
  tags: TAGS,
  summary:
    'Portfolios eines Profils mit Zahl der Kampagnen, dazu angelegte, noch nicht importierte',
  request: { query: z.object({ profileId: z.uuid() }) },
  responses: {
    200: { description: 'Portfolios.', content: json(portfolioListResponseSchema) },
    ...errors,
  },
});

const createPortfolioRoute = createRoute({
  method: 'post',
  path: '/ads/tools/portfolios',
  tags: TAGS,
  summary: 'Portfolio anlegen (Bulk-Datei, Recht „write“)',
  request: { body: { content: json(createPortfolioRequestSchema), required: true } },
  responses: {
    201: { description: 'Übermittlung angelegt.', content: json(createPortfolioResponseSchema) },
    ...errors,
    409: {
      description: 'Name im Profil schon vergeben bzw. in Anlage.',
      content: json(errorResponseSchema),
    },
  },
});

function toApiError(error: unknown): unknown {
  if (!(error instanceof PortfolioError)) return error;
  return new ApiError(
    error.code === 'NOT_FOUND' ? 404 : 409,
    `PORTFOLIO_${error.code}`,
    error.message,
  );
}

export function registerPortfolioRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (permission: 'view' | 'write') => [
    requireSession(deps),
    requireFeature(deps, 'tools', permission),
  ];
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  async function run<T>(action: () => Promise<T | null>): Promise<T> {
    let result: T | null;
    try {
      result = await action();
    } catch (error) {
      throw toApiError(error);
    }
    if (result === null)
      throw new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');
    return result;
  }

  app.openapi({ ...listRoute, middleware: guard('view') }, async (c) => {
    const { profileId } = c.req.valid('query');
    const result = await run(() => listProfilePortfolios(db, { ...actor(c), profileId }));
    return c.json(
      {
        portfolios: result.portfolios,
        pending: result.pending.map((entry) => ({
          ...entry,
          createdAt: entry.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi({ ...createPortfolioRoute, middleware: guard('write') }, async (c) => {
    const result = await run(() =>
      createPortfolioRequest(db, { ...actor(c), request: c.req.valid('json') }),
    );
    const { submission } = result;
    return c.json(
      {
        submission: {
          ...submission,
          createdAt: submission.createdAt.toISOString(),
          startedAt: toIso(submission.startedAt),
          finishedAt: toIso(submission.finishedAt),
        },
      },
      201,
    );
  });
}
