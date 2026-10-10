import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Portfolio“ (`phase-4.md` 4.7, F9): Portfolios eines Profils ansehen und ein neues per Bulk-Datei anlegen. */

const P1 = '00000000-0000-4000-8000-0000000000a1';
const C1 = '00000000-0000-4000-8000-0000000000c1';
const S1 = '00000000-0000-4000-8000-0000000000e1';
const PF1 = '00000000-0000-4000-8000-0000000000b1';

const submission = {
  id: S1,
  profileId: P1,
  accountName: 'Waldkauz DE',
  countryCode: 'DE',
  channel: 'bulk_file',
  kind: 'portfolio',
  status: 'pending',
  error: null,
  createdBy: null,
  createdByName: null,
  createdAt: '2026-10-10T08:00:00.000Z',
  startedAt: null,
  finishedAt: null,
  changes: 1,
  counts: { submitted: 1, applied: 0, failed: 0, dismissed: 0 },
};

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
function routes(overrides: Record<string, Responder | Response> = {}, orgRole = 'admin' as const) {
  return {
    'GET /api/me': json(meFixture({ orgRole })),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/ads/changes/pending': json({ changes: [], check: null }),
    'GET /api/ads/tools/product-groups': json({
      groups: [],
      profiles: [
        {
          id: P1,
          accountName: 'Waldkauz DE',
          countryCode: 'DE',
          accountType: 'seller',
          clientId: C1,
        },
      ],
      clients: [{ id: C1, name: 'Waldkauz' }],
      maxGroups: 2000,
      maxItems: 100,
    }),
    'GET /api/ads/tools/portfolios': json({
      portfolios: [
        {
          id: PF1,
          amazonPortfolioId: '7001',
          name: 'Bestand',
          state: 'ENABLED',
          budgetAmount: '300.00',
          budgetCurrencyCode: 'EUR',
          budgetPolicy: 'MONTHLY_RECURRING',
          budgetStartDate: '2026-01-01',
          budgetEndDate: null,
          campaigns: 4,
        },
      ],
      pending: [
        {
          itemId: '00000000-0000-4000-8000-0000000000f1',
          submissionId: S1,
          name: 'Unterwegs',
          status: 'submitted',
          budget: null,
          createdAt: '2026-10-10T08:00:00.000Z',
        },
      ],
    }),
    'POST /api/ads/tools/portfolios': json({ submission }, 201),
    ...overrides,
  };
}

async function mountPage(overrides: Record<string, Responder | Response> = {}, orgRole?: 'viewer') {
  const stub = stubFetch(routes(overrides, orgRole as never));
  const mounted = await mountWithApp(undefined, { path: '/ads/tools/portfolios' });
  await flushPromises();
  return { ...mounted, ...stub };
}

const found = <T extends Element>(selector: string) =>
  vi.waitFor(() => {
    const element = document.querySelector<T>(selector);
    if (!element) throw new Error(`nicht gefunden: ${selector}`);
    return element;
  });
async function type(selector: string, value: string) {
  const input = await found<HTMLInputElement>(selector);
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await flushPromises();
}
async function choose(selector: string, value: string) {
  const select = await found<HTMLSelectElement>(selector);
  select.value = value;
  select.dispatchEvent(new Event('change', { bubbles: true }));
  await flushPromises();
}
async function click(selector: string) {
  (await found<HTMLElement>(selector)).click();
  await flushPromises();
}
const body = (requests: RecordedRequest[], method: string, path: string) =>
  requests.find((r) => r.method === method && r.path === path)?.body as Record<string, unknown>;

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Portfolio“', () => {
  it('zeigt die Portfolios des Profils und angelegte, noch nicht importierte', async () => {
    await mountPage();
    await choose('[data-portfolio-profile]', P1);
    const row = await found(`[data-portfolio="${PF1}"]`);
    expect(row.textContent).toContain('Bestand');
    expect(row.textContent).toContain('4');
    const pending = await found('[data-portfolio-pending]');
    expect(pending.textContent).toContain('Unterwegs');
    expect(pending.querySelector('a')?.getAttribute('href')).toBe(
      `/ads/changes?tab=submissions&submission=${S1}`,
    );
  });

  it('legt ein Portfolio mit monatlichem Budget an und verweist auf die Übermittlung', async () => {
    const { requests } = await mountPage();
    await choose('[data-portfolio-profile]', P1);
    await type('[data-portfolio-name]', 'Garten');
    await click('[data-portfolio-budget-toggle]');
    await type('[data-portfolio-amount]', '500.00');
    await choose('[data-portfolio-policy]', 'monthlyRecurring');
    await type('[data-portfolio-start]', '2026-11-01');
    await click('[data-portfolio-create]');
    expect(body(requests, 'POST', '/api/ads/tools/portfolios')).toEqual({
      profileId: P1,
      name: 'Garten',
      budget: {
        amount: '500.00',
        policy: 'monthlyRecurring',
        startDate: '2026-11-01',
        endDate: null,
      },
    });
    const done = await found('[data-portfolio-created]');
    expect(done.querySelector('a')?.getAttribute('href')).toBe(
      `/ads/changes?tab=submissions&submission=${S1}`,
    );
  });

  it('meldet einen vergebenen Namen verständlich', async () => {
    await mountPage({
      'POST /api/ads/tools/portfolios': json(
        { error: { code: 'PORTFOLIO_NAME_TAKEN', message: 'x' } },
        409,
      ),
    });
    await choose('[data-portfolio-profile]', P1);
    await type('[data-portfolio-name]', 'Bestand');
    await click('[data-portfolio-create]');
    expect((await found('[data-portfolio-form]')).textContent).toContain('gibt es im Profil schon');
  });

  it('zeigt Viewern kein Formular', async () => {
    await mountPage({}, 'viewer');
    await choose('[data-portfolio-profile]', P1);
    await found(`[data-portfolio="${PF1}"]`);
    expect(document.querySelector('[data-portfolio-form]')).toBeNull();
  });

  it('zeigt einen Fehler der Liste mit „Erneut versuchen“', async () => {
    await mountPage({
      'GET /api/ads/tools/portfolios': json({ error: { code: 'X', message: 'x' } }, 500),
    });
    await choose('[data-portfolio-profile]', P1);
    expect((await found('[data-portfolio-error]')).textContent).toContain('Portfolios');
  });
});
