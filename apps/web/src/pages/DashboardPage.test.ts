import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DashboardData, TimeSeriesData } from '../api/client';
import { json, stubFetch, type RecordedRequest } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';

// AG Charts zeichnet auf Canvas (fehlt in happy-dom); geprüft werden die übergebenen Optionen.
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
const P2 = '00000000-0000-4000-8000-0000000000a2';
const SP = 'SPONSORED_PRODUCTS';
const SB = 'SPONSORED_BRANDS';

const full = {
  sales: 'full',
  purchases: 'full',
  units: 'full',
  salesSameSku: 'full',
  purchasesSameSku: 'full',
  unitsSameSku: 'full',
} as const;

function period(cost: string, sales: string | null) {
  return {
    sums: {
      impressions: '10000',
      clicks: '500',
      cost,
      sales,
      purchases: '40',
      units: '42',
      salesSameSku: null,
      purchasesSameSku: null,
      unitsSameSku: null,
      viewableImpressions: null,
      viewableCost: null,
    },
    derived: {
      ctr: '0.05',
      cpc: '0.5',
      cvr: '0.08',
      acos: sales ? '0.25' : null,
      roas: sales ? '4' : null,
      cpm: '25',
      vcpm: null,
    },
  };
}

const noChange = { absolute: null, relative: null };
function total(cost: string, sales: string | null, mixed = false) {
  return {
    current: period(cost, sales),
    comparison: period('200', '800'),
    change: {
      impressions: noChange,
      clicks: { absolute: '40', relative: '0.1' },
      cost: { absolute: '50', relative: '0.25' },
      sales: { absolute: '200', relative: '0.25' },
      purchases: noChange,
      units: noChange,
      ctr: noChange,
      cpc: { absolute: '-0.01', relative: '-0.02' },
      cvr: noChange,
      acos: { absolute: '0.01', relative: '0.04' },
      roas: noChange,
      cpm: noChange,
      vcpm: noChange,
    },
    attribution: { mixed, sameSkuMixed: false, coverage: full },
  };
}

function dashboard(patch: Partial<DashboardData> = {}): DashboardData {
  return {
    meta: {
      currency: 'EUR',
      converted: true,
      missingFxCurrencies: [],
      dataThrough: '2026-09-25',
      provisionalFrom: '2026-09-12',
      earliestDate: '2026-06-24',
      profilesWithoutData: 0,
    },
    total: total('250', '1000', true),
    byClient: [
      { key: C1, label: 'Waldkauz (Demo)', ...total('200', '900') },
      { key: null, label: null, ...total('50', '100') },
    ],
    byProfile: [
      { key: P1, label: 'Demo DE', countryCode: 'DE', currencyCode: 'EUR', ...total('200', '900') },
      { key: P2, label: 'Demo IT', countryCode: 'IT', currencyCode: 'EUR', ...total('50', '100') },
    ],
    byAdProduct: [
      { key: SP, label: null, share: { cost: '0.8', sales: '0.9' }, ...total('200', '900') },
      { key: SB, label: null, share: { cost: '0.2', sales: '0.1' }, ...total('50', '100', true) },
    ],
    status: {
      lastSyncAt: '2026-09-26T04:10:00.000Z',
      adProducts: [
        // SB hängt in einem Profil; SP ist nur in einem Profil anderer Zeitzone einen Tag älter (kein Alarm).
        { adProduct: SB, dataThrough: '2026-09-20', profilesWithoutData: 0, profilesBehind: 1 },
        { adProduct: SP, dataThrough: '2026-09-19', profilesWithoutData: 0, profilesBehind: 0 },
      ],
      sbCampaignsWithoutMetrics: 3,
    },
    fxRatesThrough: '2026-09-25',
    fxRatesStale: false,
    ...patch,
  } as DashboardData;
}

function series(): TimeSeriesData {
  const day = (date: string, cost: string) => ({ date, ...period(cost, '40') });
  return {
    meta: dashboard().meta,
    days: [day('2026-09-24', '10'), day('2026-09-25', '12')],
    comparisonDays: [],
    attribution: { mixed: false, sameSkuMixed: false, coverage: full },
    comparisonAttribution: null,
  } as TimeSeriesData;
}

