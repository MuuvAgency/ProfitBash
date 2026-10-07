import { describe, expect, it } from 'vitest';
import {
  buildNgrams,
  classifySearchTerm,
  createProtectedTermMatcher,
  isProtectedSearchTerm,
  tokenizeSearchTerm,
  type SearchTermRules,
  type SearchTermSums,
} from './search-terms';

const sums = (overrides: Partial<SearchTermSums> = {}): SearchTermSums => ({
  impressions: '1000',
  clicks: '10',
  cost: '5.00',
  sales: '0',
  purchases: '0',
  units: '0',
  ...overrides,
});

const rules: SearchTermRules = {
  harvestMinPurchases: 3,
  harvestMaxAcos: '0.25',
  negateMinClicks: 25,
  negateMinCost: '20',
};

describe('tokenizeSearchTerm', () => {
  it('trennt an Leerraum und schreibt klein', () => {
    expect(tokenizeSearchTerm('  LED  Lampe\tWarmweiß ')).toEqual(['led', 'lampe', 'warmweiß']);
  });

  it('lässt Satzzeichen im Wort stehen (ein Wort bleibt ein Wort)', () => {
    expect(tokenizeSearchTerm('t-shirt 3.5mm')).toEqual(['t-shirt', '3.5mm']);
  });

  it('ergibt für einen leeren Begriff keine Wörter', () => {
    expect(tokenizeSearchTerm('   ')).toEqual([]);
  });
});

describe('buildNgrams', () => {
  it('bildet 1-, 2- und 3-Gramme und summiert die Kennzahlen exakt', () => {
    const ngrams = buildNgrams([
      {
        searchTerm: 'led lampe dimmbar',
        ...sums({ cost: '0.10', sales: '10', purchases: '1', clicks: '4' }),
      },
      {
        searchTerm: 'led lampe',
        ...sums({ cost: '0.20', sales: '5.5', purchases: '2', clicks: '6' }),
      },
    ]);
    const find = (gram: string) => ngrams.find((n) => n.gram === gram);

    expect(find('led lampe')).toEqual({
      size: 2,
      gram: 'led lampe',
      searchTerms: 2,
      impressions: '2000',
      clicks: '10',
      cost: '0.3',
      sales: '15.5',
      purchases: '3',
      units: '0',
    });
    expect(find('led lampe dimmbar')?.size).toBe(3);
    expect(find('dimmbar')).toMatchObject({ size: 1, searchTerms: 1, cost: '0.1' });
    expect(ngrams.map((n) => n.gram).sort()).toEqual(
      ['dimmbar', 'lampe', 'lampe dimmbar', 'led', 'led lampe', 'led lampe dimmbar'].sort(),
    );
  });

  it('zählt ein N-Gramm je Zeile nur einmal, auch wenn es im Begriff doppelt steht', () => {
    const [led] = buildNgrams([{ searchTerm: 'led led led', ...sums({ cost: '1' }) }], [1]);
    expect(led).toMatchObject({ gram: 'led', searchTerms: 1, cost: '1' });
  });

  it('zählt denselben Suchbegriff aus mehreren Targets als einen Begriff, summiert aber alle Zeilen', () => {
    const [gram] = buildNgrams(
      [
        { searchTerm: 'Lampe', ...sums({ cost: '1' }) },
        { searchTerm: 'lampe', ...sums({ cost: '2' }) },
      ],
      [1],
    );
    expect(gram).toMatchObject({ gram: 'lampe', searchTerms: 1, cost: '3', clicks: '20' });
  });

  it('sortiert nach Spend absteigend, dann nach Länge und Text', () => {
    const ngrams = buildNgrams(
      [
        { searchTerm: 'b a', ...sums({ cost: '1' }) },
        { searchTerm: 'c', ...sums({ cost: '9' }) },
      ],
      [1, 2],
    );
    expect(ngrams.map((n) => n.gram)).toEqual(['c', 'a', 'b', 'b a']);
  });

  it('bildet nur die verlangten Längen und nichts aus leeren Begriffen', () => {
    expect(buildNgrams([{ searchTerm: ' ', ...sums() }])).toEqual([]);
    expect(buildNgrams([{ searchTerm: 'a b c', ...sums() }], [3]).map((n) => n.gram)).toEqual([
      'a b c',
    ]);
  });
});

