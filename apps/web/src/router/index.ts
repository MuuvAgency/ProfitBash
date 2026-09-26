import {
  createRouter,
  createWebHistory,
  type RouteComponent,
  type RouteMeta,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router';
import { NAVIGATION, SETTINGS_PATH, type Access, type NavItem } from '../navigation/navigation';
import type { useSessionStore } from '../stores/session';
import { resolveGuard } from './guard';

declare module 'vue-router' {
  interface RouteMeta {
    /** Menüeintrag der Seite (aktiver Zustand in der Sidebar). */
    navItemId?: string;
    /** i18n-Key des Seitentitels (Browser-Tab). */
    titleKey?: string;
  }
}

function accessMeta(access: Access): RouteMeta {
  if (access === 'all') return {};
  if (access === 'orgAdmin') return { requiresOrgAdmin: true };
  if (access === 'superadmin') return { requiresSuperadmin: true };
  return { feature: access.feature };
}

const PlaceholderPage = () => import('../pages/PlaceholderPage.vue');

/** Fertige Seiten je Menüeintrag (`NavItem.id`). Alle anderen öffnen bis zu ihrer Phase einen Platzhalter. */
const PAGES: Partial<Record<string, RouteComponent | (() => Promise<RouteComponent>)>> = {
  connections: () => import('../pages/ConnectionsPage.vue'),
  sync: () => import('../pages/SyncStatusPage.vue'),
};

function navRoute(item: NavItem): RouteRecordRaw {
  const path = item.path.slice(1);
  const page = PAGES[item.id];
  return {
    // Bereiche mit Unterseiten (`/ads/tools/*`) nehmen beliebige Unterpfade an.
    path: item.hasSubpages ? `${path}/:subpath(.*)*` : path,
    name: item.id,
    ...(page
      ? { component: page }
      : { component: PlaceholderPage, props: { itemId: item.id, phase: item.phase } }),
    meta: { ...accessMeta(item.access), navItemId: item.id, titleKey: item.labelKey },
  };
}

const routes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'login',
    component: () => import('../pages/LoginPage.vue'),
    meta: { guestOnly: true, titleKey: 'login.pageTitle' },
  },
  {
    path: '/',
    component: () => import('../layouts/AppShell.vue'),
    // Wird an alle Unterrouten vererbt.
    meta: { requiresAuth: true },
    children: [
      // Leitet im Guard auf den ersten sichtbaren Menüeintrag weiter.
      { path: '', name: 'home', component: PlaceholderPage, meta: { home: true } },
      ...NAVIGATION.flatMap((group) => group.items.map(navRoute)),
      {
        path: SETTINGS_PATH.slice(1),
        name: 'settings',
        component: PlaceholderPage,
        props: { itemId: 'settings', phase: 0 },
        meta: { titleKey: 'nav.settings' },
      },
      {
        path: 'forbidden',
        name: 'forbidden',
        component: () => import('../pages/ForbiddenPage.vue'),
        meta: { titleKey: 'forbidden.title' },
      },
      {
        path: ':pathMatch(.*)*',
        name: 'not-found',
        component: () => import('../pages/NotFoundPage.vue'),
        meta: { titleKey: 'notFound.title' },
      },
    ],
  },
];

export function createAppRouter(history: RouterHistory = createWebHistory()): Router {
  return createRouter({ history, routes });
}

/** Lädt vor der ersten Navigation `/api/me` und prüft jede Navigation gegen Rolle und Features. */
export function installGuards(router: Router, session: ReturnType<typeof useSessionStore>) {
  router.beforeEach(async (to) => {
    await session.ensureLoaded();
    return resolveGuard(to, session.guardSession);
  });
}
