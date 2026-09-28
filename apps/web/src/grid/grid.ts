import { AG_GRID_LOCALE_DE } from '@ag-grid-community/locale';
import {
  CellStyleModule,
  ClientSideRowModelModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  CsvExportModule,
  CustomFilterModule,
  LocaleModule,
  ModuleRegistry,
  PinnedRowModule,
  RowAutoHeightModule,
  RowStyleModule,
  TextFilterModule,
  themeQuartz,
  ValidationModule,
} from 'ag-grid-community';

/**
 * AG Grid Community (ADR 001). Nur die Module, die die App nutzt, damit das Bundle klein bleibt.
 * Sortieren gehört zum Kern. Für den Explorer (`phase-2.md` F6/F7): Textfilter, eigene Filter (Beträge als
 * Decimal-Strings, ohne `number`), Summenzeile (angeheftete Zeile) und CSV-Export. Nicht registriert sind u. a.
 * `TooltipModule` und `RenderApiModule`: Tooltips kommen von PrimeVue. Braucht eine Tabelle mehr, hier ergänzen;
 * in der Entwicklung meldet das `ValidationModule` fehlende Module in der Konsole.
 */
ModuleRegistry.registerModules([
  ClientSideRowModelModule,
  RowStyleModule,
  CellStyleModule,
  ColumnApiModule,
  ColumnAutoSizeModule,
  RowAutoHeightModule,
  LocaleModule,
  TextFilterModule,
  CustomFilterModule,
  PinnedRowModule,
  CsvExportModule,
  ...(import.meta.env.DEV ? [ValidationModule] : []),
]);

/** Deutsche Texte des Grids (Filter, Sortierung, leere Tabelle), Paket `@ag-grid-community/locale`. */
export const gridLocaleText: Record<string, string> = AG_GRID_LOCALE_DE;

/**
 * Grid-Styles liegen im CSS-Layer `ag-grid` (Reihenfolge in src/styles/main.css), damit Tailwind-Utilities
 * sie überschreiben können. AG Grid setzt seine Styles sonst an den Anfang von <head>: Dann entstünde der
 * Layer vor allen anderen, und Tailwinds Preflight nähme den Zellen das Padding. Deshalb in den <body>.
 */
export const gridStyleOptions = {
  themeCssLayer: 'ag-grid',
  themeStyleContainer: () => document.body,
};

/**
 * Grid-Theme aus den Design-Tokens (CSS-Variablen aus src/styles/main.css). Hell und dunkel
 * wechseln dadurch mit der Klasse `.dark`, ohne ein zweites Theme.
 * Zebra über „Well Sunken“, nur die Kopfzeile bekommt eine feine Linie (DESIGN.md §4).
 */
export const gridTheme = themeQuartz.withParams({
  fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-body-md)',
  headerFontSize: 'var(--text-label-eyebrow)',
  headerFontWeight: 700,
  backgroundColor: 'var(--color-tile)',
  foregroundColor: 'var(--color-ink)',
  chromeBackgroundColor: 'var(--color-tile)',
  headerTextColor: 'var(--color-ink-secondary)',
  oddRowBackgroundColor: 'var(--color-well)',
  borderColor: 'var(--color-line)',
  accentColor: 'var(--color-violet)',
  wrapperBorder: false,
  wrapperBorderRadius: 0,
  rowBorder: false,
  columnBorder: false,
  headerRowBorder: true,
});
