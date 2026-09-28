import type { Coverage } from './metrics';

/**
 * Attribution nach `docs/tasks/phase-2.md` F4 (Tabelle dort, Details in `phase-1.md` 1.9): welche Kennzahl-Spalte
 * je Ad-Typ, Ebene, Kontotyp und Einstellung für Umsatz, Käufe und Einheiten gilt, und ob eine Summe
 * gemischte Attribution enthält oder Werte fehlen.
 */

export const AD_PRODUCTS = ['SPONSORED_PRODUCTS', 'SPONSORED_BRANDS', 'SPONSORED_DISPLAY'] as const;
export type AdProduct = (typeof AD_PRODUCTS)[number];

/** Ebenen der Kennzahl-Tabellen (wie `AmazonAdsMetricsLevel` in `@profitbash/amazon-ads`). */
export const METRICS_LEVELS = ['campaign', 'adGroup', 'target', 'productAd', 'searchTerm'] as const;
export type MetricsLevel = (typeof METRICS_LEVELS)[number];

/** Kennzahl-Spalten, die je Ad-Typ und Ebene fehlen können (Namen wie in `DailyMetricValues`, `packages/db`). */
export const METRIC_COLUMNS = [
  'sales7d',
  'sales14d',
  'salesSameSku7d',
  'salesSameSku14d',
  'purchases7d',
  'purchases14d',
  'purchasesSameSku7d',
  'purchasesSameSku14d',
  'units7d',
  'units14d',
  'unitsSameSku7d',
  'unitsSameSku14d',
  'salesClicks14d',
  'purchasesClicks14d',
  'unitsClicks14d',
  'viewableImpressions',
] as const;
export type MetricColumn = (typeof METRIC_COLUMNS)[number];

/** Standard „wie Konsole“ oder einheitlich „14 Tage, nur Klicks“ (F4). */
export type AttributionSetting = 'console' | 'clicks14d';

/** Grundlage der Zuordnung: Fenster in Tagen und ob Views (nicht nur Klicks) zählen. */
export interface AttributionBasis {
  windowDays: 7 | 14;
  views: boolean;
}

export const ATTRIBUTED_FIELDS = [
  'sales',
  'purchases',
  'units',
  'salesSameSku',
  'purchasesSameSku',
  'unitsSameSku',
] as const;
export type AttributedField = (typeof ATTRIBUTED_FIELDS)[number];

/** Gewählte Spalte je Feld; `null` = Amazon liefert den Wert hier nicht (Anzeige „–“, nie 0). */
export type AttributionSelection = Record<AttributedField, MetricColumn | null> & {
  basis: AttributionBasis;
  /** Grundlage der Same-SKU-Werte (bei SD nur Klick), `null`, wenn es keine gibt. */
  sameSkuBasis: AttributionBasis | null;
};

const SP_COLUMNS = [
  'sales7d',
  'sales14d',
  'salesSameSku7d',
  'salesSameSku14d',
  'purchases7d',
  'purchases14d',
  'purchasesSameSku7d',
  'purchasesSameSku14d',
  'units7d',
  'units14d',
  'unitsSameSku7d',
  'unitsSameSku14d',
] as const satisfies readonly MetricColumn[];

const SB_SEARCH_TERM_COLUMNS = [
  'sales14d',
  'purchases14d',
  'units14d',
  'salesClicks14d',
  'purchasesClicks14d',
] as const satisfies readonly MetricColumn[];

/** SB-Targets: `unitsSoldClicks` fehlt im Report (1.9). */
const SB_TARGET_COLUMNS = [
  ...SB_SEARCH_TERM_COLUMNS,
  'salesSameSku14d',
  'purchasesSameSku14d',
] as const satisfies readonly MetricColumn[];

const SB_COLUMNS = [
  ...SB_TARGET_COLUMNS,
  'unitsClicks14d',
] as const satisfies readonly MetricColumn[];

const SD_COLUMNS = [
  ...SB_COLUMNS,
  'viewableImpressions',
] as const satisfies readonly MetricColumn[];

/**
 * Spalten, die der Report eines Ad-Typs auf einer Ebene füllt; `null` = kein Report (SD-Suchbegriffe).
 * Ein Test gleicht die Tabelle mit den Report-Definitionen in `@profitbash/amazon-ads` ab.
 */
export const METRIC_AVAILABILITY: Record<
  AdProduct,
  Record<MetricsLevel, readonly MetricColumn[] | null>
> = {
  SPONSORED_PRODUCTS: {
    campaign: SP_COLUMNS,
    adGroup: SP_COLUMNS,
    target: SP_COLUMNS,
    productAd: SP_COLUMNS,
    searchTerm: SP_COLUMNS,
  },
  SPONSORED_BRANDS: {
    campaign: SB_COLUMNS,
    adGroup: SB_COLUMNS,
    target: SB_TARGET_COLUMNS,
    productAd: SB_COLUMNS,
    searchTerm: SB_SEARCH_TERM_COLUMNS,
  },
  SPONSORED_DISPLAY: {
    campaign: SD_COLUMNS,
    adGroup: SD_COLUMNS,
    target: SD_COLUMNS,
    productAd: SD_COLUMNS,
    searchTerm: null,
  },
};

