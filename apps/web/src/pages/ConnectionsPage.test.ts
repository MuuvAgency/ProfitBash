import type { Profile } from '@profitbash/shared';
import { DOMWrapper, flushPromises } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { browserNavigation } from '../connections/browser-navigation';
import { json, stubFetch } from '../test/fetch-stub';
import {
  CONNECTION_ID,
  clientFixture,
  connectionFixture,
  meFixture,
  profileFixture,
} from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';
import ConnectionsPage from './ConnectionsPage.vue';

const PROFILES_PATH = `/api/connections/${CONNECTION_ID}/profiles`;
const SYNC_PATH = `/api/connections/${CONNECTION_ID}/sync`;

const soapi = clientFixture();
const soapiDe = profileFixture({ accountName: 'Soapi GmbH' });
const soapiUk = profileFixture({
  accountName: 'Soapi UK Ltd',
  countryCode: 'UK',
  currencyCode: 'GBP',
  timezone: 'Europe/London',
  clientId: soapi.id,
});
const aliseoSe = profileFixture({
  accountName: 'Aliseo Nordic AB',
  countryCode: 'SE',
  currencyCode: 'SEK',
  timezone: 'Europe/Stockholm',
  accountType: 'vendor',
  removedAt: '2026-09-25T03:00:00.000Z',
});

const serverError = () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);
const pending = () => new Promise<Response>(() => {});

function routes(overrides: Parameters<typeof stubFetch>[0] = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/connections': json({ connections: [connectionFixture()] }),
    [`GET ${PROFILES_PATH}`]: json({ profiles: [soapiDe, soapiUk, aliseoSe] }),
    'GET /api/clients': json({ clients: [soapi] }),
    ...overrides,
  };
}

async function mountPage(path = '/admin/connections') {
  return mountWithApp(ConnectionsPage, { path });
}

type Wrapper = Awaited<ReturnType<typeof mountPage>>['wrapper'];

function button(wrapper: Wrapper, label: string) {
  const found = wrapper.findAll('button').filter((b) => b.text() === label);
  expect(found, `Button „${label}“`).toHaveLength(1);
  return found[0]!;
}

function row(wrapper: Wrapper, accountName: string) {
  return wrapper.findAll('[role="row"]').find((r) => r.text().includes(accountName));
}

async function waitForRow(wrapper: Wrapper, accountName: string) {
  await vi.waitFor(() => expect(row(wrapper, accountName)).toBeDefined());
  return row(wrapper, accountName)!;
}

/** Wählt eine Option in einem PrimeVue-Select (das Overlay hängt am <body>). */
async function choose(wrapper: Wrapper, comboboxLabel: string, optionLabel: string) {
  await wrapper.get(`[role="combobox"][aria-label="${comboboxLabel}"]`).trigger('click');
  await flushPromises();
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.getAttribute('aria-label') === optionLabel,
  );
  expect(option, `Option „${optionLabel}“`).toBeDefined();
  // PrimeVue wählt Optionen auf `mousedown` (vor dem Blur des Comboboxes).
  option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await flushPromises();
}

function dialog() {
  const element = document.body.querySelector<HTMLElement>('[role="dialog"]');
  return element ? new DOMWrapper(element) : null;
}

