import { describe, expect, it } from 'vitest';
import { metricHints, type AttributionLike, type MetaLike } from './hints';

const full = {
  sales: 'full',
  purchases: 'full',
  units: 'full',
  salesSameSku: 'full',
  purchasesSameSku: 'full',
  unitsSameSku: 'full',
} as const;
const attribution = (patch: Partial<AttributionLike> = {}): AttributionLike => ({
  mixed: false,
  sameSkuMixed: false,
  coverage: full,
  ...patch,
});
const meta = (patch: Partial<MetaLike> = {}): MetaLike => ({
  converted: false,
  missingFxCurrencies: [],
  ...patch,
});

describe('metricHints', () => {
  it('ohne Besonderheiten: keine Hinweise', () => {
    expect(metricHints('sales', { meta: meta(), attribution: attribution() })).toEqual([]);
  });

  it('umgerechnete Beträge: „≈“, auch mit nicht gezählten Währungen', () => {
    expect(
      metricHints('cost', { meta: meta({ converted: true }), attribution: attribution() }),
    ).toEqual([{ kind: 'approx' }]);
    expect(
      metricHints('clicks', {
        meta: meta({ converted: true, missingFxCurrencies: ['SEK'] }),
        attribution: attribution(),
      }),
    ).toEqual([{ kind: 'missingFx', currencies: ['SEK'] }]);
  });

  it('Zähler ohne Betrag bekommen kein „≈“', () => {
    expect(
      metricHints('clicks', { meta: meta({ converted: true }), attribution: attribution() }),
    ).toEqual([]);
  });

  it('gemischte Attribution bei Umsatz, Käufen und daraus abgeleiteten Kennzahlen', () => {
    for (const key of ['sales', 'purchases', 'units', 'acos', 'roas', 'cvr'] as const) {
      expect(metricHints(key, { meta: meta(), attribution: attribution({ mixed: true }) })).toEqual(
        [{ kind: 'mixedAttribution' }],
      );
    }
    expect(
      metricHints('cost', { meta: meta(), attribution: attribution({ mixed: true }) }),
    ).toEqual([]);
  });

  it('Wert fehlt bzw. unvollständig nach der Abdeckung des Feldes', () => {
    const none = attribution({ coverage: { ...full, units: 'none' } });
    const partial = attribution({ coverage: { ...full, sales: 'partial' } });
    expect(metricHints('units', { meta: meta(), attribution: none })).toEqual([
      { kind: 'missingValue' },
    ]);
    expect(metricHints('sales', { meta: meta(), attribution: partial })).toEqual([
      { kind: 'partialValue' },
    ]);
    // ACoS aus unvollständigem Umsatz: kommt als „–“ (2.5), Hinweis wie beim Umsatz.
    expect(metricHints('acos', { meta: meta(), attribution: partial })).toEqual([
      { kind: 'partialValue' },
    ]);
  });

  it('Betrag, umgerechnet und gemischt: beide Hinweise', () => {
    expect(
      metricHints('sales', {
        meta: meta({ converted: true }),
        attribution: attribution({ mixed: true }),
      }),
    ).toEqual([{ kind: 'approx' }, { kind: 'mixedAttribution' }]);
  });
});
