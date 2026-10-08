import type { FileImport, Profile } from '@profitbash/shared';
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
    // Währung legt der Marktplatz fest (nur Anzeige), die Zeitzone ist vorgeschlagen.
    expect(form!.get('[data-testid="file-profile-currency"]').text()).toBe('GBP');
    expect(form!.get('[role="combobox"][aria-label="Zeitzone"]').text()).toBe('Europe/London');
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

  it('zeigt den Abschnitt auch, wenn die Connections nicht laden', async () => {
    stubFetch(
      routes({
        'GET /api/connections': serverError(),
        'GET /api/profiles/file': json({ profiles: [fileProfile] }),
      }),
    );
    const { wrapper } = await mountPage();
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Die Connections konnten nicht geladen werden.'),
    );
    await waitForRow(wrapper, 'Kranich Datei');
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

describe('Datei-Importe (1.11f)', () => {
  const kranich = profileFixture({
    accountName: 'Kranich Datei',
    connectionId: null,
    amazonProfileId: null,
    amazonAccountId: null,
    syncedAt: null,
    metricsImportedThrough: null,
    lastBulkImportAt: '2026-10-06T09:00:00.000Z',
  });
  const importsPath = `/api/profiles/${kranich.id}/file-imports`;

  function fileImport(overrides: Partial<FileImport> = {}): FileImport {
    return {
      id: '0b7d3c1e-2a4f-4b6c-8d9e-0f1a2b3c4d5e',
      profileId: kranich.id,
      kind: 'bulk',
      fileName: 'bulk-de.xlsx',
      byteSize: 80_000,
      sha256: 'abc',
      complete: false,
      status: 'imported',
      error: null,
      counters: { campaigns: 10, targets: 85, created: 3 },
      uploadedBy: null,
      periodStart: null,
      periodEnd: null,
      createdAt: '2026-10-06T09:00:00.000Z',
      startedAt: '2026-10-06T09:00:01.000Z',
      finishedAt: '2026-10-06T09:00:02.000Z',
      ...overrides,
    };
  }

  beforeEach(() => {
    // Nur das Datum festhalten: AG Grid und vue-query brauchen echte Timer.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-07T10:00:00.000Z'));
  });

  async function openFiles(wrapper: Wrapper) {
    const fileRow = await waitForRow(wrapper, 'Kranich Datei');
    await fileRow.get('button[aria-label="Dateien von Kranich Datei (DE)"]').trigger('click');
    await flushPromises();
    await vi.waitFor(() => expect(dialog()?.text()).toContain('Dateien: Kranich Datei (DE)'));
    return dialog()!;
  }

  function chooseFile(form: DOMWrapper<Element>, file: File) {
    const input = form.get<HTMLInputElement>('input#file-import-file');
    Object.defineProperty(input.element, 'files', { value: [file], configurable: true });
    return input.trigger('change');
  }

  it('zeigt den letzten Import und Hinweise auf veraltete Daten je Profil', async () => {
    const stale = profileFixture({
      ...kranich,
      id: '7c3f2a10-1b2c-4d5e-8f90-aaaaaaaaaaaa',
      accountName: 'Reiher Datei',
      lastBulkImportAt: '2026-09-20T09:00:00.000Z',
      metricsImportedThrough: '2026-09-30',
    });
    const never = profileFixture({
      ...kranich,
      id: '7c3f2a10-1b2c-4d5e-8f90-bbbbbbbbbbbb',
      accountName: 'Storch Datei',
      lastBulkImportAt: null,
    });
    stubFetch(routes({ 'GET /api/profiles/file': json({ profiles: [kranich, stale, never] }) }));
    const { wrapper } = await mountPage();
    const fresh = await waitForRow(wrapper, 'Kranich Datei');
    expect(fresh.text()).toContain('06.10.2026');
    expect(fresh.text()).not.toContain('älter als');
    const old = await waitForRow(wrapper, 'Reiher Datei');
    expect(old.text()).toContain('Bulk-Datei älter als 7 Tage');
    expect(old.text()).toContain('Kennzahlen älter als 3 Tage');
    expect((await waitForRow(wrapper, 'Storch Datei')).text()).toContain('Noch keine Bulk-Datei');
  });

  it('zeigt den Verlauf mit Ergebnis, Fehlern und dem Hinweis auf eine fremde Datei', async () => {
    stubFetch(
      routes({
        'GET /api/profiles/file': json({ profiles: [kranich] }),
        [`GET ${importsPath}`]: json({
          fileImports: [
            fileImport({
              id: '0b7d3c1e-2a4f-4b6c-8d9e-000000000003',
              fileName: 'fremd.xlsx',
              counters: { campaigns: 4, unmatchedCampaigns: 4 },
            }),
            fileImport({
              id: '0b7d3c1e-2a4f-4b6c-8d9e-000000000002',
              fileName: 'kaputt.xlsx',
              status: 'failed',
              error: 'Die Datei ist keine Bulk-Datei.',
              counters: {},
            }),
            fileImport({
              complete: true,
              counters: {
                campaigns: 10,
                removed: 2,
                searchTerms: 359,
                searchTermsWithoutPeriod: 1,
                invalidSearchTermRows: 2,
              },
            }),
          ],
        }),
      }),
    );
    const { wrapper } = await mountPage();
    const files = await openFiles(wrapper);
    await vi.waitFor(() => expect(files.text()).toContain('kaputt.xlsx'));
    const text = files.text();
    expect(text).toContain('Fehlgeschlagen');
    expect(text).toContain('Die Datei ist keine Bulk-Datei.');
    expect(text).toContain('Importiert');
    expect(text).toContain('10 Kampagnen');
    expect(text).toContain('2 entfernt');
    // Suchbegriff-Blätter der Bulk-Datei (2b.1).
    expect(text).toContain('359 Suchbegriffe');
    expect(text).toContain('1 Suchbegriff ohne Zeitraum (Dateiname geändert)');
    expect(text).toContain('2 ungültige Suchbegriff-Zeilen');
    expect(text).toContain('vollständig');
    expect(text).toContain('Keine Kampagne der Datei passt zu den bisherigen Kampagnen');
  });

  it('erklärt einen leeren Verlauf und einen Ladefehler', async () => {
    stubFetch(
      routes({
        'GET /api/profiles/file': json({ profiles: [kranich] }),
        [`GET ${importsPath}`]: json({ fileImports: [] }),
      }),
    );
    const { wrapper } = await mountPage();
    const files = await openFiles(wrapper);
    await vi.waitFor(() => expect(files.text()).toContain('Noch keine Dateien hochgeladen.'));
    cleanupMounted();

    stubFetch(
      routes({
        'GET /api/profiles/file': json({ profiles: [kranich] }),
        [`GET ${importsPath}`]: serverError(),
      }),
    );
    const second = await mountPage();
    const failed = await openFiles(second.wrapper);
    await vi.waitFor(() =>
      expect(failed.text()).toContain('Der Verlauf konnte nicht geladen werden.'),
    );
  });

  it('lädt eine Bulk-Datei hoch, „vollständig“ nur mit Häkchen und Hinweis', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(new Date('2026-10-07T10:00:00.000Z'));
    let imports: FileImport[] = [];
    const { requests } = stubFetch(
      routes({
        'GET /api/profiles/file': json({ profiles: [kranich] }),
        [`GET ${importsPath}`]: () => json({ fileImports: imports }),
        [`POST ${importsPath}`]: () => {
          imports = [fileImport({ status: 'pending', complete: true, counters: {} })];
          return json(imports[0], 201);
        },
      }),
    );
    const { wrapper } = await mountPage();
    const files = await openFiles(wrapper);
    for (const label of ['Datei', 'Datei ist vollständig']) {
      expect(files.text()).toContain(label);
    }
    // Es gibt nur Bulk-Dateien (1.11e entfällt): keine Auswahl der Art, kein Tagesbericht.
    expect(files.find('[role="combobox"]').exists()).toBe(false);
    expect(files.text()).not.toContain('Tagesbericht');
    // Der Hinweis nennt die Download-Optionen (Befund 1.11d).
    expect(files.text()).toContain('pausierte und archivierte Elemente');
    expect(files.text()).toContain('ohne Impressionen');

    await files.get('form').trigger('submit');
    expect(files.text()).toContain('Bitte eine Datei auswählen.');

    await chooseFile(files, new File(['xlsx'], 'bulk-de.xlsx'));
    await files.get('input#file-import-complete').setValue(true);
    await files.get('form').trigger('submit');
    await flushPromises();

    const posts = requests.filter((r) => r.method === 'POST');
    expect(posts.map((r) => [r.path, r.body])).toEqual([
      [importsPath, { kind: 'bulk', complete: 'true', file: { name: 'bulk-de.xlsx', size: 4 } }],
    ]);
    await vi.waitFor(() => expect(files.text()).toContain('Wartet'));
    expect(files.text()).toContain('Datei angenommen. Der Import läuft im Hintergrund.');

    // Ist der Import fertig, läuft nichts mehr im Hintergrund: Der Hinweis verschwindet.
    imports = [fileImport({ complete: true })];
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(files.text()).toContain('Importiert'));
    expect(files.text()).not.toContain('Datei angenommen');
  });

  describe('Zeitraum von Hand (2b.2c)', () => {
    const START = 'input#file-import-period-start';
    const END = 'input#file-import-period-end';
    const CONSOLE_NAME = 'bulk-a1b2c3-20260901-20260930-1791399063312.xlsx';

    async function openUpload() {
      const { requests } = stubFetch(
        routes({
          'GET /api/profiles/file': json({ profiles: [kranich] }),
          [`GET ${importsPath}`]: json({ fileImports: [] }),
          [`POST ${importsPath}`]: () => json(fileImport({ status: 'pending', counters: {} }), 201),
        }),
      );
      const { wrapper } = await mountPage();
      const files = await openFiles(wrapper);
      const posts = () => requests.filter((r) => r.method === 'POST').map((r) => r.body);
      const submit = async () => {
        await files.get('form').trigger('submit');
        await flushPromises();
      };
      return { files, posts, submit };
    }

    it('fragt nur nach dem Zeitraum, wenn der Dateiname keinen trägt', async () => {
      const { files } = await openUpload();
      // Ohne Datei ist noch offen, ob der Name einen Zeitraum trägt.
      expect(files.find(START).exists()).toBe(false);

      await chooseFile(files, new File(['xlsx'], CONSOLE_NAME));
      expect(files.find(START).exists()).toBe(false);
      expect(files.find(END).exists()).toBe(false);

      await chooseFile(files, new File(['xlsx'], 'kunde-september.xlsx'));
      expect(files.get('label[for="file-import-period-start"]').text()).toBe('Zeitraum von');
      expect(files.get('label[for="file-import-period-end"]').text()).toBe('Zeitraum bis');
      expect(files.get(START).attributes('type')).toBe('date');
      // Heute in der Zeitzone des Profils als spätester Tag.
      expect(files.get(END).attributes('max')).toBe('2026-10-07');
      // Frühestens 365 Tage davor (2b.2d).
      expect(files.get(START).attributes('min')).toBe('2025-10-07');
      expect(files.get(END).attributes('min')).toBe('2025-10-07');
      expect(files.text()).toContain(
        'Ohne Angabe werden die Suchbegriffe der Datei nicht importiert',
      );
    });

    it('schickt den angegebenen Zeitraum mit, ohne Angabe keine Felder', async () => {
      const { files, posts, submit } = await openUpload();
      await chooseFile(files, new File(['xlsx'], 'kunde-september.xlsx'));
      await files.get(START).setValue('2026-09-01');
      await files.get(END).setValue('2026-09-30');
      await submit();
      expect(posts()).toEqual([
        {
          kind: 'bulk',
          complete: 'false',
          periodStart: '2026-09-01',
          periodEnd: '2026-09-30',
          file: { name: 'kunde-september.xlsx', size: 4 },
        },
      ]);

      // Nach dem Upload ist das Formular leer; die nächste Datei ohne Angabe geht ohne Zeitraum hinaus.
      expect(files.find(START).exists()).toBe(false);
      await chooseFile(files, new File(['xlsx'], 'kunde-oktober.xlsx'));
      expect(files.get<HTMLInputElement>(START).element.value).toBe('');
      await submit();
      expect(posts()[1]).toEqual({
        kind: 'bulk',
        complete: 'false',
        file: { name: 'kunde-oktober.xlsx', size: 4 },
      });
    });

    it('schickt keinen Zeitraum, wenn danach eine Datei mit Zeitraum im Namen gewählt wird', async () => {
      const { files, posts, submit } = await openUpload();
      await chooseFile(files, new File(['xlsx'], 'kunde-september.xlsx'));
      await files.get(START).setValue('2026-08-01');
      await files.get(END).setValue('2026-08-31');
      await chooseFile(files, new File(['xlsx'], CONSOLE_NAME));
      await submit();
      expect(posts()).toEqual([
        { kind: 'bulk', complete: 'false', file: { name: CONSOLE_NAME, size: 4 } },
      ]);
    });

    it('prüft den Zeitraum und meldet Fehler bei den Feldern, ohne hochzuladen', async () => {
      const { files, posts, submit } = await openUpload();
      await chooseFile(files, new File(['xlsx'], 'kunde-september.xlsx'));
      const check = async (start: string, end: string, message: string) => {
        await files.get(START).setValue(start);
        await files.get(END).setValue(end);
        await submit();
        const error = files.get('#file-import-period-error');
        expect(error.text()).toBe(message);
        expect(error.attributes('role')).toBe('alert');
        for (const field of [START, END]) {
          expect(files.get(field).attributes('aria-invalid')).toBe('true');
          expect(files.get(field).attributes('aria-describedby')).toContain(
            'file-import-period-error',
          );
        }
      };
      await check('2026-09-01', '', 'Bitte beide Tage angeben oder keinen.');
      await check('', '2026-09-30', 'Bitte beide Tage angeben oder keinen.');
      await check('2026-09-30', '2026-09-01', '„Zeitraum von“ liegt nach „Zeitraum bis“.');
      await check('2026-10-01', '2026-10-08', 'Der Zeitraum darf nicht in der Zukunft enden.');
      // Heute ist der 07.10.2026: Der 06.10.2025 liegt 366 Tage zurück (2b.2d).
      await check(
        '2025-10-06',
        '2025-10-31',
        'Der erste Tag darf höchstens 365 Tage zurückliegen.',
      );
      await check(
        '2026-07-01',
        '2026-09-30',
        'Beginn und Ende dürfen höchstens 60 Tage auseinanderliegen (mehr exportiert die Werbekonsole nicht).',
      );
      expect(posts()).toEqual([]);

      // Mit gültiger Angabe verschwindet die Meldung und die Datei geht hinaus.
      await files.get(START).setValue('2026-09-01');
      expect(files.find('#file-import-period-error').exists()).toBe(false);
      await submit();
      expect(posts()).toHaveLength(1);
    });

    it('lässt einen Zeitraum zu, der genau 365 Tage vor heute beginnt (2b.2d)', async () => {
      const { files, posts, submit } = await openUpload();
      await chooseFile(files, new File(['xlsx'], 'kunde-oktober-2025.xlsx'));
      await files.get(START).setValue('2025-10-07');
      await files.get(END).setValue('2025-10-31');
      await submit();
      expect(files.find('#file-import-period-error').exists()).toBe(false);
      expect(posts()).toMatchObject([{ periodStart: '2025-10-07', periodEnd: '2025-10-31' }]);
    });

    it('zeigt die Ablehnung des Zeitraums durch die API', async () => {
      stubFetch(
        routes({
          'GET /api/profiles/file': json({ profiles: [kranich] }),
          [`GET ${importsPath}`]: json({ fileImports: [] }),
          [`POST ${importsPath}`]: json({ error: { code: 'INVALID_PERIOD', message: 'x' } }, 400),
        }),
      );
      const { wrapper } = await mountPage();
      const files = await openFiles(wrapper);
      await chooseFile(files, new File(['x'], 'kunde.xlsx'));
      await files.get(START).setValue('2026-09-01');
      await files.get(END).setValue('2026-09-30');
      await files.get('form').trigger('submit');
      await flushPromises();
      await vi.waitFor(() =>
        expect(files.text()).toContain('Der angegebene Zeitraum ist ungültig.'),
      );
    });

    it('zeigt im Verlauf den von Hand angegebenen Zeitraum', async () => {
      stubFetch(
        routes({
          'GET /api/profiles/file': json({ profiles: [kranich] }),
          [`GET ${importsPath}`]: json({
            fileImports: [
              fileImport({
                id: '0b7d3c1e-2a4f-4b6c-8d9e-000000000007',
                fileName: 'kunde-september.xlsx',
                periodStart: '2026-09-01',
                periodEnd: '2026-09-30',
              }),
              fileImport({ fileName: CONSOLE_NAME }),
            ],
          }),
        }),
      );
      const { wrapper } = await mountPage();
      const files = await openFiles(wrapper);
      await vi.waitFor(() => expect(files.text()).toContain('kunde-september.xlsx'));
      const periods = files.findAll('[data-file-import-period]');
      // Nur der Import mit Angabe; beim anderen steht der Zeitraum im Dateinamen.
      expect(periods).toHaveLength(1);
      expect(periods[0]!.text()).toBe('Zeitraum 01.09.2026 – 30.09.2026');
      expect(periods[0]!.get('.font-data').text()).toBe('01.09.2026 – 30.09.2026');
    });
  });

  it('zeigt die Datei-Profile bei 1440 px ohne waagerechtes Scrollen: ohne Zeitzone und „Daten bis“', async () => {
    stubFetch(routes({ 'GET /api/profiles/file': json({ profiles: [kranich] }) }));
    const { wrapper } = await mountPage();
    const fileRow = await waitForRow(wrapper, 'Kranich Datei');
    // Die Mindestbreite setzt das Grid nach `grid-ready`: darauf warten, statt einmal nachzusehen.
    const grid = await vi.waitFor(() => {
      const element = fileRow.element.closest<HTMLElement>('[style*="min-width"]');
      expect(element).not.toBeNull();
      return element!;
    });
    const headers = [...grid.querySelectorAll('[role="columnheader"]')].map((h) =>
      h.textContent?.trim(),
    );
    // Ohne Tagesberichte gibt es für Datei-Profile keinen Datenstand, die Zeitzone zählt keine Tage.
    expect(headers).toEqual([
      'Land',
      'Account-Name',
      'Typ',
      'Währung',
      'Letzter Import',
      'Client',
      'Ausblenden',
      'Dateien',
    ]);
    await vi.waitFor(() => expect(parseFloat(grid.style.minWidth)).toBe(1075));
    expect(parseFloat(grid.style.minWidth)).toBeLessThanOrEqual(FIT_WIDTH_AT_1440);
    expect(wrapper.text()).not.toContain('Tagesbericht');
  });

  it('zeigt Fehler beim Hochladen im Dialog', async () => {
    stubFetch(
      routes({
        'GET /api/profiles/file': json({ profiles: [kranich] }),
        [`GET ${importsPath}`]: json({ fileImports: [] }),
        [`POST ${importsPath}`]: json({ error: { code: 'FILE_TOO_LARGE', message: 'x' } }, 413),
      }),
    );
    const { wrapper } = await mountPage();
    const files = await openFiles(wrapper);
    await chooseFile(files, new File(['x'], 'gross.xlsx'));
    await files.get('form').trigger('submit');
    await flushPromises();
    await vi.waitFor(() =>
      expect(files.text()).toContain('Die Datei ist größer als erlaubt (50 MB).'),
    );
  });
});

