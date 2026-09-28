import {
  BarSeriesModule,
  CrossLinesModule,
  LegendModule,
  LineSeriesModule,
  LocaleModule,
  ModuleRegistry,
  NumberAxisModule,
  UnitTimeAxisModule,
} from 'ag-charts-community';

/**
 * AG Charts Community (ADR 001) mit nur den Modulen, die die Charts der App nutzen: Tagesverlauf als Balken und Linie
 * auf Tagesachse (`unit-time`, ein Band je Tag) und Zahlenachse, Bereich für vorläufige Tage (`CrossLinesModule`), Legende und deutsches Locale.
 */
ModuleRegistry.registerModules([
  BarSeriesModule,
  LineSeriesModule,
  NumberAxisModule,
  UnitTimeAxisModule,
  CrossLinesModule,
  LegendModule,
  LocaleModule,
]);
