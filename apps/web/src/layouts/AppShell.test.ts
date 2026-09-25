import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
  localStorage.clear();
});

const serverError = () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);
const noUiState = { 'GET /api/settings/ui-state/shell/sidebar': json({ value: null }) };

describe('AppShell', () => {
  it('zeigt die Sidebar mit den sichtbaren Einträgen und die Seite', async () => {
    stubFetch({ 'GET /api/me': json(meFixture({ orgRole: 'viewer' })), ...noUiState });
    const { wrapper } = await mountWithApp(undefined, { path: '/ads/budgets' });
    await vi.waitFor(() => expect(wrapper.find('h1').exists()).toBe(true));
    expect(wrapper.get('h1').text()).toBe('Budgets');
    expect(wrapper.text()).toContain('Kommt in Phase 5');
    expect(wrapper.find('a[href="/admin/connections"]').exists()).toBe(false);
  });

  it('zeigt einen Ladefehler mit „Erneut versuchen“ und erholt sich danach', async () => {
    stubFetch({ 'GET /api/me': serverError });
    const { wrapper, router } = await mountWithApp(undefined, { path: '/' });
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('ProfitBash konnte nicht geladen werden'),
    );
    expect(wrapper.text()).toContain('Die Verbindung zum Server ist fehlgeschlagen.');

    stubFetch({ 'GET /api/me': json(meFixture()), ...noUiState });
    const retry = wrapper.findAll('button').find((button) => button.text() === 'Erneut versuchen');
    await retry?.trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/dashboard'));
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.get('h1').text()).toBe('Dashboard'));
  });

  it('weist Nutzer ohne Organisation darauf hin', async () => {
    stubFetch({
      'GET /api/me': json(meFixture({ withOrganization: false })),
      ...noUiState,
    });
    const { wrapper } = await mountWithApp(undefined, { path: '/notifications' });
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Du bist noch keiner Organisation zugeordnet.'),
    );
  });

  it('speichert das Einklappen der Sidebar im UI-State', async () => {
    const { requests } = stubFetch({
      'GET /api/me': json(meFixture()),
      ...noUiState,
      'PUT /api/settings/ui-state/shell/sidebar': ({ body }) => json(body),
    });
    const { wrapper } = await mountWithApp(undefined, { path: '/dashboard' });
    await vi.waitFor(() =>
      expect(wrapper.find('button[aria-label="Seitenleiste einklappen"]').exists()).toBe(true),
    );
    await wrapper.get('button[aria-label="Seitenleiste einklappen"]').trigger('click');
    await flushPromises();
    expect(requests.at(-1)).toMatchObject({
      method: 'PUT',
      body: { value: { collapsed: true } },
    });
    expect(wrapper.find('button[aria-label="Seitenleiste ausklappen"]').exists()).toBe(true);
  });

  it('übernimmt den gespeicherten eingeklappten Zustand', async () => {
    stubFetch({
      'GET /api/me': json(meFixture()),
      'GET /api/settings/ui-state/shell/sidebar': json({ value: { collapsed: true } }),
    });
    const { wrapper } = await mountWithApp(undefined, { path: '/dashboard' });
    await vi.waitFor(() =>
      expect(wrapper.find('button[aria-label="Seitenleiste ausklappen"]').exists()).toBe(true),
    );
  });
});
