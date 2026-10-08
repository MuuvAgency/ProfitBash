import { flushPromises, mount } from '@vue/test-utils';
import type { GridApi, GridReadyEvent } from 'ag-grid-community';
import { AgGridVue } from 'ag-grid-vue3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { h } from 'vue';
import { csvSafe, fileNamePart, gridCsv } from './csv';
import './grid';

afterEach(() => {
  document.body.innerHTML = '';
});

describe('gridCsv', () => {
  it('schreibt den Hinweis als ein Feld in Anführungszeichen vor die Kopfzeile', async () => {
    let api: GridApi | undefined;
    mount(
      {
        render: () =>
          h(AgGridVue, {
            rowData: [{ id: 'a', name: 'Kampagne A' }],
            columnDefs: [{ field: 'name' }],
            domLayout: 'autoHeight',
            onGridReady: (event: GridReadyEvent) => (api = event.api),
          }),
      },
      { attachTo: document.body },
    );
    await flushPromises();
    await vi.waitFor(() => expect(api).toBeDefined());
    // Komma, Anführungszeichen und Zeilenumbruch (AG Grid schreibt ihn als CRLF) bleiben in dem einen Feld.
    expect(gridCsv(api!, 'Hinweis: nur „A", B und\nC')).toBe(
      '"Hinweis: nur „A"", B und\r\nC"\r\n"Name"\r\n"Kampagne A"',
    );
    expect(gridCsv(api!)).toBe('"Name"\r\n"Kampagne A"');
  });
});

describe('csvSafe', () => {
  it('entschärft Formeln in Texten, lässt Decimal-Strings und normale Texte', () => {
    expect(csvSafe('=HYPERLINK("x")')).toBe('\'=HYPERLINK("x")');
    expect(csvSafe('+49 Lampe')).toBe("'+49 Lampe");
    expect(csvSafe('@home')).toBe("'@home");
    expect(csvSafe('-0.1')).toBe('-0.1');
    expect(csvSafe('-rabatt')).toBe("'-rabatt");
    expect(csvSafe('Lampe')).toBe('Lampe');
  });
});

describe('fileNamePart', () => {
  it('macht aus freiem Text einen Teil eines Dateinamens', () => {
    expect(fileNamePart('Demo DE')).toBe('demo-de');
    expect(fileNamePart('  Müller & Söhne GmbH / UK ')).toBe('muller-sohne-gmbh-uk');
    expect(fileNamePart('../..\\x:y')).toBe('x-y');
  });
});
