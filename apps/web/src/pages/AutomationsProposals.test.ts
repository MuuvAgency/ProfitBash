import { DEFAULT_STRUCTURE_CATALOG } from '@profitbash/shared';
import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture, type MeFixtureOptions } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

/** Seite „Automationen“, Tabs „Vorschläge“ und „Läufe“ (`phase-5.md` 5.8). */

const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const RUN = '00000000-0000-4000-8000-0000000000b1';
const PROFILE = '00000000-0000-4000-8000-0000000000c1';
const proposal = (patch: Record<string, unknown> = {}) => ({
  id: P1,
  runId: RUN,
  profileId: PROFILE,
  accountName: 'Nordwind DE',
  entityType: 'target',
  entityId: '00000000-0000-4000-8000-0000000000d1',
  campaignName: 'SP | Jacken',
  adGroupName: 'Breit',
  target: {
    targetType: 'keyword',
    keywordText: 'regenjacke',
    matchType: 'BROAD',
    expression: null,
  },
  field: 'bid',
  before: '0.50',
  after: '0.40',
  currencyCode: 'EUR',
  source: 'rule',
  ruleName: 'Viele Klicks ohne Bestellung',
  limitedBy: ['bidFloor'],
  detail: { impressions: 4000, clicks: 40, orders: 0, spend: '12.00', sales: '0', goalAcos: '25' },
  status: 'open',
  createdAt: '2026-10-10T08:00:00.000Z',
  ...patch,
});
const pause = proposal({
  id: P2,
  entityType: 'campaign',
  adGroupName: null,
  target: null,
  field: 'state',
  before: 'ENABLED',
  after: 'PAUSED',
  currencyCode: null,
  source: 'optimizer',
  ruleName: null,
  limitedBy: [],
});
const run = {
  id: RUN,
  profileId: PROFILE,
  accountName: 'Nordwind DE',
  mode: 'cart',
  periodStart: '2026-09-08',
  periodEnd: '2026-10-07',
  metricsImportedAt: '2026-10-08T06:30:00.000Z',
  counts: { targets: 1234, campaigns: 12, proposals: 56, staged: 50, dismissed: 2 },
  warnings: ['olderPeriod', 'responsibleMissing'],
  createdAt: '2026-10-10T08:00:00.000Z',
};

type Responder = (request: RecordedRequest) => Response | Promise<Response>;
async function mountTab(
  tab: 'proposals' | 'runs',
  overrides: Record<string, Responder | Response> = {},
  me: MeFixtureOptions = {},
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
    'GET /api/ads/automations/proposals': json({ proposals: [proposal(), pause], total: 2 }),
    'GET /api/ads/automations/runs': json({ runs: [run] }),
    'GET /api/ads/automations/structure-proposals': json({ proposals: [], total: 0 }),
    ...overrides,
  });
  const mounted = await mountWithApp(undefined, { path: '/ads/automations' });
  await flushPromises();
  $<HTMLButtonElement>(`[data-automation-tab="${tab}"]`)!.click();
  await flushPromises();
  return { ...mounted, ...stub };
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector);
const row = (id: string) => $(`[data-proposal-row="${id}"]`)!;
const text = (element: Element) => element.textContent!.replaceAll('\u00a0', ' ');
const posts = (requests: RecordedRequest[]) =>
  requests.filter((r) => r.method === 'POST').map((r) => [r.path, r.body]);
