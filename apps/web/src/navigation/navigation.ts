import type { FeatureKey, MeResponse } from '@profitbash/shared';

/**
 * Sidebar und Routen der App (Quelle: docs/plan.md §3). Sichtbarkeit und Router-Guards nutzen
 * dieselbe Regel (`canAccess`), damit ein Eintrag nie sichtbar ist, dessen Seite gesperrt wäre.
 */

/** `all` = jeder angemeldete Nutzer. */
export type Access = 'all' | 'orgAdmin' | 'superadmin' | { feature: FeatureKey };

export interface NavItem {
  id: string;
  /** i18n-Key des Menüeintrags, zugleich Seitentitel. */
  labelKey: string;
  path: string;
  /** Der Bereich hat Unterseiten (`/ads/tools/*`). */
  hasSubpages?: boolean;
  /** PrimeIcons-Klasse ohne `pi-`-Präfix. */
  icon: string;
  access: Access;
  /** Phase, in der die Seite gebaut wird (docs/plan.md §2). */
  phase: number;
}

export interface NavGroup {
  id: string;
  labelKey: string;
  items: NavItem[];
}

export const NAVIGATION: readonly NavGroup[] = [
  {
    id: 'overview',
    labelKey: 'nav.group.overview',
    items: [
      {
        id: 'dashboard',
        labelKey: 'nav.dashboard',
        path: '/dashboard',
        icon: 'th-large',
        access: { feature: 'dashboard' },
        phase: 2,
      },
    ],
  },
  {
    id: 'ads',
    labelKey: 'nav.group.ads',
    items: [
      {
        id: 'explorer',
        labelKey: 'nav.explorer',
        path: '/ads/explorer',
        hasSubpages: true,
        icon: 'search',
        access: { feature: 'sp-explorer' },
        phase: 2,
      },
      {
        id: 'changes',
        labelKey: 'nav.changes',
        path: '/ads/changes',
        icon: 'history',
        access: { feature: 'changes' },
        phase: 3,
      },
      {
        id: 'tags',
        labelKey: 'nav.tags',
        path: '/ads/tags',
        hasSubpages: true,
        icon: 'tags',
        access: { feature: 'tags' },
        phase: 3,
      },
      {
        id: 'tools',
        labelKey: 'nav.tools',
        path: '/ads/tools',
        hasSubpages: true,
        icon: 'wrench',
        access: { feature: 'tools' },
        phase: 4,
      },
      {
        id: 'budgets',
        labelKey: 'nav.budgets',
        path: '/ads/budgets',
        icon: 'wallet',
        access: { feature: 'budgets' },
        phase: 5,
      },
      {
        id: 'automations',
        labelKey: 'nav.automations',
        path: '/ads/automations',
        icon: 'bolt',
        access: { feature: 'automations' },
        phase: 5,
      },
      {
        id: 'goals',
        labelKey: 'nav.goals',
        path: '/ads/goals',
        icon: 'flag',
        access: { feature: 'goals' },
        phase: 5,
      },
    ],
  },
  {
    id: 'profit',
    labelKey: 'nav.group.profit',
    items: [
      {
        id: 'pnl',
        labelKey: 'nav.pnl',
        path: '/profit/pnl',
        icon: 'chart-bar',
        access: { feature: 'profit' },
        phase: 7,
      },
      {
        id: 'sales',
        labelKey: 'nav.sales',
        path: '/profit/sales',
        icon: 'chart-line',
        access: { feature: 'profit' },
        phase: 7,
      },
      {
        id: 'products',
        labelKey: 'nav.products',
        path: '/profit/products',
        icon: 'box',
        access: { feature: 'profit' },
        phase: 7,
      },
      {
        id: 'returns',
        labelKey: 'nav.returns',
        path: '/profit/returns',
        icon: 'replay',
        access: { feature: 'profit' },
        phase: 7,
      },
      {
        id: 'orders',
        labelKey: 'nav.orders',
        path: '/profit/orders',
        icon: 'receipt',
        access: { feature: 'profit' },
        phase: 7,
      },
      {
        id: 'costs',
        labelKey: 'nav.costs',
        path: '/profit/costs',
        hasSubpages: true,
        icon: 'calculator',
        access: { feature: 'profit' },
        phase: 7,
      },
    ],
  },
  {
    id: 'ops',
    labelKey: 'nav.group.ops',
    items: [
      {
        id: 'notifications',
        labelKey: 'nav.notifications',
        path: '/notifications',
        icon: 'bell',
        access: 'all',
        phase: 5,
      },
      {
        id: 'sync',
        labelKey: 'nav.sync',
        path: '/ops/sync',
        icon: 'sync',
        access: 'orgAdmin',
        phase: 0,
      },
    ],
  },
  {
    id: 'admin',
    labelKey: 'nav.group.admin',
    items: [
      {
        id: 'connections',
        labelKey: 'nav.connections',
        path: '/admin/connections',
        icon: 'link',
        access: 'orgAdmin',
        phase: 0,
      },
      {
        id: 'members',
        labelKey: 'nav.members',
        path: '/admin/members',
        icon: 'users',
        access: 'orgAdmin',
        phase: 2,
      },
      {
        id: 'audit',
        labelKey: 'nav.audit',
        path: '/admin/audit',
        icon: 'list-check',
        access: 'orgAdmin',
        phase: 6,
      },
      {
        id: 'platform',
        labelKey: 'nav.platform',
        path: '/admin/platform',
        hasSubpages: true,
        icon: 'building',
        access: 'superadmin',
        phase: 6,
      },
    ],
  },
];

/** Seite ohne Sidebar-Eintrag, erreichbar über das Account-Menü. */
export const SETTINGS_PATH = '/settings';

export function activeOrgRole(me: MeResponse) {
  return me.organizations.find((org) => org.id === me.activeOrganizationId)?.role ?? null;
}

export function canAccess(access: Access, me: MeResponse): boolean {
  if (access === 'all') return true;
  if (access === 'orgAdmin') return activeOrgRole(me) === 'admin';
  if (access === 'superadmin') return me.user.role === 'superadmin';
  return me.features[access.feature]?.view === true;
}

export function visibleNavigation(me: MeResponse): NavGroup[] {
  return NAVIGATION.map((group) => ({
    ...group,
    items: group.items.filter((item) => canAccess(item.access, me)),
  })).filter((group) => group.items.length > 0);
}

/** Startseite nach dem Login: der erste sichtbare Eintrag. */
export function homePath(me: MeResponse): string {
  return visibleNavigation(me)[0]?.items[0]?.path ?? SETTINGS_PATH;
}
