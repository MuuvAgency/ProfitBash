import type { ColumnResizedEvent, GridApi, GridReadyEvent } from 'ag-grid-community';
import { computed, ref } from 'vue';

/**
 * Mindestbreite eines Grids = Breiten der festen Spalten + Mindestbreiten der Flex-Spalten. Als Stil am
 * Grid: Darunter scrollt die Tabelle in ihrem Container, statt Spalten zu beschneiden, und keine Zahl im
 * Container muss den Spalten nachgeführt werden.
 */
export function useGridMinWidth() {
  const minWidth = ref<number>();

  function update(api: GridApi) {
    if (api.isDestroyed()) return;
    minWidth.value = api
      .getAllDisplayedColumns()
      .reduce(
        (sum, column) => sum + (column.getFlex() ? column.getMinWidth() : column.getActualWidth()),
        0,
      );
  }

  const style = computed(() => (minWidth.value ? { minWidth: `${minWidth.value}px` } : undefined));

  return {
    style,
    update,
    onGridReady: ({ api }: GridReadyEvent) => update(api),
    onColumnResized: ({ api, finished }: ColumnResizedEvent) => {
      if (finished) update(api);
    },
  };
}

/**
 * Obergrenze der Mindestbreite für Tabellen, die ohne waagerechtes Scrollen passen sollen (Sync-Status, Profiltabelle;
 * `phase-2.md` F14): Bei 1440 px mit ausgeklappter Sidebar und klassischer Scrollbar (15 px) bleiben 1113 px für den
 * Inhalt (gemessen in 2.12), Windows-Scrollbars sind 17 px breit; dazu etwas Reserve.
 */
export const FIT_WIDTH_AT_1440 = 1080;
