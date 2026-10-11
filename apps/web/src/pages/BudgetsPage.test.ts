import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Budgets“ (`phase-5.md` 5.9a): Caps je Profil mit Ist, Soll und Prognose im laufenden Monat. */

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const PF1 = '00000000-0000-4000-8000-0000000000b1';
const T1 = '00000000-0000-4000-8000-0000000000c1';
const CAP1 = '00000000-0000-4000-8000-0000000000d1';
const CAP2 = '00000000-0000-4000-8000-0000000000d2';
const K1 = '00000000-0000-4000-8000-0000000000e1';

const pacing = (input: Record<string, unknown> = {}) => ({
  daysInMonth: 31,
  elapsedDays: 10,
  dataThrough: '2026-10-10',
  exact: true,
  actual: { value: '300', low: '300', high: '300' },
  planned: '322.58',
  forecast: { value: '720', low: '720', high: '720' },
  warnLevel: null,
  forecastOver: false,
  ...input,
});
const cap = (input: Record<string, unknown> = {}) => ({
  id: CAP1,
  profileId: P1,
  scope: { type: 'profile', ids: [] },
  scopeLabels: [],
  amount: '1000.00',
  monthAmounts: {},
  effectiveAmount: '1000.00',
  warnPercents: [80, 100],
  pacing: pacing(),
  campaignCount: 1,
  campaigns: [
    {
      id: K1,
      name: 'SP | Bestseller',
      state: 'ENABLED',
      dailyBudget: '20',
      actual: '300',
      exact: true,
    },
  ],
  updatedAt: '2026-10-11T08:00:00.000Z',
  ...input,
});
const overview = (caps: unknown[] = [cap()]) => ({
  profiles: [
    {
      id: P1,
      accountName: 'Shop DE',
      countryCode: 'DE',
      currencyCode: 'EUR',
      month: '2026-10',
      dataState: { periodStart: '2026-09-11', periodEnd: '2026-10-10' },
      portfolios: [{ id: PF1, name: 'Marke' }],
      caps,
    },
    {
      id: P2,
      accountName: 'Shop FR',
      countryCode: 'FR',
      currencyCode: 'EUR',
      month: '2026-10',
      dataState: null,
      portfolios: [],
      caps: [],
    },
  ],
  tags: [{ id: T1, name: 'Fokus' }],
});

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
async function mountPage(
  overrides: Record<string, Responder | Response> = {},
  me: Parameters<typeof meFixture>[0] = {},
) {
  const stub = stubFetch({
    'GET /api/me': json(meFixture(me)),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/budgets': json(overview()),
    ...overrides,
  });
  const mounted = await mountWithApp(undefined, { path: '/ads/budgets' });
  await flushPromises();
  return { ...mounted, ...stub };
}

const button = (label: string, root: ParentNode = document) =>
  [...root.querySelectorAll('button')].find(
    (b) => b.textContent?.trim().includes(label) || b.getAttribute('aria-label') === label,
  );
const capRow = (id: string) => document.querySelector(`[data-cap="${id}"]`);
const profile = (id: string) =>
  document.querySelector<HTMLElement>(`[data-budget-profile="${id}"]`);
const sent = (requests: RecordedRequest[], method: string) =>
  requests.filter((r) => r.method === method && r.path.startsWith('/api/ads/budgets'));

