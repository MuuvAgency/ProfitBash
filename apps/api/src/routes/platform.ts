import { createRoute, type OpenAPIHono } from '@hono/zod-openapi';
import {
  createPlatformOrganization,
  findImpersonationTarget,
  grantPlatformStaff,
  listAuditEvents,
  listPlatformOrganizationMembers,
  recordAuditEvent,
  schema,
  listPlatformOrganizations,
  listPlatformStaff,
  PlatformError,
  renamePlatformOrganization,
  revokePlatformStaff,
  setPlatformEntitlements,
  type PlatformOrganization as PlatformOrganizationRecord,
} from '@profitbash/db';
import {
  AUDIT_EVENT_PAGE_SIZE,
  auditEventListSchema,
  errorResponseSchema,
  idParamSchema,
  impersonationStartSchema,
  platformMemberListSchema,
  platformEntitlementsSchema,
  platformOrganizationListSchema,
  platformOrganizationNameSchema,
  platformOrganizationSchema,
  platformStaffGrantSchema,
  platformStaffListSchema,
  type PlatformOrganization,
} from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppDeps, AppEnv } from '../context';
import { ApiError } from '../errors';
import { IMPERSONATION_PATH, requireSession, requireSuperadmin } from '../middleware';

/**
 * Plattform-Admin (`docs/tasks/phase-6.md` 6.4, F5): Organisationen, Entitlements, Staff. Nur Superadmins; eigene
 * Routen mit Audit statt der gesperrten Endpunkte des Admin-Plugins von better-auth (`phase-0.md` 0.4). Audit
 * schreibt `packages/db/src/platform.ts`.
 */

const json = <T>(schema: T) => ({ 'application/json': { schema } });
const error = (description: string) => ({ description, content: json(errorResponseSchema) });
const errors = {
  400: error('Ungültige Eingabe.'),
  401: error('Nicht angemeldet.'),
  403: error('Kein Plattform-Admin.'),
};
const orgNotFound = { 404: error('Organisation nicht gefunden.') };
const tags = ['Plattform'];

const listOrganizationsRoute = createRoute({
  method: 'get',
  path: '/platform/organizations',
  tags,
  summary: 'Alle Organisationen mit Typ, Mitgliederzahl, verknüpftem Client und Features',
  responses: {
    200: { description: 'Nach Name.', content: json(platformOrganizationListSchema) },
    ...errors,
  },
});

const createOrganizationRoute = createRoute({
  method: 'post',
  path: '/platform/organizations',
  tags,
  summary: 'Agentur-Org anlegen; der Anlegende wird ihr Admin',
  request: { body: { required: true, content: json(platformOrganizationNameSchema) } },
  responses: {
    201: { description: 'Angelegt.', content: json(platformOrganizationSchema) },
    ...errors,
    409: error('Eine Organisation mit diesem Namen (Slug) gibt es schon.'),
  },
});

const renameOrganizationRoute = createRoute({
  method: 'patch',
  path: '/platform/organizations/{id}',
  tags,
  summary: 'Organisation umbenennen (der Slug bleibt)',
  request: {
    params: idParamSchema,
    body: { required: true, content: json(platformOrganizationNameSchema) },
  },
  responses: {
    200: { description: 'Umbenannt.', content: json(platformOrganizationSchema) },
    ...errors,
    ...orgNotFound,
  },
});

const entitlementsRoute = createRoute({
  method: 'put',
  path: '/platform/organizations/{id}/entitlements',
  tags,
  summary: 'Gebuchte Features ersetzen; Kunden-Orgs nur Dashboard und Explorer',
  request: {
    params: idParamSchema,
    body: { required: true, content: json(platformEntitlementsSchema) },
  },
  responses: {
    200: {
      description: 'Organisation mit den neuen Features.',
      content: json(platformOrganizationSchema),
    },
    ...errors,
    ...orgNotFound,
    409: error('Feature ist für Kunden-Orgs nicht freigegeben.'),
  },
});

const listStaffRoute = createRoute({
  method: 'get',
  path: '/platform/staff',
  tags,
  summary: 'Nutzer mit der Plattform-Rolle superadmin',
  responses: {
    200: { description: 'Nach Name.', content: json(platformStaffListSchema) },
    ...errors,
  },
});

