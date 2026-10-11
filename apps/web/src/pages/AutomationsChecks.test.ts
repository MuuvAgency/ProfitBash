import { DEFAULT_CHECK_SETTINGS } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture, type MeFixtureOptions } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Automationen“, Tab „Prüfungen“ (`phase-5.md` 5.10): Befunde je Lauf, quittieren, Einstellungen. */

const PROFILE = '00000000-0000-4000-8000-0000000000a1';
const F1 = '00000000-0000-4000-8000-0000000000f1';
const F2 = '00000000-0000-4000-8000-0000000000f2';
const F3 = '00000000-0000-4000-8000-0000000000f3';
const ENTITY = '00000000-0000-4000-8000-0000000000e1';

const finding = (patch: Record<string, unknown> = {}) => ({
  id: F1,
  profileId: PROFILE,
  accountName: 'Nordwind DE',
  currencyCode: 'EUR',
  kind: 'spendNoOrders',
  severity: 'warning',
  entityType: 'target',
  entityId: ENTITY,
  campaignName: 'SP | Jacken',
  keywordText: 'regenjacke',
  key: '',
  detail: { spend: '42.5', clicks: 80 },
  firstSeenAt: '2026-10-10T08:00:00.000Z',
  acknowledgedAt: null,
  ...patch,
});
const placement = finding({
  id: F2,
  kind: 'placement',
  entityType: 'campaign',
  keywordText: null,
  key: 'PLACEMENT_TOP',
  detail: {
    percent: 50,
    acos: '40',
    goalAcos: '25',
    basis: 'campaign',
    spend: '400',
    sales: '1000',
  },
});
const noCap = finding({
  id: F3,
  kind: 'noCap',
  severity: 'info',
  entityType: 'profile',
  entityId: PROFILE,
  campaignName: null,
  keywordText: null,
  detail: { campaigns: 12 },
});
const checks = (patch: Record<string, unknown> = {}) => ({
  settings: DEFAULT_CHECK_SETTINGS,
  canEditSettings: true,
  findings: [finding(), placement, noCap],
  total: 3,
  ...patch,
});

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
async function mountTab(
  overrides: Record<string, Responder | Response> = {},
  me: MeFixtureOptions = {},
  path = '/ads/automations?tab=checks',
) {
  const stub = stubFetch({
    'GET /api/me': json(meFixture(me)),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/automations/settings': json({
      defaults: {},
      canEditDefaults: false,
      clients: [],
      members: [],
    }),
    'GET /api/ads/automations/checks': json(checks()),
    ...overrides,
  });
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  return { ...mounted, ...stub };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const row = (id: string) => $(`[data-finding-row="${id}"]`)!;
const text = (element: Element) => element.textContent!.replaceAll(' ', ' ');
const button = (label: string, root: ParentNode = document) =>
  [...root.querySelectorAll('button')].find((b) => b.textContent?.trim().includes(label));
