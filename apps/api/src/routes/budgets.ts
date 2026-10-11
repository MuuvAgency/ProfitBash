import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { BudgetCapError, deleteBudgetCap, getBudgetsOverview, saveBudgetCap } from '@profitbash/db';
import {
  budgetCapInputSchema,
  budgetsOverviewSchema,
  errorResponseSchema,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';

/**
 * Budgets (`docs/tasks/phase-5.md` 5.9a, F5), Feature `budgets`: Caps je Profil mit Pacing im laufenden Monat.
 * Lesen mit `view`, Anlegen, Ändern und Löschen mit `write`.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const errors = {
  400: { description: 'Ungültige Eingabe oder Umfang.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
  403: {
    description: 'Feature nicht gebucht oder kein Recht.',
    content: json(errorResponseSchema),
  },
  404: { description: 'Cap oder Profil nicht gefunden.', content: json(errorResponseSchema) },
};
const saved = { description: 'Gespeichert.', content: json(z.object({ id: z.uuid() })) };
const body = { content: json(budgetCapInputSchema), required: true };

const overviewRoute = createRoute({
  method: 'get',
  path: '/ads/budgets',
  tags: ['Budgets'],
  summary: 'Sichtbare Profile mit ihren Caps und dem Pacing im laufenden Monat',
  responses: {
    200: { description: 'Übersicht.', content: json(budgetsOverviewSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const createCapRoute = createRoute({
  method: 'post',
  path: '/ads/budgets/caps',
  tags: ['Budgets'],
  summary: 'Cap anlegen (Recht „write“)',
  request: { body },
  responses: {
    200: saved,
    ...errors,
    409: { description: 'Zu viele Caps im Profil.', content: json(errorResponseSchema) },
  },
});

const updateCapRoute = createRoute({
  method: 'put',
  path: '/ads/budgets/caps/{id}',
  tags: ['Budgets'],
  summary: 'Cap ändern (Recht „write“); das Profil eines Caps bleibt',
  request: { params: z.object({ id: z.uuid() }), body },
  responses: { 200: saved, ...errors },
});

const deleteCapRoute = createRoute({
  method: 'delete',
  path: '/ads/budgets/caps/{id}',
  tags: ['Budgets'],
  summary: 'Cap löschen (Recht „write“)',
  request: { params: z.object({ id: z.uuid() }) },
  responses: { 204: { description: 'Gelöscht.' }, ...errors },
});

const ERROR_STATUS = { NOT_FOUND: 404, INVALID_SCOPE: 400, LIMIT_REACHED: 409 } as const;

export function registerBudgetRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (permission: 'view' | 'write') => [
    requireSession(deps),
    requireFeature(deps, 'budgets', permission),
  ];
  /** Nutzer und aktive Organisation (die Guards garantieren beides). */
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  /** Führt eine Aktion aus; `BudgetCapError` wird zum API-Fehler, `null` heißt „kein Mitglied“. */
  async function run<T>(action: () => Promise<T | null>): Promise<T> {
    let result: T | null;
    try {
      result = await action();
    } catch (error) {
      if (error instanceof BudgetCapError) {
        throw new ApiError(ERROR_STATUS[error.code], `BUDGET_CAP_${error.code}`, error.message);
      }
      throw error;
    }
    if (result === null) {
      throw new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');
    }
    return result;
  }

  app.openapi({ ...overviewRoute, middleware: guard('view') }, async (c) => {
    const overview = await run(() => getBudgetsOverview(db, { ...actor(c), now: new Date() }));
    return c.json(
      {
        tags: overview.tags,
        profiles: overview.profiles.map((profile) => ({
          ...profile,
          caps: profile.caps.map((cap) => ({ ...cap, updatedAt: cap.updatedAt.toISOString() })),
        })),
      },
      200,
    );
  });

  app.openapi({ ...createCapRoute, middleware: guard('write') }, async (c) =>
    c.json(await run(() => saveBudgetCap(db, { ...actor(c), ...c.req.valid('json') })), 200),
  );

  app.openapi({ ...updateCapRoute, middleware: guard('write') }, async (c) =>
    c.json(
      await run(() =>
        saveBudgetCap(db, { ...actor(c), ...c.req.valid('json'), id: c.req.valid('param').id }),
      ),
      200,
    ),
  );

  app.openapi({ ...deleteCapRoute, middleware: guard('write') }, async (c) => {
    await run(() => deleteBudgetCap(db, { ...actor(c), id: c.req.valid('param').id }));
    return c.body(null, 204);
  });
}
