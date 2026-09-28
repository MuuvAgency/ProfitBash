import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { defineComponent } from 'vue';
import { i18n } from '../i18n';
import TimeSeriesChart from './TimeSeriesChart.vue';

// AG Charts zeichnet auf Canvas (fehlt in happy-dom); geprüft werden die übergebenen Optionen.
const { AgChartsStub } = vi.hoisted(() => ({
  AgChartsStub: {} as ReturnType<typeof defineComponent>,
}));
vi.mock('ag-charts-vue3', async () => {
  const { defineComponent: define, h: render } = await import('vue');
  Object.assign(
    AgChartsStub,
    define({
      name: 'AgChartsStub',
      props: { options: { type: Object, required: true } },
      setup: () => () => render('div', { 'data-stub': 'ag-charts' }),
    }),
  );
  return { AgCharts: AgChartsStub };
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

function mountChart() {
  setActivePinia(createPinia());
  return mount(TimeSeriesChart, {
    props: {
      label: 'Spend und Umsatz je Tag',
      points: [{ day: '2026-09-01', values: { cost: '1234.5' } }],
      series: [
        { key: 'cost', label: 'Spend', kind: 'bar', axis: 'left', format: (v: string) => v },
      ],
      provisionalFrom: '2026-09-01',
    },
    global: { plugins: [i18n] },
  });
}

describe('TimeSeriesChart', () => {
  it('beschreibt den Chart für Screenreader', () => {
    const wrapper = mountChart();
    expect(wrapper.attributes('role')).toBe('img');
    expect(wrapper.attributes('aria-label')).toBe('Spend und Umsatz je Tag');
  });

  it('deutsches Chart-Locale, Achsen formatiert über die Helper, vorläufige Tage markiert', () => {
    const options = mountChart().findComponent({ name: 'AgChartsStub' }).props('options') as {
      locale: { localeText: Record<string, string> };
      axes: {
        x: { crossLines: { label: { text: string } }[] };
        left: { label: { formatter: (p: { value: number }) => string } };
      };
    };
    expect(options.locale.localeText.overlayNoData).toBe('Keine Daten zum Anzeigen');
    expect(options.axes.left.label.formatter({ value: 12000 })).toBe('12.000');
    expect(options.axes.x.crossLines[0]!.label.text).toBe('Vorläufig');
  });
});
