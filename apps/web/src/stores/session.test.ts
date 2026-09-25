import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { useSessionStore } from './session';

const unauthorized = () => json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401);

beforeEach(() => {
  setActivePinia(createPinia());
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('session store', () => {
  it('lädt /api/me nur einmal, auch bei gleichzeitigen Aufrufen', async () => {
    const { requests } = stubFetch({ 'GET /api/me': json(meFixture()) });
    const session = useSessionStore();
    await Promise.all([session.ensureLoaded(), session.ensureLoaded()]);
    await session.ensureLoaded();
    expect(requests).toHaveLength(1);
    expect(session.status).toBe('authenticated');
    expect(session.me?.user.email).toBe('dominik@muuv.test');
  });

  it('ist ohne gültige Session anonym', async () => {
    stubFetch({ 'GET /api/me': unauthorized });
    const session = useSessionStore();
    await session.ensureLoaded();
    expect(session.status).toBe('anonymous');
    expect(session.guardSession).toEqual({ status: 'anonymous' });
  });

  it('meldet Serverfehler als Fehlerzustand und erholt sich beim erneuten Laden', async () => {
    stubFetch({ 'GET /api/me': json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) });
    const session = useSessionStore();
    await session.ensureLoaded();
    expect(session.status).toBe('error');
    expect(session.loadError).toMatchObject({ code: 'INTERNAL_ERROR' });

    stubFetch({ 'GET /api/me': json(meFixture()) });
    await session.load();
    expect(session.status).toBe('authenticated');
    expect(session.loadError).toBeNull();
  });

  it('meldet an und lädt danach den Nutzerkontext', async () => {
    const { requests } = stubFetch({
      'POST /api/auth/sign-in/email': json({ redirect: false }),
      'GET /api/me': json(meFixture()),
    });
    const session = useSessionStore();
    await session.signIn({ email: 'dominik@muuv.test', password: 'geheim' });
    expect(requests.map((r) => r.path)).toEqual(['/api/auth/sign-in/email', '/api/me']);
    expect(session.status).toBe('authenticated');
  });

  it('wirft bei falschen Zugangsdaten und bleibt anonym', async () => {
    const { requests } = stubFetch({
      'POST /api/auth/sign-in/email': json(
        { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'x' },
        401,
      ),
    });
    const session = useSessionStore();
    await expect(session.signIn({ email: 'a@b.de', password: 'falsch' })).rejects.toBeInstanceOf(
      ApiError,
    );
    expect(session.status).not.toBe('authenticated');
    expect(requests).toHaveLength(1);
  });

  it('meldet ab und vergisst den Nutzerkontext', async () => {
    stubFetch({
      'GET /api/me': json(meFixture()),
      'POST /api/auth/sign-out': json({ success: true }),
    });
    const session = useSessionStore();
    await session.ensureLoaded();
    await session.signOut();
    expect(session.status).toBe('anonymous');
    expect(session.me).toBeNull();
  });

  it('gilt als abgemeldet, wenn die Session beim Abmelden schon abgelaufen war', async () => {
    stubFetch({ 'GET /api/me': json(meFixture()), 'POST /api/auth/sign-out': unauthorized });
    const session = useSessionStore();
    await session.ensureLoaded();
    await session.signOut();
    expect(session.status).toBe('anonymous');
  });

  it('bleibt angemeldet, wenn der Server beim Abmelden nicht erreichbar ist', async () => {
    stubFetch({ 'GET /api/me': json(meFixture()) });
    const session = useSessionStore();
    await session.ensureLoaded();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    await expect(session.signOut()).rejects.toMatchObject({ code: 'NETWORK_ERROR' });
    expect(session.status).toBe('authenticated');
  });

  it('wechselt die Organisation und lädt Rechte und Menü neu', async () => {
    const other = meFixture({ orgRole: 'viewer' });
    other.activeOrganizationId = 'org-2';
    let current = meFixture();
    const { requests } = stubFetch({
      'GET /api/me': () => json(current),
      'POST /api/auth/organization/set-active': () => {
        current = other;
        return json({ id: 'org-2' });
      },
    });
    const session = useSessionStore();
    await session.ensureLoaded();
    await session.switchOrganization('org-2');
    expect(requests.at(-2)?.body).toEqual({ organizationId: 'org-2' });
    expect(session.me?.activeOrganizationId).toBe('org-2');
  });

  it('setzt das Theme sofort und speichert es mit den übrigen Einstellungen', async () => {
    const { requests } = stubFetch({
      'GET /api/me': json(meFixture()),
      'PUT /api/settings': ({ body }) => json(body),
    });
    const session = useSessionStore();
    await session.ensureLoaded();
    const saving = session.setTheme('dark');
    expect(session.preferences.theme).toBe('dark');
    await saving;
    expect(requests.at(-1)?.body).toEqual({
      theme: 'dark',
      locale: 'de-DE',
      density: 'comfortable',
    });
    expect(localStorage.getItem('profitbash.theme')).toBe('dark');
  });

  it('nimmt das Theme zurück, wenn das Speichern scheitert', async () => {
    stubFetch({
      'GET /api/me': json(meFixture()),
      'PUT /api/settings': json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500),
    });
    const session = useSessionStore();
    await session.ensureLoaded();
    await expect(session.setTheme('dark')).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    expect(session.preferences.theme).toBe('system');
    expect(localStorage.getItem('profitbash.theme')).toBe('system');
  });

  it('nutzt vor dem Login das zuletzt gespeicherte Theme', () => {
    localStorage.setItem('profitbash.theme', 'dark');
    expect(useSessionStore().preferences.theme).toBe('dark');
  });

  it('vergisst den Nutzer, wenn eine spätere Anfrage 401 liefert', async () => {
    stubFetch({ 'GET /api/me': json(meFixture()) });
    const session = useSessionStore();
    await session.ensureLoaded();
    session.markSignedOut();
    expect(session.status).toBe('anonymous');
    expect(session.me).toBeNull();
  });
});
