import { compareDecimalNullsLast } from '@profitbash/shared';
import { flushPromises, mount } from '@vue/test-utils';
import type { GridApi, GridReadyEvent } from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h, markRaw } from 'vue';
import { gridLocaleText, gridStyleOptions, gridTheme } from '../grid/grid';
import { i18n } from '../i18n';
import DecimalFilter from './DecimalFilter.vue';

interface Row {
  id: string;
  cost: string | null;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountGrid(rowData: Row[]) {
  let api: GridApi<Row> | undefined;
  mount(
    {
      render: () =>
        h(AgGridVue, {
          theme: gridTheme,
          themeCssLayer: gridStyleOptions.themeCssLayer,
          themeStyleContainer: gridStyleOptions.themeStyleContainer,
          localeText: gridLocaleText,
          rowData,
          columnDefs: [
            { field: 'id' },
            {
              colId: 'cost',
              valueGetter: ({ data }: { data?: Row }) => data?.cost ?? null,
              comparator: compareDecimalNullsLast,
              filter: markRaw(DecimalFilter),
            },
            {
              colId: 'acos',
              valueGetter: ({ data }: { data?: Row }) => data?.cost ?? null,
              filter: markRaw(DecimalFilter),
              filterParams: { scale: 2 },
            },
          ],
          domLayout: 'autoHeight',
          getRowId: ({ data }: { data: unknown }) => (data as Row).id,
          onGridReady: (event: GridReadyEvent<Row>) => (api = event.api),
        }),
    },
    { attachTo: document.body, global: { plugins: [i18n] } },
  );
  await flushPromises();
  await vi.waitFor(() => expect(api).toBeDefined());
  return api!;
}

const ids = (api: GridApi<Row>) => {
  const result: string[] = [];
  for (let i = 0; i < api.getDisplayedRowCount(); i++)
    result.push(api.getDisplayedRowAtIndex(i)!.id!);
  return result;
};

describe('DecimalFilter (Beträge ohne number, F7)', () => {
  it('filtert nach mindestens/höchstens als Decimal-String, fehlende Werte fallen heraus', async () => {
    const warn = vi.spyOn(console, 'warn');
    const api = await mountGrid([
      { id: 'a', cost: '9007199254740993' },
      { id: 'b', cost: '9007199254740992' },
      { id: 'c', cost: '0.1' },
      { id: 'd', cost: null },
    ]);
    await api.setColumnFilterModel('cost', { min: '9007199254740993' });
    api.onFilterChanged();
    await vi.waitFor(() => expect(ids(api)).toEqual(['a']));

    // Deutsches Komma wird angenommen.
    await api.setColumnFilterModel('cost', { min: '0,05', max: '1' });
    api.onFilterChanged();
    await vi.waitFor(() => expect(ids(api)).toEqual(['c']));

    await api.setColumnFilterModel('cost', null);
    api.onFilterChanged();
    await vi.waitFor(() => expect(ids(api)).toEqual(['a', 'b', 'c', 'd']));
    expect(warn.mock.calls.flat().join('\n')).not.toMatch(/AG Grid/);
  });

  it('Anteile: Eingabe in Prozent (scale 2), verglichen ohne number', async () => {
    const api = await mountGrid([
      { id: 'a', cost: '0.25' },
      { id: 'b', cost: '0.31' },
      { id: 'c', cost: '0.3' },
    ]);
    await api.setColumnFilterModel('acos', { min: '30' });
    api.onFilterChanged();
    await vi.waitFor(() => expect(ids(api)).toEqual(['b', 'c']));
  });
});