export interface SelectAttributionInput {
  adProduct: AdProduct;
  level: MetricsLevel;
  /** `amazon_ads_profiles.account_type`; nur `vendor` hat in der Konsole 14 Tage (Agency = 7 Tage ist eine Annahme, 1.10). */
  accountType: string;
  setting: AttributionSetting;
}

type Candidates = Record<AttributedField, MetricColumn | null>;

function candidates(
  adProduct: AdProduct,
  accountType: string,
  setting: AttributionSetting,
): { columns: Candidates; basis: AttributionBasis; sameSkuBasis: AttributionBasis | null } {
  if (adProduct === 'SPONSORED_PRODUCTS') {
    const window = setting === 'console' && accountType !== 'vendor' ? '7d' : '14d';
    const basis: AttributionBasis = { windowDays: window === '7d' ? 7 : 14, views: false };
    return {
      columns: {
        sales: `sales${window}`,
        purchases: `purchases${window}`,
        units: `units${window}`,
        salesSameSku: `salesSameSku${window}`,
        purchasesSameSku: `purchasesSameSku${window}`,
        unitsSameSku: `unitsSameSku${window}`,
      },
      basis,
      sameSkuBasis: basis,
    };
  }

  const clicksOnly: AttributionBasis = { windowDays: 14, views: false };
  const withViews: AttributionBasis = { windowDays: 14, views: true };
  // SB-Same-SKU zählt Views wie der Umsatz (ohne Nur-Klick-Variante), SD-Same-SKU nur Klicks.
  const sameSku = {
    columns: { salesSameSku: 'salesSameSku14d', purchasesSameSku: 'purchasesSameSku14d' } as const,
    basis: adProduct === 'SPONSORED_BRANDS' ? withViews : clicksOnly,
  };
  const sameSkuUsable = setting === 'console' || !sameSku.basis.views;

  return {
    columns: {
      ...(setting === 'console'
        ? { sales: 'sales14d', purchases: 'purchases14d', units: 'units14d' }
        : { sales: 'salesClicks14d', purchases: 'purchasesClicks14d', units: 'unitsClicks14d' }),
      ...(sameSkuUsable ? sameSku.columns : { salesSameSku: null, purchasesSameSku: null }),
      unitsSameSku: null,
    },
    basis: setting === 'console' ? withViews : clicksOnly,
    sameSkuBasis: sameSkuUsable ? sameSku.basis : null,
  };
}

export function selectAttribution({
  adProduct,
  level,
  accountType,
  setting,
}: SelectAttributionInput): AttributionSelection {
  const { columns, basis, sameSkuBasis } = candidates(adProduct, accountType, setting);
  const available = METRIC_AVAILABILITY[adProduct][level] ?? [];
  const selection = Object.fromEntries(
    ATTRIBUTED_FIELDS.map((field) => {
      const column = columns[field];
      return [field, column !== null && available.includes(column) ? column : null];
    }),
  ) as Candidates;
  return { ...selection, basis, sameSkuBasis };
}

export interface AttributionSummary {
  /** Umsatz, Käufe und Einheiten beruhen auf unterschiedlichen Grundlagen (Hinweis an der Summe). */
  mixed: boolean;
  /** Dasselbe für die Same-SKU-Werte. */
  sameSkuMixed: boolean;
  /** Je Feld: in allen, einigen oder keinen der zusammengefassten Zeilen vorhanden. */
  coverage: Record<AttributedField, Coverage>;
}

const sameBasis = (a: AttributionBasis, b: AttributionBasis) =>
  a.windowDays === b.windowDays && a.views === b.views;

const isMixed = (bases: readonly AttributionBasis[]) =>
  bases.some((basis) => !sameBasis(basis, bases[0]!));

/** Fasst die Auswahlen der Zeilen einer Summe zusammen (z. B. je Ad-Typ und Kontotyp einer Auswahl). */
export function summarizeAttribution(
  selections: readonly AttributionSelection[],
): AttributionSummary {
  const coverage = Object.fromEntries(
    ATTRIBUTED_FIELDS.map((field) => {
      const present = selections.filter((selection) => selection[field] !== null).length;
      const value: Coverage =
        present === selections.length ? 'full' : present === 0 ? 'none' : 'partial';
      return [field, value];
    }),
  ) as Record<AttributedField, Coverage>;

  return {
    mixed: isMixed(selections.map((selection) => selection.basis)),
    sameSkuMixed: isMixed(
      selections.flatMap((selection) => (selection.sameSkuBasis ? [selection.sameSkuBasis] : [])),
    ),
    coverage,
  };
}
