import { flushPromises, mount } from '@vue/test-utils';
import type { GridApi, GridReadyEvent } from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { gridLocaleText, gridStyleOptions, gridTheme } from './grid';

interface Row {
  id: string;
  name: string;
  cost: string | null;
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.restoreAllMocks();
});

async function mountGrid(rowData: Row[]) {
  let api: GridApi<Row> | undefined;
  const wrapper = mount(
    {
      render: () =>
        h(AgGridVue, {
          theme: gridTheme,
          themeCssLayer: gridStyleOptions.themeCssLayer,
          themeStyleContainer: gridStyleOptions.themeStyleContainer,
          localeText: gridLocaleText,
          rowData,
          columnDefs: [
            { field: 'name', sortable: true, filter: 'agTextColumnFilter' },
            { field: 'cost', sortable: true },
          ],
          pinnedBottomRowData: [{ id: 'total', name: 'Summe', cost: '3' }],
          domLayout: 'autoHeight',
          getRowId: ({ data }: { data: unknown }) => (data as Row).id,
          onGridReady: (event: GridReadyEvent<Row>) => (api = event.api),
        }),
    },
    { attachTo: document.body },
  );
  await flushPromises();
  await vi.waitFor(() => expect(api).toBeDefined());
  return { wrapper, api: api! };
}

describe('AG Grid (Community, nur registrierte Module)', () => {
  it('zeigt deutsche Texte über das LocaleModule', async () => {
    expect(gridLocaleText.noRowsToShow).toBe('Keine Zeilen zum Anzeigen');
    const { wrapper } = await mountGrid([]);
    await vi.waitFor(() => expect(wrapper.text()).toContain('Keine Zeilen zum Anzeigen'));
  });

  it('Sortieren, Textfilter, Summenzeile und CSV-Export ohne Warnung zu fehlenden Modulen', async () => {
    const warn = vi.spyOn(console, 'warn');
    const error = vi.spyOn(console, 'error');
    const { api } = await mountGrid([
      { id: 'a', name: 'Kampagne B', cost: '2' },
      { id: 'b', name: 'Kampagne A', cost: '1' },
    ]);
    api.applyColumnState({ state: [{ colId: 'name', sort: 'asc' }] });
    await api.setColumnFilterModel('name', { type: 'contains', filter: 'Kampagne' });
    api.onFilterChanged();
    const csv = api.getDataAsCsv();
    expect(csv).toContain('"Kampagne A"');
    expect(api.getPinnedBottomRowCount()).toBe(1);
    const messages = [...warn.mock.calls, ...error.mock.calls].flat().join('\n');
    expect(messages).not.toMatch(/AG Grid/);
  });
});
