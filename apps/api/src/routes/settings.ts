import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import { recordAuditEvent, schema, type DbOrTx } from '@profitbash/db';
import {
  DEFAULT_SETTINGS,
  errorResponseSchema,
  settingsSchema,
  uiStateParamsSchema,
  uiStatePutSchema,
  uiStateResponseSchema,
  type Settings,
} from '@profitbash/shared';
import { and, eq } from 'drizzle-orm';
import type { AppDeps, AppEnv } from '../context';
import { requireSession } from '../middleware';

const { uiState, userPreferences } = schema;

/** Einstellungen des Nutzers; fehlende oder unbekannte Werte fallen auf die Defaults zurück. */
export async function loadSettings(db: DbOrTx, userId: string): Promise<Settings> {
  const [row] = await db
    .select({
      theme: userPreferences.theme,
      locale: userPreferences.locale,
      density: userPreferences.density,
    })
    .from(userPreferences)
    .where(eq(userPreferences.userId, userId))
    .limit(1);
  if (!row) return { ...DEFAULT_SETTINGS };
  const { shape } = settingsSchema;
  return {
    theme: shape.theme.catch(DEFAULT_SETTINGS.theme).parse(row.theme),
    locale: shape.locale.catch(DEFAULT_SETTINGS.locale).parse(row.locale),
    density: shape.density.catch(DEFAULT_SETTINGS.density).parse(row.density),
  };
}

const json = <T>(schema: T) => ({ 'application/json': { schema } });

const errorResponses = {
  400: { description: 'Ungültige Eingabe.', content: json(errorResponseSchema) },
  401: { description: 'Nicht angemeldet.', content: json(errorResponseSchema) },
};

const getSettingsRoute = createRoute({
  method: 'get',
  path: '/settings',
  tags: ['Einstellungen'],
  summary: 'Einstellungen des angemeldeten Nutzers',
  responses: {
    200: {
      description: 'Einstellungen (Defaults, falls nichts gespeichert ist).',
      content: json(settingsSchema),
    },
    401: errorResponses[401],
  },
});

const putSettingsRoute = createRoute({
  method: 'put',
  path: '/settings',
  tags: ['Einstellungen'],
  summary: 'Einstellungen vollständig ersetzen',
  request: { body: { required: true, content: json(settingsSchema) } },
  responses: {
    200: { description: 'Gespeicherte Einstellungen.', content: json(settingsSchema) },
    ...errorResponses,
  },
});

const getUiStateRoute = createRoute({
  method: 'get',
  path: '/settings/ui-state/{scope}/{key}',
  tags: ['Einstellungen'],
  summary: 'Gespeicherten UI-Zustand lesen',
  request: { params: uiStateParamsSchema },
  responses: {
    200: { description: 'Gespeicherter Wert oder `null`.', content: json(uiStateResponseSchema) },
    ...errorResponses,
  },
});

const putUiStateRoute = createRoute({
  method: 'put',
  path: '/settings/ui-state/{scope}/{key}',
  tags: ['Einstellungen'],
  summary: 'UI-Zustand speichern (kein Audit-Event: reiner Darstellungszustand)',
  request: {
    params: uiStateParamsSchema,
    body: { required: true, content: json(uiStatePutSchema) },
  },
  responses: {
    200: { description: 'Gespeicherter Wert.', content: json(uiStateResponseSchema) },
    ...errorResponses,
  },
});

export function registerSettingsRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  // '/settings/*' deckt auch '/settings' selbst ab.
  app.use('/settings/*', requireSession(deps));

  app.openapi(getSettingsRoute, async (c) => {
    return c.json(await loadSettings(db, c.get('auth').user.id), 200);
  });

  app.openapi(putSettingsRoute, async (c) => {
    const { user } = c.get('auth');
    const settings = c.req.valid('json');
    await db.transaction(async (tx) => {
      const before = await loadSettings(tx, user.id);
      await tx
        .insert(userPreferences)
        .values({ userId: user.id, ...settings })
        .onConflictDoUpdate({ target: userPreferences.userId, set: settings });
      await recordAuditEvent(tx, {
        organizationId: null,
        actorUserId: user.id,
        action: 'settings.update',
        target: { type: 'user_preferences', id: user.id, before, after: settings },
      });
    });
    return c.json(settings, 200);
  });

  app.openapi(getUiStateRoute, async (c) => {
    const { scope, key } = c.req.valid('param');
    const [row] = await db
      .select({ value: uiState.value })
      .from(uiState)
      .where(
        and(
          eq(uiState.userId, c.get('auth').user.id),
          eq(uiState.scope, scope),
          eq(uiState.key, key),
        ),
      )
      .limit(1);
    return c.json({ value: row?.value ?? null }, 200);
  });

  // Bewusst ohne Audit-Event: UI-Zustand (Spalten, Filter, Aufklappzustand) ist reine Darstellung
  // des eigenen Nutzers, ändert keine Geschäftsdaten und wird sehr häufig geschrieben.
  app.openapi(putUiStateRoute, async (c) => {
    const { scope, key } = c.req.valid('param');
    const { value } = c.req.valid('json');
    await db
      .insert(uiState)
      .values({ userId: c.get('auth').user.id, scope, key, value })
      .onConflictDoUpdate({ target: [uiState.userId, uiState.scope, uiState.key], set: { value } });
    return c.json({ value }, 200);
  });
}