async function click(element: HTMLElement | null | undefined) {
  element!.click();
  await flushPromises();
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('Seite „Automationen“: Vorschläge', () => {
  it('zeigt je Vorschlag Entity, vorher/nachher, Herkunft, Leitplanke und Kennzahlen', async () => {
    const { requests } = await mountTab('proposals');
    await vi.waitFor(() => expect($(`[data-proposal-row="${P1}"]`)).not.toBeNull());

    expect(requests.find((r) => r.path.endsWith('/proposals'))!.search).toBe('?status=open');
    const first = text(row(P1));
    expect(first).toContain('regenjacke · Weitgehend');
    expect(first).toContain('SP | Jacken › Breit');
    expect(first).toContain('Nordwind DE');
    expect(first).toContain('Gebot');
    expect(first).toContain('0,50 € → 0,40 €');
    expect(first).toContain('Regel: Viele Klicks ohne Bestellung');
    expect(first).toContain('Begrenzt durch: Gebotsboden');
    expect(first).toContain('40 Klicks');
    expect(first).toContain('0 Bestellungen');
    expect(first).toContain('12,00 € Ausgaben');
    expect(first).toContain('Ziel-ACoS 25 %');
    const second = text(row(P2));
    expect(second).toContain('SP | Jacken');
    expect(second).toContain('Aktiv → Pausiert');
    expect(second).toContain('Optimizer');
    expect(second).not.toContain('Begrenzt durch');
    expect(first).not.toContain('bisher Standardgebot');
  });

  it('Vorschläge des Enforcers nennen den Cap, Ist, Prognose und den Datenstand', async () => {
    const capped = proposal({
      id: P2,
      entityType: 'campaign',
      adGroupName: null,
      target: null,
      field: 'state',
      before: 'ENABLED',
      after: 'PAUSED',
      currencyCode: null,
      source: 'budget_cap',
      ruleName: null,
      limitedBy: [],
      detail: {
        capAmount: '500',
        capCurrencyCode: 'EUR',
        actual: '620.5',
        forecast: '1653.33',
        dataThrough: '2026-10-07',
      },
    });
    await mountTab('proposals', {
      'GET /api/ads/automations/proposals': json({ proposals: [capped], total: 1 }),
    });
    await vi.waitFor(() => expect($(`[data-proposal-row="${P2}"]`)).not.toBeNull());

    expect(text(row(P2))).toContain('Budget-Cap');
    expect(text(row(P2))).toContain(
      'Cap 500,00 € · Ist ≈ 620,50 € · Prognose ≈ 1.653,33 € · Daten bis 07.10.2026',
    );
  });

  it('nennt es, wenn das Target bisher mit dem Standardgebot der Ad Group bietet', async () => {
    await mountTab('proposals', {
      'GET /api/ads/automations/proposals': json({
        proposals: [proposal({ detail: { clicks: 20, hasOwnBid: false } })],
        total: 1,
      }),
    });
    await vi.waitFor(() => expect($(`[data-proposal-row="${P1}"]`)).not.toBeNull());
    expect(text(row(P1))).toContain('(bisher Standardgebot)');
  });

  it('legt einen einzelnen und markierte Vorschläge in den eigenen Warenkorb und meldet das Ergebnis', async () => {
    const { requests } = await mountTab('proposals', {
      'POST /api/ads/automations/proposals/stage': (request) =>
        json({ changed: (request.body as { ids: string[] }).ids.length - 1, skipped: 1 }),
    });
    await vi.waitFor(() => expect($(`[data-proposal-row="${P1}"]`)).not.toBeNull());
    await click(row(P1).querySelector<HTMLElement>('[data-proposal-stage]'));
    expect(posts(requests)).toEqual([['/api/ads/automations/proposals/stage', { ids: [P1] }]]);
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('0 Vorschläge übernommen, 1 übersprungen'),
    );

    expect($('[data-proposals-bulk]')).toBeNull();
    await click($('[data-proposals-select-all]'));
    expect($('[data-proposals-bulk]')!.textContent).toContain('2 markiert');
    await click($('[data-proposals-bulk-stage]'));
    expect(posts(requests)[1]).toEqual(['/api/ads/automations/proposals/stage', { ids: [P1, P2] }]);
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('1 Vorschlag übernommen, 1 übersprungen'),
    );
    // Danach laden Liste und Warenkorb neu, die Markierung ist weg.
    expect(requests.filter((r) => r.path.endsWith('/proposals')).length).toBeGreaterThan(2);
    expect(requests.filter((r) => r.path.endsWith('/changes/pending')).length).toBeGreaterThan(1);
    expect($('[data-proposals-bulk]')).toBeNull();
  });

  it('verwirft Vorschläge und zeigt Fehler der API', async () => {
    let fail = false;
    const { requests } = await mountTab('proposals', {
      'POST /api/ads/automations/proposals/dismiss': () =>
        fail
          ? json({ error: { code: 'INTERNAL', message: 'x' } }, 500)
          : json({ changed: 1, skipped: 0 }),
    });
    await vi.waitFor(() => expect($(`[data-proposal-row="${P2}"]`)).not.toBeNull());
    await click(row(P2).querySelector<HTMLElement>('[data-proposal-dismiss]'));
    expect(posts(requests)).toEqual([['/api/ads/automations/proposals/dismiss', { ids: [P2] }]]);
    await vi.waitFor(() => expect(document.body.textContent).toContain('1 Vorschlag verworfen'));

    fail = true;
    await click(row(P1).querySelector<HTMLElement>('[data-proposal-dismiss]'));
    await vi.waitFor(() => expect($('[role="alert"]')).not.toBeNull());
  });

  it('filtert nach Status; im Warenkorb liegende lassen sich nur verwerfen, verworfene gar nichts', async () => {
    const { requests } = await mountTab('proposals', {
      'GET /api/ads/automations/proposals': (request) =>
        json({
          proposals: [proposal({ status: new URLSearchParams(request.search).get('status') })],
          total: 700,
        }),
    });
    await vi.waitFor(() => expect($(`[data-proposal-row="${P1}"]`)).not.toBeNull());
    expect(document.body.textContent).toContain('1 von 700');

    const filter = $<HTMLSelectElement>('[data-proposals-status]')!;
    filter.value = 'staged';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(requests.some((r) => r.search === '?status=staged')).toBe(true));
    await vi.waitFor(() => expect(row(P1).querySelector('[data-proposal-stage]')).toBeNull());
    expect(row(P1).querySelector('[data-proposal-dismiss]')).not.toBeNull();

    filter.value = 'dismissed';
    filter.dispatchEvent(new Event('change', { bubbles: true }));
    await vi.waitFor(() => expect(row(P1).querySelector('[data-proposal-dismiss]')).toBeNull());
    expect($('[data-proposals-select-all]')).toBeNull();
  });

  it('Viewer lesen nur; leerer Zustand und Ladefehler mit erneutem Versuch', async () => {
    await mountTab('proposals', {}, { orgRole: 'viewer' });
    await vi.waitFor(() => expect($(`[data-proposal-row="${P1}"]`)).not.toBeNull());
    for (const selector of [
      '[data-proposal-stage]',
      '[data-proposal-dismiss]',
      '[data-proposals-select-all]',
      '[data-proposal-select]',
    ]) {
      expect($(selector)).toBeNull();
    }
    cleanupMounted();

    let calls = 0;
    await mountTab('proposals', {
      'GET /api/ads/automations/proposals': () =>
        calls++ === 0
          ? json({ error: { code: 'INTERNAL', message: 'x' } }, 500)
          : json({ proposals: [], total: 0 }),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Die Vorschläge konnten nicht geladen werden'),
    );
    await click(
      [...document.querySelectorAll('button')].find((b) =>
        b.textContent?.includes('Erneut versuchen'),
      ),
    );
    await vi.waitFor(() => expect(document.body.textContent).toContain('Keine offenen Vorschläge'));
  });
});

