import { describe, expect, it } from 'vitest';
import {
  buildNgrams,
  classifySearchTerm,
  classifySearchTermsAcrossTargets,
  comparableSearchTerm,
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

describe('comparableSearchTerm', () => {
  it('ist klein geschrieben, NFC und fasst Leerraum zusammen', () => {
    expect(comparableSearchTerm('  LED\t Lampe ')).toBe('led lampe');
    // „é“ zusammengesetzt (e + Akzent) und als ein Zeichen sind derselbe Begriff.
    expect(comparableSearchTerm('cafe\u0301')).toBe(comparableSearchTerm('caf\u00e9'));
    expect(comparableSearchTerm('t-shirt')).toBe('t-shirt');
  });
});

describe('classifySearchTermsAcrossTargets', () => {
  const target = (
    searchTerm: string,
    overrides: Partial<SearchTermSums> = {},
    flags: { protected?: boolean; alreadyTargeted?: boolean } = {},
  ) => ({
    searchTerm,
    protected: flags.protected ?? false,
    alreadyTargeted: flags.alreadyTargeted ?? false,
    ...sums(overrides),
  });
  const across = (rows: ReturnType<typeof target>[]) =>
    classifySearchTermsAcrossTargets(rows, rules);

  it('Harvest: Käufe 1 + 2 über zwei Targets erreichen die Grenze 3 (Summen exakt)', () => {
    const rows = [
      target('led lampe', { purchases: '1', cost: '0.10', sales: '40', units: '1' }),
      target('led lampe', { purchases: '2', cost: '0.20', sales: '60.5', units: '3' }),
    ];
    for (const row of rows) expect(classifySearchTerm(row, rules).classification).toBe('watch');
    expect([...across(rows)]).toEqual([
      [
        'led lampe',
        {
          classification: 'harvest',
          reason: null,
          targets: 2,
          onlyAcrossTargets: true,
          impressions: '2000',
          clicks: '20',
          cost: '0.3',
          sales: '100.5',
          purchases: '3',
          units: '4',
        },
      ],
    ]);
  });

  it('bleibt unter der Harvest-Grenze bei Beobachten (1 + 1 Käufe)', () => {
    const result = across([
      target('led lampe', { purchases: '1', sales: '50' }),
      target('led lampe', { purchases: '1', sales: '50' }),
    ]);
    expect(result.get('led lampe')).toMatchObject({
      classification: 'watch',
      reason: 'tooFewData',
      onlyAcrossTargets: false,
    });
  });

  it('Negieren: Klicks ohne Kauf über mehrere Targets erreichen Klick- und Spend-Grenze', () => {
    const rows = [
      target('lampe billig', { clicks: '10', cost: '8' }),
      target('lampe billig', { clicks: '10', cost: '7' }),
      target('lampe billig', { clicks: '5', cost: '5' }),
    ];
    for (const row of rows) expect(classifySearchTerm(row, rules).classification).toBe('watch');
    expect(across(rows).get('lampe billig')).toMatchObject({
      classification: 'negate',
      reason: null,
      targets: 3,
      onlyAcrossTargets: true,
      clicks: '25',
      cost: '20',
    });
    // Ein Cent bzw. ein Klick weniger reicht nicht.
    expect(
      across([
        target('lampe billig', { clicks: '10', cost: '8' }),
        target('lampe billig', { clicks: '15', cost: '11.99' }),
      ]).get('lampe billig')?.classification,
    ).toBe('watch');
    expect(
      across([
        target('lampe billig', { clicks: '10', cost: '10' }),
        target('lampe billig', { clicks: '14', cost: '10' }),
      ]).get('lampe billig')?.classification,
    ).toBe('watch');
  });

  it('negiert nicht, wenn der Begriff auf einem anderen Target gekauft wurde', () => {
    const rows = [
      target('lampe', { clicks: '30', cost: '30' }),
      target('lampe', { clicks: '2', cost: '1', purchases: '1', sales: '20' }),
    ];
    expect(classifySearchTerm(rows[0]!, rules).classification).toBe('negate');
    expect(across(rows).get('lampe')).toMatchObject({
      classification: 'watch',
      reason: 'tooFewData',
      onlyAcrossTargets: false,
    });
  });

  it('ein geschützter Begriff wird auch über alle Targets nie negiert', () => {
    const result = across([
      target('nordwind lampe', { clicks: '200', cost: '300' }, { protected: true }),
      target('nordwind lampe', { clicks: '200', cost: '300' }, { protected: true }),
    ]);
    expect(result.get('nordwind lampe')).toMatchObject({
      classification: 'watch',
      reason: 'protected',
      onlyAcrossTargets: false,
    });
  });

  it('eine Zeile allein ergibt die Einstufung der Zeile', () => {
    const rows = [
      target('a', { purchases: '3', cost: '25', sales: '100' }),
      target('b', { clicks: '25', cost: '20' }),
      target('c', { purchases: '3', cost: '25.01', sales: '100' }),
      target('d', { purchases: '9', cost: '1', sales: '100' }, { alreadyTargeted: true }),
      target('e'),
    ];
    const result = across(rows);
    expect(result.size).toBe(rows.length);
    for (const row of rows) {
      expect(result.get(row.searchTerm)).toMatchObject({
        ...classifySearchTerm(row, rules),
        targets: 1,
        onlyAcrossTargets: false,
      });
    }
  });

  it('fasst Schreibweisen desselben Begriffs zusammen (Groß-/Kleinschreibung, Leerraum, NFC)', () => {
    const result = across([
      target('LED  Lampe', { purchases: '1', sales: '50' }),
      target(' led lampe', { purchases: '1', sales: '50' }),
      target('Led\tLampe ', { purchases: '1', sales: '50' }),
      target('led lampen', { purchases: '1', sales: '50' }),
    ]);
    expect([...result.keys()]).toEqual(['led lampe', 'led lampen']);
    expect(result.get('led lampe')).toMatchObject({
      classification: 'harvest',
      targets: 3,
      purchases: '3',
    });
    expect(result.get(comparableSearchTerm('LED Lampe'))?.targets).toBe(3);
  });

  it('prüft den ACoS an den Summen (Grenze zählt mit)', () => {
    // Je Zeile über dem Ziel bzw. zu wenige Käufe; zusammen genau am Ziel: 25 / 100.
    const atTarget = across([
      target('lampe', { purchases: '2', cost: '20', sales: '40' }),
      target('lampe', { purchases: '1', cost: '5', sales: '60' }),
    ]);
    expect(atTarget.get('lampe')).toMatchObject({ classification: 'harvest', cost: '25' });
    const above = across([
      target('lampe', { purchases: '2', cost: '20.01', sales: '40' }),
      target('lampe', { purchases: '1', cost: '5', sales: '60' }),
    ]);
    expect(above.get('lampe')).toMatchObject({
      classification: 'watch',
      reason: 'acosAboveTarget',
    });
    // Eine Zeile wäre allein ein Harvest, die Summe liegt über dem Ziel.
    const diluted = across([
      target('lampe', { purchases: '3', cost: '10', sales: '100' }),
      target('lampe', { purchases: '0', cost: '40', sales: '0' }),
    ]);
    expect(diluted.get('lampe')).toMatchObject({
      classification: 'watch',
      reason: 'acosAboveTarget',
    });
  });

  it('„schon exakt gebucht“ gilt für den Begriff, sobald eine Zeile es meldet', () => {
    const result = across([
      target('lampe', { purchases: '2', sales: '50' }),
      target('lampe', { purchases: '2', sales: '50' }, { alreadyTargeted: true }),
    ]);
    expect(result.get('lampe')).toMatchObject({
      classification: 'watch',
      reason: 'alreadyTargeted',
    });
  });

  it('„nur über alle Targets“ gilt nicht, wenn schon eine Zeile allein dieselbe Einstufung erreicht', () => {
    const result = across([
      target('lampe', { purchases: '3', cost: '10', sales: '100' }),
      target('lampe', { purchases: '1', cost: '1', sales: '30' }),
    ]);
    expect(result.get('lampe')).toMatchObject({
      classification: 'harvest',
      targets: 2,
      onlyAcrossTargets: false,
    });
  });

  it('Harvest über alle Targets, obwohl eine Zeile allein ein Negativ-Vorschlag ist', () => {
    const rows = [
      target('lampe', { clicks: '30', cost: '30', purchases: '0', sales: '0' }),
      target('lampe', { clicks: '4', cost: '2', purchases: '1', sales: '60' }),
      target('lampe', { clicks: '6', cost: '3', purchases: '2', sales: '80' }),
    ];
    expect(rows.map((row) => classifySearchTerm(row, rules).classification)).toEqual([
      'negate',
      'watch',
      'watch',
    ]);
    // 35 Spend auf 140 Umsatz: genau am Ziel von 25 %.
    expect(across(rows).get('lampe')).toMatchObject({
      classification: 'harvest',
      reason: null,
      targets: 3,
      onlyAcrossTargets: true,
      cost: '35',
      sales: '140',
      purchases: '3',
    });
  });

  it('fasst leere Suchbegriffe (auch nur Leerraum) zu einer Gruppe zusammen', () => {
    const result = across([
      target('', { clicks: '10', cost: '8' }),
      target('   ', { clicks: '10', cost: '7' }),
      target('\t', { clicks: '5', cost: '5' }),
    ]);
    expect([...result.keys()]).toEqual(['']);
    expect(result.get('')).toMatchObject({ classification: 'negate', targets: 3, clicks: '25' });
  });

  it('ergibt ohne Zeilen nichts', () => {
    expect(across([]).size).toBe(0);
  });
});
