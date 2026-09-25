import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { createApi } from './client';
import { ApiError } from './errors';
import { meFixture } from '../test/fixtures';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createApi', () => {
  it('liefert die Daten eigener Endpunkte', async () => {
    stubFetch({ 'GET /api/me': json(meFixture()) });
    await expect(createApi().me()).resolves.toEqual(meFixture());
  });

  it('wirft ApiError mit dem Code aus dem Fehler-Body', async () => {
    stubFetch({
      'GET /api/me': json({ error: { code: 'NO_ACTIVE_ORGANIZATION', message: 'x' } }, 403),
    });
    await expect(createApi().me()).rejects.toMatchObject({
      status: 403,
      code: 'NO_ACTIVE_ORGANIZATION',
    });
  });

  it('meldet 401 eigener Endpunkte an onUnauthorized', async () => {
    stubFetch({ 'GET /api/me': json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401) });
    const onUnauthorized = vi.fn();
    await expect(createApi({ onUnauthorized }).me()).rejects.toBeInstanceOf(ApiError);
    expect(onUnauthorized).toHaveBeenCalledOnce();
  });

  it('meldet einen fehlgeschlagenen Login nicht als abgelaufene Session', async () => {
    stubFetch({
      'POST /api/auth/sign-in/email': json(
        { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'Invalid email or password' },
        401,
      ),
    });
    const onUnauthorized = vi.fn();
    await expect(
      createApi({ onUnauthorized }).auth.signIn({ email: 'a@b.de', password: 'falsch' }),
    ).rejects.toMatchObject({ status: 401, code: 'INVALID_EMAIL_OR_PASSWORD' });
    expect(onUnauthorized).not.toHaveBeenCalled();
  });

  it('wandelt Verbindungsfehler in ApiError NETWORK_ERROR', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(createApi().me()).rejects.toMatchObject({ status: 0, code: 'NETWORK_ERROR' });
    await expect(createApi().auth.signOut()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
  });

  it('sendet schreibende Requests als JSON von derselben Origin', async () => {
    const { requests } = stubFetch({
      'POST /api/auth/sign-in/email': json({ redirect: false, token: 't' }),
      'POST /api/auth/sign-out': json({ success: true }),
      'POST /api/auth/organization/set-active': json({ id: 'org-2' }),
      'PUT /api/settings': json({ theme: 'dark', locale: 'de-DE', density: 'compact' }),
    });
    const api = createApi();
    await api.auth.signIn({ email: 'a@b.de', password: 'geheim' });
    await api.auth.signOut();
    await api.auth.setActiveOrganization('org-2');
    await api.updateSettings({ theme: 'dark', locale: 'de-DE', density: 'compact' });

    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['POST', '/api/auth/sign-in/email', { email: 'a@b.de', password: 'geheim' }],
      ['POST', '/api/auth/sign-out', {}],
      ['POST', '/api/auth/organization/set-active', { organizationId: 'org-2' }],
      ['PUT', '/api/settings', { theme: 'dark', locale: 'de-DE', density: 'compact' }],
    ]);
    for (const request of requests) {
      expect(request.headers.get('content-type')).toBe('application/json');
      expect(request.credentials).toBe('same-origin');
    }
  });

  it('liest und schreibt UI-Zustand', async () => {
    const { requests } = stubFetch({
      'GET /api/settings/ui-state/shell/sidebar': json({ value: { collapsed: true } }),
      'PUT /api/settings/ui-state/shell/sidebar': json({ value: { collapsed: false } }),
    });
    const api = createApi();
    await expect(api.getUiState('shell', 'sidebar')).resolves.toEqual({ collapsed: true });
    await api.putUiState('shell', 'sidebar', { collapsed: false });
    expect(requests[1]?.body).toEqual({ value: { collapsed: false } });
  });

  it('behandelt erfolgreiche Antworten ohne Body als Erfolg', async () => {
    stubFetch({
      'PUT /api/settings/ui-state/shell/sidebar': new Response(null, { status: 204 }),
    });
    await expect(
      createApi().putUiState('shell', 'sidebar', { collapsed: true }),
    ).resolves.toBeUndefined();
  });
});