const filterOptions = (profiles = true) => ({
  clients: [{ id: C1, name: 'Waldkauz (Demo)', slug: 'waldkauz' }],
  profiles: profiles
    ? [P1, P2].map((id, index) => ({
        id,
        amazonProfileId: `710000000000000${index}`,
        accountName: index === 0 ? 'Demo DE' : 'Demo IT',
        countryCode: index === 0 ? 'DE' : 'IT',
        currencyCode: 'EUR',
        timezone: 'Europe/Berlin',
        accountType: 'seller',
        clientId: index === 0 ? C1 : null,
      }))
    : [],
  currencies: ['EUR', 'USD'],
  fxRatesThrough: '2026-09-25',
  fxRatesStale: false,
});

type Route = Response | ((request: RecordedRequest) => Response | Promise<Response>);

function routes(overrides: Record<string, Route> = {}) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/shell/sidebar': json({ value: null }),
    'GET /api/settings/ui-state/analytics/filters': json({ value: null }),
    'PUT /api/settings/ui-state/analytics/filters': new Response(null, { status: 204 }),
    'POST /api/ads/filter-options': json(filterOptions()),
    'POST /api/ads/dashboard': json(dashboard()),
    'POST /api/ads/timeseries': json(series()),
    ...overrides,
  };
}