describe('isProtectedSearchTerm', () => {
  it('erkennt einen geschützten Begriff als ganze Wortfolge, ohne Groß-/Kleinschreibung', () => {
    expect(isProtectedSearchTerm('Nordwind Lampe led', ['nordwind lampe'])).toBe(true);
    expect(isProtectedSearchTerm('lampe nordwind', ['Nordwind'])).toBe(true);
  });

  it('trifft keine Wortteile und keine getrennte Wortfolge', () => {
    expect(isProtectedSearchTerm('nordwinde lampe', ['nordwind'])).toBe(false);
    expect(isProtectedSearchTerm('nordwind led lampe', ['nordwind lampe'])).toBe(false);
  });

  it('trennt für den Schutz auch an Satzzeichen (Bindestrich, Apostroph, Komma)', () => {
    expect(isProtectedSearchTerm('nordwind-lampe', ['nordwind'])).toBe(true);
    expect(isProtectedSearchTerm("nordwind's lampe", ['Nordwind'])).toBe(true);
    expect(isProtectedSearchTerm('lampe,nordwind', ['nordwind'])).toBe(true);
    expect(isProtectedSearchTerm('nordwind lampe', ['nordwind-lampe'])).toBe(true);
    expect(isProtectedSearchTerm('nordwinde-lampe', ['nordwind'])).toBe(false);
  });

  it('bereitet die Begriffe einmal vor (gleiches Ergebnis je Suchbegriff)', () => {
    const matches = createProtectedTermMatcher(['Nordwind', ' ', 'hero lampe']);
    expect(matches('NORDWIND led')).toBe(true);
    expect(matches('die hero-lampe')).toBe(true);
    expect(matches('lampe')).toBe(false);
  });

  it('übergeht leere geschützte Begriffe', () => {
    expect(isProtectedSearchTerm('lampe', ['', '  '])).toBe(false);
  });
});

describe('classifySearchTerm', () => {
  const classify = (
    overrides: Partial<SearchTermSums>,
    options: { alreadyTargeted?: boolean; protectedTerms?: string[]; searchTerm?: string } = {},
  ) =>
    classifySearchTerm(
      {
        protected: isProtectedSearchTerm(
          options.searchTerm ?? 'led lampe',
          options.protectedTerms ?? [],
        ),
        alreadyTargeted: options.alreadyTargeted ?? false,
        ...sums(overrides),
      },
      rules,
    );

  it('Negieren: genug Klicks, kein Kauf, genug Spend (Grenzen zählen mit)', () => {
    expect(classify({ clicks: '25', cost: '20', purchases: '0' })).toEqual({
      classification: 'negate',
      reason: null,
    });
  });

  it('Beobachten, solange Klicks oder Spend unter der Grenze liegen', () => {
    expect(classify({ clicks: '24', cost: '50' })).toEqual({
      classification: 'watch',
      reason: 'tooFewData',
    });
    expect(classify({ clicks: '80', cost: '19.99' })).toEqual({
      classification: 'watch',
      reason: 'tooFewData',
    });
  });

  it('negiert nie mit einem Kauf', () => {
    expect(classify({ clicks: '90', cost: '90', purchases: '1', sales: '10' }).classification).toBe(
      'watch',
    );
  });

  it('geschützte Begriffe bekommen nie einen Negativ-Vorschlag', () => {
    expect(
      classify(
        { clicks: '500', cost: '900', purchases: '0' },
        { searchTerm: 'nordwind lampe', protectedTerms: ['Nordwind'] },
      ),
    ).toEqual({ classification: 'watch', reason: 'protected' });
  });

  it('Harvest: genug Käufe und ACoS höchstens am Ziel (Grenzen zählen mit)', () => {
    expect(classify({ purchases: '3', cost: '25', sales: '100' })).toEqual({
      classification: 'harvest',
      reason: null,
    });
  });

  it('geschützte Begriffe dürfen geerntet werden', () => {
    expect(
      classify(
        { purchases: '5', cost: '10', sales: '100' },
        { searchTerm: 'nordwind lampe', protectedTerms: ['nordwind'] },
      ).classification,
    ).toBe('harvest');
  });

  it('Beobachten bei ACoS über dem Ziel; Käufe ohne Umsatz haben einen eigenen Grund', () => {
    expect(classify({ purchases: '3', cost: '25.01', sales: '100' })).toEqual({
      classification: 'watch',
      reason: 'acosAboveTarget',
    });
    expect(classify({ purchases: '3', cost: '5', sales: '0' })).toEqual({
      classification: 'watch',
      reason: 'noSales',
    });
  });

  it('Beobachten bei zu wenigen Käufen', () => {
    expect(classify({ purchases: '2', cost: '1', sales: '100' })).toEqual({
      classification: 'watch',
      reason: 'tooFewData',
    });
  });

  it('kein Harvest, wenn es das exakte Target schon gibt', () => {
    expect(
      classify({ purchases: '9', cost: '1', sales: '100' }, { alreadyTargeted: true }),
    ).toEqual({ classification: 'watch', reason: 'alreadyTargeted' });
  });

  it('negiert auch einen Begriff, der schon exakt gebucht ist', () => {
    expect(
      classify({ clicks: '40', cost: '40', purchases: '0' }, { alreadyTargeted: true })
        .classification,
    ).toBe('negate');
  });
});