const grantStaffRoute = createRoute({
  method: 'post',
  path: '/platform/staff',
  tags,
  summary: 'Plattform-Rolle superadmin an ein Mitglied einer Agentur-Org vergeben',
  request: { body: { required: true, content: json(platformStaffGrantSchema) } },
  responses: {
    204: { description: 'Vergeben (oder schon vorhanden).' },
    ...errors,
    404: error('Kein Nutzer mit dieser E-Mail-Adresse.'),
    409: error('Der Nutzer ist kein Mitglied einer Agentur-Org.'),
  },
});

const revokeStaffRoute = createRoute({
  method: 'delete',
  path: '/platform/staff/{id}',
  tags,
  summary: 'Plattform-Rolle entziehen; der letzte Superadmin behält sie',
  request: { params: idParamSchema },
  responses: {
    204: { description: 'Entzogen.' },
    ...errors,
    404: error('Kein Plattform-Admin mit dieser ID.'),
    409: error('Letzter Plattform-Admin.'),
  },
});

const auditRoute = createRoute({
  method: 'get',
  path: '/platform/audit-events',
  tags,
  summary: `Plattformweite Ereignisse (ohne Organisation), die letzten ${AUDIT_EVENT_PAGE_SIZE}`,
  responses: {
    200: { description: 'Neueste zuerst.', content: json(auditEventListSchema) },
    ...errors,
  },
});

const membersRoute = createRoute({
  method: 'get',
  path: '/platform/organizations/{id}/members',
  tags,
  summary: 'Mitglieder einer Organisation (Auswahl für „Als Nutzer ansehen“)',
  request: { params: idParamSchema },
  responses: {
    200: { description: 'Nach Name.', content: json(platformMemberListSchema) },
    ...errors,
  },
});

const impersonationPath = IMPERSONATION_PATH.slice('/api'.length);

const startImpersonationRoute = createRoute({
  method: 'post',
  path: impersonationPath,
  tags,
  summary: 'Als Nutzer ansehen: Session mit dessen vollen Rechten, höchstens eine Stunde (F4)',
  request: { body: { required: true, content: json(impersonationStartSchema) } },
  responses: {
    204: { description: 'Begonnen; die Antwort setzt die Session des Nutzers.' },
    ...errors,
    404: error('Nutzer nicht gefunden.'),
    409: error('Superadmins lassen sich nicht ansehen.'),
  },
});

const stopImpersonationRoute = createRoute({
  method: 'delete',
  path: impersonationPath,
  tags,
  summary: 'Impersonation beenden; stellt die Session des Superadmins wieder her',
  responses: {
    204: { description: 'Beendet.' },
    401: errors[401],
    409: error('Keine Impersonation aktiv.'),
  },
});

const ERROR_STATUS: Record<PlatformError['code'], ContentfulStatusCode> = {
  NOT_FOUND: 404,
  INVALID_NAME: 400,
  SLUG_TAKEN: 409,
  FEATURE_NOT_FOR_CUSTOMERS: 409,
  NOT_AGENCY_MEMBER: 409,
  LAST_SUPERADMIN: 409,
};

async function mapErrors<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof PlatformError) {
      throw new ApiError(ERROR_STATUS[err.code], `PLATFORM_${err.code}`, err.message);
    }
    throw err;
  }
}

const toOrganization = (record: PlatformOrganizationRecord): PlatformOrganization => ({
  ...record,
  createdAt: record.createdAt.toISOString(),
});

