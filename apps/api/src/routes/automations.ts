import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  AutomationError,
  getAutomationRules,
  getAutomationSettings,
  saveAutomationRules,
  type StoredAutomationRules,
  saveGuardrailDefaults,
  setClientAutomation,
} from '@profitbash/db';
import {
  automationRulesResponseSchema,
  automationSettingsSchema,
  errorResponseSchema,
  guardrailsSchema,
  saveAutomationRulesRequestSchema,
  setClientAutomationRequestSchema,
} from '@profitbash/shared';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { requireFeature, requireSession } from '../middleware';

/**
 * Automationen (`docs/tasks/phase-5.md` 5.4), Feature `automations`: Leitplanken der Organisation (ändern nur
 * Admins), Modus, zuständiger Nutzer und überschriebene Werte je Client (Recht `write`). Jede Änderung antwortet mit
 * dem neuen Stand aller Einstellungen.
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
const settingsResponse = {
  description: 'Einstellungen.',
  content: json(automationSettingsSchema),
};

const getRoute = createRoute({
  method: 'get',
  path: '/ads/automations/settings',
  tags: ['Automationen'],
  summary: 'Leitplanken der Organisation und Einstellungen der sichtbaren Clients',
  responses: { 200: settingsResponse, 401: errors[401], 403: errors[403] },
});

const defaultsRoute = createRoute({
  method: 'put',
  path: '/ads/automations/settings/defaults',
  tags: ['Automationen'],
  summary: 'Leitplanken der Organisation speichern (nur Org-Admins)',
  request: { body: { content: json(guardrailsSchema), required: true } },
  responses: { 200: settingsResponse, ...errors },
});

const clientRoute = createRoute({
  method: 'put',
  path: '/ads/automations/settings/clients/{clientId}',
  tags: ['Automationen'],
  summary: 'Modus, zuständigen Nutzer und Leitplanken eines Clients setzen (Recht „write“)',
  request: {
    params: z.object({ clientId: z.uuid() }),
    body: { content: json(setClientAutomationRequestSchema), required: true },
  },
  responses: {
    200: settingsResponse,
    ...errors,
    404: { description: 'Client nicht gefunden.', content: json(errorResponseSchema) },
  },
});

const rulesResponse = { description: 'Regeln.', content: json(automationRulesResponseSchema) };

const rulesRoute = createRoute({
  method: 'get',
  path: '/ads/automations/rules',
  tags: ['Automationen'],
  summary: 'Regeln der Organisation in ihrer Reihenfolge (erste passende gewinnt)',
  responses: { 200: rulesResponse, 401: errors[401], 403: errors[403] },
});

const saveRulesRoute = createRoute({
  method: 'put',
  path: '/ads/automations/rules',
  tags: ['Automationen'],
  summary: 'Regeln speichern (ganze Liste, Recht „write“)',
  description:
    '`version` ist die zuletzt gelesene; hat inzwischen jemand gespeichert, antwortet der Server mit 409.',
  request: { body: { content: json(saveAutomationRulesRequestSchema), required: true } },
  responses: {
    200: rulesResponse,
    ...errors,
    409: { description: 'Inzwischen geändert.', content: json(errorResponseSchema) },
  },
});

const STATUS_BY_CODE = {
  FORBIDDEN: [403, 'AUTOMATION_DEFAULTS_FORBIDDEN'],
  NOT_FOUND: [404, 'CLIENT_NOT_FOUND'],
  INVALID_RESPONSIBLE: [400, 'AUTOMATION_INVALID_RESPONSIBLE'],
  VERSION_CONFLICT: [409, 'AUTOMATION_RULES_VERSION_CONFLICT'],
  UNKNOWN_CLIENT: [400, 'AUTOMATION_RULES_UNKNOWN_CLIENT'],
} as const;

export function registerAutomationRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const guard = (permission: 'view' | 'write') => [
    requireSession(deps),
    requireFeature(deps, 'automations', permission),
  ];
  /** Nutzer und aktive Organisation (die Guards garantieren beides). */
  const actor = (c: { get(key: 'auth'): AppEnv['Variables']['auth'] }) => {
    const auth = c.get('auth');
    return { userId: auth.user.id, orgId: auth.activeOrganization!.organizationId };
  };
  /** Führt eine Aktion aus; `AutomationError` wird zum API-Fehler, `null` heißt „kein Mitglied“. */
  async function run<T>(action: () => Promise<T | null>): Promise<T> {
    let result: T | null;
    try {
      result = await action();
    } catch (error) {
      if (!(error instanceof AutomationError)) throw error;
      const [status, code] = STATUS_BY_CODE[error.code];
      throw new ApiError(status, code, error.message);
    }
    if (result === null) {
      throw new ApiError(403, 'FEATURE_FORBIDDEN', 'Kein Mitglied der Organisation.');
    }
    return result;
  }
  const view = (input: { userId: string; orgId: string }) =>
    run(() => getAutomationSettings(db, input));

  app.openapi({ ...getRoute, middleware: guard('view') }, async (c) =>
    c.json(await view(actor(c)), 200),
  );

  app.openapi({ ...defaultsRoute, middleware: guard('write') }, async (c) => {
    await run(() => saveGuardrailDefaults(db, { ...actor(c), guardrails: c.req.valid('json') }));
    return c.json(await view(actor(c)), 200);
  });

  app.openapi({ ...clientRoute, middleware: guard('write') }, async (c) => {
    await run(() =>
      setClientAutomation(db, {
        ...actor(c),
        clientId: c.req.valid('param').clientId,
        ...c.req.valid('json'),
      }),
    );
    return c.json(await view(actor(c)), 200);
  });

  const serializeRules = (stored: StoredAutomationRules) => ({
    ...stored,
    updatedAt: stored.updatedAt?.toISOString() ?? null,
  });

  app.openapi({ ...rulesRoute, middleware: guard('view') }, async (c) =>
    c.json(serializeRules(await run(() => getAutomationRules(db, actor(c)))), 200),
  );

  app.openapi({ ...saveRulesRoute, middleware: guard('write') }, async (c) => {
    const saved = await run(() => saveAutomationRules(db, { ...actor(c), ...c.req.valid('json') }));
    return c.json(serializeRules(saved), 200);
  });
}
