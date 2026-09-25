import { describe, expect, it } from 'vitest';
import { meFixture } from '../test/fixtures';
import { canAccess, homePath, NAVIGATION, visibleNavigation } from './navigation';

const ids = (groups: ReturnType<typeof visibleNavigation>) =>
  groups.flatMap((group) => group.items.map((item) => item.id));

describe('NAVIGATION', () => {
  it('enthält die Einträge aus docs/plan.md §3 mit eindeutigen Pfaden', () => {
    const paths = NAVIGATION.flatMap((group) => group.items.map((item) => item.path));
    expect(paths).toEqual([
      '/dashboard',
      '/ads/explorer',
      '/ads/changes',
      '/ads/tags',
      '/ads/tools',
      '/ads/budgets',
      '/ads/automations',
      '/ads/goals',
      '/profit/pnl',
      '/profit/sales',
      '/profit/products',
      '/profit/returns',
      '/profit/orders',
      '/profit/costs',
      '/notifications',
      '/ops/sync',
      '/admin/connections',
      '/admin/members',
      '/admin/audit',
      '/admin/platform',
    ]);
  });
});

describe('visibleNavigation', () => {
  it('zeigt Org-Admins mit allen Features alles außer dem Plattform-Admin', () => {
    const visible = ids(visibleNavigation(meFixture({ orgRole: 'admin' })));
    expect(visible).toHaveLength(19);
    expect(visible).not.toContain('platform');
  });

  it('zeigt den Plattform-Admin nur Superadmins', () => {
    expect(ids(visibleNavigation(meFixture({ platformRole: 'superadmin' })))).toContain('platform');
  });

  it('blendet Admin-Einträge für Nicht-Admins aus und entfernt leere Gruppen', () => {
    const groups = visibleNavigation(meFixture({ orgRole: 'viewer' }));
    expect(groups.map((group) => group.id)).toEqual(['overview', 'ads', 'profit', 'ops']);
    expect(ids(groups)).not.toContain('sync');
    expect(ids(groups)).toContain('notifications');
  });

  it('blendet nicht gebuchte Features aus', () => {
    const groups = visibleNavigation(meFixture({ features: ['dashboard', 'sp-explorer'] }));
    expect(groups.map((group) => group.id)).not.toContain('profit');
    expect(ids(groups)).toContain('explorer');
    expect(ids(groups)).not.toContain('budgets');
  });
});

describe('canAccess', () => {
  it('prüft die Admin-Rolle in der aktiven Organisation', () => {
    const me = meFixture({ orgRole: 'viewer' });
    me.organizations.push({
      id: 'org-2',
      name: 'Andere',
      slug: 'andere',
      type: 'client',
      role: 'admin',
    });
    expect(canAccess('orgAdmin', me)).toBe(false);
    expect(canAccess('orgAdmin', { ...me, activeOrganizationId: 'org-2' })).toBe(true);
  });

  it('verlangt für Features das Recht view', () => {
    expect(canAccess({ feature: 'budgets' }, meFixture({ features: ['budgets'] }))).toBe(true);
    expect(canAccess({ feature: 'budgets' }, meFixture({ features: [] }))).toBe(false);
  });

  it('erlaubt „all“ jedem angemeldeten Nutzer, auch ohne Organisation', () => {
    expect(canAccess('all', meFixture({ withOrganization: false }))).toBe(true);
  });
});

describe('homePath', () => {
  it('ist der erste sichtbare Eintrag', () => {
    expect(homePath(meFixture())).toBe('/dashboard');
    expect(homePath(meFixture({ features: ['profit'] }))).toBe('/profit/pnl');
  });

  it('fällt ohne Features und ohne Admin-Rolle auf die Benachrichtigungen zurück', () => {
    expect(homePath(meFixture({ orgRole: 'viewer', features: [] }))).toBe('/notifications');
  });
});
