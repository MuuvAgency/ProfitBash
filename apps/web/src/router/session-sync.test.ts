import { QueryClient } from '@tanstack/vue-query';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { api } from '../api';
import { useSessionStore } from '../stores/session';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { createAppRouter, installGuards } from './index';
import { installSessionSync } from './session-sync';

const unauthorized = () => json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401);
const serverError = () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);

let uninstall: (() => void) | undefined;

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  uninstall?.();
  vi.unstubAllGlobals();
});

function setup() {
  const router = createAppRouter(createMemoryHistory());
  const session = useSessionStore();
  const queryClient = new QueryClient();
  installGuards(router, session);
  uninstall = installSessionSync(router, session, queryClient);
  return { router, session, queryClient };
}

describe('installSessionSync', () => {
  it('schickt bei abgelaufener Session zum Login mit Rücksprung und leert den Cache', async () => {
    stubFetch({ 'GET /api/me': json(meFixture()) });
    const { router, session, queryClient } = setup();
    await router.push('/ads/budgets?range=7d');
    queryClient.setQueryData(['probe'], 1);

    stubFetch({ 'GET /api/settings/ui-state/shell/sidebar': unauthorized });
    await expect(api.getUiState('shell', 'sidebar')).rejects.toMatchObject({ status: 401 });

    await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
    expect(router.currentRoute.value.query).toEqual({
      redirect: '/ads/budgets?range=7d',
      reason: 'expired',
    });
    expect(session.status).toBe('anonymous');
    expect(queryClient.getQueryData(['probe'])).toBeUndefined();
  });

  it('ignoriert 401, solange niemand angemeldet ist', async () => {
    stubFetch({ 'GET /api/me': unauthorized });
    const { router } = setup();
    await router.push('/login');
    await router.push('/login?redirect=%2Fads');
    expect(router.currentRoute.value.query).toEqual({ redirect: '/ads' });
  });

  describe('nach „Erneut versuchen“', () => {
    it('leitet von der Startseite auf den ersten sichtbaren Eintrag', async () => {
      stubFetch({ 'GET /api/me': serverError });
      const { router, session } = setup();
      await router.push('/');
      expect(session.status).toBe('error');

      stubFetch({ 'GET /api/me': json(meFixture()) });
      await session.load();
      await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/dashboard'));
    });

    it('prüft die Rechte für die aktuelle Seite', async () => {
      stubFetch({ 'GET /api/me': serverError });
      const { router, session } = setup();
      await router.push('/admin/platform');

      stubFetch({ 'GET /api/me': json(meFixture()) });
      await session.load();
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('forbidden'));
    });

    it('schickt zum Login, wenn die Session inzwischen abgelaufen ist', async () => {
      stubFetch({ 'GET /api/me': serverError });
      const { router, session } = setup();
      await router.push('/ads/budgets');

      stubFetch({ 'GET /api/me': unauthorized });
      await session.load();
      await vi.waitFor(() => expect(router.currentRoute.value.name).toBe('login'));
      expect(router.currentRoute.value.query.redirect).toBe('/ads/budgets');
    });
  });
});
