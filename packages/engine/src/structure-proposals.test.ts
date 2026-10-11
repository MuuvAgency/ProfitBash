import { describe, expect, it } from 'vitest';
import { graduationProposals, presetSwitchProposals } from './structure-proposals';

/** Graduation- und Preset-Vorschläge (`phase-5.md` 5.11b) aus den Kanten des Struktur-Katalogs, ohne I/O. */

const blocks = [
  { key: 'AUTO', targeting: 'auto' },
  { key: 'EXACT', targeting: 'keyword' },
  { key: 'EXACT1', targeting: 'keyword' },
  { key: 'PAT', targeting: 'product' },
] as const;
const edge = (
  from: string,
  to: string,
  minOrders: number | null = null,
  maxAcosPercentOfGoal: number | null = null,
) => ({ from, to, minOrders, maxAcosPercentOfGoal });
const row = (searchTerm: string, amazonCampaignId: string, orders: number, spend = '10') => ({
  searchTerm,
  amazonCampaignId,
  clicks: 40,
  orders,
  spend,
  sales: '100',
});
const base = {
  blocks,
  edges: [edge('AUTO', 'EXACT'), edge('AUTO', 'PAT'), edge('EXACT', 'EXACT1', 8, 100)],
  campaignBlocks: new Map([
    ['c-auto', 'AUTO'],
    ['c-exact', 'EXACT'],
  ]),
  // Harvest-Regel der Suchbegriff-Einstufung: ab 3 Käufen, ACoS höchstens 25 %.
  harvest: { minOrders: 3, maxAcos: '0.25' },
  goalAcos: '20' as string | null,
  marked: new Set<string>(),
  exactIn: new Map<string, (string | null)[]>(),
};
const run = (rows: ReturnType<typeof row>[], patch: Partial<typeof base> = {}) =>
  graduationProposals({ ...base, ...patch, rows });

describe('graduationProposals', () => {
  it('schlägt einen Begriff vor, der die Harvest-Regel erfüllt (Kante ohne eigene Kriterien)', () => {
    expect(run([row('Trinkflasche  1L', 'c-auto', 3)])).toEqual([
      {
        termKey: 'trinkflasche 1l',
        searchTerm: 'Trinkflasche  1L',
        fromBlock: 'AUTO',
        toBlocks: ['EXACT'],
        amazonCampaignId: 'c-auto',
        clicks: 40,
        orders: 3,
        spend: '10',
        sales: '100',
        acos: '10',
      },
    ]);
  });

  it('lässt aus: zu wenige Bestellungen, ACoS über der Regel, Kampagne ohne Baustein, Baustein ohne Kante', () => {
    expect(run([row('a', 'c-auto', 2)])).toEqual([]);
    expect(run([row('a', 'c-auto', 3, '26')])).toEqual([]);
    expect(run([row('a', 'c-unbekannt', 9)])).toEqual([]);
    expect(
      run([row('a', 'c-single', 9)], { campaignBlocks: new Map([['c-single', 'EXACT1']]) }),
    ).toEqual([]);
  });

  it('summiert die Zeilen eines Begriffs je Baustein', () => {
    const [proposal] = run([row('a', 'c-auto', 2, '4'), row('A', 'c-auto', 1, '6')]);
    expect(proposal).toMatchObject({ orders: 3, clicks: 80, spend: '10', sales: '200', acos: '5' });
  });

  it('nimmt die eigenen Kriterien der Kante: Bestellungen und ACoS in Prozent des Ziels', () => {
    // Ziel 20 %, Kante 100 % → ACoS höchstens 20 %.
    expect(run([row('a', 'c-exact', 8, '20')])).toMatchObject([
      { fromBlock: 'EXACT', toBlocks: ['EXACT1'] },
    ]);
    expect(run([row('a', 'c-exact', 7, '20')])).toEqual([]);
    expect(run([row('a', 'c-exact', 8, '21')])).toEqual([]);
  });

  it('nimmt ohne Ziel den ACoS der Harvest-Regel', () => {
    expect(run([row('a', 'c-exact', 8, '25')], { goalAcos: null })).toHaveLength(1);
    expect(run([row('a', 'c-exact', 8, '26')], { goalAcos: null })).toEqual([]);
  });

  it('schickt ASIN-Suchbegriffe nur in Produkt-Bausteine und Begriffe nur in Keyword-Bausteine', () => {
    expect(run([row('b0abcd1234', 'c-auto', 3)])).toMatchObject([{ toBlocks: ['PAT'] }]);
  });

  it('lässt Begriffe aus, die schon auf der Merkliste stehen', () => {
    expect(run([row('a', 'c-auto', 3)], { marked: new Set(['a']) })).toEqual([]);
  });

  it('lässt ein Ziel aus, wenn der Begriff dort, weiter hinten oder in einer Kampagne ohne Baustein schon exakt gebucht ist', () => {
    const exactIn = (blocksOfTerm: (string | null)[]) => ({
      exactIn: new Map([['a', blocksOfTerm]]),
    });
    expect(run([row('a', 'c-auto', 3)], exactIn(['EXACT']))).toEqual([]);
    expect(run([row('a', 'c-auto', 3)], exactIn(['EXACT1']))).toEqual([]);
    expect(run([row('a', 'c-auto', 3)], exactIn([null]))).toEqual([]);
    // Exakt gebucht in der Quelle selbst hindert den Schritt in die Einzel-Kampagne nicht.
    expect(run([row('a', 'c-exact', 8)], exactIn(['EXACT']))).toHaveLength(1);
  });

  it('macht je Begriff einen Vorschlag: aus dem Baustein mit den meisten Bestellungen', () => {
    const proposals = run([row('a', 'c-auto', 3), row('a', 'c-exact', 9)]);
    expect(proposals).toMatchObject([{ termKey: 'a', fromBlock: 'EXACT', orders: 9 }]);
  });

  it('zählt Begriffe ohne Umsatz nicht (kein ACoS)', () => {
    expect(run([{ ...row('a', 'c-auto', 3), sales: '0' }])).toEqual([]);
  });
});

