import { formatCurrency, formatDateTime, formatNumber, formatPercent } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';
import { PREVIEW_DATE } from '../settings/preview';

const serverError = () => json({ error: { code: 'INTERNAL_ERROR', message: 'x' } }, 500);

function routes(put: Parameters<typeof stubFetch>[0][string] = ({ body }) => json(body)) {
  return { 'GET /api/me': json(meFixture()), 'PUT /api/settings': put };
}

async function mountPage() {
  return mountWithApp(undefined, { path: '/settings' });
}

type Wrapper = Awaited<ReturnType<typeof mountPage>>['wrapper'];

function radio(wrapper: Wrapper, label: string) {
  const labelElement = wrapper.findAll('label').find((l) => l.text() === label);
  expect(labelElement, `Label „${label}“`).toBeDefined();
  return wrapper.get<HTMLInputElement>(`input[type="radio"]#${labelElement!.attributes('for')}`);
}

function localeSelect(wrapper: Wrapper) {
  const label = wrapper.findAll('label').find((l) => l.text() === 'Format');
  expect(label).toBeDefined();
  return wrapper.get(`[role="combobox"][aria-labelledby="${label!.attributes('id')}"]`);
}

async function chooseLocale(wrapper: Wrapper, optionLabel: string) {
  await localeSelect(wrapper).trigger('click');
  await flushPromises();
  const option = [...document.body.querySelectorAll<HTMLElement>('[role="option"]')].find(
    (o) => o.getAttribute('aria-label') === optionLabel,
  );
  expect(option, `Option „${optionLabel}“`).toBeDefined();
  // PrimeVue wählt Optionen auf `mousedown` (vor dem Blur des Comboboxes).
  option!.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
  await flushPromises();
}

/** Vorschau als Paare aus Bezeichnung und Wert. */
function preview(wrapper: Wrapper) {
  return Object.fromEntries(
    wrapper
      .findAll('[data-testid="format-preview"] > div')
      .map((entry) => [entry.get('dt').text(), entry.get('dd').text()]),
  );
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('SettingsPage', () => {
  it('ist die Seite hinter „Einstellungen“ (kein Platzhalter)', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    expect(wrapper.get('h1').text()).toBe('Einstellungen');
    // Die Statusregion ist von Anfang an da (sonst lesen Screenreader die Meldung nicht vor).
    expect(wrapper.get('[role="status"]').text()).toBe('');
    expect(wrapper.text()).not.toContain('Folgt in Kürze');
  });

  it('zeigt das gespeicherte Design und speichert eine Änderung', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper, session } = await mountPage();
    expect(radio(wrapper, 'Wie System').element.checked).toBe(true);

    await radio(wrapper, 'Dunkel').setValue(true);
    await flushPromises();
    expect(session.preferences.theme).toBe('dark');
    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({ theme: 'dark' });
    expect(wrapper.get('[role="status"]').text()).toBe('Gespeichert.');
  });

  it('zeigt eine Formatvorschau in der gewählten Locale, Werte in Mono', async () => {
    stubFetch(routes());
    const { wrapper } = await mountPage();
    expect(localeSelect(wrapper).text()).toBe('Deutsch (Deutschland)');
    expect(preview(wrapper)).toEqual({
      Zahl: '1.234.567,89',
      'Betrag (EUR)': formatCurrency('1234.5', 'EUR', 'de-DE'),
      'Betrag (GBP)': formatCurrency('1234.5', 'GBP', 'de-DE'),
      Prozent: formatPercent('0.1234', 'de-DE'),
      'Datum und Uhrzeit': formatDateTime(PREVIEW_DATE, 'de-DE'),
    });
    for (const value of wrapper.findAll('[data-testid="format-preview"] dd')) {
      expect(value.classes()).toContain('font-data');
    }
  });

  it('speichert eine andere Locale und passt die Vorschau an', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper } = await mountPage();
    await chooseLocale(wrapper, 'Englisch (Vereinigtes Königreich)');

    expect(requests.find((r) => r.method === 'PUT')?.body).toMatchObject({ locale: 'en-GB' });
    expect(preview(wrapper)).toMatchObject({
      Zahl: formatNumber('1234567.89', 'en-GB'),
      'Betrag (EUR)': formatCurrency('1234.5', 'EUR', 'en-GB'),
    });
    expect(preview(wrapper).Zahl).toBe('1,234,567.89');
  });

  it('meldet einen gescheiterten Save auch dann, wenn ein späterer klappt', async () => {
    let calls = 0;
    let failFirst!: () => void;
    stubFetch(
      routes(({ body }) =>
        ++calls === 1
          ? new Promise<Response>((resolve) => (failFirst = () => resolve(serverError())))
          : json(body),
      ),
    );
    const { wrapper, session } = await mountPage();
    // Die zweite Änderung kommt, während der erste Save noch läuft.
    await radio(wrapper, 'Dunkel').setValue(true);
    await vi.waitFor(() => expect(calls).toBe(1));
    await chooseLocale(wrapper, 'Englisch (USA)');
    failFirst();
    await vi.waitFor(() => expect(calls).toBe(2));
    await flushPromises();
    expect(session.preferences).toMatchObject({ theme: 'system', locale: 'en-US' });
    expect(wrapper.get('[role="alert"]').text()).toContain(
      'Die Einstellung konnte nicht gespeichert werden.',
    );
    expect(wrapper.get('[role="status"]').text()).toBe('');
  });

  it('meldet einen Speicherfehler und zeigt wieder den gespeicherten Wert', async () => {
    stubFetch(routes(serverError));
    const { wrapper, session } = await mountPage();
    await chooseLocale(wrapper, 'Englisch (USA)');
    await vi.waitFor(() =>
      expect(wrapper.get('[role="alert"]').text()).toContain(
        'Die Einstellung konnte nicht gespeichert werden.',
      ),
    );
    expect(session.preferences.locale).toBe('de-DE');
    expect(localeSelect(wrapper).text()).toBe('Deutsch (Deutschland)');
    expect(wrapper.get('[role="status"]').text()).toBe('');
  });
});