let assign: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  assign = vi.spyOn(browserNavigation, 'assign').mockImplementation(() => {});
});

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ConnectionsPage', () => {
  it('zeigt die Connection mit Status und ihre Profile', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    const de = await waitForRow(wrapper, 'Soapi GmbH');

    expect(wrapper.get('h1').text()).toBe('Clients & Connections');
    expect(wrapper.text()).toContain('ads@muuv.test');
    expect(wrapper.text()).toContain('Europa');
    expect(wrapper.text()).toContain('Aktiv');
    for (const text of ['Deutschland', 'Seller', 'EUR', 'Europe/Berlin']) {
      expect(de.text()).toContain(text);
    }
    const uk = row(wrapper, 'Soapi UK Ltd')!;
    expect(uk.text()).toContain('Vereinigtes Königreich');
    await vi.waitFor(() => expect(uk.find('img[src*="gb.svg"]').exists()).toBe(true));
    expect(uk.get('[role="combobox"]').text()).toBe('Soapi');
  });

  it('blendet entfernte Profile nur mit dem Filter „Entfernte anzeigen“ ein', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    expect(row(wrapper, 'Aliseo Nordic AB')).toBeUndefined();

    const toggle = wrapper.get('input[role="switch"]#connections-show-removed');
    expect(wrapper.get('label[for="connections-show-removed"]').text()).toBe('Entfernte anzeigen');
    await toggle.setValue(true);
    const removed = await waitForRow(wrapper, 'Aliseo Nordic AB');
    expect(removed.text()).toContain('Entfernt');
    expect(removed.text()).toContain('Vendor');
  });

  it('zeigt beim Laden ein Skelett', async () => {
    stubFetch(routes({ 'GET /api/connections': pending }));
    const { wrapper } = await mountPage();
    expect(wrapper.find('[aria-busy="true"]').exists()).toBe(true);
  });

  it('bietet ohne Connection das Verbinden an', async () => {
    stubFetch(routes({ 'GET /api/connections': json({ connections: [] }) }));
    const { wrapper } = await mountPage();
    await vi.waitFor(() => expect(wrapper.text()).toContain('Noch kein Amazon-Konto verbunden'));
  });

  it('zeigt einen Ladefehler mit „Erneut versuchen“ und erholt sich', async () => {
    let fail = true;
    stubFetch(
      routes({
        'GET /api/connections': () =>
          fail ? serverError() : json({ connections: [connectionFixture()] }),
      }),
    );
    const { wrapper } = await mountPage();
    await vi.waitFor(() =>
      expect(wrapper.get('[role="alert"]').text()).toContain(
        'Die Connections konnten nicht geladen werden.',
      ),
    );
    fail = false;
    await button(wrapper, 'Erneut versuchen').trigger('click');
    await waitForRow(wrapper, 'Soapi GmbH');
  });

  it('lässt einen Fehler beim Laden der Profile nicht die ganze Seite scheitern', async () => {
    stubFetch(routes({ [`GET ${PROFILES_PATH}`]: serverError }));
    const { wrapper } = await mountPage();
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Die Profile konnten nicht geladen werden.'),
    );
    expect(wrapper.text()).toContain('ads@muuv.test');
    expect(button(wrapper, 'Jetzt synchronisieren').attributes('disabled')).toBeUndefined();
  });

  it('startet das Verbinden und leitet zu Amazon weiter', async () => {
    const url = 'https://eu.account.amazon.com/ap/oa?state=abc';
    const { requests } = stubFetch(routes({ 'POST /api/amazon/oauth/start': json({ url }) }));
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    await button(wrapper, 'Amazon-Account verbinden').trigger('click');
    await flushPromises();
    expect(requests.find((r) => r.path === '/api/amazon/oauth/start')?.body).toEqual({});
    expect(assign).toHaveBeenCalledWith(url);
  });

  it('folgt keinen Weiterleitungen außer http(s)', async () => {
    stubFetch(routes({ 'POST /api/amazon/oauth/start': json({ url: 'javascript:alert(1)' }) }));
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    await button(wrapper, 'Amazon-Account verbinden').trigger('click');
    await flushPromises();
    expect(assign).not.toHaveBeenCalled();
    expect(wrapper.get('[role="alert"]').text()).toContain('Etwas ist schiefgelaufen.');
  });

  it('bietet bei reauth_required „Neu verbinden“ statt Sync an', async () => {
    const url = 'https://eu.account.amazon.com/ap/oa?state=def';
    const { requests } = stubFetch(
      routes({
        'GET /api/connections': json({
          connections: [connectionFixture({ status: 'reauth_required' })],
        }),
        'POST /api/amazon/oauth/start': json({ url }),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    expect(wrapper.text()).toContain('Neu verbinden nötig');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Jetzt synchronisieren')).toBe(false);

    await button(wrapper, 'Neu verbinden').trigger('click');
    await flushPromises();
    expect(requests.find((r) => r.path === '/api/amazon/oauth/start')?.body).toEqual({
      connectionId: CONNECTION_ID,
    });
    expect(assign).toHaveBeenCalledWith(url);
  });

  it('plant einen Sync ein und bestätigt es', async () => {
    const { requests } = stubFetch(
      routes({ [`POST ${SYNC_PATH}`]: json({ status: 'queued' }, 202) }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    await button(wrapper, 'Jetzt synchronisieren').trigger('click');
    await flushPromises();
    expect(requests.some((r) => r.method === 'POST' && r.path === SYNC_PATH)).toBe(true);
    expect(wrapper.get('[role="status"]').text()).toContain('Sync eingeplant.');
  });

  it('lädt die Connections neu, wenn der Sync ein Neu-Verbinden verlangt', async () => {
    let status: 'active' | 'reauth_required' = 'active';
    const { requests } = stubFetch(
      routes({
        'GET /api/connections': () => json({ connections: [connectionFixture({ status })] }),
        [`POST ${SYNC_PATH}`]: () => {
          status = 'reauth_required';
          return json({ error: { code: 'CONNECTION_REAUTH_REQUIRED', message: 'x' } }, 409);
        },
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    await button(wrapper, 'Jetzt synchronisieren').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(wrapper.text()).toContain('Neu verbinden nötig'));
    expect(requests.filter((r) => r.path === '/api/connections')).toHaveLength(2);
    expect(wrapper.text()).toContain('Amazon akzeptiert die Freigabe nicht mehr.');
    expect(button(wrapper, 'Neu verbinden').exists()).toBe(true);
  });

  it('zeigt das Ergebnis des OAuth-Callbacks und entfernt es beim Schließen aus der URL', async () => {
    stubFetch(routes());
    const { wrapper, router } = await mountPage('/admin/connections?oauth=connected');
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Amazon-Konto verbunden. Die Profile werden jetzt'),
    );
    await wrapper.get('button[aria-label="Hinweis schließen"]').trigger('click');
    await vi.waitFor(() => expect(router.currentRoute.value.fullPath).toBe('/admin/connections'));
    expect(wrapper.text()).not.toContain('Amazon-Konto verbunden.');
  });

  it('zeigt einen abgelehnten OAuth-Versuch als Fehler', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage('/admin/connections?oauth=access_denied');
    await vi.waitFor(() =>
      expect(wrapper.get('[role="alert"]').text()).toContain('bei Amazon abgelehnt'),
    );
  });

  it('blendet ein Profil aus', async () => {
    const { requests } = stubFetch(
      routes({
        [`PATCH /api/profiles/${soapiDe.id}`]: ({ body }) =>
          json({ ...soapiDe, ...(body as Partial<Profile>) }),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    const toggle = () => wrapper.get('input[aria-label="Soapi GmbH ausblenden"]');
    expect((toggle().element as HTMLInputElement).checked).toBe(false);
    await toggle().setValue(true);
    await flushPromises();
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ isHidden: true });
    await vi.waitFor(() => expect((toggle().element as HTMLInputElement).checked).toBe(true));
  });

  it('graut ausgeblendete Profile aus und nimmt das beim Einblenden zurück', async () => {
    const hidden = { ...soapiDe, isHidden: true };
    stubFetch(
      routes({
        [`GET ${PROFILES_PATH}`]: json({ profiles: [hidden, soapiUk] }),
        [`PATCH /api/profiles/${soapiDe.id}`]: ({ body }) =>
          json({ ...hidden, ...(body as Partial<Profile>) }),
      }),
    );
    const { wrapper } = await mountPage();
    const dimmed = () => row(wrapper, 'Soapi GmbH')!.classes('text-ink-tertiary');
    await waitForRow(wrapper, 'Soapi GmbH');
    expect(dimmed()).toBe(true);
    expect(row(wrapper, 'Soapi UK Ltd')!.classes('text-ink-tertiary')).toBe(false);

    await wrapper.get('input[aria-label="Soapi GmbH ausblenden"]').setValue(false);
    await flushPromises();
    await vi.waitFor(() => expect(dimmed()).toBe(false));
  });

  it('meldet einen Fehler beim Speichern eines Profils', async () => {
    stubFetch(routes({ [`PATCH /api/profiles/${soapiDe.id}`]: serverError }));
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    await wrapper.get('input[aria-label="Soapi GmbH ausblenden"]').setValue(true);
    await flushPromises();
    await vi.waitFor(() =>
      expect(wrapper.get('[role="alert"]').text()).toContain(
        'Das Profil konnte nicht gespeichert werden.',
      ),
    );
    expect(
      (wrapper.get('input[aria-label="Soapi GmbH ausblenden"]').element as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it('ordnet ein Profil einem bestehenden Client zu', async () => {
    const { requests } = stubFetch(
      routes({
        [`PATCH /api/profiles/${soapiDe.id}`]: ({ body }) =>
          json({ ...soapiDe, ...(body as Partial<Profile>) }),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    await choose(wrapper, 'Client für Soapi GmbH', 'Soapi');
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ clientId: soapi.id });
    await vi.waitFor(() =>
      expect(row(wrapper, 'Soapi GmbH')!.get('[role="combobox"]').text()).toBe('Soapi'),
    );
  });

  it('legt einen neuen Client an und ordnet das Profil zu', async () => {
    const aliseo = clientFixture({
      id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      name: 'Aliseo',
      slug: 'aliseo',
    });
    let clients = [soapi];
    const { requests } = stubFetch(
      routes({
        'GET /api/clients': () => json({ clients }),
        'POST /api/clients': () => {
          clients = [aliseo, soapi];
          return json(aliseo, 201);
        },
        [`PATCH /api/profiles/${soapiDe.id}`]: ({ body }) =>
          json({ ...soapiDe, ...(body as Partial<Profile>) }),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    await choose(wrapper, 'Client für Soapi GmbH', 'Neuen Client anlegen …');

    const form = dialog();
    expect(form?.text()).toContain('Neuen Client anlegen');
    await form!.get('form').trigger('submit');
    expect(form!.text()).toContain('Bitte einen Namen eingeben.');

    const input = form!.get('input');
    expect(form!.get(`label[for="${input.attributes('id')}"]`).text()).toBe('Name');
    await input.setValue(' Aliseo ');
    await form!.get('form').trigger('submit');
    await flushPromises();

    expect(
      requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.path, r.body]),
    ).toEqual([
      ['POST', '/api/clients', { name: 'Aliseo' }],
      ['PATCH', `/api/profiles/${soapiDe.id}`, { clientId: aliseo.id }],
    ]);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await vi.waitFor(() =>
      expect(row(wrapper, 'Soapi GmbH')!.get('[role="combobox"]').text()).toBe('Aliseo'),
    );
  });

  it('zeigt einen vergebenen Client-Namen im Dialog an', async () => {
    stubFetch(
      routes({
        'POST /api/clients': json({ error: { code: 'CLIENT_SLUG_TAKEN', message: 'x' } }, 409),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Soapi GmbH');
    await choose(wrapper, 'Client für Soapi GmbH', 'Neuen Client anlegen …');
    const form = dialog()!;
    await form.get('input').setValue('Soapi');
    await form.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() =>
      expect(form.get('[role="alert"]').text()).toContain('Einen Client mit diesem Namen gibt es'),
    );
  });
});
