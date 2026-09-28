import {
  BarSeriesModule,
  CrossLinesModule,
  LegendModule,
  LineSeriesModule,
  LocaleModule,
  ModuleRegistry,
  NumberAxisModule,
  TimeAxisModule,
} from 'ag-charts-community';

/**
 * AG Charts Community (ADR 001) mit nur den Modulen, die die Charts der App nutzen: Tagesverlauf als Balken und Linie
 * auf Zeit- und Zahlenachse, Bereich für vorläufige Tage (`CrossLinesModule`), Legende und deutsches Locale.
 */
ModuleRegistry.registerModules([
  BarSeriesModule,
  LineSeriesModule,
  NumberAxisModule,
  TimeAxisModule,
  CrossLinesModule,
  LegendModule,
  LocaleModule,
]);
