import {
  createRouter,
  createWebHistory,
  type RouteComponent,
  type RouteMeta,
  type RouteRecordRaw,
  type Router,
  type RouterHistory,
} from 'vue-router';
import { SET_PASSWORD_PATH } from '@profitbash/shared';
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
  dashboard: () => import('../pages/DashboardPage.vue'),
  explorer: () => import('../pages/ExplorerPage.vue'),
  changes: () => import('../pages/ChangesPage.vue'),
  tags: () => import('../pages/TagsPage.vue'),
  connections: () => import('../pages/ConnectionsPage.vue'),
  members: () => import('../pages/MembersPage.vue'),
  sync: () => import('../pages/SyncStatusPage.vue'),
  notifications: () => import('../pages/NotificationsPage.vue'),
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
  // Öffentlich (auch angemeldet erreichbar): Passwort über den Einmal-Link setzen, Token im Fragment (F9).
  {
    path: SET_PASSWORD_PATH,
    name: 'set-password',
    component: () => import('../pages/SetPasswordPage.vue'),
    meta: { titleKey: 'setPassword.pageTitle' },
  },
  {
    path: '/',
    component: () => import('../layouts/AppShell.vue'),
    // Wird an alle Unterrouten vererbt.
    meta: { requiresAuth: true },
    children: [
      // Leitet im Guard auf den ersten sichtbaren Menüeintrag weiter.
      { path: '', name: 'home', component: PlaceholderPage, meta: { home: true } },
      // Explorer ohne Ebene: Kampagnen (F6), mit allen Parametern.
      {
        path: 'ads/explorer',
        redirect: (to) => ({ path: '/ads/explorer/campaigns', query: to.query, hash: to.hash }),
      },
      // Suchbegriff-Analyse (2b.2): eigene Seite unter dem Explorer, vor dessen Unterpfaden.
      {
        path: 'ads/explorer/search-term-analysis',
        name: 'search-term-analysis',
        component: () => import('../pages/SearchTermAnalysisPage.vue'),
        meta: { feature: 'sp-explorer', navItemId: 'explorer', titleKey: 'searchTerms.title' },
      },
      // Tools (Phase 4): Produktgruppen (4.1) sind die Einstiegsseite; weitere Unterseiten folgen mit ihren Aufgaben.
      { path: 'ads/tools', redirect: '/ads/tools/product-groups' },
      {
        path: 'ads/tools/product-groups',
        name: 'product-groups',
        component: () => import('../pages/ProductGroupsPage.vue'),
        meta: { feature: 'tools', navItemId: 'tools', titleKey: 'productGroups.title' },
      },
      {
        path: 'ads/tools/setup',
        name: 'campaign-setup',
        component: () => import('../pages/SetupPage.vue'),
        meta: { feature: 'tools', navItemId: 'tools', titleKey: 'setup.title' },
      },
      {
        path: 'ads/tools/portfolios',
        name: 'portfolios',
        component: () => import('../pages/PortfoliosPage.vue'),
        meta: { feature: 'tools', navItemId: 'tools', titleKey: 'portfolios.title' },
      },
      {
        path: 'ads/tools/bid-simulator',
        name: 'bid-simulator',
        component: () => import('../pages/BidSimulatorPage.vue'),
        meta: { feature: 'tools', navItemId: 'tools', titleKey: 'bidSimulator.title' },
      },
      {
        path: 'ads/tools/catalog',
        name: 'structure-catalog',
        component: () => import('../pages/CatalogPage.vue'),
        meta: { feature: 'tools', navItemId: 'tools', titleKey: 'catalog.title' },
      },
      ...NAVIGATION.flatMap((group) => group.items.map(navRoute)),
      {
        path: SETTINGS_PATH.slice(1),
        name: 'settings',
        component: () => import('../pages/SettingsPage.vue'),
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
