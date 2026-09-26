import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/errors';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { useSessionStore } from './session';

const flushMicrotasks = () => new Promise((resolve) => setTimeout(resolve, 0));

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

  it('ändert die Locale sofort und speichert sie mit den übrigen Einstellungen', async () => {
    const { requests } = stubFetch({
      'GET /api/me': json(meFixture()),
      'PUT /api/settings': ({ body }) => json(body),
    });
    const session = useSessionStore();
    await session.ensureLoaded();
    const saving = session.updatePreferences({ locale: 'en-GB' });
    expect(session.preferences.locale).toBe('en-GB');
    await saving;
    expect(requests.at(-1)?.body).toEqual({
      theme: 'system',
      locale: 'en-GB',
      density: 'comfortable',
    });
  });

  /** PUT-Antworten auf Anweisung: `respond(i, ok)` beantwortet den i-ten Request. */
  function deferredSettings() {
    const pending: ((ok: boolean) => void)[] = [];
    const stub = stubFetch({
      'GET /api/me': json(meFixture()),
      'POST /api/auth/sign-out': json({ success: true }),
      'PUT /api/settings': ({ body }) =>
        new Promise<Response>((resolve) =>
          pending.push((ok) =>
            resolve(
              ok ? json(body) : json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500),
            ),
          ),
        ),
    });
    const puts = () => stub.requests.filter((r) => r.method === 'PUT').map((r) => r.body);
    async function respond(index: number, ok: boolean) {
      await vi.waitFor(() => expect(pending.length).toBeGreaterThan(index));
      pending[index]!(ok);
    }
    return { puts, respond };
  }

  it('speichert nacheinander: eine spätere Änderung überholt keine frühere', async () => {
    const { puts, respond } = deferredSettings();
    const session = useSessionStore();
    await session.ensureLoaded();
    const first = session.updatePreferences({ theme: 'dark' });
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    const second = session.updatePreferences({ locale: 'en-US' });
    await flushMicrotasks();
    // Der zweite Request startet erst, wenn der erste beantwortet ist.
    expect(puts()).toHaveLength(1);
    await respond(0, true);
    await respond(1, true);
    await Promise.all([first, second]);
    expect(puts()).toEqual([
      { theme: 'dark', locale: 'de-DE', density: 'comfortable' },
      { theme: 'dark', locale: 'en-US', density: 'comfortable' },
    ]);
  });

  it('fällt auf den gespeicherten Stand zurück, wenn mehrere Änderungen desselben Felds scheitern', async () => {
    const { respond } = deferredSettings();
    const session = useSessionStore();
    await session.ensureLoaded();
    // Sofort abwarten, sonst gelten die Fehler als unbehandelt.
    const results = Promise.allSettled([
      session.updatePreferences({ theme: 'dark' }),
      session.updatePreferences({ theme: 'light' }),
    ]);
    await respond(0, false);
    await respond(1, false);
    expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    // Nicht „dark“ (war nie gespeichert), sondern der Stand des Servers.
    expect(session.preferences.theme).toBe('system');
    expect(localStorage.getItem('profitbash.theme')).toBe('system');
  });

  it('behält die letzte Wahl, wenn ein früherer Request scheitert (A → B → A)', async () => {
    const { puts, respond } = deferredSettings();
    const session = useSessionStore();
    await session.ensureLoaded();
    const first = session.updatePreferences({ theme: 'dark' });
    const firstResult = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    const rest = Promise.all([
      session.updatePreferences({ theme: 'light' }),
      session.updatePreferences({ theme: 'dark' }),
    ]);
    await respond(0, false);
    await respond(1, true);
    expect(await firstResult).toMatchObject({ code: 'INTERNAL_ERROR' });
    await rest;
    expect(session.preferences.theme).toBe('dark');
    expect(puts().at(-1)).toMatchObject({ theme: 'dark' });
  });

  it('sendet keinen weiteren Request, wenn der Stand schon gespeichert ist', async () => {
    const { puts, respond } = deferredSettings();
    const session = useSessionStore();
    await session.ensureLoaded();
    const saves = [session.updatePreferences({ theme: 'dark' })];
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    saves.push(session.updatePreferences({ locale: 'en-US' }));
    saves.push(session.updatePreferences({ density: 'compact' }));
    await respond(0, true);
    await respond(1, true);
    await Promise.all(saves);
    // Der zweite Request trägt beide wartenden Änderungen, ein dritter wäre identisch.
    expect(puts()).toHaveLength(2);
    expect(puts()[1]).toEqual({ theme: 'dark', locale: 'en-US', density: 'compact' });
  });

  it('speichert nach dem Abmelden nichts mehr für den bisherigen Nutzer', async () => {
    const { puts, respond } = deferredSettings();
    const session = useSessionStore();
    await session.ensureLoaded();
    const saves = [session.updatePreferences({ theme: 'dark' })];
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    saves.push(session.updatePreferences({ locale: 'en-US' }));
    session.markSignedOut();
    await respond(0, true);
    await Promise.allSettled(saves);
    await flushMicrotasks();
    expect(puts()).toHaveLength(1);
  });

  it('nimmt bei einem Fehler nur die eigenen Felder zurück', async () => {
    let calls = 0;
    stubFetch({
      'GET /api/me': json(meFixture()),
      'PUT /api/settings': ({ body }) =>
        ++calls === 1 ? json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500) : json(body),
    });
    const session = useSessionStore();
    await session.ensureLoaded();
    const theme = session.updatePreferences({ theme: 'dark' });
    const locale = session.updatePreferences({ locale: 'en-GB' });
    await expect(theme).rejects.toMatchObject({ code: 'INTERNAL_ERROR' });
    await locale;
    expect(session.preferences).toMatchObject({ theme: 'system', locale: 'en-GB' });
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

  it('verwirft eine ältere /api/me-Antwort, die nach dem Abmelden eintrifft', async () => {
    let release: (() => void) | undefined;
    stubFetch({
      'GET /api/me': () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(json(meFixture()));
        }),
      'POST /api/auth/sign-out': json({ success: true }),
    });
    const session = useSessionStore();
    const loading = session.load();
    await vi.waitFor(() => expect(release).toBeDefined());
    await session.signOut();
    release?.();
    await loading;
    expect(session.status).toBe('anonymous');
    expect(session.me).toBeNull();
  });

  it('lädt nach einem Org-Wechsel frisch, statt eine ältere Anfrage wiederzuverwenden', async () => {
    let active = 'org-1';
    let releaseFirst: (() => void) | undefined;
    const meFor = (org: string) => ({ ...meFixture(), activeOrganizationId: org });
    stubFetch({
      'GET /api/me': () => {
        const org = active;
        if (!releaseFirst) {
          return new Promise<Response>((resolve) => {
            releaseFirst = () => resolve(json(meFor(org)));
          });
        }
        return json(meFor(org));
      },
      'POST /api/auth/organization/set-active': ({ body }) => {
        active = (body as { organizationId: string }).organizationId;
        return json({ id: active });
      },
    });
    const session = useSessionStore();
    const initial = session.load();
    await vi.waitFor(() => expect(releaseFirst).toBeDefined());
    await session.switchOrganization('org-2');
    releaseFirst?.();
    await initial;
    expect(session.me?.activeOrganizationId).toBe('org-2');
  });

  it('behält das zuletzt gewählte Theme auch nach dem Abmelden', async () => {
    stubFetch({
      'GET /api/me': json(meFixture()),
      'PUT /api/settings': ({ body }) => json(body),
      'POST /api/auth/sign-out': json({ success: true }),
    });
    const session = useSessionStore();
    await session.ensureLoaded();
    await session.setTheme('dark');
    await session.signOut();
    expect(session.preferences.theme).toBe('dark');
  });
});
