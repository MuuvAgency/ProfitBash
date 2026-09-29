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
import { FIT_WIDTH_AT_1440 } from '../grid/min-width';
import { cleanupMounted, mountWithApp } from '../test/mount';
import ConnectionsPage from './ConnectionsPage.vue';

const PROFILES_PATH = `/api/connections/${CONNECTION_ID}/profiles`;
const SYNC_PATH = `/api/connections/${CONNECTION_ID}/sync`;

const nordwind = clientFixture();
const nordwindDe = profileFixture({ accountName: 'Nordwind GmbH' });
const nordwindUk = profileFixture({
  accountName: 'Nordwind UK Ltd',
  countryCode: 'UK',
  currencyCode: 'GBP',
  timezone: 'Europe/London',
  clientId: nordwind.id,
  metricsImportedThrough: null,
});
const lindenhofSe = profileFixture({
  accountName: 'Lindenhof Nordic AB',
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
    [`GET ${PROFILES_PATH}`]: json({ profiles: [nordwindDe, nordwindUk, lindenhofSe] }),
    'GET /api/clients': json({ clients: [nordwind] }),
    'GET /api/profiles/file': json({ profiles: [] }),
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

/** AG Grid rendert Zeilen in Frames von höchstens 60 ms; auf langsamen Rechnern kommt jede Zeile evtl. erst später. */
async function waitForRow(wrapper: Wrapper, accountName: string) {
  await vi.waitFor(() => expect(row(wrapper, accountName)).toBeDefined());
  return row(wrapper, accountName)!;
}

/** Wählt eine Option in einem PrimeVue-Select (das Overlay hängt am <body>). */
async function choose(
  wrapper: Wrapper | DOMWrapper<Element>,
  comboboxLabel: string,
  optionLabel: string,
) {
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
  vi.useRealTimers();
});

/** Antwort, die erst auf Anweisung eintrifft (Reihenfolge paralleler Requests steuern). */
function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((r) => (resolve = r));
  return { promise, resolve };
}

