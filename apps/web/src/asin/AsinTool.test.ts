import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';
import AsinTool from './AsinTool.vue';
import { resetAsinTool } from './state';
import QuickTools from '../components/shell/QuickTools.vue';

const CAMPAIGN = '00000000-0000-4000-8000-0000000000ca';
const AD_GROUP = '00000000-0000-4000-8000-0000000000ad';
const C1 = '00000000-0000-4000-8000-0000000000c1';

const filterOptions = {
  clients: [{ id: C1, name: 'Waldkauz', slug: 'waldkauz' }],
  profiles: [
    {
      id: '00000000-0000-4000-8000-0000000000a1',
      amazonProfileId: '1',
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

const period = {
  sums: {
    impressions: '100',
    clicks: '10',
    cost: '12.5',
    sales: '50',
    purchases: '2',
    units: '2',
    salesSameSku: null,
    purchasesSameSku: null,
    unitsSameSku: null,
    viewableImpressions: null,
    viewableCost: null,
  },
  derived: { ctr: '0.1', cpc: '1.25', cvr: '0.2', acos: '0.25', roas: '4', cpm: '125', vcpm: null },
};

const row = {
  id: 'ad-1',
  profileId: '00000000-0000-4000-8000-0000000000a1',
  accountName: 'Demo DE',
  countryCode: 'DE',
  currencyCode: 'EUR',
  adProduct: 'SPONSORED_BRANDS',
  name: 'B0DEMO0001',
  state: 'ENABLED',
  removed: false,
  placeholder: false,
  hasMetrics: true,
  attributes: {
    campaignId: CAMPAIGN,
    campaignName: 'SB Waldkauz',
    adGroupId: AD_GROUP,
    adGroupName: 'AG Kollektion',
    asin: 'B0DEMO0001',
    asins: ['B0DEMO0001', 'B0DEMO0002', 'B0DEMO0003'],
  },
  current: period,
  comparison: null,
  change: null,
  attribution: null,
};

function routes(rows = [row]) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/settings/ui-state/analytics/filters': json({
      value: {
        clientIds: [C1],
        withoutClient: false,
        profileIds: null,
        period: { preset: 'last7' },
        comparison: 'previous',
        currency: 'JPY',
        attribution: 'console',
      },
    }),
    'POST /api/ads/filter-options': json(filterOptions),
    'POST /api/ads/asin-search': json({
      meta: {
        currency: 'EUR',
        converted: false,
        missingFxCurrencies: [],
        dataThrough: '2026-09-25',
        provisionalFrom: '2026-09-12',
        earliestDate: '2026-06-24',
        profilesWithoutData: 0,
      },
      rows,
      totalRows: rows.length,
      truncated: false,
      maxRows: 10000,
      total: null,
    }),
  };
}

afterEach(() => {
  cleanupMounted();
  resetAsinTool();
  vi.unstubAllGlobals();
});

async function search(text: string) {
  const mounted = await mountWithApp(AsinTool, { path: '/dashboard' });
  const input = mounted.wrapper.find('[data-asin-input]');
  await input.setValue(text);
  await mounted.wrapper.find('form').trigger('submit');
  await flushPromises();
  return mounted;
}