async function mountDashboard(path = '/dashboard') {
  const mounted = await mountWithApp(undefined, { path });
  await flushPromises();
  await vi.waitFor(() => expect(mounted.wrapper.find('[data-kpi-value]').exists()).toBe(true));
  return mounted;
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

const text = (wrapper: { text(): string }) => wrapper.text().replace(/\u00a0/g, ' ');

describe('DashboardPage', () => {
  it('KPI-Kacheln nach F11 mit Veränderung und „≈“ bei umgerechneten Beträgen', async () => {
    stubFetch(routes());
    const { wrapper } = await mountDashboard();
    const tiles = wrapper.findAll('article');
    const labels = tiles.map((tile) => tile.find('[data-kpi-label]').text());
    expect(labels).toEqual(expect.arrayContaining(['ACoS', 'ROAS', 'Käufe (Ads)', 'Klicks']));
    const acos = tiles.find((tile) => tile.find('[data-kpi-label]').text() === 'ACoS')!;
    expect(text(acos)).toContain('25,0 %');
    // ACoS gestiegen = schlecht
    expect(acos.find('[data-kpi-change]').attributes('data-tone')).toBe('negative');
    const clicks = tiles.find((tile) => tile.find('[data-kpi-label]').text() === 'Klicks')!;
    // CPC mit „≈“ (umgerechneter Betrag) und eigener Veränderung
    expect(text(clicks)).toContain('CPC ≈ 0,50 €');
    expect(clicks.findAll('[data-kpi-change]')).toHaveLength(2);
    // Hero: Spend und Umsatz, umgerechnet
    const hero = wrapper.find('[data-dashboard-hero]');
    expect(text(hero)).toContain('≈ 250,00 €');
    expect(text(hero)).toContain('≈ 1.000,00 €');
  });

  it('Hero-Kachel lädt die Tagesreihe mit entfernten Kampagnen (passt zur Dashboard-Summe)', async () => {
    const { requests } = stubFetch(routes());
    await mountDashboard();
    const timeseries = requests.find((r) => r.path === '/api/ads/timeseries');
    expect(timeseries?.body).toMatchObject({
      level: 'campaign',
      filter: { includeRemoved: true },
      period: expect.any(Object),
    });
    const dashboardRequest = requests.find((r) => r.path === '/api/ads/dashboard');
    expect(dashboardRequest?.body).toMatchObject({ currency: 'auto', attribution: 'console' });
  });

  it('gemischte Attribution an Umsatz, Käufen, ACoS und ROAS, nicht am Spend', async () => {
    stubFetch(routes());
    const { wrapper } = await mountDashboard();
    const mixed = 'button[aria-label="Hinweis anzeigen: Gemischte Attribution"]';
    const hero = wrapper.find('[data-dashboard-hero]');
    // Hero: nur am Umsatz
    expect(hero.findAll(mixed)).toHaveLength(1);
    const withHint = wrapper
      .findAll('article')
      .filter((tile) => tile.find(mixed).exists())
      .map((tile) => tile.find('[data-kpi-label]').text());
    expect(withHint).toEqual(['ACoS', 'ROAS', 'Käufe (Ads)']);
  });

  it('Anteil je Ad-Typ und Erklärung der SB-Preview-Lücke, sobald SB in der Auswahl ist', async () => {
    stubFetch(routes());
    const { wrapper } = await mountDashboard();
    const share = wrapper.find('[data-dashboard-ad-products]');
    expect(text(share)).toContain('Sponsored Products');
    expect(text(share)).toContain('80,0 %');
    // Umsatz je Ad-Typ als Betrag
    expect(text(share)).toContain('900,00 €');
    expect(text(share)).toContain('3 SB-Kampagnen ohne Kennzahlen');
  });

  it('ohne SB keine Erklärung der Preview-Lücke', async () => {
    stubFetch(
      routes({
        'POST /api/ads/dashboard': json(
          dashboard({
            byAdProduct: [dashboard().byAdProduct[0]!],
            status: { ...dashboard().status, sbCampaignsWithoutMetrics: 0, adProducts: [] },
          }),
        ),
      }),
    );
    const { wrapper } = await mountDashboard();
    expect(text(wrapper)).not.toContain('SB-Kampagne');
  });

  it('Datenstand: Daten bis, vorläufig, letzter Sync, Kurse bis, hängender Ad-Typ', async () => {
    stubFetch(routes());
    const { wrapper } = await mountDashboard();
    const status = text(wrapper.find('[data-dashboard-status]'));
    expect(status).toContain('25.09.2026');
    expect(status).toContain('12.09.2026');
    expect(status).toContain('Kurse bis');
    expect(status).toContain('Sponsored Brands: Daten bis 20.09.2026');
    expect(status).not.toContain('Sponsored Products: Daten bis');
    expect(status).not.toContain('älter als 5 Tage');
  });

  it('veraltete Kurse: Warnung', async () => {
    stubFetch(routes({ 'POST /api/ads/dashboard': json(dashboard({ fxRatesStale: true })) }));
    const { wrapper } = await mountDashboard();
    expect(text(wrapper.find('[data-dashboard-status]'))).toContain('älter als 5 Tage');
  });

  it('Tabelle je Client bzw. Profil mit Sprung in den Explorer', async () => {
    stubFetch(routes());
    const { wrapper } = await mountDashboard();
    const table = wrapper.find('[data-dashboard-breakdown]');
    expect(table.findAll('tbody tr').map((row) => row.find('th a').text())).toEqual([
      'Waldkauz (Demo)',
      'Ohne Client',
    ]);
    const link = table.find('tbody tr a');
    expect(link.attributes('href')).toBe(`/ads/explorer?clients=${C1}`);

    await table.find('[data-view="profile"]').trigger('click');
    await flushPromises();
    const rows = wrapper.findAll('[data-dashboard-breakdown] tbody tr');
    expect(rows.map((row) => row.find('th a').text())).toEqual(['Demo DE', 'Demo IT']);
    // Profil-IDs nie in der URL: Merker pf=1, die Auswahl steht im Verlaufseintrag.
    const profileLink = rows[0]!.find('a').attributes('href')!;
    expect(profileLink).toContain('pf=1');
    expect(profileLink).not.toContain(P1);
  });

  it('Tabelle sortierbar über die Spaltenköpfe (Decimal-Strings)', async () => {
    stubFetch(routes());
    const { wrapper } = await mountDashboard();
    const table = wrapper.find('[data-dashboard-breakdown]');
    const spend = table.find('button[aria-label="Sortieren nach Spend"]');
    await spend.trigger('click');
    await flushPromises();
    const names = () =>
      wrapper.findAll('[data-dashboard-breakdown] tbody tr').map((row) => row.find('th a').text());
    // erster Klick: absteigend (größter Spend zuerst)
    expect(names()).toEqual(['Waldkauz (Demo)', 'Ohne Client']);
    await spend.trigger('click');
    await flushPromises();
    expect(names()).toEqual(['Ohne Client', 'Waldkauz (Demo)']);
  });

  it('Fehler der Tagesreihe betrifft nur die Hero-Kachel', async () => {
    stubFetch(
      routes({
        'POST /api/ads/timeseries': json({ error: { code: 'SERVER', message: 'x' } }, 500),
      }),
    );
    const { wrapper } = await mountDashboard();
    await vi.waitFor(() =>
      expect(text(wrapper.find('[data-dashboard-hero]'))).toContain(
        'Der Tagesverlauf konnte nicht geladen werden.',
      ),
    );
    expect(wrapper.findAll('[role="alert"]')).toHaveLength(1);
    expect(text(wrapper.find('[data-dashboard-hero]'))).toContain('250,00 €');
  });

  it('Fehler der Kennzahlen: je Widget ein Fehler mit „Erneut versuchen“, Filter bleiben nutzbar', async () => {
    stubFetch(
      routes({
        'POST /api/ads/dashboard': json({ error: { code: 'SERVER', message: 'x' } }, 500),
      }),
    );
    const mounted = await mountWithApp(undefined, { path: '/dashboard' });
    await flushPromises();
    await vi.waitFor(() =>
      expect(mounted.wrapper.findAll('[role="alert"]').length).toBeGreaterThan(0),
    );
    expect(text(mounted.wrapper)).toContain('Die Kennzahlen konnten nicht geladen werden.');
    expect(text(mounted.wrapper)).toContain('Erneut versuchen');
    expect(mounted.wrapper.find('section[aria-label="Filter"]').exists()).toBe(true);
  });

  it('Filteroptionen nicht ladbar: keine ewigen Skeletons, der Fehler steht in der Filterleiste', async () => {
    stubFetch(
      routes({
        'POST /api/ads/filter-options': json({ error: { code: 'SERVER', message: 'x' } }, 500),
      }),
    );
    const { wrapper } = await mountWithApp(undefined, { path: '/dashboard' });
    await flushPromises();
    await vi.waitFor(() =>
      expect(text(wrapper)).toContain('Die Filter konnten nicht geladen werden.'),
    );
    expect(wrapper.find('[data-dashboard-hero]').exists()).toBe(false);
  });

  it('ohne sichtbare Profile: Hinweis mit Weg zu den Connections (Admin)', async () => {
    const { requests } = stubFetch(
      routes({ 'POST /api/ads/filter-options': json(filterOptions(false)) }),
    );
    const { wrapper } = await mountWithApp(undefined, { path: '/dashboard' });
    await flushPromises();
    await vi.waitFor(() => expect(text(wrapper)).toContain('Noch keine Amazon-Profile'));
    expect(wrapper.find('a[href="/admin/connections"]').exists()).toBe(true);
    expect(requests.some((r) => r.path === '/api/ads/dashboard')).toBe(false);
  });
});

describe('Gespeicherte Ansichten im Dashboard (F8)', () => {
  it('lädt die Filterleiste einer Ansicht und behält andere Parameter nicht', async () => {
    const { requests } = stubFetch(
      routes({
        'GET /api/saved-views': json({
          views: [
            {
              id: '00000000-0000-4000-8000-0000000000e2',
              name: 'Letzte Woche ohne Vergleich',
              area: 'dashboard',
              shared: false,
              owner: { id: 'user-1', name: 'Dominik' },
              own: true,
              canEdit: true,
              canShare: true,
              hiddenItems: 0,
              selectionHidden: false,
              outdated: false,
              createdAt: '2026-09-28T08:00:00.000Z',
              updatedAt: '2026-09-28T08:00:00.000Z',
              state: {
                filters: {
                  clientIds: [],
                  withoutClient: false,
                  profileIds: null,
                  period: { preset: 'lastWeek' },
                  comparison: 'off',
                  currency: 'EUR',
                  attribution: 'clicks14d',
                },
              },
            },
          ],
        }),
      }),
    );
    const { wrapper, router } = await mountDashboard();
    await wrapper.find('[data-saved-views]').trigger('click');
    await vi.waitFor(() =>
      expect(document.body.textContent).toContain('Letzte Woche ohne Vergleich'),
    );
    // Eigene Ansicht: Aktionen vorhanden
    expect(
      document.querySelector('[aria-label="„Letzte Woche ohne Vergleich“ löschen"]'),
    ).not.toBeNull();
    [...document.querySelectorAll<HTMLButtonElement>('[data-saved-view] button')]
      .find((b) => b.textContent?.includes('Letzte Woche'))!
      .click();
    await vi.waitFor(() =>
      expect(router.currentRoute.value.query).toEqual({
        period: 'lastWeek',
        cmp: 'off',
        cur: 'EUR',
        attr: 'clicks14d',
      }),
    );
    await vi.waitFor(() =>
      expect(requests.filter((r) => r.path === '/api/ads/dashboard').at(-1)?.body).toMatchObject({
        comparison: null,
        currency: 'EUR',
        attribution: 'clicks14d',
      }),
    );
  });
});
