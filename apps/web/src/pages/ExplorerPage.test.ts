import { flushPromises } from '@vue/test-utils';
import MultiSelect from 'primevue/multiselect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExplorerRowsData, TimeSeriesData } from '../api/client';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

vi.mock('ag-charts-vue3', async () => {
  const { defineComponent, h } = await import('vue');
  return {
    AgCharts: defineComponent({
      name: 'AgChartsStub',
      props: { options: { type: Object, required: true } },
      setup: () => () => h('div', { 'data-stub': 'ag-charts' }),
    }),
  };
});

const C1 = '00000000-0000-4000-8000-0000000000c1';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const CAMPAIGN = '00000000-0000-4000-8000-0000000000ca';
const CAMPAIGN2 = '00000000-0000-4000-8000-0000000000cb';
const AD = '00000000-0000-4000-8000-0000000000ad';

const coverage = {
  sales: 'full',
  purchases: 'full',
  units: 'full',
  salesSameSku: 'full',
  purchasesSameSku: 'full',
  unitsSameSku: 'full',
} as const;

function period(cost: string) {
  return {
    sums: {
      impressions: '1000',
      clicks: '20',
      cost,
      sales: '40',
      purchases: '2',
      units: '2',
      salesSameSku: null,
      purchasesSameSku: null,
      unitsSameSku: null,
      viewableImpressions: null,
      viewableCost: null,
    },
    derived: {
      ctr: '0.02',
      cpc: '0.5',
      cvr: '0.1',
      acos: '0.25',
      roas: '4',
      cpm: '10',
      vcpm: null,
    },
  };
}

type Row = ExplorerRowsData['rows'][number];
function row(id: string, name: string, cost: string, patch: Partial<Row> = {}): Row {
  return {
    id,
    profileId: P1,
    accountName: 'Demo DE',
    countryCode: 'DE',
    currencyCode: 'EUR',
    adProduct: 'SPONSORED_PRODUCTS',
    name,
    state: 'ENABLED',
    removed: false,
    placeholder: false,
    hasMetrics: true,
    attributes: { amazonId: '1' },
    current: period(cost),
    comparison: null,
    change: null,
    attribution: null,
    ...patch,
  } as Row;
}

const meta = {
  currency: 'EUR',
  converted: false,
  missingFxCurrencies: [],
  dataThrough: '2026-09-25',
  provisionalFrom: '2026-09-12',
  earliestDate: '2026-06-24',
  profilesWithoutData: 0,
};

function rowsResponse(rows: Row[], patch: Partial<ExplorerRowsData> = {}): ExplorerRowsData {
  return {
    meta,
    rows,
    totalRows: rows.length,
    truncated: false,
    maxRows: 10000,
    total: {
      current: period('30'),
      comparison: null,
      change: null,
      attribution: { mixed: false, sameSkuMixed: false, coverage },
    },
    ...patch,
  } as ExplorerRowsData;
}

const campaigns = () => [
  row(CAMPAIGN, 'SP Waldkauz Nistkasten', '20.125'),
  row(CAMPAIGN2, '=SUMME(1)', '10'),
];

function withComparison(rows: Row[]): Row[] {
  return rows.map((r) => ({
    ...r,
    comparison: period('5'),
    change: { cost: '1.5', sales: '0', acos: '-0.1' } as Row['change'],
  }));
}

const series = (): TimeSeriesData =>
  ({
    meta,
    days: [{ date: '2026-09-24', ...period('10') }],
    comparisonDays: [],
    attribution: { mixed: false, sameSkuMixed: false, coverage },
    comparisonAttribution: null,
  }) as TimeSeriesData;

const filterOptions = {
  clients: [{ id: C1, name: 'Waldkauz (Demo)', slug: 'waldkauz' }],
  profiles: [
    {
      id: P1,
      amazonProfileId: '7100000000000001',
      accountName: 'Demo DE',
      countryCode: 'DE',
      currencyCode: 'EUR',
      timezone: 'Europe/Berlin',
      accountType: 'seller',
      clientId: C1,
    },
  ],
  currencies: ['EUR', 'USD'],
  fxRatesThrough: '2026-09-25',
  fxRatesStale: false,
};

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

