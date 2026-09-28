import { describe, expect, it } from 'vitest';
import { change, deriveMetrics, sumDecimals, sumWithGaps, type MetricTotals } from './metrics';

const totals = (overrides: Partial<MetricTotals> = {}): MetricTotals => ({
  impressions: '2000',
  clicks: '40',
  cost: '30.00',
  sales: '120.00',
  purchases: '4',
  viewableImpressions: null,
  ...overrides,
});

describe('sumDecimals', () => {
  it('summiert Decimal-Strings exakt', () => {
    expect(sumDecimals(['0.1', '0.2', '10'])).toBe('10.3');
  });

  it('ergibt 0 für eine leere Liste', () => {
    expect(sumDecimals([])).toBe('0');
  });
});

describe('sumWithGaps', () => {
  it('summiert vollständige Werte ohne Hinweis', () => {
    expect(sumWithGaps(['1.5', '2'])).toEqual({ value: '3.5', coverage: 'full' });
  });

  it('zählt fehlende Werte nicht als 0, sondern meldet die Lücke', () => {
    expect(sumWithGaps(['1.5', null, '2'])).toEqual({ value: '3.5', coverage: 'partial' });
  });

  it('ergibt null, wenn kein Wert vorliegt', () => {
    expect(sumWithGaps([null, null])).toEqual({ value: null, coverage: 'none' });
  });

  it('gilt für eine leere Liste als vollständig mit 0', () => {
    expect(sumWithGaps([])).toEqual({ value: '0', coverage: 'full' });
  });
});

describe('deriveMetrics', () => {
  it('berechnet CTR, CPC, CVR, ACoS, ROAS und CPM als Anteile bzw. Beträge', () => {
    expect(deriveMetrics(totals())).toEqual({
      ctr: '0.02',
      cpc: '0.75',
      cvr: '0.1',
      acos: '0.25',
      roas: '4',
      cpm: '15',
      vcpm: null,
    });
  });

  it('berechnet vCPM aus Kosten und sichtbaren Impressionen (nur SD)', () => {
    expect(deriveMetrics(totals({ viewableImpressions: '1500' })).vcpm).toBe('20');
  });

  it('ergibt null statt Infinity oder 0 bei Division durch 0', () => {
    expect(
      deriveMetrics(
        totals({
          impressions: '0',
          clicks: '0',
          cost: '0',
          sales: '0',
          purchases: '0',
          viewableImpressions: '0',
        }),
      ),
    ).toEqual({ ctr: null, cpc: null, cvr: null, acos: null, roas: null, cpm: null, vcpm: null });
  });

  it('ergibt ACoS 0 bei Umsatz ohne Kosten, aber ROAS null', () => {
    const derived = deriveMetrics(totals({ cost: '0' }));
    expect(derived.acos).toBe('0');
    expect(derived.roas).toBeNull();
  });

  it('lässt Kennzahlen aus fehlenden Werten fehlen, statt sie als 0 zu rechnen', () => {
    const derived = deriveMetrics(totals({ sales: null, purchases: null }));
    expect(derived.acos).toBeNull();
    expect(derived.roas).toBeNull();
    expect(derived.cvr).toBeNull();
    expect(derived.cpc).toBe('0.75');
  });

  it('behält die volle Rechengenauigkeit (gerundet wird erst bei der Anzeige)', () => {
    expect(deriveMetrics(totals({ clicks: '3', cost: '1' })).cpc).toBe(
      '0.3333333333333333333333333333333333',
    );
  });
});

describe('change', () => {
  it('liefert absolute und relative Veränderung', () => {
    expect(change('150', '120')).toEqual({ absolute: '30', relative: '0.25' });
    expect(change('90', '120')).toEqual({ absolute: '-30', relative: '-0.25' });
  });

  it('bezieht die relative Veränderung auf den Betrag des Vergleichswerts', () => {
    expect(change('-50', '-100')).toEqual({ absolute: '50', relative: '0.5' });
  });

  it('hat keine relative Veränderung, wenn der Vergleichswert 0 ist', () => {
    expect(change('10', '0')).toEqual({ absolute: '10', relative: null });
  });

  it('ergibt null, wenn ein Wert fehlt', () => {
    expect(change(null, '10')).toEqual({ absolute: null, relative: null });
    expect(change('10', null)).toEqual({ absolute: null, relative: null });
  });
});