async function field(selector: string) {
  return vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>(selector);
    if (!found) throw new Error(`kein Feld ${selector}`);
    return found;
  });
}
async function type(selector: string, value: string) {
  const input = await field(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function check(selector: string) {
  (await field(selector)).click();
  await flushPromises();
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Budgets“', () => {
  it('zeigt je Profil die Caps mit Ist, Soll, Prognose, Datenstand und Kampagnen', async () => {
    await mountPage();
    await vi.waitFor(() => expect(capRow(CAP1)).not.toBeNull());

    const text = capRow(CAP1)!.textContent!;
    expect(text).toContain('Ganzes Profil');
    expect(text).toMatch(/1\.000,00\s€/);
    expect(text).toMatch(/Ist\s*300,00\s€/);
    expect(text).toMatch(/Soll\s*322,58\s€/);
    // Die Prognose ist immer geschätzt, das Ist hier exakt.
    expect(text).toMatch(/Prognose\s*≈\s*720,00\s€/);
    expect(text).toContain('SP | Bestseller');
    expect(profile(P1)!.textContent).toContain('Oktober 2026');
    expect(profile(P1)!.textContent).toContain('Datenstand 11.09.2026 – 10.10.2026');
    // Profil ohne Kennzahlen und ohne Cap.
    expect(profile(P2)!.textContent).toContain('Noch keine Kennzahlen');
    expect(profile(P2)!.textContent).toContain('Noch kein Cap');
  });

  it('kennzeichnet Schätzungen mit „≈“ und Spanne, Warnschwelle und Prognose über dem Cap', async () => {
    await mountPage({
      'GET /api/ads/budgets': json(
        overview([
          cap({
            scope: { type: 'portfolios', ids: [PF1] },
            scopeLabels: ['Marke'],
            monthAmounts: { '2026-10': '350' },
            effectiveAmount: '350',
            pacing: pacing({
              exact: false,
              actual: { value: '300', low: '250', high: '350' },
              warnLevel: 80,
              forecastOver: true,
            }),
          }),
        ]),
      ),
    });
    await vi.waitFor(() => expect(capRow(CAP1)).not.toBeNull());

    const text = capRow(CAP1)!.textContent!;
    expect(text).toContain('Portfolios: Marke');
    expect(text).toMatch(/350,00\s€/);
    expect(text).toContain('abweichend in diesem Monat');
    expect(text).toMatch(/Ist\s*≈\s*300,00\s€/);
    expect(text).toMatch(/250,00\s€\s*bis\s*350,00\s€/);
    expect(text).toContain('80 % erreicht');
    expect(text).toContain('Prognose über dem Cap');
  });

  it('legt einen Cap für Tags an', async () => {
    const { requests } = await mountPage({
      'POST /api/ads/budgets/caps': json({ id: CAP2 }),
    });
    await vi.waitFor(() => expect(button('Cap anlegen', profile(P1)!)).toBeDefined());
    button('Cap anlegen', profile(P1)!)!.click();

    await check('[data-cap-scope="tags"]');
    await check(`[data-cap-scope-id="${T1}"]`);
    await type('[data-cap-amount]', '1500,50');
    button('Speichern')!.click();
    await flushPromises();

    const [post] = sent(requests, 'POST');
    expect(post!.body).toEqual({
      profileId: P1,
      scope: { type: 'tags', ids: [T1] },
      amount: '1500.50',
      monthAmounts: {},
      warnPercents: [80, 100],
    });
    await vi.waitFor(() => expect(document.querySelector('[data-cap-amount]')).toBeNull());
    expect(sent(requests, 'GET').length).toBeGreaterThan(1);
  });

  it('ändert Betrag, Monatsausnahme und Warnschwellen und löscht', async () => {
    const { requests } = await mountPage({
      [`PUT /api/ads/budgets/caps/${CAP1}`]: json({ id: CAP1 }),
      [`DELETE /api/ads/budgets/caps/${CAP1}`]: new Response(null, { status: 204 }),
    });
    await vi.waitFor(() => expect(capRow(CAP1)).not.toBeNull());
    button('Cap „Ganzes Profil“ bearbeiten')!.click();

    expect((await field('[data-cap-amount]')).value).toBe('1000,00');
    await type('[data-cap-amount]', '1200');
    button('Monat hinzufügen')!.click();
    await type('[data-cap-month="0"]', '2026-11');
    await type('[data-cap-month-amount="0"]', '5000');
    await type('[data-cap-warn]', '90');
    button('Speichern')!.click();
    await flushPromises();

    expect(sent(requests, 'PUT')[0]!.body).toEqual({
      profileId: P1,
      scope: { type: 'profile', ids: [] },
      amount: '1200',
      monthAmounts: { '2026-11': '5000' },
      warnPercents: [90],
    });

    await vi.waitFor(() => expect(document.querySelector('[data-cap-amount]')).toBeNull());
    button('Cap „Ganzes Profil“ bearbeiten')!.click();
    await field('[data-cap-amount]');
    button('Cap löschen')!.click();
    await flushPromises();
    expect(sent(requests, 'DELETE')).toHaveLength(1);
  });

  it('prüft die Eingabe vor dem Senden und zeigt Fehler des Servers', async () => {
    const { requests } = await mountPage({
      'POST /api/ads/budgets/caps': json(
        {
          error: {
            code: 'BUDGET_CAP_INVALID_SCOPE',
            message: 'Portfolio oder Tag nicht gefunden.',
          },
        },
        400,
      ),
    });
    await vi.waitFor(() => expect(button('Cap anlegen', profile(P1)!)).toBeDefined());
    button('Cap anlegen', profile(P1)!)!.click();

    await type('[data-cap-amount]', '0');
    await type('[data-cap-warn]', '80, 120');
    button('Speichern')!.click();
    await flushPromises();
    expect(sent(requests, 'POST')).toHaveLength(0);
    expect(document.body.textContent).toContain('Betrag über 0');
    expect(document.body.textContent).toContain('ganze Prozentwerte von 1 bis 100');

    await type('[data-cap-amount]', '100');
    await type('[data-cap-warn]', '80');
    button('Speichern')!.click();
    await flushPromises();
    expect(sent(requests, 'POST')).toHaveLength(1);
    expect(document.body.textContent).toContain('Portfolio oder Tag gibt es nicht (mehr)');
    expect(document.querySelector('[data-cap-amount]')).not.toBeNull();
  });

  it('Viewer lesen nur', async () => {
    await mountPage({}, { orgRole: 'viewer' });
    await vi.waitFor(() => expect(capRow(CAP1)).not.toBeNull());
    expect(button('Cap anlegen')).toBeUndefined();
    expect(button('Cap „Ganzes Profil“ bearbeiten')).toBeUndefined();
  });

  it('zeigt Fehler mit erneutem Versuch und einen leeren Zustand ohne Profile', async () => {
    await mountPage({
      'GET /api/ads/budgets': json({ error: { code: 'X', message: 'x' } }, 500),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Die Budgets konnten nicht geladen werden.'),
    );
    expect(button('Erneut versuchen')).toBeDefined();
    cleanupMounted();
    vi.unstubAllGlobals();

    await mountPage({ 'GET /api/ads/budgets': json({ profiles: [], tags: [] }) });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Noch keine Profile'));
  });
});
