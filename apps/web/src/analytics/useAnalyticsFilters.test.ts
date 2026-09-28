import { flushPromises } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h } from 'vue';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';
import { DEFAULT_FILTER_STATE, type FilterState } from './filters';
import { useAnalyticsFilters } from './useAnalyticsFilters';

const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const HIDDEN = '00000000-0000-4000-8000-0000000000ff';

const filterOptions = {
  clients: [
    { id: C1, name: 'Waldkauz', slug: 'waldkauz' },
    { id: C2, name: 'Lumen', slug: 'lumen' },
  ],
  profiles: [P1, P2].map((id, index) => ({
    id,
    amazonProfileId: `7100000000000000${index}`,
    accountName: `Demo ${index}`,
    countryCode: 'DE',
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
    accountType: 'seller',
    clientId: index === 0 ? C1 : C2,
  })),
  currencies: ['EUR', 'USD'],
  fxRatesThrough: '2026-09-25',
  fxRatesStale: false,
};

let filters: ReturnType<typeof useAnalyticsFilters>;
const Probe = defineComponent({
  setup() {
    filters = useAnalyticsFilters();
    return () => h('div');
  },
});

function routes(stored: unknown) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/analytics/filters': json({ value: stored }),
    'PUT /api/settings/ui-state/analytics/filters': new Response(null, { status: 204 }),
    'POST /api/ads/filter-options': json(filterOptions),
  };
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('useAnalyticsFilters', () => {
  it('ohne Filter in der URL: letzte Auswahl, kurz in die URL übernommen', async () => {
    const stored: FilterState = {
      ...DEFAULT_FILTER_STATE,
      clientIds: [C1],
      profileIds: [P1],
      comparison: 'off',
    };
    stubFetch(routes(stored));
    const { router } = await mountWithApp(Probe, { path: '/dashboard' });
    await flushPromises();

    expect(filters.ready.value).toBe(true);
    expect(filters.state.value).toEqual(stored);
    expect(router.currentRoute.value.query).toEqual({ clients: C1, pf: '1', cmp: 'off' });
    expect(filters.query.value).toMatchObject({
      clientIds: [C1],
      profileIds: [P1],
      comparison: null,
    });
  });

  it('Filter in der URL haben Vorrang; unsichtbare IDs fallen weg', async () => {
    stubFetch(routes(null));
    await mountWithApp(Probe, { path: `/dashboard?clients=${C2},${HIDDEN}&cur=USD` });
    await flushPromises();
    expect(filters.state.value).toMatchObject({ clientIds: [C2], currency: 'USD' });
    expect(filters.query.value.clientIds).toEqual([C2]);
  });

  it('update schreibt URL (neuer Verlaufseintrag) und ui_state mit den Profilen', async () => {
    const { requests } = stubFetch(routes(null));
    const { router } = await mountWithApp(Probe, { path: '/dashboard?level=campaign' });
    await flushPromises();
    const push = vi.spyOn(router, 'push');

    filters.update({ clientIds: [C1], profileIds: [P1], period: { preset: 'last7' } });
    await flushPromises();

    expect(push).toHaveBeenCalledOnce();
    expect(router.currentRoute.value.query).toEqual({
      level: 'campaign',
      clients: C1,
      pf: '1',
      period: 'last7',
    });
    const put = requests.find((r) => r.method === 'PUT');
    expect(put?.body).toEqual({
      value: {
        ...DEFAULT_FILTER_STATE,
        clientIds: [C1],
        profileIds: [P1],
        period: { preset: 'last7' },
      },
    });
  });

  it('gespeicherte Auswahl nicht ladbar: Standard, Seite bleibt nutzbar', async () => {
    stubFetch({
      ...routes(null),
      'GET /api/settings/ui-state/analytics/filters': json(
        { error: { code: 'SERVER', message: 'x' } },
        500,
      ),
    });
    await mountWithApp(Probe, { path: '/dashboard' });
    await flushPromises();
    expect(filters.ready.value).toBe(true);
    expect(filters.state.value).toEqual(DEFAULT_FILTER_STATE);
  });
});
