import { describe, expect, it } from 'vitest';
import type { SearchTermRowData } from '../api/client';
import { harvestTerms, isAsinSearchTerm, negativeInputs } from './actions';

const C1 = '00000000-0000-4000-8000-0000000000c1';
const C2 = '00000000-0000-4000-8000-0000000000c2';
const G1 = '00000000-0000-4000-8000-0000000000a1';
const G2 = '00000000-0000-4000-8000-0000000000a2';

type Row = Pick<SearchTermRowData, 'searchTerm' | 'campaignId' | 'adGroupId' | 'protected'>;
const row = (searchTerm: string, patch: Partial<Row> = {}): Row => ({
  searchTerm,
  campaignId: C1,
  adGroupId: G1,
  protected: false,
  ...patch,
});
const options = { level: 'adGroup', matchType: 'EXACT', confirmProtected: false } as const;

describe('isAsinSearchTerm', () => {
  it('erkennt ASINs (Suchbegriffe von Produkt-Targets), nicht gewöhnliche Wörter', () => {
    expect(isAsinSearchTerm('b0abc12345')).toBe(true);
    expect(isAsinSearchTerm(' B0ABC12345 ')).toBe(true);
    expect(isAsinSearchTerm('b0abc1234')).toBe(false);
    expect(isAsinSearchTerm('wandlampen')).toBe(false);
    expect(isAsinSearchTerm('b0 abc12345')).toBe(false);
  });
});

describe('negativeInputs', () => {
  it('legt je Zeile ein negatives Keyword exakt in der Ad Group der Zeile an (Standard, F9)', () => {
    const { inputs, skipped } = negativeInputs([row('lampe billig')], options);

    expect(inputs).toEqual([
      {
        operation: 'create_negative',
        campaignId: C1,
        adGroupId: G1,
        negative: { type: 'keyword', keywordText: 'lampe billig', matchType: 'EXACT' },
      },
    ]);
    expect(skipped).toEqual({ noEntity: 0, protected: 0, tooLong: 0 });
  });

  it('stellt auf Kampagnenebene und Wortgruppe um', () => {
    const { inputs } = negativeInputs([row('lampe billig')], {
      ...options,
      level: 'campaign',
      matchType: 'PHRASE',
    });

    expect(inputs[0]).toMatchObject({
      adGroupId: null,
      negative: { type: 'keyword', matchType: 'PHRASE' },
    });
  });

  it('nennt dieselbe Stelle nur einmal (mehrere Targets einer Ad Group, Kampagnenebene über Ad Groups)', () => {
    const rows = [
      row('Lampe  billig'),
      row('lampe billig'),
      row('lampe billig', { adGroupId: G2 }),
      row('lampe billig', { campaignId: C2, adGroupId: G2 }),
    ];

    expect(negativeInputs(rows, options).inputs).toHaveLength(3);
    expect(negativeInputs(rows, { ...options, level: 'campaign' }).inputs).toHaveLength(2);
  });

  it('macht aus einer ASIN ein negatives Produkt-Target, unabhängig vom Match-Typ', () => {
    const { inputs } = negativeInputs([row('b0abc12345')], { ...options, matchType: 'PHRASE' });

    expect(inputs[0]).toMatchObject({ negative: { type: 'product', asin: 'B0ABC12345' } });
  });

  it('überspringt Zeilen ohne bekannte Kampagne bzw. Ad Group und zu lange Begriffe', () => {
    const rows = [
      row('ohne kampagne', { campaignId: null }),
      row('ohne ad group', { adGroupId: null }),
      row('x'.repeat(81)),
    ];

    expect(negativeInputs(rows, options)).toEqual({
      inputs: [],
      skipped: { noEntity: 2, protected: 0, tooLong: 1 },
    });
    // Auf Kampagnenebene reicht die Kampagne.
    expect(negativeInputs(rows, { ...options, level: 'campaign' }).inputs).toHaveLength(1);
  });

  it('nimmt geschützte Begriffe nur mit Bestätigung mit und sendet sie dann bestätigt', () => {
    const rows = [row('nordwind lampe', { protected: true }), row('lampe billig')];

    const without = negativeInputs(rows, options);
    expect(without.inputs).toHaveLength(1);
    expect(without.skipped.protected).toBe(1);

    const confirmed = negativeInputs(rows, { ...options, confirmProtected: true });
    expect(confirmed.inputs.map((input) => 'confirmProtected' in input)).toEqual([true, false]);
    expect(confirmed.skipped.protected).toBe(0);
  });
});

describe('harvestTerms', () => {
  it('nennt jeden Suchbegriff einmal (ohne Groß/Klein und doppelten Leerraum)', () => {
    expect(
      harvestTerms([
        { searchTerm: 'LED Lampe' },
        { searchTerm: 'led  lampe' },
        { searchTerm: 'x' },
      ]),
    ).toEqual(['LED Lampe', 'x']);
  });
});
