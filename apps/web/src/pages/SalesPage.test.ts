import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { SalesData } from '../api/client';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { isOpenForCustomers, meFixture } from '../test/fixtures';
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

const ACCOUNT = '00000000-0000-4000-8000-0000000000b1';

function period(revenueNet: string, revenueGross: string) {
  return {
    revenueNet,
    revenueGross,
    units: 12,
    orders: 10,
    unpricedUnits: 2,
    adCost: '50',
    adSales: '300',
    tacos: '0.05',
    organicNet: '700',
    organicGross: '890',
  };
}

function sales(patch: Partial<SalesData> = {}): SalesData {
  return {
    meta: {
      currency: 'EUR',
      converted: true,
      missingFxCurrencies: [],
      accounts: 1,
      adProfiles: 1,
    },
    current: period('1000', '1190'),
    comparison: period('800', '952'),
    change: {
      revenueNet: { absolute: '200', relative: '0.25' },
      revenueGross: { absolute: '238', relative: '0.25' },
      units: { absolute: '2', relative: '0.2' },
      orders: { absolute: '1', relative: '0.1' },
      tacos: { absolute: '0.01', relative: '0.2' },
    },
    days: [{ date: '2026-09-24', revenueNet: '100', revenueGross: '119', units: 2 }],
    comparisonDays: [],
    products: [
      {
        sellerAccountId: ACCOUNT,
        countryCode: 'DE',
        currencyCode: 'EUR',
        sku: 'NW-TEE-001',
        asin: 'B0MOCK0001',
        current: { revenueNet: '600', revenueGross: '714', units: 7, orders: 6 },
        comparison: null,
      },
    ],
    truncated: false,
    ...patch,
  };
}

const filterOptions = {
  clients: [],
  profiles: [],
  currencies: ['EUR'],
  fxRatesThrough: '2026-09-25',
  fxRatesStale: false,
};

type Route = Response | ((request: RecordedRequest) => Response | Promise<Response>);

function routes(overrides: Record<string, Route> = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/settings/ui-state/analytics/filters': json({ value: null }),
    'PUT /api/settings/ui-state/analytics/filters': new Response(null, { status: 204 }),
    'GET /api/settings/ui-state/profit/vat': json({ value: null }),
    'PUT /api/settings/ui-state/profit/vat': new Response(null, { status: 204 }),
    'POST /api/ads/filter-options': json(filterOptions),
    'POST /api/profit/sales': json(sales()),
    ...overrides,
  };
}

async function mountSales() {
  const mounted = await mountWithApp(undefined, { path: '/profit/sales' });
  await flushPromises();
  return mounted;
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

const text = (wrapper: { text(): string }) => wrapper.text().replace(/ /g, ' ');
const tile = (wrapper: Awaited<ReturnType<typeof mountSales>>['wrapper'], label: string) =>
  wrapper.findAll('article').find((t) => t.find('[data-kpi-label]').text() === label)!;

describe('SalesPage', () => {
  it('zeigt Umsatz netto, TACoS und organischen Umsatz mit „≈“ und Veränderung', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper } = await mountSales();
    await vi.waitFor(() => expect(wrapper.find('[data-kpi-value]').exists()).toBe(true));

    expect(text(tile(wrapper, 'Umsatz (netto)'))).toContain('≈ 1.000,00 €');
    expect(tile(wrapper, 'Umsatz (netto)').find('[data-kpi-change]').attributes('data-tone')).toBe(
      'positive',
    );
    expect(text(tile(wrapper, 'TACoS'))).toContain('5,0 %');
    // TACoS gestiegen = schlecht
    expect(tile(wrapper, 'TACoS').find('[data-kpi-change]').attributes('data-tone')).toBe(
      'negative',
    );
    expect(text(tile(wrapper, 'Organischer Umsatz (netto)'))).toContain('700,00 €');
    expect(text(wrapper)).toContain('2 Stück ohne Preis');
    expect(text(wrapper.find('[data-sales-products]'))).toContain('NW-TEE-001');
    expect(text(wrapper.find('[data-sales-products]'))).toContain('600,00 €');

    const body = requests.find((r) => r.path === '/api/profit/sales')?.body;
    expect(body).toMatchObject({ currency: 'auto', period: expect.any(Object) });
    expect(body).not.toHaveProperty('tagIds');
  });

  it('schaltet auf brutto um und merkt sich die Wahl', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper } = await mountSales();
    await vi.waitFor(() => expect(wrapper.find('[data-kpi-value]').exists()).toBe(true));

    await wrapper.find('[data-vat="gross"]').trigger('click');
    await flushPromises();

    expect(text(tile(wrapper, 'Umsatz (brutto)'))).toContain('1.190,00 €');
    // TACoS bleibt netto.
    expect(text(tile(wrapper, 'TACoS'))).toContain('5,0 %');
    expect(text(wrapper.find('[data-sales-products]'))).toContain('714,00 €');
    const put = requests.find(
      (r) => r.method === 'PUT' && r.path === '/api/settings/ui-state/profit/vat',
    );
    expect(put?.body).toEqual({ value: { mode: 'gross' } });
  });

  it('ohne passende Ads-Profile kein TACoS, mit Hinweis', async () => {
    stubFetch(
      routes({
        'POST /api/profit/sales': json(
          sales({
            meta: { ...sales().meta, adProfiles: 0 },
            current: {
              ...period('1000', '1190'),
              adCost: null,
              adSales: null,
              tacos: null,
              organicNet: null,
              organicGross: null,
            },
          }),
        ),
      }),
    );
    const { wrapper } = await mountSales();
    await vi.waitFor(() => expect(wrapper.find('[data-kpi-value]').exists()).toBe(true));
    expect(text(tile(wrapper, 'TACoS'))).toContain('–');
    expect(text(wrapper)).toContain('Kein Ads-Profil');
  });

  it('leerer Zustand ohne Seller-Konten', async () => {
    stubFetch(
      routes({
        'POST /api/profit/sales': json(
          sales({ meta: { ...sales().meta, accounts: 0 }, products: [] }),
        ),
      }),
    );
    const { wrapper } = await mountSales();
    await vi.waitFor(() => expect(text(wrapper)).toContain('Noch keine Verkaufsdaten'));
  });

  it('Fehlerzustand mit erneutem Versuch', async () => {
    stubFetch(
      routes({ 'POST /api/profit/sales': json({ error: { code: 'X', message: 'kaputt' } }, 500) }),
    );
    const { wrapper } = await mountSales();
    await vi.waitFor(() =>
      expect(text(wrapper)).toContain('Die Verkaufsdaten konnten nicht geladen werden'),
    );
  });

  it('Kunden-Login mit `profit`: nur freigegebene Anfragen', async () => {
    const { requests } = stubFetch(
      routes({
        'GET /api/me': json(
          meFixture({ orgType: 'client', orgRole: 'viewer', features: ['profit'] }),
        ),
      }),
    );
    const { wrapper } = await mountSales();
    await vi.waitFor(() => expect(wrapper.find('[data-kpi-value]').exists()).toBe(true));
    expect(requests.map((r) => r.path).filter((path) => !isOpenForCustomers(path))).toEqual([]);
  });
});
