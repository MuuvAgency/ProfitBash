import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import PrimeVue from 'primevue/config';
import { afterEach, describe, expect, it } from 'vitest';
import { i18n } from '../i18n';
import KpiTile from './KpiTile.vue';

afterEach(() => {
  document.body.innerHTML = '';
});

function mountTile(props: Record<string, unknown>) {
  setActivePinia(createPinia());
  return mount(KpiTile, {
    props: { label: 'Umsatz', metric: 'sales', value: '1.234,50 €', ...props },
    global: { plugins: [i18n, [PrimeVue, { unstyled: true }]] },
    attachTo: document.body,
  });
}

describe('KpiTile', () => {
  it('Beschriftung, Wert in Mono und Veränderung mit Farbe nach Bedeutung', () => {
    const wrapper = mountTile({ change: '0.124', comparisonValue: '1.098,00 €' });
    expect(wrapper.find('h3, [data-kpi-label]').text()).toBe('Umsatz');
    const value = wrapper.find('[data-kpi-value]');
    expect(value.text()).toBe('1.234,50 €');
    expect(value.classes()).toContain('font-data');
    const delta = wrapper.find('[data-kpi-change]');
    expect(delta.text()).toContain('+12,4');
    expect(delta.attributes('data-tone')).toBe('positive');
    expect(wrapper.text()).toContain('Vergleich: 1.098,00 €');
  });

  it('ACoS gestiegen ist schlecht, Spend gestiegen neutral', () => {
    expect(
      mountTile({ metric: 'acos', change: '0.05' })
        .find('[data-kpi-change]')
        .attributes('data-tone'),
    ).toBe('negative');
    expect(
      mountTile({ metric: 'cost', change: '0.05' })
        .find('[data-kpi-change]')
        .attributes('data-tone'),
    ).toBe('neutral');
  });

  it('ohne Vergleich keine Veränderung', () => {
    expect(mountTile({ change: null }).find('[data-kpi-change]').exists()).toBe(false);
  });

  it('Veränderung für Screenreader in Worten', () => {
    const delta = mountTile({ change: '-0.031' }).find('[data-kpi-change]');
    expect(delta.find('.sr-only').text()).toBe('gesunken um -3,1\u00a0%');
  });

  it('„≈“ vor umgerechneten Beträgen, Hinweis per Klick lesbar (auch auf Touch)', async () => {
    const wrapper = mountTile({ hints: [{ kind: 'approx' }] });
    expect(wrapper.find('[data-kpi-value]').text()).toBe('≈ 1.234,50 €');
    const button = wrapper.find('button[aria-label="Hinweis anzeigen: Umgerechnet"]');
    expect(button.exists()).toBe(true);
    await button.trigger('click');
    await flushPromises();
    expect(document.body.textContent).toContain('EZB-Kurs');
  });

  it('Hinweise gemischte Attribution und fehlender Wert', () => {
    const wrapper = mountTile({
      value: '–',
      hints: [{ kind: 'mixedAttribution' }, { kind: 'missingValue' }],
    });
    const labels = wrapper.findAll('button').map((b) => b.attributes('aria-label'));
    expect(labels).toEqual([
      'Hinweis anzeigen: Gemischte Attribution',
      'Hinweis anzeigen: Wert fehlt',
    ]);
  });

  it('Ladezustand als Skeleton in Kachelform', () => {
    const wrapper = mountTile({ loading: true });
    expect(wrapper.find('[data-kpi-value]').exists()).toBe(false);
    expect(wrapper.attributes('aria-busy')).toBe('true');
  });
});