describe('Seite „Automationen“: Läufe', () => {
  it('zeigt je Lauf Profil, Datenstand, Modus, Zähler und Hinweise', async () => {
    await mountTab('runs');
    await vi.waitFor(() => expect($(`[data-run-row="${RUN}"]`)).not.toBeNull());
    const content = text($(`[data-run-row="${RUN}"]`)!);
    expect(content).toContain('Nordwind DE');
    expect(content).toContain('08.09.2026');
    expect(content).toContain('07.10.2026');
    expect(content).toContain('Vorschläge in den Warenkorb');
    expect(content).toContain('1.234 Targets');
    expect(content).toContain('12 Kampagnen');
    expect(content).toContain('56 Vorschläge');
    expect(content).toContain('50 im Warenkorb');
    expect(content).toContain('Der Zeitraum endet vor dem des vorigen Laufs');
    expect(content).toContain('Zuständiger fehlt');
  });

  it('leerer Zustand und Ladefehler', async () => {
    await mountTab('runs', { 'GET /api/ads/automations/runs': json({ runs: [] }) });
    await vi.waitFor(() => expect(document.body.textContent).toContain('Noch kein Lauf'));
    cleanupMounted();
    await mountTab('runs', {
      'GET /api/ads/automations/runs': json({ error: { code: 'INTERNAL', message: 'x' } }, 500),
    });
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Die Läufe konnten nicht geladen werden'),
    );
  });
});