describe('ASIN-Tool (F10)', () => {
  it('sucht mit Zeitraum und Auswahl der Filterleiste, ohne Vergleich; nicht wählbare Währung wird automatisch', async () => {
    const { requests } = stubFetch(routes());
    const { wrapper } = await search('b0demo0001, SKU-7\nb0demo0001');
    await vi.waitFor(() => expect(wrapper.text()).toContain('SB Waldkauz'));
    const body = requests.find((r) => r.path === '/api/ads/asin-search')!.body as Record<
      string,
      unknown
    >;
    expect(body).toMatchObject({
      terms: ['b0demo0001', 'SKU-7'],
      clientIds: [C1],
      comparison: null,
      currency: 'auto',
    });
    expect(wrapper.text()).toContain('Zeitraum: Letzte 7 Tage');
    expect(wrapper.text()).toContain('teilt sich 3 ASINs');
    expect(wrapper.text().replace(/\u00a0/g, ' ')).toContain('Spend 12,50 €');
    expect(wrapper.text()).toContain('ACoS 25,0');
  });

  it('Klick springt in den Explorer: Product Ads der Ad Group mit der Suche', async () => {
    stubFetch(routes());
    const { wrapper } = await search('B0DEMO0001');
    await vi.waitFor(() => expect(wrapper.text()).toContain('SB Waldkauz'));
    const link = wrapper.find('[data-asin-results] a');
    expect(link.attributes('href')).toBe(
      `/ads/explorer/product-ads?campaign=${CAMPAIGN}&adGroup=${AD_GROUP}&q=B0DEMO0001`,
    );
    expect(wrapper.find('[data-asin-open-explorer]').attributes('href')).toBe(
      '/ads/explorer/product-ads?q=B0DEMO0001',
    );
  });

  it('leer und ohne Eingabe', async () => {
    const { requests } = stubFetch(routes([]));
    const { wrapper } = await search('   ');
    expect(wrapper.text()).toContain('Bitte mindestens eine ASIN oder SKU eingeben.');
    expect(requests.some((r) => r.path === '/api/ads/asin-search')).toBe(false);
    await wrapper.find('[data-asin-input]').setValue('B0NICHTDA');
    await wrapper.find('form').trigger('submit');
    await vi.waitFor(() =>
      expect(wrapper.text()).toContain('Keine Product Ads zu diesen ASINs oder SKUs.'),
    );
  });

  it('Ladezustand und Fehler der Suche selbst (DoD)', async () => {
    stubFetch({ ...routes(), 'POST /api/ads/asin-search': () => new Promise<Response>(() => {}) });
    const pending = await search('B0DEMO0001');
    await vi.waitFor(() =>
      expect(pending.wrapper.find('[aria-busy="true"] [data-skeleton]').exists()).toBe(true),
    );
    cleanupMounted();
    resetAsinTool();

    stubFetch({
      ...routes(),
      'POST /api/ads/asin-search': json({ error: { code: 'SERVER', message: 'x' } }, 500),
    });
    const { wrapper } = await search('B0DEMO0001');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Die Suche ist fehlgeschlagen.'));
    expect(wrapper.text()).toContain('Erneut versuchen');
  });

  it('Filteroptionen nicht ladbar: Fehler mit „Erneut versuchen“ statt ewigem Skeleton', async () => {
    stubFetch({
      ...routes(),
      'POST /api/ads/filter-options': json({ error: { code: 'SERVER', message: 'x' } }, 500),
    });
    const { wrapper } = await search('B0DEMO0001');
    await vi.waitFor(() => expect(wrapper.text()).toContain('Die Suche ist fehlgeschlagen.'));
    expect(wrapper.text()).toContain('Erneut versuchen');
  });

  it('eigener Zeitraum mit Daten; „weitere“ zählt alle Treffer; Eingabe bleibt nach dem Schließen', async () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ ...row, id: `ad-${i}` }));
    const r = routes(many);
    stubFetch({
      ...r,
      'GET /api/settings/ui-state/analytics/filters': json({
        value: {
          clientIds: [],
          withoutClient: false,
          profileIds: null,
          period: { preset: 'custom', range: { from: '2026-09-01', to: '2026-09-10' } },
          comparison: 'off',
          currency: 'auto',
          attribution: 'console',
        },
      }),
      'POST /api/ads/asin-search': async () => {
        const res = await (r['POST /api/ads/asin-search'] as Response).clone().json();
        return json({ ...res, totalRows: 12000, truncated: true });
      },
    });
    const { wrapper } = await search('B0DEMO0001');
    await vi.waitFor(() => expect(wrapper.text()).toContain('SB Waldkauz'));
    expect(wrapper.text()).toContain('01.09.2026 – 10.09.2026');
    expect(wrapper.text()).toContain('und 11.970 weitere');
    wrapper.unmount();
    const again = await mountWithApp(AsinTool, { path: '/dashboard' });
    expect((again.wrapper.find('[data-asin-input]').element as HTMLTextAreaElement).value).toBe(
      'B0DEMO0001',
    );
  });

  it('Quick-Tools ohne Explorer-Recht zeigen das Tool nicht', async () => {
    stubFetch({ ...routes(), 'GET /api/me': json(meFixture({ features: ['dashboard'] })) });
    const { wrapper } = await mountWithApp(QuickTools, { path: '/dashboard' });
    await wrapper.find('button').trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('Hier erscheinen kleine Werkzeuge');
    expect(document.querySelector('[data-asin-input]')).toBeNull();
  });
});
