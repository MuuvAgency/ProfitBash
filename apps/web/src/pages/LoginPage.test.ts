import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';
import LoginPage from './LoginPage.vue';

const unauthorized = () => json({ error: { code: 'UNAUTHORIZED', message: 'x' } }, 401);

afterEach(() => {
  vi.unstubAllGlobals();
  cleanupMounted();
});

async function fillAndSubmit(
  wrapper: Awaited<ReturnType<typeof mountWithApp>>['wrapper'],
  email: string,
  password: string,
) {
  await wrapper.get('input[type="email"]').setValue(email);
  await wrapper.get('input[autocomplete="current-password"]').setValue(password);
  await wrapper.get('form').trigger('submit');
  await flushPromises();
}

describe('LoginPage', () => {
  it('hat sichtbare Labels für E-Mail und Passwort', async () => {
    stubFetch({ 'GET /api/me': unauthorized });
    const { wrapper } = await mountWithApp(LoginPage, { path: '/login' });
    for (const [label, selector] of [
      ['E-Mail-Adresse', 'input[type="email"]'],
      ['Passwort', 'input[autocomplete="current-password"]'],
    ] as const) {
      const input = wrapper.get(selector);
      expect(wrapper.get(`label[for="${input.attributes('id')}"]`).text()).toBe(label);
    }
  });

  it('verlangt E-Mail und Passwort, bevor es den Server fragt', async () => {
    const { requests } = stubFetch({ 'GET /api/me': unauthorized });
    const { wrapper } = await mountWithApp(LoginPage, { path: '/login' });
    await fillAndSubmit(wrapper, '', '');
    expect(wrapper.text()).toContain('Bitte E-Mail-Adresse und Passwort eingeben.');
    expect(requests.filter((r) => r.path.startsWith('/api/auth'))).toHaveLength(0);
  });

  it('meldet an und springt zum sicheren Rücksprungziel', async () => {
    let signedIn = false;
    const { requests } = stubFetch({
      'GET /api/me': () => (signedIn ? json(meFixture()) : unauthorized()),
      'POST /api/auth/sign-in/email': () => {
        signedIn = true;
        return json({ redirect: false });
      },
    });
    const { wrapper, router } = await mountWithApp(LoginPage, {
      path: '/login?redirect=%2Fads%2Fbudgets%3Frange%3D7d',
    });
    await fillAndSubmit(wrapper, ' dominik@muuv.test ', 'geheim');
    expect(requests.find((r) => r.path === '/api/auth/sign-in/email')?.body).toEqual({
      email: 'dominik@muuv.test',
      password: 'geheim',
    });
    await vi.waitFor(() =>
      expect(router.currentRoute.value.fullPath).toBe('/ads/budgets?range=7d'),
    );
  });

  it('ignoriert fremde Rücksprungziele', async () => {
    let signedIn = false;
    stubFetch({
      'GET /api/me': () => (signedIn ? json(meFixture()) : unauthorized()),
      'POST /api/auth/sign-in/email': () => {
        signedIn = true;
        return json({ redirect: false });
      },
    });
    const { wrapper, router } = await mountWithApp(LoginPage, {
      path: '/login?redirect=%2F%2Fevil.test',
    });
    await fillAndSubmit(wrapper, 'dominik@muuv.test', 'geheim');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/dashboard'));
  });

  it('zeigt falsche Zugangsdaten verständlich an und leert das Passwort', async () => {
    stubFetch({
      'GET /api/me': unauthorized,
      'POST /api/auth/sign-in/email': json(
        { code: 'INVALID_EMAIL_OR_PASSWORD', message: 'x' },
        401,
      ),
    });
    const { wrapper, router } = await mountWithApp(LoginPage, { path: '/login' });
    await fillAndSubmit(wrapper, 'dominik@muuv.test', 'falsch');
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'E-Mail-Adresse oder Passwort ist falsch.',
    );
    expect(
      (wrapper.get('input[autocomplete="current-password"]').element as HTMLInputElement).value,
    ).toBe('');
    expect((wrapper.get('input[type="email"]').element as HTMLInputElement).value).toBe(
      'dominik@muuv.test',
    );
    expect(router.currentRoute.value.name).toBe('login');
  });

  it('weist auf eine abgelaufene Sitzung hin', async () => {
    stubFetch({ 'GET /api/me': unauthorized });
    const { wrapper } = await mountWithApp(LoginPage, { path: '/login?reason=expired' });
    expect(wrapper.text()).toContain('Deine Sitzung ist abgelaufen.');
  });

  it('kann das Passwort sichtbar machen', async () => {
    stubFetch({ 'GET /api/me': unauthorized });
    const { wrapper } = await mountWithApp(LoginPage, { path: '/login' });
    const input = () => wrapper.get('input[autocomplete="current-password"]');
    expect(input().attributes('type')).toBe('password');
    await wrapper.get('button[aria-label="Passwort anzeigen"]').trigger('click');
    expect(input().attributes('type')).toBe('text');
    expect(wrapper.find('button[aria-label="Passwort verbergen"]').exists()).toBe(true);
  });
});
