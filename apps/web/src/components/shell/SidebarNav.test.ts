import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { visibleNavigation } from '../../navigation/navigation';
import { json, stubFetch } from '../../test/fetch-stub';
import { meFixture } from '../../test/fixtures';
import { cleanupMounted, mountWithApp } from '../../test/mount';
import SidebarNav from './SidebarNav.vue';

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupMounted();
});

async function mountNav(options: {
  collapsed?: boolean;
  path?: string;
  me?: ReturnType<typeof meFixture>;
}) {
  const me = options.me ?? meFixture();
  stubFetch({ 'GET /api/me': json(me) });
  return mountWithApp(
    {
      render: () =>
        h(SidebarNav, { groups: visibleNavigation(me), collapsed: options.collapsed ?? false }),
    },
    { path: options.path ?? '/dashboard' },
  );
}

describe('SidebarNav', () => {
  it('zeigt Gruppen und Einträge mit Links', async () => {
    const { wrapper } = await mountNav({ me: meFixture({ orgRole: 'viewer' }) });
    const text = wrapper.text();
    expect(text).toContain('Amazon Ads');
    expect(text).toContain('Budgets');
    expect(text).not.toContain('Clients & Connections');
    expect(wrapper.get('a[href="/ads/budgets"]').text()).toContain('Budgets');
  });

  it('markiert die aktuelle Seite, auch auf Unterseiten', async () => {
    const { wrapper } = await mountNav({ path: '/ads/tools/campaign-setup' });
    const current = wrapper.findAll('a[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]?.attributes('href')).toBe('/ads/tools');
  });

  it('beschriftet Links auch im eingeklappten Zustand', async () => {
    const { wrapper } = await mountNav({ collapsed: true });
    expect(wrapper.get('a[href="/ads/budgets"]').attributes('aria-label')).toBe('Budgets');
  });

  it('ist als Hauptnavigation ausgezeichnet', async () => {
    const { wrapper } = await mountNav({});
    expect(wrapper.get('nav').attributes('aria-label')).toBe('Hauptnavigation');
  });
});
