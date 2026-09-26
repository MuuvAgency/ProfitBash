import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../../test/fetch-stub';
import { meFixture } from '../../test/fixtures';
import { cleanupMounted, mountWithApp } from '../../test/mount';

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const noUiState = { 'GET /api/settings/ui-state/shell/sidebar': json({ value: null }) };

async function openMenuAndClick(
  wrapper: Awaited<ReturnType<typeof mountWithApp>>['wrapper'],
  label: string,
) {
  await vi.waitFor(() =>
    expect(wrapper.find('button[aria-controls="desktop-account-menu"]').exists()).toBe(true),
  );
  await wrapper.get('button[aria-controls="desktop-account-menu"]').trigger('click');
  await flushPromises();
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (element) => element.textContent?.trim() === label,
  );
  if (!item) throw new Error(`Menüpunkt „${label}“ nicht gefunden`);
  (item.querySelector('a, div') ?? item).dispatchEvent(new MouseEvent('click', { bubbles: true }));
  await flushPromises();
}

describe('AccountMenu', () => {
  it('meldet ab, leert den Cache und geht zum Login', async () => {
    const { requests } = stubFetch({
      'GET /api/me': json(meFixture()),
      ...noUiState,
      'POST /api/auth/sign-out': json({ success: true }),
    });
    const { wrapper, router, queryClient } = await mountWithApp(undefined, { path: '/dashboard' });
    queryClient.setQueryData(['probe'], 1);
    await openMenuAndClick(wrapper, 'Abmelden');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
    expect(requests.some((r) => r.path === '/api/auth/sign-out')).toBe(true);
    expect(queryClient.getQueryData(['probe'])).toBeUndefined();
  });

  it('wechselt die Organisation und prüft die aktuelle Seite mit den neuen Rechten', async () => {
    const adminMe = meFixture({ orgRole: 'admin' });
    adminMe.organizations.push({
      id: 'org-2',
      name: 'Nordwind',
      slug: 'nordwind',
      type: 'client',
      role: 'viewer',
    });
    let current = adminMe;
    stubFetch({
      'GET /api/me': () => json(current),
      ...noUiState,
      'POST /api/auth/organization/set-active': () => {
        current = { ...adminMe, activeOrganizationId: 'org-2' };
        return json({ id: 'org-2' });
      },
    });
    const { wrapper, router } = await mountWithApp(undefined, { path: '/admin/connections' });
    await openMenuAndClick(wrapper, 'Nordwind');
    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('forbidden'));
  });

  it('schaltet auf das dunkle Design und speichert es', async () => {
    const { requests } = stubFetch({
      'GET /api/me': json(meFixture()),
      ...noUiState,
      'PUT /api/settings': ({ body }) => json(body),
    });
    const { wrapper, session } = await mountWithApp(undefined, { path: '/dashboard' });
    await openMenuAndClick(wrapper, 'Dunkles Design');
    await vi.waitFor(() => expect(requests.at(-1)?.body).toMatchObject({ theme: 'dark' }));
    expect(session.preferences.theme).toBe('dark');
  });
});
