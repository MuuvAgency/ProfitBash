import { flushPromises } from '@vue/test-utils';
import DatePicker from 'primevue/datepicker';
import Select from 'primevue/select';
import TreeSelect from 'primevue/treeselect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { defineComponent, h, type PropType } from 'vue';
import { json, stubFetch } from '../test/fetch-stub';
import { meFixture } from '../test/fixtures';
import { cleanupMounted, mountWithApp } from '../test/mount';
import FilterBar from './FilterBar.vue';
import { useAnalyticsFilters } from './useAnalyticsFilters';

const C1 = '00000000-0000-4000-8000-0000000000c1';
const P1 = '00000000-0000-4000-8000-0000000000a1';
const P2 = '00000000-0000-4000-8000-0000000000a2';
const P3 = '00000000-0000-4000-8000-0000000000a3';

const profile = (id: string, name: string, clientId: string | null) => ({
  id,
  amazonProfileId: '71000000000000' + id.slice(-2),
  accountName: name,
  countryCode: 'DE',
  currencyCode: 'EUR',
  timezone: 'Europe/Berlin',
  accountType: 'seller',
  clientId,
});

const filterOptions = {
  clients: [{ id: C1, name: 'Waldkauz (Demo)', slug: 'waldkauz' }],
  profiles: [profile(P1, 'Demo DE', C1), profile(P2, 'Demo FR', C1), profile(P3, 'Demo IT', null)],
  currencies: ['EUR', 'GBP', 'USD'],
  fxRatesThrough: '2026-09-25',
  fxRatesStale: false,
};

function routes(options: Response = json(filterOptions)) {
  return {
    'GET /api/me': json(meFixture()),
    'GET /api/settings/ui-state/analytics/filters': json({ value: null }),
    'PUT /api/settings/ui-state/analytics/filters': new Response(null, { status: 204 }),
    'POST /api/ads/filter-options': options,
  };
}

const Host = defineComponent({
  props: { earliestDate: { type: String as PropType<string | null>, default: null } },
  setup(props) {
    const filters = useAnalyticsFilters();
    return () => h(FilterBar, { filters, earliestDate: props.earliestDate });
  },
});

async function mountBar(path = '/dashboard', earliestDate: string | null = '2026-01-01') {
  const mounted = await mountWithApp(defineComponent({ render: () => h(Host, { earliestDate }) }), {
    path,
  });
  await flushPromises();
  return mounted;
}

afterEach(() => {
  cleanupMounted();
  vi.unstubAllGlobals();
});

describe('FilterBar', () => {
  it('zeigt alle Felder mit sichtbarer Beschriftung', async () => {
    stubFetch(routes());
    const { wrapper } = await mountBar();
    const labels = wrapper.findAll('label').map((label) => label.text());
    expect(labels).toEqual([
      'Clients und Profile',
      'Zeitraum',
      'Vergleich',
      'Währung',
      'Attribution',
    ]);
    // Jede Beschriftung gehört zu einem Feld.
    for (const label of wrapper.findAll('label')) {
      expect(document.getElementById(label.attributes('for')!)).not.toBeNull();
    }
    expect(wrapper.text()).toContain('Alle Profile');
  });

  it('Zeitraum wählen schreibt die URL', async () => {
    stubFetch(routes());
    const { wrapper, router } = await mountBar();
    const period = wrapper.findAllComponents(Select)[0]!;
    expect(period.props('options')).toHaveLength(14);
    period.vm.$emit('update:modelValue', 'last7');
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({ period: 'last7' });
  });

  it('„Frei wählen“ zeigt die Datumsauswahl und übernimmt den Bereich', async () => {
    stubFetch(routes());
    const { wrapper, router } = await mountBar(
      '/dashboard?period=custom&from=2026-05-01&to=2026-05-31',
    );
    const picker = wrapper.findComponent(DatePicker);
    expect(picker.exists()).toBe(true);
    picker.vm.$emit('update:modelValue', [new Date(2026, 5, 1), new Date(2026, 5, 14)]);
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({
      period: 'custom',
      from: '2026-06-01',
      to: '2026-06-14',
    });
  });

  it('nur ein Ende gewählt: URL bleibt, bis der Bereich vollständig ist', async () => {
    stubFetch(routes());
    const { wrapper, router } = await mountBar(
      '/dashboard?period=custom&from=2026-05-01&to=2026-05-31',
    );
    wrapper.findComponent(DatePicker).vm.$emit('update:modelValue', [new Date(2026, 5, 1), null]);
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({ from: '2026-05-01', to: '2026-05-31' });
  });

  it('Vorjahr ist gesperrt, solange Daten dafür fehlen', async () => {
    stubFetch(routes());
    const { wrapper } = await mountBar('/dashboard', '2026-06-01');
    const comparison = wrapper.findAllComponents(Select)[1]!;
    const options = comparison.props('options') as { value: string; disabled: boolean }[];
    expect(options.find((o) => o.value === 'previousYear')?.disabled).toBe(true);
    expect(options.find((o) => o.value === 'previous')?.disabled).toBe(false);
  });

  it('Währung: automatisch und die wählbaren Währungen', async () => {
    stubFetch(routes());
    const { wrapper, router } = await mountBar();
    const currency = wrapper.findAllComponents(Select)[2]!;
    expect((currency.props('options') as { value: string }[]).map((o) => o.value)).toEqual([
      'auto',
      'EUR',
      'GBP',
      'USD',
    ]);
    currency.vm.$emit('update:modelValue', 'GBP');
    await flushPromises();
    expect(router.currentRoute.value.query).toMatchObject({ cur: 'GBP' });
  });

  it('Clients und Profile: Baum mit „Ohne Client“; Teilauswahl setzt Clients und Merker', async () => {
    stubFetch(routes());
    const { wrapper, router } = await mountBar();
    const tree = wrapper.findComponent(TreeSelect);
    const nodes = tree.props('options') as { key: string; label: string; children: unknown[] }[];
    expect(nodes.map((n) => [n.label, n.children.length])).toEqual([
      ['Waldkauz (Demo)', 2],
      ['Ohne Client', 1],
    ]);
    tree.vm.$emit('update:modelValue', {
      [`client:${C1}`]: { checked: false, partialChecked: true },
      [`profile:${P1}`]: { checked: true, partialChecked: false },
    });
    await flushPromises();
    expect(router.currentRoute.value.query).toEqual({ clients: C1, pf: '1' });
    expect(wrapper.text()).toContain('1 Profil');
  });

  it('Filter nicht ladbar: Fehler mit „Erneut versuchen“', async () => {
    stubFetch(routes(json({ error: { code: 'SERVER', message: 'x' } }, 500)));
    const { wrapper } = await mountBar();
    expect(wrapper.find('[role="alert"]').text()).toContain(
      'Die Filter konnten nicht geladen werden.',
    );
    expect(wrapper.text()).toContain('Erneut versuchen');
  });
});
