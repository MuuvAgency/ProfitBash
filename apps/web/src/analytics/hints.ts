import type { MetricKey } from './metrics';

/**
 * Hinweise an einer Summe (`phase-2.md` F3, F4, 2.6): „≈“ bei umgerechneten Beträgen, nicht gezählte Währungen ohne
 * Kurs, gemischte Attribution und fehlende bzw. unvollständige Werte (Amazon liefert sie für Ad-Typ oder Ebene nicht).
 */
export type Coverage = 'full' | 'partial' | 'none';

export interface AttributionLike {
  mixed: boolean;
  sameSkuMixed: boolean;
  coverage: Record<
    'sales' | 'purchases' | 'units' | 'salesSameSku' | 'purchasesSameSku' | 'unitsSameSku',
    Coverage
  >;
}

export interface MetaLike {
  converted: boolean;
  missingFxCurrencies: string[];
}

export type MetricHint =
  | { kind: 'approx' }
  | { kind: 'missingFx'; currencies: string[] }
  | { kind: 'mixedAttribution' }
  | { kind: 'missingValue' }
  | { kind: 'partialValue' };

/** Beträge (ACoS und ROAS sind Quotienten zweier Beträge derselben Währung, also ohne „≈“). */
const MONEY = new Set<MetricKey>(['cost', 'sales', 'cpc', 'cpm', 'vcpm']);

/** Attributionsabhängige Kennzahlen und das Feld, dessen Abdeckung sie bestimmt. */
const ATTRIBUTED: Partial<Record<MetricKey, keyof AttributionLike['coverage']>> = {
  sales: 'sales',
  purchases: 'purchases',
  units: 'units',
  acos: 'sales',
  roas: 'sales',
  cvr: 'purchases',
};

export function metricHints(
  key: MetricKey,
  { meta, attribution }: { meta: MetaLike; attribution: AttributionLike },
): MetricHint[] {
  const hints: MetricHint[] = [];
  if (meta.converted && MONEY.has(key)) {
    hints.push({ kind: 'approx' });
  }
  if (meta.missingFxCurrencies.length) {
    hints.push({ kind: 'missingFx', currencies: meta.missingFxCurrencies });
  }
  const field = ATTRIBUTED[key];
  if (field) {
    const coverage = attribution.coverage[field];
    if (coverage === 'none') hints.push({ kind: 'missingValue' });
    else if (coverage === 'partial') hints.push({ kind: 'partialValue' });
    else if (attribution.mixed) hints.push({ kind: 'mixedAttribution' });
  }
  return hints;
}
