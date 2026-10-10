import type { EntityPeriodMetric } from '@profitbash/db';
import { normalizeHeader, parseBulkAmount } from './bulk-columns';
import { parseBulkCount } from './bulk-search-terms';

/**
 * Kennzahlen der Kampagnen-Blätter (`phase-5.md` 5.1): Summen über den Download-Zeitraum je Zeile (Kampagne,
 * Ad Group, Target, Anzeige, Platzierung). Abgeleitete Spalten (Klickrate, Conversion-Rate, ACOS, CPC, ROAS)
 * werden nicht gelesen, sondern später berechnet.
 *
 * `normalizeHeader` schneidet Klammerzusätze ab; „Sales (Views & Clicks)“ würde so zu „Sales“. Die SD-Spalten
 * mit Views werden deshalb am Zusatz erkannt, bevor normalisiert wird.
 */

export type MetricColumn =
  | 'impressions'
  | 'clicks'
  | 'cost'
  | 'sales'
  | 'purchases'
  | 'units'
  | 'viewableImpressions'
  | 'salesViewsClicks'
  | 'purchasesViewsClicks'
  | 'unitsViewsClicks';

export type MetricValues = Omit<
  EntityPeriodMetric,
  'level' | 'amazonCampaignId' | 'amazonEntityId'
>;

/** Englisch laut echter Datei, Deutsch laut Befund 1.11 (Zusatz „(Aufrufe und Klicks)“ ungeprüft). */
const ALIASES: Record<'plain' | 'views', Partial<Record<MetricColumn, readonly string[]>>> = {
  plain: {
    impressions: ['Impressions'],
    clicks: ['Clicks', 'Klicks'],
    cost: ['Spend', 'Ausgaben'],
    sales: ['Sales', 'Verkäufe'],
    purchases: ['Orders', 'Bestellungen'],
    units: ['Units', 'Einheiten'],
    viewableImpressions: ['Viewable Impressions', 'Sichtbare Impressions'],
  },
  views: {
    salesViewsClicks: ['Sales', 'Verkäufe'],
    purchasesViewsClicks: ['Orders', 'Bestellungen'],
    unitsViewsClicks: ['Units', 'Einheiten'],
  },
};

const VIEWS_SUFFIX = /\((views\s*(&|and|und)\s*clicks|aufrufe\s+und\s+klicks)\)\s*$/i;

const BY_HEADER = (kind: 'plain' | 'views') =>
  new Map(
    Object.entries(ALIASES[kind]).flatMap(([column, aliases]) =>
      aliases!.map((alias) => [normalizeHeader(alias), column as MetricColumn] as const),
    ),
  );
const PLAIN = BY_HEADER('plain');
const VIEWS = BY_HEADER('views');

/** Diese Spalten müssen alle da sein, sonst trägt das Blatt keine Kennzahlen (Leistungsdaten abgewählt). */
const REQUIRED: readonly MetricColumn[] = [
  'impressions',
  'clicks',
  'cost',
  'sales',
  'purchases',
  'units',
];

/** Spalten der Kennzahlen laut Kopfzeile; `null`, wenn eine Pflichtspalte fehlt. */
export function mapMetricHeader(header: readonly string[]): Map<MetricColumn, number> | null {
  const result = new Map<MetricColumn, number>();
  header.forEach((text, index) => {
    const views = VIEWS_SUFFIX.test(text.replace(/[   ]/g, ' ').trim());
    const column = (views ? VIEWS : PLAIN).get(normalizeHeader(text));
    if (column && !result.has(column)) result.set(column, index);
  });
  return REQUIRED.every((column) => result.has(column)) ? result : null;
}

/**
 * Kennzahlen einer Zeile: `null`, wenn alle Pflichtzellen leer sind; `'invalid'`, wenn eine Zelle nicht lesbar ist
 * oder nur ein Teil gefüllt ist.
 */
export function parseMetricCells(
  cells: readonly string[],
  columns: ReadonlyMap<MetricColumn, number>,
): MetricValues | null | 'invalid' {
  const text = (column: MetricColumn) => {
    const index = columns.get(column);
    return index === undefined ? '' : (cells[index] ?? '').trim();
  };
  if (REQUIRED.every((column) => text(column) === '')) return null;
  const invalid = Symbol('invalid');
  const check = <T>(result: T | null | 'invalid', required: boolean): T | null => {
    if (result === 'invalid' || (required && result === null)) throw invalid;
    return result;
  };
  const count = (column: MetricColumn, required: boolean) =>
    check(parseBulkCount(text(column)), required);
  const amount = (column: MetricColumn, required: boolean) =>
    check(parseBulkAmount(text(column)), required);
  try {
    return {
      impressions: count('impressions', true)!,
      clicks: count('clicks', true)!,
      cost: amount('cost', true)!,
      sales: amount('sales', true)!,
      purchases: count('purchases', true)!,
      units: count('units', true)!,
      viewableImpressions: count('viewableImpressions', false),
      salesViewsClicks: amount('salesViewsClicks', false),
      purchasesViewsClicks: count('purchasesViewsClicks', false),
      unitsViewsClicks: count('unitsViewsClicks', false),
    };
  } catch (error) {
    if (error === invalid) return 'invalid';
    throw error;
  }
}