describe('Abschnitt „Struktur“ im Tab „Vorschläge“ (5.11b)', () => {
  const S1 = '00000000-0000-4000-8000-0000000000e1';
  const S2 = '00000000-0000-4000-8000-0000000000e2';
  const base = {
    profileId: PROFILE,
    accountName: 'Nordwind DE',
    currencyCode: 'EUR',
    firstSeenAt: '2026-10-10T08:00:00.000Z',
    dismissedAt: null,
  };
  const graduation = {
    ...base,
    id: S1,
    kind: 'graduation',
    subject: 'trinkflasche 1l',
    key: 'SP-AUTO',
    detail: {
      searchTerm: 'Trinkflasche 1L',
      fromBlock: 'SP-AUTO',
      toBlocks: ['SP-KW-BROAD-CLUSTER', 'SP-KW-EXACT'],
      clicks: 40,
      orders: 3,
      spend: '10',
      sales: '100',
      acos: '10',
      periodStart: '2026-09-08',
      periodEnd: '2026-10-07',
    },
  };
  const presetSwitch = {
    ...base,
    id: S2,
    kind: 'presetSwitch',
    subject: '00000000-0000-4000-8000-0000000000f1',
    key: 'muuv-standard',
    detail: {
      productGroupName: 'Flaschen',
      from: 'launch',
      to: 'muuv-standard',
      orders: 31,
      spend: '120.00',
      sales: '900.00',
      acos: '13.33',
      goalAcos: '20',
    },
  };
  const routes = (overrides: Record<string, Responder | Response> = {}) => ({
    'GET /api/ads/automations/structure-proposals': json({
      proposals: [graduation, presetSwitch],
      total: 2,
    }),
    'GET /api/ads/tools/catalog': json({
      catalog: structuredClone(DEFAULT_STRUCTURE_CATALOG),
      version: 0,
      updatedAt: null,
      clientPresets: [],
      productGroupPresets: [],
      clients: [],
    }),
    'POST /api/ads/automations/structure-proposals/accept': json({ changed: 1, skipped: 0 }),
    'POST /api/ads/automations/structure-proposals/dismiss': json({ changed: 1, skipped: 0 }),
    ...overrides,
  });
  const row = (id: string) =>
    vi.waitFor(() => {
      const element = $(`[data-structure-row="${id}"]`);
      if (!element) throw new Error('keine Zeile');
      return element;
    });
  const posts = (requests: RecordedRequest[], action: string) =>
    requests
      .filter(
        (r) =>
          r.method === 'POST' && r.path === `/api/ads/automations/structure-proposals/${action}`,
      )
      .map((r) => r.body);

  it('zeigt Graduation mit Bausteinen und Kennzahlen und den Preset-Wechsel mit Namen', async () => {
    await mountTab('proposals', routes());
    const first = await row(S1);
    expect(first.textContent).toContain('Trinkflasche 1L');
    expect(first.textContent).toContain('Automatisch → Breit-Cluster, Exakt');
    expect(first.textContent).toContain('3 Bestellungen');
    expect(first.textContent).toContain('ACoS 10 %');
    expect(first.textContent).toContain('Nordwind DE');
    const second = await row(S2);
    expect(second.textContent).toContain('Flaschen');
    expect(second.textContent).toContain('Launch → Muuv-Standard');
    expect(second.textContent).toContain('Ziel-ACoS 20 %');
  });

  it('nimmt an und verwirft je Vorschlag und meldet das Ergebnis', async () => {
    const { requests } = await mountTab('proposals', routes());
    (await row(S1)).querySelector<HTMLButtonElement>('[data-structure-accept]')!.click();
    await flushPromises();
    expect(posts(requests, 'accept')).toEqual([{ ids: [S1] }]);
    await vi.waitFor(() => expect(document.body.textContent).toContain('1 Vorschlag angenommen'));
    (await row(S2)).querySelector<HTMLButtonElement>('[data-structure-dismiss]')!.click();
    await flushPromises();
    expect(posts(requests, 'dismiss')).toEqual([{ ids: [S2] }]);
  });

  it('sagt, wenn sich ein Vorschlag nicht mehr annehmen ließ', async () => {
    await mountTab(
      'proposals',
      routes({
        'POST /api/ads/automations/structure-proposals/accept': json({ changed: 0, skipped: 1 }),
      }),
    );
    (await row(S1)).querySelector<HTMLButtonElement>('[data-structure-accept]')!.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain('ließ sich nicht annehmen'));
  });

  it('Viewer lesen nur; leerer Zustand und Fehler haben eigene Texte', async () => {
    await mountTab('proposals', routes(), { orgRole: 'viewer' });
    await row(S1);
    expect($('[data-structure-accept]')).toBeNull();
    expect($('[data-structure-dismiss]')).toBeNull();
    cleanupMounted();

    await mountTab('proposals');
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain(
        'Keine offenen Graduation- oder Preset-Vorschläge',
      ),
    );
    cleanupMounted();

    await mountTab(
      'proposals',
      routes({
        'GET /api/ads/automations/structure-proposals': json(
          { error: { code: 'X', message: 'x' } },
          500,
        ),
      }),
    );
    await vi.waitFor(() => expect($('[data-structure-error]')).not.toBeNull());
    // Ein Fehler hier lässt die Gebots- und Budget-Vorschläge stehen.
    expect($(`[data-proposal-row="${P1}"]`)).not.toBeNull();
  });
});