function routes(rows: Responder = defaultRows) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/settings/ui-state/analytics/filters': json({ value: null }),
    'PUT /api/settings/ui-state/analytics/filters': new Response(null, { status: 204 }),
    'POST /api/ads/filter-options': json(filterOptions),
    'POST /api/ads/explorer/rows': rows,
    'POST /api/ads/timeseries': json(series()),
    'GET /api/saved-views': json({ views: [] }),
  };
}

function defaultRows({ body }: RecordedRequest): Response {
  const request = body as { level: string; comparison: unknown };
  if (request.level === 'negative') {
    return json(
      rowsResponse(
        [
          row('n1', 'gratis', '0', {
            current: null,
            attributes: { level: 'campaign', matchType: 'NEGATIVE_EXACT', campaignName: 'SP A' },
          }),
        ],
        { total: null },
      ),
    );
  }
  if (request.level === 'adGroup') {
    return json(
      rowsResponse([
        row('g1', 'AG Nistkasten', '20', {
          attributes: { campaignId: CAMPAIGN, campaignName: 'SP Waldkauz Nistkasten' },
        }),
      ]),
    );
  }
  if (request.level === 'productAd') {
    return json(
      rowsResponse([
        row(AD, 'B0DEMO0001', '20', {
          adProduct: 'SPONSORED_BRANDS',
          attributes: { asin: 'B0DEMO0001', asins: ['B0DEMO0001', 'B0DEMO0002', 'B0DEMO0003'] },
        }),
      ]),
    );
  }
  const rows = campaigns();
  return json(rowsResponse(request.comparison ? withComparison(rows) : rows));
}

async function mountExplorer(path = '/ads/explorer') {
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  return mounted;
}

/** AG Grid zeichnet Zeilen asynchron: auf jede gelesene Zeile warten. */
async function waitForRow(text: string) {
  await vi.waitFor(() => expect(document.body.textContent).toContain(text), { timeout: 3000 });
}

