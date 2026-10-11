import { createRoute, z, type OpenAPIHono } from '@hono/zod-openapi';
import {
  acceptStructureProposals,
  acknowledgeAutomationFindings,
  dismissStructureProposals,
  listStructureProposals,
  AutomationError,
  dismissAutomationProposals,
  getAutomationChecks,
  saveCheckSettings,
  getAutomationRules,
  getAutomationSettings,
  listAutomationProposals,
  listAutomationRuns,
  previewAutomationRules,
  saveAutomationRules,
  stageAutomationProposals,
  type StoredAutomationRules,
  saveGuardrailDefaults,
  setClientAutomation,
} from '@profitbash/db';
import {
  acknowledgeFindingsRequestSchema,
  automationChecksSchema,
  CHECK_FINDING_FILTERS,
  checkSettingsSchema,
  automationProposalActionResponseSchema,
  automationProposalIdsRequestSchema,
  automationProposalsQuerySchema,
  automationProposalsResponseSchema,
  automationRulesPreviewSchema,
  automationRulesResponseSchema,
  automationRunsResponseSchema,
  automationSettingsSchema,
  errorResponseSchema,
  guardrailsSchema,
  previewAutomationRulesRequestSchema,
  saveAutomationRulesRequestSchema,
  setClientAutomationRequestSchema,
  STRUCTURE_PROPOSAL_FILTERS,
  structureProposalsResponseSchema,
  type AutomationRun,
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

const previewRulesRoute = createRoute({
  method: 'post',
  path: '/ads/automations/rules/preview',
  tags: ['Automationen'],
  summary: 'Vorschau: für wie viele Entities würde jede Regel heute greifen',
  description:
    'Speichert nichts. Geprüft werden aktive Targets und Kampagnen der sichtbaren Profile mit ihrem Datenstand; ' +
    'das Ziel kommt von Profil bzw. Client (ohne Produktgruppen), Leitplanken bleiben außen vor.',
  request: { body: { content: json(previewAutomationRulesRequestSchema), required: true } },
  responses: {
    200: { description: 'Zähler je Regel.', content: json(automationRulesPreviewSchema) },
    ...errors,
  },
});

const runsRoute = createRoute({
  method: 'get',
  path: '/ads/automations/runs',
  tags: ['Automationen'],
  summary: 'Die letzten Läufe der Automatik in den sichtbaren Profilen, neueste zuerst',
  responses: {
    200: { description: 'Läufe.', content: json(automationRunsResponseSchema) },
    401: errors[401],
    403: errors[403],
  },
});

const proposalsRoute = createRoute({
  method: 'get',
  path: '/ads/automations/proposals',
  tags: ['Automationen'],
  summary: 'Vorschläge der Automatik in einem Status (offen, im Warenkorb, verworfen)',
  request: { query: automationProposalsQuerySchema },
  responses: {
    200: { description: 'Vorschläge.', content: json(automationProposalsResponseSchema) },
    ...errors,
  },
});

const proposalAction = (action: 'stage' | 'dismiss', summary: string) =>
  createRoute({
    method: 'post',
    path: `/ads/automations/proposals/${action}`,
    tags: ['Automationen'],
    summary,
    request: { body: { content: json(automationProposalIdsRequestSchema), required: true } },
    responses: {
      200: { description: 'Ergebnis.', content: json(automationProposalActionResponseSchema) },
      ...errors,
    },
  });
const stageProposalsRoute = proposalAction(
  'stage',
  'Offene Vorschläge in den eigenen Warenkorb legen (Recht „write“)',
);
const dismissProposalsRoute = proposalAction(
  'dismiss',
  'Vorschläge verwerfen, auch im Warenkorb liegende (Recht „write“)',
);

const checksResponse = { description: 'Prüfungen.', content: json(automationChecksSchema) };
const checksQuerySchema = z.object({ status: z.enum(CHECK_FINDING_FILTERS).default('open') });

const checksRoute = createRoute({
  method: 'get',
  path: '/ads/automations/checks',
  tags: ['Automationen'],
  summary: 'Einstellungen der Prüfungen und Befunde der sichtbaren Profile (offen oder quittiert)',
  request: { query: checksQuerySchema },
  responses: { 200: checksResponse, ...errors },
});

const checkSettingsRoute = createRoute({
  method: 'put',
  path: '/ads/automations/checks/settings',
  tags: ['Automationen'],
  summary:
    'Einstellungen der Prüfungen speichern (nur Org-Admins); sie wirken mit dem nächsten Lauf',
  request: { body: { content: json(checkSettingsSchema), required: true } },
  responses: { 200: checksResponse, ...errors },
});

const acknowledgeRoute = createRoute({
  method: 'post',
  path: '/ads/automations/checks/acknowledge',
  tags: ['Automationen'],
  summary: 'Offene Befunde quittieren (Recht „write“)',
  request: { body: { content: json(acknowledgeFindingsRequestSchema), required: true } },
  responses: {
    200: { description: 'Ergebnis.', content: json(automationProposalActionResponseSchema) },
    ...errors,
  },
});

const structureProposalsRoute = createRoute({
  method: 'get',
  path: '/ads/automations/structure-proposals',
  tags: ['Automationen'],
  summary: 'Graduation- und Preset-Vorschläge der sichtbaren Profile (offen oder verworfen)',
  request: {
    query: z.object({ status: z.enum(STRUCTURE_PROPOSAL_FILTERS).default('open') }),
  },
  responses: {
    200: { description: 'Vorschläge.', content: json(structureProposalsResponseSchema) },
    ...errors,
  },
});

const structureAction = (action: 'accept' | 'dismiss', summary: string) =>
  createRoute({
    method: 'post',
    path: `/ads/automations/structure-proposals/${action}`,
    tags: ['Automationen'],
    summary,
    request: { body: { content: json(automationProposalIdsRequestSchema), required: true } },
    responses: {
      200: { description: 'Ergebnis.', content: json(automationProposalActionResponseSchema) },
      ...errors,
    },
  });
const acceptStructureRoute = structureAction(
  'accept',
  'Vorschläge annehmen: Begriff auf die Merkliste bzw. Preset der Produktgruppe ändern (Recht „write“)',
);
const dismissStructureRoute = structureAction('dismiss', 'Vorschläge verwerfen (Recht „write“)');

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

  app.openapi({ ...previewRulesRoute, middleware: guard('view') }, async (c) =>
    c.json(
      await run(() => previewAutomationRules(db, { ...actor(c), ...c.req.valid('json') })),
      200,
    ),
  );

  app.openapi({ ...runsRoute, middleware: guard('view') }, async (c) => {
    const runs = await run(() => listAutomationRuns(db, actor(c)));
    return c.json(
      {
        runs: runs.map((row) => ({
          ...row,
          mode: row.mode as AutomationRun['mode'],
          metricsImportedAt: row.metricsImportedAt.toISOString(),
          createdAt: row.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi({ ...proposalsRoute, middleware: guard('view') }, async (c) => {
    const { proposals, total } = await run(() =>
      listAutomationProposals(db, { ...actor(c), ...c.req.valid('query') }),
    );
    return c.json(
      {
        total,
        proposals: proposals.map((row) => ({
          ...row,
          entityType: row.entityType as 'target' | 'campaign',
          field: row.field as 'bid' | 'budget' | 'state',
          source: row.source as 'rule' | 'optimizer' | 'budget_cap',
          createdAt: row.createdAt.toISOString(),
        })),
      },
      200,
    );
  });

  app.openapi({ ...stageProposalsRoute, middleware: guard('write') }, async (c) =>
    c.json(
      await run(() => stageAutomationProposals(db, { ...actor(c), ...c.req.valid('json') })),
      200,
    ),
  );

  app.openapi({ ...dismissProposalsRoute, middleware: guard('write') }, async (c) =>
    c.json(
      await run(() => dismissAutomationProposals(db, { ...actor(c), ...c.req.valid('json') })),
      200,
    ),
  );

  app.openapi({ ...structureProposalsRoute, middleware: guard('view') }, async (c) => {
    const { proposals, total } = await run(() =>
      listStructureProposals(db, { ...actor(c), ...c.req.valid('query') }),
    );
    return c.json(
      {
        total,
        proposals: proposals.map((row) => ({
          ...row,
          firstSeenAt: row.firstSeenAt.toISOString(),
          dismissedAt: row.dismissedAt?.toISOString() ?? null,
        })),
      },
      200,
    );
  });

  app.openapi({ ...acceptStructureRoute, middleware: guard('write') }, async (c) =>
    c.json(
      await run(() => acceptStructureProposals(db, { ...actor(c), ...c.req.valid('json') })),
      200,
    ),
  );

  app.openapi({ ...dismissStructureRoute, middleware: guard('write') }, async (c) =>
    c.json(
      await run(() => dismissStructureProposals(db, { ...actor(c), ...c.req.valid('json') })),
      200,
    ),
  );

  const checksView = async (
    input: { userId: string; orgId: string },
    status: (typeof CHECK_FINDING_FILTERS)[number],
  ) => {
    const checks = await run(() => getAutomationChecks(db, { ...input, status }));
    return {
      ...checks,
      findings: checks.findings.map((row) => ({
        ...row,
        firstSeenAt: row.firstSeenAt.toISOString(),
        acknowledgedAt: row.acknowledgedAt?.toISOString() ?? null,
      })),
    };
  };

  app.openapi({ ...checksRoute, middleware: guard('view') }, async (c) =>
    c.json(await checksView(actor(c), c.req.valid('query').status), 200),
  );

  app.openapi({ ...checkSettingsRoute, middleware: guard('write') }, async (c) => {
    await run(() => saveCheckSettings(db, { ...actor(c), settings: c.req.valid('json') }));
    return c.json(await checksView(actor(c), 'open'), 200);
  });

  app.openapi({ ...acknowledgeRoute, middleware: guard('write') }, async (c) =>
    c.json(
      await run(() => acknowledgeAutomationFindings(db, { ...actor(c), ...c.req.valid('json') })),
      200,
    ),
  );
}