describe('Datei-Importe: Abschluss (1.11f)', () => {
  it('lädt „Letzter Import“ neu, sobald eine laufende Datei fertig ist', async () => {
    const profile = profileFixture({
      accountName: 'Kranich Datei',
      connectionId: null,
      amazonProfileId: null,
      lastBulkImportAt: null,
    });
    const base = {
      id: '0b7d3c1e-2a4f-4b6c-8d9e-0f1a2b3c4d5e',
      profileId: profile.id,
      kind: 'bulk',
      fileName: 'bulk.xlsx',
      byteSize: 1,
      sha256: 'x',
      complete: false,
      error: null,
      counters: {},
      uploadedBy: null,
      periodStart: null,
      periodEnd: null,
      createdAt: '2026-10-07T09:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    } satisfies Omit<FileImport, 'status'>;
    let status: FileImport['status'] = 'running';
    const { requests } = stubFetch(
      routes({
        'GET /api/profiles/file': json({ profiles: [profile] }),
        [`GET /api/profiles/${profile.id}/file-imports`]: () => {
          const response = json({ fileImports: [{ ...base, status }] });
          status = 'imported';
          return response;
        },
      }),
    );
    const { wrapper } = await mountPage();
    const fileRow = await waitForRow(wrapper, 'Kranich Datei');
    await fileRow.get('button[aria-label="Dateien von Kranich Datei (DE)"]').trigger('click');
    await vi.waitFor(() => expect(dialog()?.text()).toContain('Läuft'));
    const profileLoads = () => requests.filter((r) => r.path === '/api/profiles/file').length;
    const before = profileLoads();
    // Der Verlauf fragt alle 3 s nach, solange eine Datei läuft.
    await vi.waitFor(() => expect(dialog()?.text()).toContain('Importiert'), { timeout: 5_000 });
    await vi.waitFor(() => expect(profileLoads()).toBeGreaterThan(before));
  }, 10_000);

  it('verfolgt eine hochgeladene Datei auch nach dem Schließen des Dialogs', async () => {
    const profile = profileFixture({
      accountName: 'Kranich Datei',
      connectionId: null,
      amazonProfileId: null,
      lastBulkImportAt: null,
    });
    const path = `/api/profiles/${profile.id}/file-imports`;
    const created = {
      id: '0b7d3c1e-2a4f-4b6c-8d9e-0f1a2b3c4d5f',
      profileId: profile.id,
      kind: 'bulk',
      fileName: 'bulk.xlsx',
      byteSize: 4,
      sha256: 'x',
      complete: false,
      status: 'pending',
      error: null,
      counters: {},
      uploadedBy: null,
      periodStart: null,
      periodEnd: null,
      createdAt: '2026-10-07T09:00:00.000Z',
      startedAt: null,
      finishedAt: null,
    } satisfies FileImport;
    // Vor dem Upload leer, danach wartend, bis der Test den Import nach dem Schließen enden lässt.
    let uploaded = false;
    let finished = false;
    const { requests } = stubFetch(
      routes({
        'GET /api/profiles/file': json({ profiles: [profile] }),
        [`GET ${path}`]: () => {
          if (!uploaded) return json({ fileImports: [] });
          return json({ fileImports: [{ ...created, status: finished ? 'imported' : 'pending' }] });
        },
        [`POST ${path}`]: () => {
          uploaded = true;
          return json(created, 201);
        },
      }),
    );
    const { wrapper } = await mountPage();
    const fileRow = await waitForRow(wrapper, 'Kranich Datei');
    await fileRow.get('button[aria-label="Dateien von Kranich Datei (DE)"]').trigger('click');
    await vi.waitFor(() => expect(dialog()?.text()).toContain('Noch keine Dateien hochgeladen.'));
    const files = dialog()!;
    const input = files.get<HTMLInputElement>('input#file-import-file');
    Object.defineProperty(input.element, 'files', {
      value: [new File(['xlsx'], 'bulk.xlsx')],
      configurable: true,
    });
    await input.trigger('change');
    await files.get('form').trigger('submit');
    await vi.waitFor(() => expect(files.text()).toContain('Datei angenommen'));

    // Dialog schließen, solange die Datei noch wartet.
    const profileLoads = () => requests.filter((r) => r.path === '/api/profiles/file').length;
    const before = profileLoads();
    document.body
      .querySelector<HTMLElement>(
        '[role="dialog"] button[aria-label="Close"], [role="dialog"] .p-dialog-close-button',
      )!
      .click();
    await vi.waitFor(() => expect(dialog()).toBeNull());
    expect(profileLoads()).toBe(before);
    finished = true;

    await vi.waitFor(() => expect(profileLoads()).toBeGreaterThan(before), { timeout: 5_000 });
  }, 10_000);
});

describe('Clients: geschützte Begriffe (2b.2)', () => {
  const clientsSection = (wrapper: Wrapper) => wrapper.get('section[aria-label="Clients"]');

  it('listet die Clients mit ihren geschützten Begriffen', async () => {
    stubFetch(
      routes({
        'GET /api/clients': json({
          clients: [
            clientFixture({ protectedTerms: ['hero lampe', 'nordwind'] }),
            clientFixture({ id: '5d1e8a2b-3c4f-4a6b-9d7e-000000000002', name: 'Lindenhof' }),
          ],
        }),
      }),
    );
    const { wrapper } = await mountPage();
    const text = clientsSection(wrapper).text();
    expect(text).toContain('Nordwind');
    expect(text).toContain('hero lampe, nordwind');
    expect(text).toContain('Lindenhof');
    expect(text).toContain('Keine geschützten Begriffe');
  });

  it('speichert die Begriffe je Zeile und zeigt die gespeicherte Liste', async () => {
    const { requests } = stubFetch(
      routes({
        'GET /api/clients': json({ clients: [clientFixture({ protectedTerms: ['nordwind'] })] }),
        [`PATCH /api/clients/${nordwind.id}`]: json(
          clientFixture({ protectedTerms: ['hero lampe', 'nordwind'] }),
        ),
      }),
    );
    const { wrapper } = await mountPage();
    await clientsSection(wrapper).get('button').trigger('click');
    await flushPromises();

    const textarea = document.querySelector<HTMLTextAreaElement>('#protected-terms')!;
    expect(textarea.value).toBe('nordwind');
    textarea.value = ' Nordwind \n\nHero  Lampe\n';
    textarea.dispatchEvent(new Event('input'));
    await flushPromises();
    [...document.querySelectorAll('button')]
      .find((b) => b.textContent?.trim() === 'Speichern')!
      .click();
    await flushPromises();

    const patch = requests.find((r) => r.method === 'PATCH');
    expect(patch?.body).toEqual({ protectedTerms: ['Nordwind', 'Hero  Lampe'] });
    expect(document.querySelector('#protected-terms')).toBeNull();
    expect(clientsSection(wrapper).text()).toContain('hero lampe, nordwind');
  });

  it('zeigt einen Fehler im Dialog, wenn das Speichern scheitert, und lehnt zu viele Begriffe vorher ab', async () => {
    const { requests } = stubFetch(
      routes({ [`PATCH /api/clients/${nordwind.id}`]: serverError() }),
    );
    const { wrapper } = await mountPage();
    await clientsSection(wrapper).get('button').trigger('click');
    await flushPromises();
    const textarea = document.querySelector<HTMLTextAreaElement>('#protected-terms')!;
    const save = () =>
      [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === 'Speichern')!;

    textarea.value = Array.from({ length: 201 }, (_, i) => `t${i}`).join('\n');
    textarea.dispatchEvent(new Event('input'));
    await flushPromises();
    save().click();
    await flushPromises();
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain('200');

    textarea.value = 'nordwind';
    textarea.dispatchEvent(new Event('input'));
    await flushPromises();
    save().click();
    await flushPromises();
    expect(requests.filter((r) => r.method === 'PATCH')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"] [role="alert"]')).not.toBeNull();
    expect(document.querySelector('#protected-terms')).not.toBeNull();
  });
});