const rowRequests = (requests: RecordedRequest[]) =>
  requests
    .filter((r) => r.path === '/api/ads/explorer/rows')
    .map((r) => r.body as Record<string, unknown>);

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('ExplorerPage', () => {
  it('Reiter je Ebene, Standard Kampagnen', async () => {
    stubFetch(routes());
    const { wrapper, router } = await mountExplorer();
    await waitForRow('SP Waldkauz Nistkasten');
    const tabs = wrapper.findAll('nav[aria-label="Ebenen"] a');
    expect(tabs.map((tab) => tab.text())).toEqual([
      'Portfolios',
      'Kampagnen',
      'Ad Groups',
      'Targets',
      'Product Ads',
      'Suchbegriffe',
      'Negatives',
    ]);
    expect(tabs[1]!.attributes('aria-current')).toBe('page');
    expect(tabs[3]!.attributes('href')).toBe('/ads/explorer/targets');
    expect(router.currentRoute.value.path).toBe('/ads/explorer/campaigns');
  });

  it('lädt die Zeilen zuerst ohne Vergleich, danach mit (Dominik, 2026-09-28)', async () => {
    const { requests } = stubFetch(routes());
    await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    await vi.waitFor(() => expect(rowRequests(requests)).toHaveLength(2));
    const [first, second] = rowRequests(requests);
    expect(first).toMatchObject({ level: 'campaign', comparison: null });
    expect(second).toMatchObject({ level: 'campaign', comparison: expect.any(Object) });
    // Veränderung erscheint, sobald der Vergleich da ist.
    await waitForRow('+150,0');
  });

  it('Drill-Down: Klick auf eine Kampagne zeigt deren Ad Groups, Brotkrumen zurück', async () => {
    stubFetch(routes());
    const { wrapper, router } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    const link = [...document.querySelectorAll('a')].find(
      (a) => a.textContent === 'SP Waldkauz Nistkasten',
    )!;
    expect(link.getAttribute('href')).toBe(`/ads/explorer/ad-groups?campaign=${CAMPAIGN}`);
    link.click();
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/ads/explorer/ad-groups'));
    await waitForRow('AG Nistkasten');
    const crumbs = wrapper.find('nav[aria-label="Pfad"]');
    expect(crumbs.text()).toContain('Alle Profile');
    expect(crumbs.text()).toContain('SP Waldkauz Nistkasten');
    // Reiter behalten den Drill-Down
    expect(wrapper.find('nav[aria-label="Ebenen"] a[href*="targets"]').attributes('href')).toBe(
      `/ads/explorer/targets?campaign=${CAMPAIGN}`,
    );
  });

  it('Kürzung auf 10 000 Zeilen wird deutlich gesagt', async () => {
    stubFetch(
      routes(() =>
        json(rowsResponse(campaigns(), { totalRows: 12187, truncated: true, maxRows: 10000 })),
      ),
    );
    const { wrapper } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    expect(wrapper.text().replace(/\u00a0/g, ' ')).toContain(
      'Es werden die 10.000 Zeilen mit dem höchsten Spend gezeigt (von 12.187).',
    );
  });

  it('Negatives: ohne Kennzahlen, ohne Chart, ohne Vergleichsanfrage', async () => {
    const { requests, wrapper } = await (async () => {
      const stub = stubFetch(routes());
      const mounted = await mountExplorer('/ads/explorer/negatives');
      return { requests: stub.requests, wrapper: mounted.wrapper };
    })();
    await waitForRow('gratis');
    expect(rowRequests(requests)).toHaveLength(1);
    expect(rowRequests(requests)[0]).toMatchObject({ level: 'negative', comparison: null });
    expect(requests.some((r) => r.path === '/api/ads/timeseries')).toBe(false);
    expect(document.body.textContent).not.toContain('Spend');
    expect(wrapper.find('[data-explorer-chart]').exists()).toBe(false);
  });

  it('Suchfeld ASIN/SKU im Reiter Product Ads: Suche in der URL und in der Anfrage', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper, router } = await mountExplorer('/ads/explorer/product-ads');
    await waitForRow('teilt sich 3 ASINs');
    await wrapper.find('[data-explorer-search]').setValue('B0DEMO0001 sku-9');
    await wrapper.find('form[role="search"]').trigger('submit');
    await flushPromises();
    expect(router.currentRoute.value.query.q).toBe('B0DEMO0001,sku-9');
    await vi.waitFor(() =>
      expect(rowRequests(requests).at(-1)).toMatchObject({
        level: 'productAd',
        filter: { productSearch: ['B0DEMO0001', 'sku-9'] },
      }),
    );
    // Andere Reiter nehmen die Suche nicht mit.
    expect(
      wrapper.find('nav[aria-label="Ebenen"] a[href*="campaigns"]').attributes('href'),
    ).not.toContain('q=');
    expect(
      wrapper.find('nav[aria-label="Ebenen"] a[href*="product-ads"]').attributes('href'),
    ).toContain('q=');
    await wrapper.find('[data-explorer-search-clear]').trigger('click');
    await flushPromises();
    expect(router.currentRoute.value.query.q).toBeUndefined();
  });

  it('Tastatur: Zellen sind fokussierbar, Enter auf dem Namen öffnet den Drill-Down (2.13)', async () => {
    stubFetch(routes());
    const { router } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    const cell = [...document.querySelectorAll<HTMLElement>('.ag-cell[col-id="name"]')].find((c) =>
      c.textContent?.includes('SP Waldkauz Nistkasten'),
    )!;
    expect(cell.getAttribute('tabindex')).toBe('-1');
    cell.focus();
    cell.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/ads/explorer/ad-groups'));
  });

  it('Tastatur: Enter auf dem fokussierten Link selbst oder mit Wiederholung löst nichts zusätzlich aus', async () => {
    stubFetch(routes());
    const { router } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    const cell = () =>
      [...document.querySelectorAll<HTMLElement>('.ag-cell[col-id="name"]')].find((c) =>
        c.textContent?.includes('SP Waldkauz Nistkasten'),
      )!;
    // Der Link handelt selbst (nativ); happy-dom führt das nicht aus, der Handler darf nicht zusätzlich klicken.
    cell()
      .querySelector('a')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    for (const init of [{ repeat: true }, { metaKey: true }, { ctrlKey: true }]) {
      cell().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }));
    }
    await flushPromises();
    expect(router.currentRoute.value.path).toBe('/ads/explorer/campaigns');
  });

  it('Product Ads mit mehreren ASINs: Liste im Popover der Zelle', async () => {
    stubFetch(routes());
    await mountExplorer('/ads/explorer/product-ads');
    await waitForRow('teilt sich 3 ASINs');
    const button = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('teilt sich 3 ASINs'),
    )!;
    button.click();
    await flushPromises();
    await vi.waitFor(() => expect(document.body.textContent).toContain('B0DEMO0003'));
  });

  it('Chart über dem Grid lädt die Tagesreihe der Ebene mit Drill-Down', async () => {
    const { requests } = stubFetch(routes());
    await mountExplorer(`/ads/explorer/ad-groups?campaign=${CAMPAIGN}`);
    await waitForRow('AG Nistkasten');
    await vi.waitFor(() =>
      expect(requests.some((r) => r.path === '/api/ads/timeseries')).toBe(true),
    );
    const body = requests.find((r) => r.path === '/api/ads/timeseries')!.body;
    expect(body).toMatchObject({ level: 'adGroup', filter: { campaignIds: [CAMPAIGN] } });
  });

  it('Entfernte anzeigen und Ad-Typ wirken auf die Anfrage und stehen in der URL', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper, router } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    await wrapper.find('input[type="checkbox"][data-explorer-removed]').setValue(true);
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({ removed: '1' });
    await vi.waitFor(() =>
      expect(rowRequests(requests).at(-1)).toMatchObject({ filter: { includeRemoved: true } }),
    );
  });

  it('CSV-Export: geladene Zeilen, Beträge als Decimal-String mit Währung, Hinweis bei Kürzung', async () => {
    stubFetch(
      routes(() =>
        json(rowsResponse(campaigns(), { totalRows: 12187, truncated: true, maxRows: 10000 })),
      ),
    );
    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
      blob = value as Blob;
      return 'blob:csv';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { wrapper } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    await wrapper.find('button[data-explorer-export]').trigger('click');
    await vi.waitFor(() => expect(blob).toBeDefined());
    const csv = await blob!.text();
    // BOM, damit Excel UTF-8 erkennt; der Hinweis steht vor der Kopfzeile.
    expect(csv.startsWith('\uFEFF')).toBe(true);
    expect(csv.indexOf('nur die 10.000')).toBeLessThan(csv.indexOf('"Name"'));
    // Formeln in Texten entschärft
    expect(csv).toContain(`"'=SUMME(1)"`);
    // Betrag als Decimal-String (nicht „20,13 €“)
    expect(csv).toContain('"20.125"');
    expect(csv).toContain('nur die 10.000 Zeilen mit dem höchsten Spend von 12.187');
    expect(csv).toContain('"Währung"');
    expect(csv).toContain('"SP Waldkauz Nistkasten"');
    expect(csv).toContain('"EUR"');
  });

  it('CSV-Export in der Sortierung des Grids (aus der URL)', async () => {
    stubFetch(routes());
    let blob: Blob | undefined;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((value) => {
      blob = value as Blob;
      return 'blob:csv';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const { wrapper } = await mountExplorer('/ads/explorer/campaigns?sort=cost.asc');
    await waitForRow('SP Waldkauz Nistkasten');
    await wrapper.find('button[data-explorer-export]').trigger('click');
    await vi.waitFor(() => expect(blob).toBeDefined());
    const csv = await blob!.text();
    // Spend aufsteigend: 10 vor 20.125 (die API liefert absteigend).
    expect(csv.indexOf(`"'=SUMME(1)"`)).toBeLessThan(csv.indexOf('"SP Waldkauz Nistkasten"'));
  });

  it('Fehler beim Nachladen des Vergleichs: Zeilen bleiben, eigener Hinweis mit „Erneut versuchen“', async () => {
    stubFetch(
      routes(({ body }) =>
        (body as { comparison: unknown }).comparison === null
          ? json(rowsResponse(campaigns()))
          : json({ error: { code: 'SERVER', message: 'x' } }, 500),
      ),
    );
    const { wrapper } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Der Vergleich konnte nicht geladen werden.'),
    );
    expect(wrapper.text()).toContain('Erneut versuchen');
    expect(wrapper.text()).not.toContain('Die Zeilen konnten nicht geladen werden.');
  });

  it('speichert die Spaltenauswahl je Ebene (ui_state)', async () => {
    const { requests } = stubFetch({
      ...routes(),
      'GET /api/settings/ui-state/explorer/columns.campaign': json({ value: null }),
      'PUT /api/settings/ui-state/explorer/columns.campaign': new Response(null, { status: 204 }),
    });
    const { wrapper } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    const picker = wrapper
      .findAllComponents(MultiSelect)
      .find((c) => String(c.props('inputId')).endsWith('-columns'))!;
    picker.vm.$emit('update:modelValue', ['cost', 'sales']);
    await vi.waitFor(() =>
      expect(
        requests.find(
          (r) =>
            r.method === 'PUT' && r.path === '/api/settings/ui-state/explorer/columns.campaign',
        )?.body,
      ).toEqual({ value: ['cost', 'sales'] }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector('.ag-header-cell[col-id="clicks"]')).toBeNull(),
    );
    expect(document.querySelector('.ag-header-cell[col-id="sales"]')).not.toBeNull();
  });

  it('Fehler beim Laden der Zeilen: Hinweis mit „Erneut versuchen“', async () => {
    stubFetch(routes(() => json({ error: { code: 'SERVER', message: 'x' } }, 500)));
    const { wrapper } = await mountExplorer('/ads/explorer/campaigns');
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Die Zeilen konnten nicht geladen werden.'),
    );
    expect(wrapper.text()).toContain('Erneut versuchen');
  });
});

