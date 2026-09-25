import type { FeatureKey, MeResponse } from '@profitbash/shared';
import type { LocationQuery, RouteLocationRaw, RouteMeta } from 'vue-router';
import { canAccess, homePath } from '../navigation/navigation';

declare module 'vue-router' {
  interface RouteMeta {
    /** Nur mit Session erreichbar (wird an Unterrouten vererbt). */
    requiresAuth?: boolean;
    /** Nur ohne Session sinnvoll (Login); Angemeldete werden weitergeleitet. */
    guestOnly?: boolean;
    /** Startseite: leitet auf den ersten sichtbaren Menüeintrag. */
    home?: boolean;
    /** Verlangt `view` auf diesem Feature-Key. */
    feature?: FeatureKey;
    requiresOrgAdmin?: boolean;
    requiresSuperadmin?: boolean;
  }
}

export type GuardSession =
  | { status: 'authenticated'; me: MeResponse }
  | { status: 'anonymous' }
  /** `/api/me` ist fehlgeschlagen (Netzwerk, 5xx); die Shell zeigt den Fehler mit „Erneut versuchen“. */
  | { status: 'error' };

export interface GuardTarget {
  fullPath: string;
  meta: RouteMeta;
  query: LocationQuery;
}

/**
 * Prüft einen Rücksprung-Pfad aus der URL. Nur interne Pfade sind erlaubt, sonst ließe sich
 * der Login als Weiterleitung auf fremde Seiten missbrauchen (Open Redirect).
 */
export function safeRedirect(value: unknown): string | null {
  if (typeof value !== 'string' || !value.startsWith('/')) return null;
  if (value.startsWith('//') || value.includes('\\')) return null;
  if (value === '/login' || value.startsWith('/login?') || value.startsWith('/login#')) return null;
  return value;
}

const FORBIDDEN: RouteLocationRaw = { name: 'forbidden' };

/** Entscheidet über eine Navigation. `true` = erlaubt, sonst Weiterleitung. */
export function resolveGuard(to: GuardTarget, session: GuardSession): true | RouteLocationRaw {
  const { meta } = to;

  if (session.status === 'error') return true;

  if (session.status === 'anonymous') {
    if (!meta.requiresAuth) return true;
    return to.fullPath === '/'
      ? { name: 'login' }
      : { name: 'login', query: { redirect: to.fullPath } };
  }

  const { me } = session;
  if (meta.guestOnly) return { path: safeRedirect(to.query.redirect) ?? homePath(me) };
  if (meta.home) return { path: homePath(me) };
  if (meta.requiresSuperadmin && !canAccess('superadmin', me)) return FORBIDDEN;
  if (meta.requiresOrgAdmin && !canAccess('orgAdmin', me)) return FORBIDDEN;
  if (meta.feature && !canAccess({ feature: meta.feature }, me)) return FORBIDDEN;
  return true;
}