describe('presetSwitchProposals', () => {
  const switches = [
    { from: 'launch', to: 'standard', minOrders: 30, minSpend: null, acos: null },
    {
      from: 'standard',
      to: 'control',
      minOrders: 100,
      minSpend: null,
      acos: { comparison: 'lte' as const, percentOfGoal: 100 },
    },
    {
      from: 'standard',
      to: 'profit',
      minOrders: null,
      minSpend: '200',
      acos: { comparison: 'gte' as const, percentOfGoal: 150 },
    },
  ];
  const group = (
    presetKey: string,
    orders: number,
    spend: string,
    sales: string,
    goalAcos: string | null = '20',
  ) => ({
    id: 'g1',
    presetKey,
    orders,
    spend,
    sales,
    goalAcos,
  });
  const run = (g: ReturnType<typeof group>, eurRate = '1') =>
    presetSwitchProposals({ switches, groups: [g], eurRate });

  it('schlägt den ersten Wechsel vor, dessen Bedingungen alle zutreffen', () => {
    expect(run(group('launch', 30, '50', '400'))).toEqual([
      {
        productGroupId: 'g1',
        from: 'launch',
        to: 'standard',
        orders: 30,
        spend: '50',
        sales: '400',
        acos: '12.5',
        goalAcos: '20',
      },
    ]);
    expect(run(group('launch', 29, '50', '400'))).toEqual([]);
    // Gruppen in einem Preset ohne Wechsel bekommen nichts.
    expect(run(group('control', 500, '50', '400'))).toEqual([]);
  });

  it('prüft den ACoS gegen das Ziel in beide Richtungen', () => {
    expect(run(group('standard', 100, '80', '400'))).toMatchObject([{ to: 'control' }]);
    expect(run(group('standard', 100, '84', '400'))).toEqual([]);
    expect(run(group('standard', 10, '300', '1000'))).toMatchObject([{ to: 'profit', acos: '30' }]);
    expect(run(group('standard', 10, '290', '1000'))).toEqual([]);
  });

  it('ohne Ziel passt keine ACoS-Bedingung; Ausgaben ohne Umsatz liegen über jeder Schwelle', () => {
    expect(run(group('standard', 100, '80', '400', null))).toEqual([]);
    expect(run(group('standard', 0, '300', '0'))).toMatchObject([{ to: 'profit', acos: null }]);
  });

  it('rechnet Mindest-Ausgaben (EUR) in die Währung des Profils um', () => {
    // 200 EUR × 11 = 2200 SEK.
    expect(run(group('standard', 10, '2100', '5000'), '11')).toEqual([]);
    expect(run(group('standard', 10, '2200', '5000'), '11')).toMatchObject([{ to: 'profit' }]);
  });
});