const VIEW_ID = '00000000-0000-4000-8000-0000000000e1';

function savedView(patch: Record<string, unknown> = {}) {
  return {
    id: VIEW_ID,
    name: 'Top-Targets Waldkauz',
    area: 'explorer',
    shared: true,
    owner: { id: 'user-2', name: 'Emil' },
    own: false,
    canEdit: false,
    canShare: false,
    hiddenItems: 0,
    selectionHidden: false,
    outdated: false,
    createdAt: '2026-09-28T08:00:00.000Z',
    updatedAt: '2026-09-28T08:00:00.000Z',
    state: {
      filters: {
        clientIds: [C1],
        withoutClient: false,
        profileIds: null,
        period: { preset: 'last7' },
        comparison: 'off',
        currency: 'auto',
        attribution: 'console',
      },
      explorer: {
        level: 'target',
        drill: { portfolioId: null, campaignId: CAMPAIGN, adGroupId: null },
        includeRemoved: false,
        adProducts: [],
        chartMetrics: ['clicks', 'sales'],
        columns: ['cost', 'sales'],
        sort: { column: 'cost', direction: 'asc' },
      },
    },
    ...patch,
  };
}

const button = (selector: string) => document.querySelector<HTMLElement>(selector)!;

describe('Gespeicherte Ansichten im Explorer (F8)', () => {
  it('speichert Filterleiste, Ebene, Drill-Down, Spalten, Sortierung und Chart', async () => {
    const { requests } = stubFetch({
      ...routes(),
      'POST /api/saved-views': ({ body }) =>
        json({ ...savedView(), ...(body as object), own: true, canEdit: true }, 201),
    });
    const { wrapper } = await mountExplorer(
      `/ads/explorer/ad-groups?campaign=${CAMPAIGN}&sort=sales.desc&m1=clicks`,
    );
    await waitForRow('AG Nistkasten');
    await wrapper.find('[data-saved-views]').trigger('click');
    await vi.waitFor(() => expect(button('[data-saved-views-create]')).toBeTruthy());
    await vi.waitFor(() =>
      expect(button('[data-saved-views-create]').hasAttribute('disabled')).toBe(false),
    );
    button('[data-saved-views-create]').click();
    await flushPromises();
    const input = document.querySelector<HTMLInputElement>('[data-saved-view-name]')!;
    input.value = 'Meine Ad Groups';
    input.dispatchEvent(new Event('input'));
    // Admin darf freigeben
    expect(document.querySelector('[data-saved-view-shared]')).not.toBeNull();
    button('[data-saved-view-submit]').click();
    await vi.waitFor(() =>
      expect(requests.some((r) => r.method === 'POST' && r.path === '/api/saved-views')).toBe(true),
    );
    const body = requests.find((r) => r.method === 'POST' && r.path === '/api/saved-views')!.body;
    expect(body).toMatchObject({
      name: 'Meine Ad Groups',
      area: 'explorer',
      shared: false,
      state: {
        filters: { period: { preset: 'last30' }, comparison: 'previous' },
        explorer: {
          level: 'adGroup',
          drill: { portfolioId: null, campaignId: CAMPAIGN, adGroupId: null },
          chartMetrics: ['clicks', 'sales'],
          columns: null,
          sort: { column: 'sales', direction: 'desc' },
        },
      },
    });
  });

  it('lädt eine Ansicht: Ebene, Drill-Down und Sortierung in die URL, Spalten als eigene Auswahl', async () => {
    const { requests } = stubFetch({
      ...routes(),
      'GET /api/saved-views': json({ views: [savedView()] }),
      'PUT /api/settings/ui-state/explorer/columns.target': new Response(null, { status: 204 }),
    });
    const { wrapper, router } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    await wrapper.find('[data-saved-views]').trigger('click');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Top-Targets Waldkauz'));
    expect(document.body.textContent).toContain('von Emil');
    // Fremde Ansicht ohne Recht: keine Aktionen außer „Link kopieren“
    expect(
      document.querySelector(`[data-saved-view="${VIEW_ID}"] [aria-label^="„Top"]`),
    ).toBeNull();
    [...document.querySelectorAll<HTMLButtonElement>(`[data-saved-view="${VIEW_ID}"] button`)]
      .find((b) => b.textContent?.includes('Top-Targets'))!
      .click();
    await flushPromises();
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/ads/explorer/targets'));
    expect(router.currentRoute.value.query).toEqual({
      campaign: CAMPAIGN,
      m1: 'clicks',
      sort: 'cost.asc',
      clients: C1,
      period: 'last7',
      cmp: 'off',
    });
    await vi.waitFor(() =>
      expect(
        requests.find((r) => r.path === '/api/settings/ui-state/explorer/columns.target')?.body,
      ).toEqual({ value: ['cost', 'sales'] }),
    );
    await vi.waitFor(() =>
      expect(rowRequests(requests).at(-1)).toMatchObject({
        level: 'target',
        clientIds: [C1],
        filter: { campaignIds: [CAMPAIGN] },
      }),
    );
    // Aktive Ansicht steht auf dem Knopf.
    await vi.waitFor(() =>
      expect(wrapper.find('[data-saved-views]').text()).toContain('Top-Targets Waldkauz'),
    );
  });

  it('Link mit ?view=<id> lädt die Ansicht und entfernt den Parameter', async () => {
    stubFetch({
      ...routes(),
      [`GET /api/saved-views/${VIEW_ID}`]: json(savedView({ hiddenItems: 2 })),
      'PUT /api/settings/ui-state/explorer/columns.target': new Response(null, { status: 204 }),
    });
    const { wrapper, router } = await mountExplorer(`/ads/explorer?view=${VIEW_ID}`);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/ads/explorer/targets'));
    expect(router.currentRoute.value.query.view).toBeUndefined();
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('2 Einträge dieser Ansicht sind für dich nicht sichtbar'),
    );
  });

  it('Link führt ohne neuen Verlaufseintrag zur Ansicht (Zurück springt nicht auf den Link)', async () => {
    stubFetch({
      ...routes(),
      [`GET /api/saved-views/${VIEW_ID}`]: json(savedView()),
      'PUT /api/settings/ui-state/explorer/columns.target': new Response(null, { status: 204 }),
    });
    const { router } = await mountExplorer(`/ads/explorer?view=${VIEW_ID}`);
    await vi.waitFor(() => expect(router.currentRoute.value.path).toBe('/ads/explorer/targets'));
    // Zurück führt vor den Link, nicht auf ihn (dort würde die Ansicht erneut geladen).
    const seen: string[] = [];
    router.afterEach((to) => void seen.push(to.fullPath));
    router.back();
    await flushPromises();
    expect(seen.some((path) => path.includes('view='))).toBe(false);
  });

  it('Link auf eine Dashboard-Ansicht oder ohne sichtbare Auswahl lädt nichts und sagt es', async () => {
    stubFetch({
      ...routes(),
      [`GET /api/saved-views/${VIEW_ID}`]: json(savedView({ area: 'dashboard' })),
    });
    const { wrapper, router } = await mountExplorer(`/ads/explorer/campaigns?view=${VIEW_ID}`);
    await vi.waitFor(() => expect(router.currentRoute.value.query.view).toBeUndefined());
    expect(router.currentRoute.value.path).toBe('/ads/explorer/campaigns');
    expect(wrapper.text()).toContain('Die verlinkte Ansicht gibt es nicht');
    cleanupMounted();

    stubFetch({
      ...routes(),
      [`GET /api/saved-views/${VIEW_ID}`]: json(savedView({ selectionHidden: true })),
    });
    const second = await mountExplorer(`/ads/explorer/campaigns?view=${VIEW_ID}`);
    await vi.waitFor(() => expect(second.router.currentRoute.value.query.view).toBeUndefined());
    expect(second.router.currentRoute.value.path).toBe('/ads/explorer/campaigns');
    expect(second.wrapper.text()).toContain('Die Ansicht wurde nicht geladen.');
  });

  it('Überschreiben einer Team-Ansicht fragt vorher nach', async () => {
    const { requests } = stubFetch({
      ...routes(),
      'GET /api/saved-views': json({ views: [savedView({ canEdit: true })] }),
      [`PATCH /api/saved-views/${VIEW_ID}`]: json(savedView({ canEdit: true })),
    });
    const { wrapper } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    await wrapper.find('[data-saved-views]').trigger('click');
    await vi.waitFor(() => expect(document.body.textContent).toContain('Top-Targets Waldkauz'));
    button('[aria-label="„Top-Targets Waldkauz“ mit dem aktuellen Stand überschreiben"]').click();
    await flushPromises();
    expect(document.body.textContent).toContain('Das betrifft alle, die sie nutzen.');
    expect(requests.some((r) => r.method === 'PATCH')).toBe(false);
    button('[data-saved-view-submit]').click();
    await vi.waitFor(() =>
      expect(requests.find((r) => r.method === 'PATCH')?.body).toMatchObject({
        state: { explorer: { level: 'campaign' } },
      }),
    );
  });

  it('Viewer speichern nur persönlich', async () => {
    stubFetch({ ...routes(), 'GET /api/me': json(meFixture({ orgRole: 'viewer' })) });
    const { wrapper } = await mountExplorer('/ads/explorer/campaigns');
    await waitForRow('SP Waldkauz Nistkasten');
    await wrapper.find('[data-saved-views]').trigger('click');
    await vi.waitFor(() =>
      expect(button('[data-saved-views-create]').hasAttribute('disabled')).toBe(false),
    );
    button('[data-saved-views-create]').click();
    await flushPromises();
    expect(document.querySelector('[data-saved-view-shared]')).toBeNull();
    expect(document.body.textContent).toContain('Freigeben können Editoren und Admins.');
  });
});
