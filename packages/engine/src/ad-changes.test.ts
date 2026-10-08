import { describe, expect, it } from 'vitest';
import {
  AD_CHANGE_WARNING_COUNT,
  checkAdChanges,
  type AdChangeCheckInput,
  type AdChangeLimitLookup,
} from './ad-changes';

/** Prüfungen vor dem Übermitteln (`phase-3.md` 3.4, F6): Grenzen von Amazon hart, große Änderungen als Warnung. */

const noLimits: AdChangeLimitLookup = () => null;
/** Gebote 0.02 bis 1000, Budgets ab 1, Platzierungen bis 900. */
const limits: AdChangeLimitLookup = ({ field }) =>
  field === 'budget'
    ? { min: '1', max: '1000000' }
    : field === 'placement'
      ? { min: '0', max: '900' }
      : { min: '0.02', max: '1000' };

let next = 0;
function change(patch: Partial<AdChangeCheckInput>): AdChangeCheckInput {
  next += 1;
  return {
    id: `c${next}`,
    field: 'bid',
    before: '1.00',
    after: '1.10',
    adProduct: 'SPONSORED_PRODUCTS',
    countryCode: 'DE',
    negative: null,
    profileId: 'p',
    ...patch,
  };
}

describe('checkAdChanges: Grenzen von Amazon', () => {
  it('meldet Werte unter dem Minimum und über dem Maximum mit den Grenzen', () => {
    const low = change({ field: 'bid', after: '0.01' });
    const high = change({ field: 'default_bid', after: '1000.01' });
    const budget = change({ field: 'budget', before: '5', after: '0.5' });
    const ok = change({ field: 'bid', after: '0.02' });
    const result = checkAdChanges([low, high, budget, ok], { limitFor: limits });
    expect(result.violations).toEqual([
      { changeId: low.id, code: 'belowMinimum', min: '0.02', max: '1000' },
      { changeId: high.id, code: 'aboveMaximum', min: '0.02', max: '1000' },
      { changeId: budget.id, code: 'belowMinimum', min: '1', max: '1000000' },
    ]);
  });

  it('fragt die Grenze je Ad-Typ, Land und Feld ab (Platzierungen als placement)', () => {
    const asked: unknown[] = [];
    checkAdChanges(
      [
        change({ field: 'placement_top', before: '0', after: '50', countryCode: 'SE' }),
        change({ field: 'state', before: 'ENABLED', after: 'PAUSED' }),
      ],
      {
        limitFor: (input) => {
          asked.push(input);
          return null;
        },
      },
    );
    expect(asked).toEqual([
      { adProduct: 'SPONSORED_PRODUCTS', countryCode: 'SE', field: 'placement' },
    ]);
  });

  it('prüft Länge und Wortzahl neuer negativer Keywords', () => {
    const words = change({
      field: null,
      before: null,
      after: null,
      negative: { type: 'keyword', keywordText: 'eins zwei drei vier fünf', matchType: 'PHRASE' },
    });
    const fine = change({
      field: null,
      before: null,
      after: null,
      negative: { type: 'keyword', keywordText: 'eins zwei drei vier fünf', matchType: 'EXACT' },
    });
    const asin = change({
      field: null,
      before: null,
      after: null,
      negative: { type: 'product', asin: 'B000000001' },
    });
    const result = checkAdChanges([words, fine, asin], { limitFor: noLimits });
    expect(result.violations).toEqual([{ changeId: words.id, code: 'tooManyWords', max: 4 }]);
  });
});

describe('checkAdChanges: Eingaben', () => {
  it('übergeht Werte, die keine einfache Dezimalzahl sind, statt zu werfen oder falsch zu rechnen', () => {
    const result = checkAdChanges(
      [
        change({ after: 'abc' }),
        change({ after: '1e3' }),
        change({ after: 'NaN' }),
        change({ before: '0x10', after: '100' }),
      ],
      { limitFor: limits },
    );
    expect(result.violations).toEqual([]);
    expect(result.largeChanges).toEqual([]);
  });

  it('zählt „mehr als 200“ je Profil, wenn die Änderungen ihr Profil nennen', () => {
    const many = [
      ...Array.from({ length: 150 }, () => change({ profileId: 'a' })),
      ...Array.from({ length: 150 }, () => change({ profileId: 'b' })),
    ];
    expect(checkAdChanges(many, { limitFor: noLimits }).tooMany).toBeNull();
    const one = [...many, ...Array.from({ length: 51 }, () => change({ profileId: 'a' }))];
    expect(checkAdChanges(one, { limitFor: noLimits }).tooMany).toEqual({ count: 201, limit: 200 });
  });
});

describe('checkAdChanges: Warnungen nach F6', () => {
  it('warnt bei Geboten und Budgets, die sich um mehr als 50 % ändern', () => {
    const up = change({ field: 'bid', before: '1.00', after: '1.51' });
    const down = change({ field: 'budget', before: '20', after: '9.99' });
    const exactly = change({ field: 'bid', before: '1.00', after: '1.50' });
    const half = change({ field: 'default_bid', before: '0.40', after: '0.20' });
    const result = checkAdChanges([up, down, exactly, half], { limitFor: noLimits });
    expect(result.largeChanges).toEqual([
      { changeId: up.id, changePercent: '51' },
      { changeId: down.id, changePercent: '-50.05' },
    ]);
  });

  it('vergleicht ein Gebot ohne Wert vorher mit dem Vergleichswert (Standardgebot der Ad Group)', () => {
    const large = change({ field: 'bid', before: null, comparisonBefore: '0.40', after: '0.61' });
    const small = change({ field: 'bid', before: null, comparisonBefore: '0.40', after: '0.60' });
    const own = change({ field: 'bid', before: '1.00', comparisonBefore: '0.10', after: '1.10' });
    const result = checkAdChanges([large, small, own], { limitFor: noLimits });
    expect(result.largeChanges).toEqual([{ changeId: large.id, changePercent: '52.5' }]);
  });

  it('warnt nicht ohne Wert vorher und nicht bei Platzierungen oder Zuständen', () => {
    const result = checkAdChanges(
      [
        change({ field: 'bid', before: null, after: '5' }),
        change({ field: 'placement_top', before: '10', after: '300' }),
        change({ field: 'state', before: 'ENABLED', after: 'PAUSED' }),
      ],
      { limitFor: noLimits },
    );
    expect(result.largeChanges).toEqual([]);
  });

  it('warnt bei mehr als 200 Änderungen', () => {
    const many = Array.from({ length: AD_CHANGE_WARNING_COUNT + 1 }, () => change({}));
    expect(checkAdChanges(many.slice(1), { limitFor: noLimits }).tooMany).toBeNull();
    expect(checkAdChanges(many, { limitFor: noLimits }).tooMany).toEqual({
      count: 201,
      limit: 200,
    });
  });
});
