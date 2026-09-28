import { flushPromises } from '@vue/test-utils';
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
  row(CAMPAIGN, 'SP Waldkauz Nistkasten', '20'),
  row(CAMPAIGN2, 'SP Waldkauz Futterhaus', '10'),
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
    expect(csv).toContain('nur die 10.000 Zeilen mit dem höchsten Spend von 12.187');
    expect(csv).toContain('"Währung"');
    expect(csv).toContain('"SP Waldkauz Nistkasten"');
    expect(csv).toContain('"20"');
    expect(csv).toContain('"EUR"');
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