async function click(element: HTMLElement | null | undefined) {
  element!.click();
  await flushPromises();
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Automationen“: Prüfungen', () => {
  it('öffnet den Tab über ?tab=checks und zeigt je Befund Art, Ort und Zahlen', async () => {
    await mountTab();
    await vi.waitFor(() => expect($(`[data-finding-row="${F1}"]`)).not.toBeNull());

    expect($('[data-automation-tab="checks"]')!.getAttribute('aria-selected')).toBe('true');
    expect(text(row(F1))).toContain('Ausgaben ohne Bestellung');
    expect(text(row(F1))).toContain('regenjacke');
    expect(text(row(F1))).toContain('SP | Jacken · Nordwind DE');
    expect(text(row(F1))).toContain('42,50 € Ausgaben, 80 Klicks, keine Bestellung');
    expect(text(row(F1))).toContain('seit 10.10.2026');
    expect(text(row(F2))).toContain('Platzierung über dem Ziel');
    expect(text(row(F2))).toContain(
      'Anfang der Suchergebnisse: Anpassung +50 %, ACoS 40 % bei Ziel 25 % (ACoS der Kampagne)',
    );
    expect(text(row(F3))).toContain('Hinweis');
    expect(text(row(F3))).toContain('12 aktive Kampagnen unter keinem Budget-Cap');
    // Dinge, die ProfitBash aus der Datei nicht sieht.
    expect(document.body.textContent).toContain('Sponsored Prompts');
  });

  it('quittiert einen Befund und alle gezeigten', async () => {
    const { requests } = await mountTab({
      'POST /api/ads/automations/checks/acknowledge': json({ changed: 1, skipped: 0 }),
    });
    await vi.waitFor(() => expect($(`[data-finding-row="${F1}"]`)).not.toBeNull());
    const posts = () =>
      requests.filter((r) => r.method === 'POST').map((r) => (r.body as { ids: string[] }).ids);
    const loads = () => requests.filter((r) => r.path === '/api/ads/automations/checks').length;
    const before = loads();

    await click(button('Quittieren', row(F1)));
    expect(posts()).toEqual([[F1]]);
    expect(loads()).toBeGreaterThan(before);
    await click(button('Alle quittieren'));
    expect(posts()[1]).toEqual([F1, F2, F3]);
  });

  it('zeigt quittierte Befunde ohne Aktionen; Viewer quittieren nicht', async () => {
    const { requests } = await mountTab({
      'GET /api/ads/automations/checks': (request) =>
        json(
          request.search.includes('status=acknowledged')
            ? checks({
                findings: [finding({ acknowledgedAt: '2026-10-11T09:00:00.000Z' })],
                total: 1,
              })
            : checks(),
        ),
    });
    await vi.waitFor(() => expect($(`[data-finding-row="${F2}"]`)).not.toBeNull());
    const select = $<HTMLSelectElement>('[data-findings-status]')!;
    select.value = 'acknowledged';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    await flushPromises();

    await vi.waitFor(() => expect($(`[data-finding-row="${F2}"]`)).toBeNull());
    expect(requests.some((r) => r.search.includes('status=acknowledged'))).toBe(true);
    expect(text(row(F1))).toContain('quittiert am 11.10.2026');
    expect(button('Quittieren')).toBeUndefined();

    cleanupMounted();
    vi.unstubAllGlobals();
    await mountTab({}, { orgRole: 'viewer' });
    await vi.waitFor(() => expect($(`[data-finding-row="${F1}"]`)).not.toBeNull());
    expect(button('Quittieren')).toBeUndefined();
  });

  it('Admins ändern Schwellen und schalten Prüfungen ab; andere sehen die Werte gesperrt', async () => {
    const { requests } = await mountTab({
      'PUT /api/ads/automations/checks/settings': json(checks()),
    });
    await vi.waitFor(() => expect($('[data-check-enabled="vcpm"]')).not.toBeNull());

    $<HTMLInputElement>('[data-check-enabled="vcpm"]')!.click();
    const spend = $<HTMLInputElement>('[data-check-spend]')!;
    expect(spend.value).toBe('20,00');
    spend.value = '35,5';
    spend.dispatchEvent(new Event('input', { bubbles: true }));
    const percent = $<HTMLInputElement>('[data-check-placement]')!;
    percent.value = '0';
    percent.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    await click(button('Einstellungen speichern'));
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(0);
    expect(document.body.textContent).toContain('Bitte die Werte prüfen');

    percent.value = '75';
    percent.dispatchEvent(new Event('input', { bubbles: true }));
    await flushPromises();
    await click(button('Einstellungen speichern'));
    expect(requests.find((r) => r.method === 'PUT')!.body).toEqual({
      enabled: { ...DEFAULT_CHECK_SETTINGS.enabled, vcpm: false },
      placementMinPercent: 75,
      spendNoOrdersMinEur: '35.5',
    });

    cleanupMounted();
    vi.unstubAllGlobals();
    await mountTab({ 'GET /api/ads/automations/checks': json(checks({ canEditSettings: false })) });
    await vi.waitFor(() => expect($('[data-check-enabled="vcpm"]')).not.toBeNull());
    expect($<HTMLInputElement>('[data-check-enabled="vcpm"]')!.disabled).toBe(true);
    expect(button('Einstellungen speichern')).toBeUndefined();
  });

  it('zeigt einen leeren Zustand und Fehler mit erneutem Versuch', async () => {
    await mountTab({
      'GET /api/ads/automations/checks': json(checks({ findings: [], total: 0 })),
    });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Keine offenen Befunde'));

    cleanupMounted();
    vi.unstubAllGlobals();
    await mountTab({
      'GET /api/ads/automations/checks': json({ error: { code: 'X', message: 'x' } }, 500),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Die Prüfungen konnten nicht geladen werden.'),
    );
    expect(button('Erneut versuchen')).toBeDefined();
  });
});
