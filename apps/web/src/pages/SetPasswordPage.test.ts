import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { cleanupMounted, mountWithApp } from '../test/mount';

const TOKEN = 'Abc_-'.repeat(8) + 'xyz';

function routes(extra: Record<string, Response> = {}) {
  return {
    'GET /api/me': json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401),
    'POST /api/password-links/inspect': json({
      email: 'nora@muuv.test',
      name: 'Nora',
      expiresAt: '2026-10-06T08:00:00.000Z',
    }),
    ...extra,
  };
}

function setHash(hash: string) {
  history.replaceState(null, '', `/set-password${hash}`);
}

const input = (id: string, value: string) => {
  const el = document.getElementById(id) as HTMLInputElement;
  el.value = value;
  el.dispatchEvent(new Event('input'));
};

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
  history.replaceState(null, '', '/');
});

describe('SetPasswordPage', () => {
  it('Token aus dem Fragment, im Body an die API, danach zur Anmeldung', async () => {
    expect(TOKEN).toHaveLength(43);
    setHash(`#${TOKEN}`);
    const { requests } = stubFetch({
      ...routes(),
      'POST /api/password-links/redeem': new Response(null, { status: 204 }),
    });
    const { wrapper, router } = await mountWithApp(undefined, { path: '/set-password' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('Zugang für Nora'));
    // Fragment sofort aus der Adresszeile entfernt; nie im Pfad oder Query-String.
    expect(location.hash).toBe('');
    expect(requests.every((r) => !r.path.includes(TOKEN) && !r.search.includes(TOKEN))).toBe(true);
    expect(requests.find((r) => r.path === '/api/password-links/inspect')?.body).toEqual({
      token: TOKEN,
    });

    input('set-password', 'kurz');
    input('set-password-repeat', 'kurz');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.text()).toContain('mindestens 12 Zeichen');

    input('set-password', 'ein-langes-passwort');
    input('set-password-repeat', 'ein-anderes-passwort');
    await wrapper.find('form').trigger('submit');
    expect(wrapper.text()).toContain('stimmen nicht überein');

    input('set-password-repeat', 'ein-langes-passwort');
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/login'));
    expect(router.currentRoute.value.query).toEqual({ reason: 'passwordSet' });
    expect(requests.find((r) => r.path === '/api/password-links/redeem')?.body).toEqual({
      token: TOKEN,
      password: 'ein-langes-passwort',
    });
    await vi.waitFor(() => expect(wrapper.text()).toContain('Passwort gesetzt.'));
  });

  it('abgelaufener oder fehlender Link: Hinweis statt Formular', async () => {
    setHash(`#${TOKEN}`);
    stubFetch(
      routes({
        'POST /api/password-links/inspect': json(
          { error: { code: 'PASSWORD_LINK_INVALID', message: 'x' } },
          410,
        ),
      }),
    );
    const { wrapper } = await mountWithApp(undefined, { path: '/set-password' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('Dieser Link gilt nicht (mehr).'));
    expect(wrapper.find('form').exists()).toBe(false);
    cleanupMounted();

    setHash('');
    const { requests } = stubFetch(routes());
    const second = await mountWithApp(undefined, { path: '/set-password' });
    await flushPromises();
    expect(second.wrapper.text()).toContain('Dieser Link gilt nicht (mehr).');
    expect(requests.some((r) => r.path === '/api/password-links/inspect')).toBe(false);
  });
});
