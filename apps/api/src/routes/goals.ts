import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import { deleteGoal, getGoalsOverview, GoalError, setGoal, type GoalRecord } from '@profitbash/db';
import { calculateTargetAcos } from '@profitbash/engine';
import {
  errorResponseSchema,
  goalSchema,
  goalsOverviewSchema,
  setGoalRequestSchema,
  targetAcosRequestSchema,
  targetAcosResponseSchema,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';

/**
 * Ziele (`docs/tasks/phase-5.md` 5.3, F4), Feature `goals`: Ziel-ACoS bzw. -ROAS je Client, Profil oder
 * Produktgruppe. Lesen und Rechner mit `view`, Setzen und Löschen mit `write`. Der Rechner läuft auf dem Server,
 * weil das Web kein `decimal.js` hat (ADR 003).
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
  description: 'Ziel oder Ziel-Objekt nicht gefunden.',
  content: json(errorResponseSchema),
};

const overviewRoute = createRoute({
  method: 'get',
  path: '/ads/goals',
  tags: ['Ziele'],
  summary: 'Sichtbare Clients, Profile und Produktgruppen mit ihrem Ziel',
  responses: {
    200: { description: 'Übersicht.', content: json(goalsOverviewSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const setRoute = createRoute({
  method: 'put',
  path: '/ads/goals',
  tags: ['Ziele'],
  summary: 'Ziel eines Clients, Profils oder einer Produktgruppe setzen (Recht „write“)',
  request: { body: { content: json(setGoalRequestSchema), required: true } },
  responses: {
    200: { description: 'Gesetzt.', content: json(goalSchema) },
    ...errors,
    404: notFound,
  },
});

const deleteRoute = createRoute({
  method: 'delete',
  path: '/ads/goals/{id}',
  tags: ['Ziele'],
  summary: 'Ziel löschen (Recht „write“)',
  request: { params: z.object({ id: z.uuid() }) },
  responses: {
    204: { description: 'Gelöscht.' },
    ...errors,
    404: notFound,
  },
});

const calculateRoute = createRoute({
  method: 'post',
  path: '/ads/goals/calculate',
  tags: ['Ziele'],
  summary: 'Rechner: Break-even- und Ziel-ACoS aus Preis, Kosten, Gebühren und Marge',
  description: 'Speichert nichts.',
  request: { body: { content: json(targetAcosRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(targetAcosResponseSchema) },
    ...errors,
  },
});

const serialize = (goal: GoalRecord) => ({ ...goal, updatedAt: goal.updatedAt.toISOString() });

export function registerGoalRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (permission: 'view' | 'write') => [
    requireSession(deps),
    requireFeature(deps, 'goals', permission),
  ];
  /** Nutzer und aktive Organisation (die Guards garantieren beides). */
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  /** Führt eine Aktion aus; `GoalError` wird zum API-Fehler, `null` heißt „kein Mitglied“. */
  async function run<T>(action: () => Promise<T | null>): Promise<T> {
    let result: T | null;
    try {
      result = await action();
    } catch (error) {
      if (error instanceof GoalError) throw new ApiError(404, 'GOAL_NOT_FOUND', error.message);
      throw error;
    }
    if (result === null) {
      throw new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');
    }
    return result;
  }

  app.openapi({ ...overviewRoute, middleware: guard('view') }, async (c) => {
    const overview = await run(() => getGoalsOverview(db, actor(c)));
    const profile = (p: (typeof overview.unassignedProfiles)[number]) => ({
      ...p,
      goal: p.goal && serialize(p.goal),
      productGroups: p.productGroups.map((g) => ({ ...g, goal: g.goal && serialize(g.goal) })),
    });
    return c.json(
      {
        clients: overview.clients.map((client) => ({
          ...client,
          goal: client.goal && serialize(client.goal),
          profiles: client.profiles.map(profile),
        })),
        unassignedProfiles: overview.unassignedProfiles.map(profile),
      },
      200,
    );
  });

  app.openapi({ ...setRoute, middleware: guard('write') }, async (c) => {
    const goal = await run(() => setGoal(db, { ...actor(c), ...c.req.valid('json') }));
    return c.json(serialize(goal), 200);
  });

  app.openapi({ ...deleteRoute, middleware: guard('write') }, async (c) => {
    await run(() => deleteGoal(db, { ...actor(c), id: c.req.valid('param').id }));
    return c.body(null, 204);
  });

  app.openapi({ ...calculateRoute, middleware: guard('view') }, (c) =>
    c.json(calculateTargetAcos(c.req.valid('json')), 200),
  );
}
