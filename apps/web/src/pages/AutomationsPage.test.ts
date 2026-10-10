import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture, type MeFixtureOptions } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Automationen“, Tab „Einstellungen“ (`phase-5.md` 5.4): Leitplanken der Organisation und je Client. */

const C1 = '00000000-0000-4000-8000-0000000000c1';
const U1 = '00000000-0000-4000-8000-0000000000e1';
const U2 = '00000000-0000-4000-8000-0000000000e2';
const defaults = {
  maxBidChangePercent: 25,
  bidFloorCpcPercent: 50,
  bidFloorEur: null,
  maxBidEur: '3.00',
  minClicks: 15,
  minSpendEur: '10.00',
  maxBudgetDecreasePercent: 20,
};
const settings = (patch: Record<string, unknown> = {}) => ({
  defaults,
  canEditDefaults: true,
  clients: [
    {
      id: C1,
      name: 'Kunde Eins',
      mode: 'shadow',
      responsibleUserId: null,
      overrides: { minClicks: 30 },
    },
  ],
  members: [
    { userId: U1, name: 'Ada' },
    { userId: U2, name: 'Emil' },
  ],
  ...patch,
});

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
async function mountPage(
  overrides: Record<string, Responder | Response> = {},
  me: MeFixtureOptions = {},
) {
  const stub = stubFetch({
    'GET /api/me': json(meFixture(me)),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/automations/settings': json(settings()),
    ...overrides,
  });
  const mounted = await mountWithApp(undefined, { path: '/ads/automations' });
  await flushPromises();
  return { ...mounted, ...stub };
}

const $ = <T extends HTMLElement = HTMLInputElement>(selector: string) =>
  document.querySelector<T>(selector);
const field = (form: 'defaults' | 'client', key: string) =>
  $(`[data-guardrails="${form}"] [data-guardrail="${key}"]`)!;
const button = (label: string) =>
  [...document.querySelectorAll('button')].find(
    (b) => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label,
  );
const puts = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.method === 'PUT').map((r) => [r.path, r.body]);

