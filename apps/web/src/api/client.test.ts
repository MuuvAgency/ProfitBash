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

describe('Connections, Profile und Clients', () => {
  const connectionId = '11111111-1111-4111-8111-111111111111';
  const profileId = '22222222-2222-4222-8222-222222222222';
  const clientId = '33333333-3333-4333-8333-333333333333';

  it('liest Connections, Profile und Clients aus der Hülle der Antwort', async () => {
    stubFetch({
      'GET /api/connections': json({ connections: [{ id: connectionId }] }),
      [`GET /api/connections/${connectionId}/profiles`]: json({ profiles: [{ id: profileId }] }),
      'GET /api/clients': json({ clients: [{ id: clientId }] }),
    });
    const api = createApi();
    await expect(api.listConnections()).resolves.toEqual([{ id: connectionId }]);
    await expect(api.listProfiles(connectionId)).resolves.toEqual([{ id: profileId }]);
    await expect(api.listClients()).resolves.toEqual([{ id: clientId }]);
  });

  it('startet das Verbinden und liefert die Einwilligungs-URL', async () => {
    const { requests } = stubFetch({
      'POST /api/amazon/oauth/start': json({ url: 'https://eu.account.amazon.com/ap/oa?x=1' }),
    });
    const api = createApi();
    await expect(api.startAmazonOAuth()).resolves.toBe('https://eu.account.amazon.com/ap/oa?x=1');
    await api.startAmazonOAuth({ connectionId });
    expect(requests.map((r) => r.body)).toEqual([{}, { connectionId }]);
  });

  it('plant einen Sync ein und meldet „Neu verbinden nötig“ als Fehlercode', async () => {
    const { requests } = stubFetch({
      [`POST /api/connections/${connectionId}/sync`]: json({ status: 'queued' }, 202),
    });
    await createApi().syncConnection(connectionId);
    expect(requests[0]).toMatchObject({
      method: 'POST',
      path: `/api/connections/${connectionId}/sync`,
    });

    stubFetch({
      [`POST /api/connections/${connectionId}/sync`]: json(
        { error: { code: 'CONNECTION_REAUTH_REQUIRED', message: 'x' } },
        409,
      ),
    });
    await expect(createApi().syncConnection(connectionId)).rejects.toMatchObject({
      status: 409,
      code: 'CONNECTION_REAUTH_REQUIRED',
    });
  });

  it('ändert Profile und legt Clients an', async () => {
    const { requests } = stubFetch({
      [`PATCH /api/profiles/${profileId}`]: ({ body }) =>
        json({ id: profileId, ...(body as object) }),
      'POST /api/clients': json({ id: clientId, name: 'Soapi', slug: 'soapi' }, 201),
    });
    const api = createApi();
    await expect(api.updateProfile(profileId, { isHidden: true })).resolves.toMatchObject({
      id: profileId,
      isHidden: true,
    });
    await expect(api.createClient({ name: 'Soapi' })).resolves.toMatchObject({ id: clientId });
    expect(requests.map((r) => [r.method, r.path, r.body])).toEqual([
      ['PATCH', `/api/profiles/${profileId}`, { isHidden: true }],
      ['POST', '/api/clients', { name: 'Soapi' }],
    ]);
  });
});

describe('Sync-Status', () => {
  it('liest die Jobläufe und übergibt nur gesetzte Filter', async () => {
    const run = { id: '44444444-4444-4444-8444-444444444444', job: 'profiles-sync' };
    const { requests } = stubFetch({ 'GET /api/job-runs': json({ jobRuns: [run] }) });
    const api = createApi();
    await expect(api.listJobRuns()).resolves.toEqual([run]);
    await api.listJobRuns({ job: 'token-refresh' });
    await api.listJobRuns({ job: 'profiles-sync', status: 'failed' });
    expect(requests.map((r) => r.search)).toEqual([
      '',
      '?job=token-refresh',
      '?job=profiles-sync&status=failed',
    ]);
  });
});
