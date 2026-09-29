import { flushPromises } from '@vue/test-utils';
import Select from 'primevue/select';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

const SELF = '00000000-0000-4000-8000-0000000000f1';
const EMIL = '00000000-0000-4000-8000-0000000000f2';

const member = (patch: Record<string, unknown>) => ({
  id: SELF,
  userId: 'u1',
  name: 'Dominik',
  email: 'dominik@muuv.test',
  role: 'admin',
  status: 'active',
  linkExpiresAt: null,
  isSelf: true,
  createdAt: '2026-09-01T08:00:00.000Z',
  ...patch,
});

const list = () => ({
  members: [
    member({}),
    member({
      id: EMIL,
      userId: 'u2',
      name: 'Emil',
      email: 'emil@muuv.test',
      role: 'editor',
      status: 'pending',
      linkExpiresAt: '2026-10-06T08:00:00.000Z',
      isSelf: false,
    }),
  ],
});

const LINK = 'http://localhost:3000/set-password#' + 'a'.repeat(43);

function routes(extra: Record<string, Response | ((r: never) => Response)> = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/members': json(list()),
    ...extra,
  };
}

const q = <T extends Element = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('MembersPage', () => {
  it('Liste mit Rolle und Status, ohne Entfernen am eigenen Konto', async () => {
    stubFetch(routes());
    const { wrapper } = await mountWithApp(undefined, { path: '/admin/members' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('emil@muuv.test'));
    expect(wrapper.text()).toContain('Link offen bis 06.10.2026');
    expect(wrapper.text()).toContain('Aktiv');
    expect(wrapper.find('[aria-label="Emil entfernen"]').exists()).toBe(true);
    expect(wrapper.find('[aria-label="Dominik entfernen"]').exists()).toBe(false);
  });

  it('anlegen zeigt den Link einmal zum Kopieren', async () => {
    const { requests } = stubFetch(
      routes({
        'POST /api/members': json(
          {
            member: member({ id: EMIL, name: 'Nora', isSelf: false }),
            link: { url: LINK, expiresAt: '2026-10-06T08:00:00.000Z' },
          },
          201,
        ),
      }),
    );
    const { wrapper } = await mountWithApp(undefined, { path: '/admin/members' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('emil@muuv.test'));
    await wrapper.find('[data-member-create]').trigger('click');
    await flushPromises();
    const set = (selector: string, value: string) => {
      const input = q<HTMLInputElement>(selector);
      input.value = value;
      input.dispatchEvent(new Event('input'));
    };
    set('[data-member-email]', 'nora@muuv.test');
    set('[data-member-name]', 'Nora');
    q('[data-member-submit]').click();
    await vi.waitFor(() => expect(q<HTMLInputElement>('[data-member-link]')?.value).toBe(LINK));
    expect(requests.find((r) => r.method === 'POST')?.body).toEqual({
      email: 'nora@muuv.test',
      name: 'Nora',
      role: 'editor',
    });
    expect(document.body.textContent).toContain('Er wird nur jetzt angezeigt');
  });

  it('Fehler „letzter Admin“ erscheint an der Zeile', async () => {
    stubFetch(
      routes({
        [`PATCH /api/members/${SELF}`]: json(
          { error: { code: 'MEMBER_LAST_ADMIN', message: 'x' } },
          409,
        ),
        [`DELETE /api/members/${EMIL}`]: new Response(null, { status: 204 }),
      }),
    );
    const { wrapper } = await mountWithApp(undefined, { path: '/admin/members' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('emil@muuv.test'));
    const select = wrapper
      .findAllComponents(Select)
      .find(
        (s) =>
          s.attributes('aria-label') === 'Rolle von Dominik' ||
          s.props('ariaLabel') === 'Rolle von Dominik',
      )!;
    select.vm.$emit('update:modelValue', 'viewer');
    await flushPromises();
    // Eigene Admin-Rolle abgeben: erst nach Rückfrage.
    expect(document.body.textContent).toContain('Du verlierst sofort den Zugriff');
    q('[data-member-confirm]').click();
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Die Organisation braucht mindestens einen Admin.'),
    );
  });

  it('entfernen fragt nach', async () => {
    const { requests } = stubFetch(
      routes({ [`DELETE /api/members/${EMIL}`]: new Response(null, { status: 204 }) }),
    );
    const { wrapper } = await mountWithApp(undefined, { path: '/admin/members' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('emil@muuv.test'));
    await wrapper.find('[aria-label="Emil entfernen"]').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain(
      'Persönliche gespeicherte Ansichten werden gelöscht',
    );
    expect(requests.some((r) => r.method === 'DELETE')).toBe(false);
    q('[data-member-remove-confirm]').click();
    await vi.waitFor(() => expect(requests.some((r) => r.method === 'DELETE')).toBe(true));
  });

  it('neuer Link für ein aktives Konto fragt nach, für einen offenen Link nicht', async () => {
    const { requests } = stubFetch(
      routes({
        [`POST /api/members/${SELF}/password-link`]: json(
          { url: LINK, expiresAt: '2026-10-06T08:00:00.000Z' },
          201,
        ),
        [`POST /api/members/${EMIL}/password-link`]: json(
          { url: LINK, expiresAt: '2026-10-06T08:00:00.000Z' },
          201,
        ),
      }),
    );
    const { wrapper } = await mountWithApp(undefined, { path: '/admin/members' });
    await vi.waitFor(() => expect(wrapper.text()).toContain('emil@muuv.test'));
    await wrapper
      .find('[aria-label="Neuen Link zum Passwort-Setzen für Emil erzeugen"]')
      .trigger('click');
    await vi.waitFor(() => expect(requests.some((r) => r.path.includes(EMIL))).toBe(true));
    await vi.waitFor(() => expect(q<HTMLInputElement>('[data-member-link]')?.value).toBe(LINK));
    q<HTMLElement>('.p-dialog-close-button, [aria-label="Schließen"]')?.click();
    await flushPromises();

    await wrapper
      .find('[aria-label="Neuen Link zum Passwort-Setzen für Dominik erzeugen"]')
      .trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('hat schon ein Passwort');
    expect(requests.some((r) => r.path.includes(`${SELF}/password-link`))).toBe(false);
    q('[data-member-confirm]').click();
    await vi.waitFor(() =>
      expect(requests.some((r) => r.path.includes(`${SELF}/password-link`))).toBe(true),
    );
  });

  it('Laden, Fehler mit „Erneut versuchen“ und leere Liste (DoD)', async () => {
    stubFetch(routes({ 'GET /api/members': () => new Promise<Response>(() => {}) } as never));
    await mountWithApp(undefined, { path: '/admin/members' });
    await vi.waitFor(() => expect(q('[aria-busy="true"] [data-skeleton]')).not.toBeNull());
    cleanupMounted();

    stubFetch(
      routes({ 'GET /api/members': json({ error: { code: 'SERVER', message: 'x' } }, 500) }),
    );
    const failed = await mountWithApp(undefined, { path: '/admin/members' });
    await vi.waitFor(() =>
      expect(failed.wrapper.text()).toContain('Die Mitglieder konnten nicht geladen werden.'),
    );
    expect(failed.wrapper.text()).toContain('Erneut versuchen');
    cleanupMounted();

    stubFetch(routes({ 'GET /api/members': json({ members: [] }) }));
    const empty = await mountWithApp(undefined, { path: '/admin/members' });
    await vi.waitFor(() => expect(empty.wrapper.text()).toContain('Noch keine Mitglieder.'));
  });

  it('nur für Org-Admins', async () => {
    stubFetch(routes({ 'GET /api/me': json(meFixture({ orgRole: 'editor' })) }));
    const { router } = await mountWithApp(undefined, { path: '/admin/members' });
    await flushPromises();
    expect(router.currentRoute.value.name).toBe('forbidden');
  });
});