async function type(input: HTMLInputElement, value: string) {
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function ready() {
  await vi.waitFor(() => expect($('[data-guardrails="defaults"]')).not.toBeNull());
}
async function openClient() {
  await ready();
  button('Einstellungen für „Kunde Eins“ bearbeiten')!.click();
  await vi.waitFor(() => expect($('[data-guardrails="client"]')).not.toBeNull());
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Automationen“: Einstellungen', () => {
  it('zeigt die Leitplanken der Organisation und je Client Modus und überschriebene Werte', async () => {
    await mountPage();
    await ready();

    expect($('[role="tab"][aria-selected="true"]')!.textContent).toContain('Einstellungen');
    expect(field('defaults', 'maxBidChangePercent').value).toBe('25');
    expect(field('defaults', 'maxBidEur').value).toBe('3,00');
    expect(field('defaults', 'bidFloorEur').value).toBe('');
    const row = $<HTMLElement>(`[data-client-row="${C1}"]`)!;
    expect(row.textContent).toContain('Kunde Eins');
    expect(row.textContent).toContain('Schattenmodus');
    expect(row.textContent).toContain('1 Wert überschrieben');
  });

  it('speichert die Leitplanken der Organisation; leeres Höchstgebot heißt keines', async () => {
    const { requests } = await mountPage({
      'PUT /api/ads/automations/settings/defaults': json(settings()),
    });
    await ready();
    await type(field('defaults', 'maxBidChangePercent'), '10');
    await type(field('defaults', 'maxBidEur'), '');
    await type(field('defaults', 'minSpendEur'), '12,5');
    $<HTMLButtonElement>('[data-defaults-save]')!.click();
    await flushPromises();

    expect(puts(requests)).toEqual([
      [
        '/api/ads/automations/settings/defaults',
        { ...defaults, maxBidChangePercent: 10, maxBidEur: null, minSpendEur: '12.5' },
      ],
    ]);
  });

  it('sperrt das Speichern bei ungültigen Werten und markiert das Feld', async () => {
    await mountPage();
    await ready();
    const save = () => $<HTMLButtonElement>('[data-defaults-save]')!;
    await type(field('defaults', 'maxBidChangePercent'), '0');
    expect(save().disabled).toBe(true);
    expect(field('defaults', 'maxBidChangePercent').getAttribute('aria-invalid')).toBe('true');
    await type(field('defaults', 'maxBidChangePercent'), '25');
    await type(field('defaults', 'minClicks'), '');
    expect(save().disabled).toBe(true);
    await type(field('defaults', 'minClicks'), '15');
    expect(save().disabled).toBe(false);
  });

  it('Nicht-Admins sehen die Leitplanken der Organisation gesperrt, ändern aber Clients', async () => {
    await mountPage(
      { 'GET /api/ads/automations/settings': json(settings({ canEditDefaults: false })) },
      { orgRole: 'editor' },
    );
    await ready();
    expect(field('defaults', 'minClicks').disabled).toBe(true);
    expect($('[data-defaults-save]')).toBeNull();
    expect(document.body.textContent).toContain('Nur Admins ändern die Leitplanken');
    expect(button('Einstellungen für „Kunde Eins“ bearbeiten')).toBeDefined();
  });

  it('setzt Modus, zuständigen Nutzer und überschriebene Werte eines Clients', async () => {
    const { requests } = await mountPage({
      [`PUT /api/ads/automations/settings/clients/${C1}`]: json(settings()),
    });
    await openClient();

    // Vorbelegt: eigener Wert im Feld, sonst der Wert der Organisation als Platzhalter.
    expect(field('client', 'minClicks').value).toBe('30');
    expect(field('client', 'maxBidChangePercent').value).toBe('');
    expect(field('client', 'maxBidChangePercent').placeholder).toBe('25');
    expect($('[data-client-responsible]')).toBeNull();

    $('input[name="automation-mode"][value="cart"]')!.click();
    await flushPromises();
    const responsible = $<HTMLSelectElement>('[data-client-responsible]')!;
    responsible.value = U2;
    responsible.dispatchEvent(new Event('change', { bubbles: true }));
    await type(field('client', 'minClicks'), '');
    await type(field('client', 'maxBidEur'), '1,50');
    $<HTMLButtonElement>('[data-client-save]')!.click();
    await flushPromises();

    expect(puts(requests)).toEqual([
      [
        `/api/ads/automations/settings/clients/${C1}`,
        { mode: 'cart', responsibleUserId: U2, overrides: { maxBidEur: '1.50' } },
      ],
    ]);
    await vi.waitFor(() => expect($('[data-guardrails="client"]')).toBeNull());
  });

  it('meldet Fehler der API im Dialog', async () => {
    await mountPage({
      [`PUT /api/ads/automations/settings/clients/${C1}`]: json(
        { error: { code: 'AUTOMATION_INVALID_RESPONSIBLE', message: 'x' } },
        400,
      ),
    });
    await openClient();
    $<HTMLButtonElement>('[data-client-save]')!.click();
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Zuständig kann nur ein Mitglied mit Schreibrecht sein',
      ),
    );
    expect($('[data-guardrails="client"]')).not.toBeNull();
  });

  it('Viewer lesen nur; ohne Clients steht ein Hinweis; Ladefehler mit erneutem Versuch', async () => {
    await mountPage(
      {
        'GET /api/ads/automations/settings': json(
          settings({ canEditDefaults: false, clients: [] }),
        ),
      },
      { orgRole: 'viewer' },
    );
    await ready();
    expect(document.body.textContent).toContain('Noch kein Client mit Profil');
    expect(document.querySelectorAll('[aria-label^="Einstellungen für"]')).toHaveLength(0);
    cleanupMounted();
    vi.unstubAllGlobals();

    await mountPage({
      'GET /api/ads/automations/settings': json({ error: { code: 'X', message: 'x' } }, 500),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Die Einstellungen konnten nicht geladen werden'),
    );
    expect(button('Erneut versuchen')).toBeDefined();
  });
});
