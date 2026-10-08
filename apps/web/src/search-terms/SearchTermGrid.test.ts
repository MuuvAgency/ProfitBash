import { flushPromises, mount } from '@vue/test-utils';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Component } from 'vue';
import SearchTermGrid from './SearchTermGrid.vue';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('SearchTermGrid', () => {
  it('meldet, ab wann exportiert werden kann (vorher wäre die Datei leer)', async () => {
    // Generische Komponente: Die Zeilenform ergibt sich erst aus den Props.
    const wrapper = mount(SearchTermGrid as Component, {
      props: {
        rows: [{ id: 'a', gram: 'lampe' }],
        columnDefs: [{ colId: 'gram', field: 'gram', headerName: 'Wortbaustein' }],
      },
      attachTo: document.body,
    });
    const grid = wrapper.vm as unknown as { ready: boolean; csv: () => string };
    await flushPromises();
    await vi.waitFor(() => expect(grid.ready).toBe(true));
    expect(grid.csv()).toBe('"Wortbaustein"\r\n"lampe"');
    wrapper.unmount();
  });
});