export function registerPlatformRoutes(app: OpenAPIHono<AppEnv>, deps: AppDeps) {
  const { db } = deps;
  const middleware = [requireSession(deps), requireSuperadmin()];

  app.openapi({ ...listOrganizationsRoute, middleware }, async (c) =>
    c.json({ organizations: (await listPlatformOrganizations(db)).map(toOrganization) }, 200),
  );

  app.openapi({ ...createOrganizationRoute, middleware }, async (c) => {
    const record = await mapErrors(() =>
      createPlatformOrganization(db, {
        name: c.req.valid('json').name,
        actorUserId: c.get('auth').user.id,
      }),
    );
    return c.json(toOrganization(record), 201);
  });

  app.openapi({ ...renameOrganizationRoute, middleware }, async (c) => {
    const record = await mapErrors(() =>
      renamePlatformOrganization(db, {
        orgId: c.req.valid('param').id,
        name: c.req.valid('json').name,
        actorUserId: c.get('auth').user.id,
      }),
    );
    return c.json(toOrganization(record), 200);
  });

  app.openapi({ ...entitlementsRoute, middleware }, async (c) => {
    const record = await mapErrors(() =>
      setPlatformEntitlements(db, {
        orgId: c.req.valid('param').id,
        features: c.req.valid('json').features,
        actorUserId: c.get('auth').user.id,
      }),
    );
    return c.json(toOrganization(record), 200);
  });

  app.openapi({ ...listStaffRoute, middleware }, async (c) =>
    c.json({ staff: await listPlatformStaff(db, { actorUserId: c.get('auth').user.id }) }, 200),
  );

  app.openapi({ ...grantStaffRoute, middleware }, async (c) => {
    await mapErrors(() =>
      grantPlatformStaff(db, {
        email: c.req.valid('json').email,
        actorUserId: c.get('auth').user.id,
      }),
    );
    return c.body(null, 204);
  });

  app.openapi({ ...revokeStaffRoute, middleware }, async (c) => {
    await mapErrors(() =>
      revokePlatformStaff(db, {
        userId: c.req.valid('param').id,
        actorUserId: c.get('auth').user.id,
      }),
    );
    return c.body(null, 204);
  });

  app.openapi({ ...membersRoute, middleware }, async (c) =>
    c.json({ members: await listPlatformOrganizationMembers(db, c.req.valid('param').id) }, 200),
  );

  // Impersonation (6.5, F4) über das Admin-Plugin von better-auth, serverseitig: Dessen HTTP-Endpunkte bleiben
  // gesperrt (kein Audit). Es legt die Session an (eine Stunde) und merkt sich die des Superadmins in einem Cookie.
  const forwardCookies = (
    c: { header: (n: string, v: string, o: { append: true }) => void },
    headers: Headers,
  ) => {
    for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });
  };

  app.openapi({ ...startImpersonationRoute, middleware }, async (c) => {
    const target = await findImpersonationTarget(db, c.req.valid('json').userId);
    if (!target) throw new ApiError(404, 'IMPERSONATION_USER_NOT_FOUND', 'Nutzer nicht gefunden.');
    if (target.superadmin) {
      throw new ApiError(
        409,
        'IMPERSONATION_SUPERADMIN',
        'Plattform-Admins lassen sich nicht ansehen.',
      );
    }
    // Erst das Audit: Scheitert danach die Session, steht ein Beginn zu viel im Log, nie einer zu wenig.
    await recordAuditEvent(db, {
      organizationId: null,
      actorUserId: c.get('auth').user.id,
      action: 'platform.impersonation_start',
      target: { type: 'user', id: target.id, email: target.email },
    });
    const { headers } = await deps.auth.api.impersonateUser({
      body: { userId: target.id },
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    forwardCookies(c, headers);
    return c.body(null, 204);
  });

  app.openapi({ ...stopImpersonationRoute, middleware: [requireSession(deps)] }, async (c) => {
    const { user, sessionId, impersonatedBy } = c.get('auth');
    if (impersonatedBy === null) {
      throw new ApiError(409, 'IMPERSONATION_NOT_ACTIVE', 'Keine Impersonation aktiv.');
    }
    try {
      const { headers } = await deps.auth.api.stopImpersonating({
        headers: c.req.raw.headers,
        returnHeaders: true,
      });
      forwardCookies(c, headers);
    } catch {
      // Die gemerkte Session des Superadmins fehlt oder ist abgelaufen: wenigstens die des Nutzers beenden;
      // der Superadmin meldet sich danach neu an.
      await db.delete(schema.sessions).where(eq(schema.sessions.id, sessionId));
    }
    // Läuft in `runAsImpersonator` (`requireSession`): Handelnder wird der Superadmin.
    await recordAuditEvent(db, {
      organizationId: null,
      actorUserId: user.id,
      action: 'platform.impersonation_stop',
      target: { type: 'user', id: user.id, email: user.email },
    });
    return c.body(null, 204);
  });

  app.openapi({ ...auditRoute, middleware }, async (c) => {
    // shortcut: nur die neuesten Ereignisse ohne Blättern; mit vielen Staff-Wechseln Cursor wie in /audit-events.
    const { events, nextCursor } = await listAuditEvents(db, {
      orgId: null,
      area: 'platform',
      limit: AUDIT_EVENT_PAGE_SIZE,
    });
    return c.json(
      {
        events: events.map((event) => ({ ...event, createdAt: event.createdAt.toISOString() })),
        nextCursor,
      },
      200,
    );
  });
}
