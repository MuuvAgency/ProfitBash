import { listEnabledFeatures, listMemberships, schema } from '@profitbash/db';
import {
  hasOrgRole,
  isPlatformRole,
  resolveFeatureAccess,
  type FeatureKey,
  type OrgRole,
  type PlatformRole,
} from '@profitbash/shared';
import { eq } from 'drizzle-orm';
import type { MiddlewareHandler } from 'hono';
import { csrf } from 'hono/csrf';
import type { AppDeps, AppEnv } from './context';
import { ApiError } from './errors';
import type { Logger } from './logger';

const { sessions } = schema;

/**
 * Loggt jede Anfrage mit Request-ID. Nur der Pfad, nie der Query-String. Achtung, falls später
 * Passwort-Reset freigeschaltet wird: better-auth trägt den Token dann im Pfad
 * (`/api/auth/reset-password/:token`); solche Pfade vor dem Loggen kürzen.
 */
export function requestLogger(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const start = performance.now();
    await next();
    logger({
      level: 'info',
      msg: 'request',
      requestId: c.get('requestId'),
      method: c.req.method,
      path: c.req.path,
      status: c.res.status,
      durationMs: Math.round(performance.now() - start),
    });
  };
}

/**
 * CSRF-Schutz für eigene schreibende Endpunkte (zusätzlich zu SameSite-Cookies): Formular-artige
 * Requests (form-urlencoded, multipart, text/plain) müssen von `appUrl` kommen. JSON-Requests fremder
 * Origins scheitern bereits am CORS-Preflight (die API erlaubt kein CORS). better-auth unter
 * `/api/auth/*` hat eine eigene Origin-Prüfung (`trustedOrigins`).
 */
export function csrfProtection(appUrl: string): MiddlewareHandler<AppEnv> {
  const origin = new URL(appUrl).origin;
  const check = csrf({ origin });
  return (c, next) => (c.req.path.startsWith('/api/auth/') ? next() : check(c, next));
}

function toPlatformRole(role: string | null | undefined): PlatformRole {
  return role && isPlatformRole(role) ? role : 'user';
}

/**
 * Verlangt eine gültige Session und setzt `c.var.auth`: Nutzer, Mitgliedschaften und die aktive
 * Organisation. Die aktive Org kommt aus der Session, sofern der Nutzer dort (noch) Mitglied ist,
 * sonst die älteste Mitgliedschaft; dieser Fallback wird in die Session zurückgeschrieben, damit
 * better-auth-Endpunkte dieselbe Org sehen. Rollen werden bei jeder Anfrage frisch gelesen.
 *
 * Verlängert better-auth die Session dabei, wird der neue Cookie an den Browser weitergereicht.
 */
export function requireSession({
  db,
  auth,
}: Pick<AppDeps, 'db' | 'auth'>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { headers, response: result } = await auth.api.getSession({
      headers: c.req.raw.headers,
      returnHeaders: true,
    });
    if (!result) throw new ApiError(401, 'UNAUTHORIZED', 'Nicht angemeldet.');
    for (const cookie of headers.getSetCookie()) c.header('Set-Cookie', cookie, { append: true });

    const memberships = await listMemberships(db, result.user.id);
    const activeOrganization =
      memberships.find((m) => m.organizationId === result.session.activeOrganizationId) ??
      memberships[0] ??
      null;
    const activeOrganizationId = activeOrganization?.organizationId ?? null;
    if (activeOrganizationId !== (result.session.activeOrganizationId ?? null)) {
      await db
        .update(sessions)
        .set({ activeOrganizationId })
        .where(eq(sessions.id, result.session.id));
    }

    c.set('auth', {
      user: {
        id: result.user.id,
        email: result.user.email,
        name: result.user.name,
        role: toPlatformRole(result.user.role),
      },
      sessionId: result.session.id,
      memberships,
      activeOrganization,
      orgRole: activeOrganization?.role ?? null,
    });
    await next();
  };
}

/** Verlangt mindestens die Rolle `minimum` in der aktiven Organisation. Nach `requireSession`. */
export function requireRole(minimum: OrgRole): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const { activeOrganization, orgRole } = c.get('auth');
    if (!activeOrganization) {
      throw new ApiError(403, 'NO_ACTIVE_ORGANIZATION', 'Keine aktive Organisation.');
    }
    if (!hasOrgRole(orgRole, minimum)) {
      throw new ApiError(403, 'FORBIDDEN', `Erfordert die Rolle „${minimum}“.`);
    }
    await next();
  };
}

/**
 * Session und Rolle `admin` in der aktiven Organisation, als Middleware einer einzelnen Route
 * (`app.openapi({ ...route, middleware: orgAdminOnly(deps) }, …)`). Bewusst je Route statt per
 * Pfad-Präfix, damit spätere Routen unter demselben Präfix nicht unbemerkt admin-only werden.
 */
export function orgAdminOnly(deps: Pick<AppDeps, 'db' | 'auth'>) {
  return [requireSession(deps), requireRole('admin')];
}

/** Verlangt die Plattform-Rolle `superadmin`. Nach `requireSession`. */
export function requireSuperadmin(): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (c.get('auth').user.role !== 'superadmin') {
      throw new ApiError(403, 'FORBIDDEN', 'Nur für Plattform-Admins.');
    }
    await next();
  };
}

/**
 * Verlangt ein Feature-Recht in der aktiven Organisation (Entitlement und Rolle, `resolveFeatureAccess`). Nach
 * `requireSession`. Mehrere Keys: eines genügt (z. B. Filterleiste für Dashboard und Explorer).
 */
export function requireFeature(
  { db }: Pick<AppDeps, 'db'>,
  features: FeatureKey | readonly FeatureKey[],
  permission: 'view' | 'write',
): MiddlewareHandler<AppEnv> {
  const keys: readonly FeatureKey[] = typeof features === 'string' ? [features] : features;
  return async (c, next) => {
    const { activeOrganization, orgRole } = c.get('auth');
    if (!activeOrganization) {
      throw new ApiError(403, 'NO_ACTIVE_ORGANIZATION', 'Keine aktive Organisation.');
    }
    const access = resolveFeatureAccess(
      orgRole,
      await listEnabledFeatures(db, activeOrganization.organizationId),
    );
    if (!keys.some((key) => access[key][permission])) {
      throw new ApiError(
        403,
        'FEATURE_FORBIDDEN',
        `Kein Recht „${permission}“ für ${keys.map((key) => `„${key}“`).join(' oder ')}.`,
      );
    }
    await next();
  };
}