describe('ConnectionsPage', () => {
  it('zeigt die Connection mit Status und ihre Profile', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    const de = await waitForRow(wrapper, 'Nordwind GmbH');

    expect(wrapper.get('h1').text()).toBe('Clients & Connections');
    expect(wrapper.text()).toContain('ads@muuv.test');
    expect(wrapper.text()).toContain('Europa');
    expect(wrapper.text()).toContain('Aktiv');
    for (const text of ['Deutschland', 'Seller', 'EUR', 'Europe/Berlin']) {
      expect(de.text()).toContain(text);
    }
    const uk = await waitForRow(wrapper, 'Nordwind UK Ltd');
    expect(uk.text()).toContain('Vereinigtes Königreich');
    await vi.waitFor(() => expect(uk.find('img[src*="gb.svg"]').exists()).toBe(true));
    expect(uk.get('[role="combobox"]').text()).toBe('Nordwind');
  });

  it('zeigt je Profil „Daten bis“ als Kalendertag, ohne Import einen Platzhalter', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    const de = await waitForRow(wrapper, 'Nordwind GmbH');

    const headers = wrapper.findAll('[role="columnheader"]').map((h) => h.text());
    expect(headers).toContain('Daten bis');
    const dataThrough = (r: DOMWrapper<Element>) => r.get('[col-id="metricsImportedThrough"]');
    expect(dataThrough(de).text()).toBe('25.09.2026');
    expect(dataThrough(de).classes()).toContain('font-data');
    expect(dataThrough(await waitForRow(wrapper, 'Nordwind UK Ltd')).text()).toBe('–');
  });

  it('gibt der Profiltabelle eine Mindestbreite aus den Spalten, darunter scrollt die Kachel', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');

    const grid = wrapper.get('div[role="region"]').element.firstElementChild as HTMLElement;
    // Feste Breiten plus Mindestbreiten der Flex-Spalten (Land, Konto, Zeitzone, Kunde), keine feste Zahl im Container.
    await vi.waitFor(() => expect(parseFloat(grid.style.minWidth)).toBe(1055));
    expect(grid.className).not.toMatch(/min-w-/);
    // Passt bei 1440 px mit ausgeklappter Sidebar auch mit klassischer Scrollbar (F14).
    expect(parseFloat(grid.style.minWidth)).toBeLessThanOrEqual(FIT_WIDTH_AT_1440);
  });

  it('bricht lange Texte (Land, Konto, Zeitzone) um statt zu kürzen: lesbar auch ohne Tooltip (F14)', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    const profile = await waitForRow(wrapper, 'Nordwind GmbH');

    for (const colId of ['country', 'accountName', 'timezone']) {
      expect(profile.find(`[col-id="${colId}"] [data-wrap]`).exists(), colId).toBe(true);
      // Vertikal zentriert, auch wenn eine andere Spalte die Zeile höher macht.
      expect(profile.get(`[col-id="${colId}"]`).classes(), colId).toContain('items-center');
    }
    expect(profile.findAll('.truncate')).toHaveLength(0);
  });

  it('erklärt „Entfernt“ per Klick (Popover, auch auf Touch lesbar)', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await wrapper.get('input[role="switch"]#connections-show-removed').setValue(true);
    const removed = await waitForRow(wrapper, 'Lindenhof Nordic AB');

    const badge = removed.get('button[aria-haspopup="dialog"]');
    expect(badge.text()).toBe('Entfernt');
    expect(badge.attributes('aria-expanded')).toBe('false');
    await badge.trigger('click');
    await flushPromises();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Amazon liefert dieses Profil nicht mehr.'),
    );
    // `aria-expanded` folgt dem `show` des Popovers (Transition-Hook, in test-utils gestubbt): im Browser geprüft (2.12).
  });

  it('blendet entfernte Profile nur mit dem Filter „Entfernte anzeigen“ ein', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    expect(row(wrapper, 'Lindenhof Nordic AB')).toBeUndefined();

    const toggle = wrapper.get('input[role="switch"]#connections-show-removed');
    expect(wrapper.get('label[for="connections-show-removed"]').text()).toBe('Entfernte anzeigen');
    await toggle.setValue(true);
    const removed = await waitForRow(wrapper, 'Lindenhof Nordic AB');
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
    await waitForRow(wrapper, 'Nordwind GmbH');
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
    await waitForRow(wrapper, 'Nordwind GmbH');
    await button(wrapper, 'Amazon-Account verbinden').trigger('click');
    await flushPromises();
    expect(requests.find((r) => r.path === '/api/amazon/oauth/start')?.body).toEqual({});
    expect(assign).toHaveBeenCalledWith(url);
  });

  it('folgt keinen Weiterleitungen außer http(s)', async () => {
    stubFetch(routes({ 'POST /api/amazon/oauth/start': json({ url: 'javascript:alert(1)' }) }));
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
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
    await waitForRow(wrapper, 'Nordwind GmbH');
    expect(wrapper.text()).toContain('Neu verbinden nötig');
    expect(wrapper.findAll('button').some((b) => b.text() === 'Jetzt synchronisieren')).toBe(false);

    await button(wrapper, 'Neu verbinden').trigger('click');
    await flushPromises();
    expect(requests.find((r) => r.path === '/api/amazon/oauth/start')?.body).toEqual({
      connectionId: CONNECTION_ID,
    });
    expect(assign).toHaveBeenCalledWith(url);
  });

  describe('Ablauf der Einwilligung', () => {
    beforeEach(() => {
      // Nur die Uhr fälschen: Timer (Polling, TanStack Query) laufen normal.
      vi.useFakeTimers({ now: new Date('2026-09-27T12:00:00.000Z'), toFake: ['Date'] });
    });

    function consentRoutes(consent: { consentedAt: string | null; expiresAt: string | null }) {
      return routes({
        'GET /api/connections': json({
          connections: [
            connectionFixture({
              consentedAt: consent.consentedAt,
              refreshTokenExpiresAt: consent.expiresAt,
            }),
          ],
        }),
        'POST /api/amazon/oauth/start': json({ url: 'https://eu.account.amazon.com/ap/oa?s=1' }),
      });
    }

    it('zeigt das Ablaufdatum ohne Warnung, solange mehr als 30 Tage bleiben', async () => {
      stubFetch(
        consentRoutes({
          consentedAt: '2026-09-20T12:00:00.000Z',
          expiresAt: '2027-09-20T12:00:00.000Z',
        }),
      );
      const { wrapper } = await mountPage();
      await waitForRow(wrapper, 'Nordwind GmbH');

      expect(wrapper.text()).toContain('Einwilligung läuft ab am 20.09.2027');
      expect(wrapper.find('[data-testid="consent-warning"]').exists()).toBe(false);
      expect(wrapper.findAll('button').some((b) => b.text() === 'Neu verbinden')).toBe(false);
    });

    it('warnt ab 30 Tagen vor dem Ablauf und bietet „Neu verbinden“ neben dem Sync an', async () => {
      const { requests } = stubFetch(
        consentRoutes({
          consentedAt: '2025-10-27T12:00:00.000Z',
          expiresAt: '2026-10-27T12:00:00.000Z',
        }),
      );
      const { wrapper } = await mountPage();
      await waitForRow(wrapper, 'Nordwind GmbH');

      expect(wrapper.text()).toContain('Einwilligung läuft ab am 27.10.2026');
      const warning = wrapper.get('[data-testid="consent-warning"]');
      expect(warning.text()).toContain('27.10.2026');
      expect(warning.text()).toContain('neu verbinden');
      button(wrapper, 'Jetzt synchronisieren');

      await button(wrapper, 'Neu verbinden').trigger('click');
      await flushPromises();
      expect(requests.find((r) => r.path === '/api/amazon/oauth/start')?.body).toEqual({
        connectionId: CONNECTION_ID,
      });
    });

    it('meldet eine abgelaufene Einwilligung', async () => {
      stubFetch(
        consentRoutes({
          consentedAt: '2025-09-01T12:00:00.000Z',
          expiresAt: '2026-09-01T12:00:00.000Z',
        }),
      );
      const { wrapper } = await mountPage();
      await waitForRow(wrapper, 'Nordwind GmbH');

      expect(wrapper.text()).toContain('Einwilligung abgelaufen am 01.09.2026');
      expect(wrapper.get('[data-testid="consent-warning"]').text()).toContain('abgelaufen');
      button(wrapper, 'Neu verbinden');
    });

    it('zeigt bei reauth_required nur den Hinweis zum Neu-Verbinden, keine zweite Warnung', async () => {
      stubFetch(
        routes({
          'GET /api/connections': json({
            connections: [
              connectionFixture({
                status: 'reauth_required',
                consentedAt: '2025-09-01T12:00:00.000Z',
                refreshTokenExpiresAt: '2026-09-01T12:00:00.000Z',
              }),
            ],
          }),
        }),
      );
      const { wrapper } = await mountPage();
      await waitForRow(wrapper, 'Nordwind GmbH');

      expect(wrapper.text()).toContain('Amazon akzeptiert die Freigabe nicht mehr.');
      expect(wrapper.find('[data-testid="consent-warning"]').exists()).toBe(false);
      button(wrapper, 'Neu verbinden');
      expect(wrapper.findAll('button').some((b) => b.text() === 'Jetzt synchronisieren')).toBe(
        false,
      );
    });

    it('zeigt „unbekannt“, wenn der Einwilligungszeitpunkt fehlt', async () => {
      stubFetch(consentRoutes({ consentedAt: null, expiresAt: null }));
      const { wrapper } = await mountPage();
      await waitForRow(wrapper, 'Nordwind GmbH');

      expect(wrapper.text()).toContain('Ablauf der Einwilligung: unbekannt');
      expect(wrapper.find('[data-testid="consent-warning"]').exists()).toBe(false);
    });
  });

  it('plant einen Sync ein und bestätigt es', async () => {
    const { requests } = stubFetch(
      routes({ [`POST ${SYNC_PATH}`]: json({ status: 'queued' }, 202) }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await button(wrapper, 'Jetzt synchronisieren').trigger('click');
    await flushPromises();
    expect(requests.some((r) => r.method === 'POST' && r.path === SYNC_PATH)).toBe(true);
    const status = wrapper.get('[role="status"]');
    expect(status.text()).toContain('Sync eingeplant.');
    // Der Hinweis verlinkt auf den Sync-Status, gefiltert auf den Profil-Sync.
    expect(status.get('a').text()).toBe('Sync-Status');
    expect(status.get('a').attributes('href')).toBe('/ops/sync?job=profiles-sync');
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
    await waitForRow(wrapper, 'Nordwind GmbH');
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
        [`PATCH /api/profiles/${nordwindDe.id}`]: ({ body }) =>
          json({ ...nordwindDe, ...(body as Partial<Profile>) }),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    const toggle = () => wrapper.get('input[aria-label="Nordwind GmbH (DE) ausblenden"]');
    expect((toggle().element as HTMLInputElement).checked).toBe(false);
    await toggle().setValue(true);
    await flushPromises();
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ isHidden: true });
    await vi.waitFor(() => expect((toggle().element as HTMLInputElement).checked).toBe(true));
  });

  it('graut ausgeblendete Profile aus und nimmt das beim Einblenden zurück', async () => {
    const hidden = { ...nordwindDe, isHidden: true };
    stubFetch(
      routes({
        [`GET ${PROFILES_PATH}`]: json({ profiles: [hidden, nordwindUk] }),
        [`PATCH /api/profiles/${nordwindDe.id}`]: ({ body }) =>
          json({ ...hidden, ...(body as Partial<Profile>) }),
      }),
    );
    const { wrapper } = await mountPage();
    const dimmed = () => row(wrapper, 'Nordwind GmbH')!.classes('text-ink-secondary');
    await waitForRow(wrapper, 'Nordwind GmbH');
    expect(dimmed()).toBe(true);
    expect((await waitForRow(wrapper, 'Nordwind UK Ltd')).classes('text-ink-secondary')).toBe(
      false,
    );

    await wrapper.get('input[aria-label="Nordwind GmbH (DE) ausblenden"]').setValue(false);
    await flushPromises();
    await vi.waitFor(() => expect(dimmed()).toBe(false));
  });

  it('meldet einen Fehler beim Speichern eines Profils', async () => {
    stubFetch(routes({ [`PATCH /api/profiles/${nordwindDe.id}`]: serverError }));
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await wrapper.get('input[aria-label="Nordwind GmbH (DE) ausblenden"]').setValue(true);
    await flushPromises();
    await vi.waitFor(() =>
      expect(wrapper.get('[role="alert"]').text()).toContain(
        'Das Profil konnte nicht gespeichert werden.',
      ),
    );
    expect(
      (wrapper.get('input[aria-label="Nordwind GmbH (DE) ausblenden"]').element as HTMLInputElement)
        .checked,
    ).toBe(false);
  });

  it('ordnet ein Profil einem bestehenden Client zu', async () => {
    const { requests } = stubFetch(
      routes({
        [`PATCH /api/profiles/${nordwindDe.id}`]: ({ body }) =>
          json({ ...nordwindDe, ...(body as Partial<Profile>) }),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await choose(wrapper, 'Client für Nordwind GmbH (DE)', 'Nordwind');
    expect(requests.find((r) => r.method === 'PATCH')?.body).toEqual({ clientId: nordwind.id });
    await vi.waitFor(() =>
      expect(row(wrapper, 'Nordwind GmbH')!.get('[role="combobox"]').text()).toBe('Nordwind'),
    );
  });

  it('legt einen neuen Client an und ordnet das Profil zu', async () => {
    const lindenhof = clientFixture({
      id: '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d',
      name: 'Lindenhof',
      slug: 'lindenhof',
    });
    let clients = [nordwind];
    const { requests } = stubFetch(
      routes({
        'GET /api/clients': () => json({ clients }),
        'POST /api/clients': () => {
          clients = [lindenhof, nordwind];
          return json(lindenhof, 201);
        },
        [`PATCH /api/profiles/${nordwindDe.id}`]: ({ body }) =>
          json({ ...nordwindDe, ...(body as Partial<Profile>) }),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await choose(wrapper, 'Client für Nordwind GmbH (DE)', 'Neuen Client anlegen …');

    const form = dialog();
    expect(form?.text()).toContain('Neuen Client anlegen');
    await form!.get('form').trigger('submit');
    expect(form!.text()).toContain('Bitte einen Namen eingeben.');

    const input = form!.get('input');
    expect(form!.get(`label[for="${input.attributes('id')}"]`).text()).toBe('Name');
    await input.setValue(' Lindenhof ');
    await form!.get('form').trigger('submit');
    await flushPromises();

    expect(
      requests.filter((r) => r.method !== 'GET').map((r) => [r.method, r.path, r.body]),
    ).toEqual([
      ['POST', '/api/clients', { name: 'Lindenhof' }],
      ['PATCH', `/api/profiles/${nordwindDe.id}`, { clientId: lindenhof.id }],
    ]);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await vi.waitFor(() =>
      expect(row(wrapper, 'Nordwind GmbH')!.get('[role="combobox"]').text()).toBe('Lindenhof'),
    );
  });

  it('zeigt einen vergebenen Client-Namen im Dialog an', async () => {
    stubFetch(
      routes({
        'POST /api/clients': json({ error: { code: 'CLIENT_SLUG_TAKEN', message: 'x' } }, 409),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await choose(wrapper, 'Client für Nordwind GmbH (DE)', 'Neuen Client anlegen …');
    const form = dialog()!;
    await form.get('input').setValue('Nordwind');
    await form.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() =>
      expect(form.get('[role="alert"]').text()).toContain('Einen Client mit diesem Namen gibt es'),
    );
  });

  it('zeigt Zuordnungen nicht als „Kein Client“, solange die Clients fehlen', async () => {
    let fail = true;
    stubFetch(
      routes({ 'GET /api/clients': () => (fail ? serverError() : json({ clients: [nordwind] })) }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind UK Ltd');
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Die Clients konnten nicht geladen werden.'),
    );
    const combobox = () => row(wrapper, 'Nordwind UK Ltd')!.get('[role="combobox"]');
    expect(combobox().text()).not.toBe('Kein Client');
    expect(combobox().attributes('aria-disabled')).toBe('true');

    fail = false;
    await button(wrapper, 'Erneut versuchen').trigger('click');
    await vi.waitFor(() => expect(combobox().text()).toBe('Nordwind'));
    expect(combobox().attributes('aria-disabled')).not.toBe('true');
  });

  it('lädt nach dem Verbinden nach, bis die ersten Profile da sind', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let synced = false;
    stubFetch(
      routes({ [`GET ${PROFILES_PATH}`]: () => json({ profiles: synced ? [nordwindDe] : [] }) }),
    );
    const { wrapper } = await mountPage('/admin/connections?oauth=connected');
    await vi.waitFor(() => expect(wrapper.text()).toContain('noch keine Profile'));
    synced = true;
    await vi.advanceTimersByTimeAsync(5_000);
    await waitForRow(wrapper, 'Nordwind GmbH');
  });

  it('lädt nach „Jetzt synchronisieren“ eine Weile nach und hört dann auf', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { requests } = stubFetch(
      routes({ [`POST ${SYNC_PATH}`]: json({ status: 'queued' }, 202) }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    const profileLoads = () => requests.filter((r) => r.path === PROFILES_PATH).length;
    const before = profileLoads();

    await button(wrapper, 'Jetzt synchronisieren').trigger('click');
    await flushPromises();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(profileLoads()).toBeGreaterThan(before);

    await vi.advanceTimersByTimeAsync(120_000);
    const afterWindow = profileLoads();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(profileLoads()).toBe(afterWindow);
  });

  it('nimmt beim Fehlschlag nur die eigene Änderung zurück', async () => {
    const hide = deferred();
    stubFetch(
      routes({
        [`PATCH /api/profiles/${nordwindDe.id}`]: ({ body }) =>
          'isHidden' in (body as object)
            ? hide.promise
            : json({ ...nordwindDe, ...(body as Partial<Profile>) }),
      }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await wrapper.get('input[aria-label="Nordwind GmbH (DE) ausblenden"]').setValue(true);
    await choose(wrapper, 'Client für Nordwind GmbH (DE)', 'Nordwind');
    await flushPromises();

    hide.resolve(serverError());
    await flushPromises();
    await vi.waitFor(() =>
      expect(
        (
          wrapper.get('input[aria-label="Nordwind GmbH (DE) ausblenden"]')
            .element as HTMLInputElement
        ).checked,
      ).toBe(false),
    );
    expect(row(wrapper, 'Nordwind GmbH')!.get('[role="combobox"]').text()).toBe('Nordwind');
  });

  it('gibt den Verbinden-Button frei, wenn der Browser von Amazon zurückkehrt', async () => {
    stubFetch(
      routes({ 'POST /api/amazon/oauth/start': json({ url: 'https://eu.account.amazon.com/' }) }),
    );
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await button(wrapper, 'Amazon-Account verbinden').trigger('click');
    await flushPromises();
    expect(button(wrapper, 'Amazon-Account verbinden').attributes('disabled')).toBeDefined();

    const event = new Event('pageshow');
    Object.defineProperty(event, 'persisted', { value: true });
    window.dispatchEvent(event);
    await flushPromises();
    expect(button(wrapper, 'Amazon-Account verbinden').attributes('disabled')).toBeUndefined();
  });

  it('lässt den Dialog nicht schließen, solange der Client angelegt wird', async () => {
    const create = deferred();
    stubFetch(routes({ 'POST /api/clients': () => create.promise }));
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await choose(wrapper, 'Client für Nordwind GmbH (DE)', 'Neuen Client anlegen …');
    const form = dialog()!;
    const closeButton = () =>
      form.find('button[aria-label="Close"], button[aria-label="Schließen"]').exists();
    expect(closeButton()).toBe(true);
    await form.get('input').setValue('Lindenhof');
    await form.get('form').trigger('submit');
    await flushPromises();

    const cancel = form.findAll('button').find((b) => b.text() === 'Abbrechen')!;
    expect(cancel.attributes('disabled')).toBeDefined();
    expect(closeButton()).toBe(false);
  });
});

describe('Profile ohne Connection (Datei-Import, 1.11a)', () => {
  const fileProfile = profileFixture({
    accountName: 'Kranich Datei',
    connectionId: null,
    amazonProfileId: null,
    amazonAccountId: null,
    syncedAt: null,
    metricsImportedThrough: null,
  });

  function fileSection(wrapper: Wrapper) {
    return wrapper.get('section[aria-label="Profile ohne Connection"]');
  }

  it('zeigt Datei-Profile in einem eigenen Abschnitt, getrennt von den Connections', async () => {
    stubFetch(routes({ 'GET /api/profiles/file': json({ profiles: [fileProfile] }) }));
    const { wrapper } = await mountPage();
    const fileRow = await waitForRow(wrapper, 'Kranich Datei');
    expect(fileSection(wrapper).text()).toContain('Kranich Datei');
    expect(fileSection(wrapper).text()).toContain('Datei-Import');
    expect(fileRow.text()).toContain('Deutschland');
    expect(fileSection(wrapper).text()).not.toContain('Nordwind GmbH');
  });

  it('zeigt den Abschnitt auch ohne Connection', async () => {
    stubFetch(
      routes({
        'GET /api/connections': json({ connections: [] }),
        'GET /api/profiles/file': json({ profiles: [fileProfile] }),
      }),
    );
    const { wrapper } = await mountPage();
    await vi.waitFor(() => expect(wrapper.text()).toContain('Noch kein Amazon-Konto verbunden'));
    await waitForRow(wrapper, 'Kranich Datei');
  });

  it('erklärt einen leeren Abschnitt', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    await vi.waitFor(() =>
      expect(fileSection(wrapper).text()).toContain('Noch keine Profile ohne Connection'),
    );
  });

  it('legt ein Profil an: Währung und Zeitzone kommen aus dem Marktplatz', async () => {
    let profiles: Profile[] = [];
    const created = profileFixture({
      ...fileProfile,
      accountName: 'Lumen UK',
      countryCode: 'UK',
      currencyCode: 'GBP',
      timezone: 'Europe/London',
      accountType: 'vendor',
    });
    const { requests } = stubFetch(
      routes({
        'GET /api/profiles/file': () => json({ profiles }),
        'POST /api/profiles': () => {
          profiles = [created];
          return json(created, 201);
        },
      }),
    );
    const { wrapper } = await mountPage();
    await vi.waitFor(() => expect(fileSection(wrapper).text()).toContain('Profil anlegen'));
    await button(wrapper, 'Profil anlegen').trigger('click');
    await flushPromises();

    const form = dialog();
    expect(form?.text()).toContain('Profil ohne Connection anlegen');
    // Sichtbare Labels für alle Felder.
    for (const label of ['Name', 'Marktplatz', 'Währung', 'Zeitzone', 'Kontotyp']) {
      expect(form!.text()).toContain(label);
    }
    await form!.get('form').trigger('submit');
    expect(form!.text()).toContain('Bitte einen Namen eingeben.');

    await form!.get('input#create-file-profile-name').setValue(' Lumen UK ');
    await choose(form!, 'Marktplatz', 'Vereinigtes Königreich');
    expect(
      (form!.get('input#create-file-profile-currency').element as HTMLInputElement).value,
    ).toBe('GBP');
    expect(
      (form!.get('input#create-file-profile-timezone').element as HTMLInputElement).value,
    ).toBe('Europe/London');
    await choose(form!, 'Kontotyp', 'Vendor');
    await form!.get('form').trigger('submit');
    await flushPromises();

    expect(requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.body])).toEqual([
      [
        '/api/profiles',
        {
          accountName: 'Lumen UK',
          countryCode: 'UK',
          currencyCode: 'GBP',
          timezone: 'Europe/London',
          accountType: 'vendor',
        },
      ],
    ]);
    await vi.waitFor(() => expect(dialog()).toBeNull());
    await waitForRow(wrapper, 'Lumen UK');
  });

  it('zeigt einen Fehler beim Anlegen im Dialog', async () => {
    stubFetch(
      routes({
        'POST /api/profiles': json({ error: { code: 'VALIDATION_ERROR', message: 'x' } }, 400),
      }),
    );
    const { wrapper } = await mountPage();
    await vi.waitFor(() => expect(fileSection(wrapper).text()).toContain('Profil anlegen'));
    await button(wrapper, 'Profil anlegen').trigger('click');
    await flushPromises();
    const form = dialog()!;
    await form.get('input#create-file-profile-name').setValue('Lumen');
    await form.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() => expect(form.find('[role="alert"]').exists()).toBe(true));
    expect(dialog()).not.toBeNull();
  });

  it('lässt einen Ladefehler der Datei-Profile nicht die Seite scheitern', async () => {
    stubFetch(routes({ 'GET /api/profiles/file': serverError() }));
    const { wrapper } = await mountPage();
    await waitForRow(wrapper, 'Nordwind GmbH');
    await vi.waitFor(() =>
      expect(fileSection(wrapper).text()).toContain(
        'Profile ohne Connection konnten nicht geladen werden',
      ),
    );
  });
});
