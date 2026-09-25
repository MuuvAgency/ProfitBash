import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryHistory } from 'vue-router';
import { useSessionStore } from '../stores/session';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { createAppRouter, installGuards } from './index';

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function setup() {
  const router = createAppRouter(createMemoryHistory());
  installGuards(router, useSessionStore());
  return router;
}

describe('Routen', () => {
  const router = createAppRouter(createMemoryHistory());

  it('leitet die Rechte aus der Navigation ab', () => {
    expect(router.resolve('/ops/sync').meta).toMatchObject({
      requiresAuth: true,
      requiresOrgAdmin: true,
    });
    expect(router.resolve('/admin/platform/orgs').meta).toMatchObject({ requiresSuperadmin: true });
    expect(router.resolve('/ads/budgets').meta).toMatchObject({ feature: 'budgets' });
  });

  it('führt Unterseiten auf den Bereich zurück', () => {
    const route = router.resolve('/ads/tools/campaign-setup');
    expect(route.name).toBe('tools');
    expect(route.meta.feature).toBe('tools');
  });

  it('schützt auch unbekannte Pfade mit Login', () => {
    const route = router.resolve('/gibt/es/nicht');
    expect(route.name).toBe('not-found');
    expect(route.meta.requiresAuth).toBe(true);
  });

  it('macht nur den Login öffentlich', () => {
    expect(router.resolve('/login').meta.requiresAuth).toBeFalsy();
  });
});

describe('installGuards', () => {
  it('schickt Nicht-Angemeldete zum Login mit Rücksprung', async () => {
    stubFetch({ 'GET /api/me': json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401) });
    const router = setup();
    await router.push('/ads/budgets?range=7d');
    expect(router.currentRoute.value.name).toBe('login');
    expect(router.currentRoute.value.query.redirect).toBe('/ads/budgets?range=7d');
  });

  it('leitet von der Startseite auf den ersten sichtbaren Eintrag', async () => {
    stubFetch({ 'GET /api/me': json(meFixture({ features: ['budgets'] })) });
    const router = setup();
    await router.push('/');
    expect(router.currentRoute.value.fullPath).toBe('/ads/budgets');
  });

  it('zeigt „Kein Zugriff“ für Admin-Seiten ohne Admin-Rolle', async () => {
    stubFetch({ 'GET /api/me': json(meFixture({ orgRole: 'viewer' })) });
    const router = setup();
    await router.push('/admin/connections');
    expect(router.currentRoute.value.name).toBe('forbidden');
  });
});
