import { describe, expect, it } from 'vitest';
import { suggestBid, type BidSuggestionInput } from './optimizer';

/** Optimizer (`phase-5.md` 5.5): Gebotsvorschlag je Target aus Zeitraumsummen und wirksamem Ziel. */

const sums = (clicks: number, spend: string, sales: string) => ({ clicks, spend, sales });
const guardrails = {
  maxBidChangePercent: 50,
  bidFloorCpcPercent: 50,
  bidFloor: null,
  maxBid: null,
  minClicks: 15,
  minSpend: '10.00',
};
/** Target mit ACoS 40 % (CPC 1.00) in einer Ad Group und Kampagne mit mehr Daten. */
const input = (patch: Partial<BidSuggestionInput> = {}): BidSuggestionInput => ({
  target: { state: 'ENABLED', bid: '1.00', metrics: sums(40, '40.00', '100.00') },
  adGroup: { state: 'ENABLED', defaultBid: '0.60', metrics: sums(200, '180.00', '600.00') },
  campaign: { state: 'ENABLED', costType: null, metrics: sums(1000, '900.00', '2500.00') },
  goalAcos: '20',
  guardrails,
  limit: null,
  ...patch,
});
const target = (patch: Partial<BidSuggestionInput['target']>) => ({
  target: { ...input().target, ...patch },
});

describe('suggestBid', () => {
  it('senkt über dem Ziel: Zielgebot = geglätteter Wert je Klick × Ziel-ACoS', () => {
    // Kampagne 2.5 je Klick → Ad Group (600 + 12 × 2.5) / 212 → Target (100 + 12 × 2.9717) / 52 = 2.6089
    expect(suggestBid(input())).toEqual({
      kind: 'suggestion',
      bid: '0.53',
      base: '1',
      hasOwnBid: true,
      valuePerClick: '2.6089',
      targetBid: '0.5218',
      limitedBy: [],
    });
  });

  it('erhöht unter dem Ziel', () => {
    expect(suggestBid(input({ goalAcos: '50' }))).toMatchObject({ bid: '1.3', limitedBy: [] });
  });

  it('wendet die Leitplanken an und nennt sie', () => {
    const tight = { ...guardrails, maxBidChangePercent: 25 };
    expect(suggestBid(input({ guardrails: tight }))).toMatchObject({
      bid: '0.75',
      targetBid: '0.5218',
      limitedBy: ['weeklyChange'],
    });
    expect(
      suggestBid(input({ goalAcos: '50', guardrails: { ...tight, maxBid: '1.10' } })),
    ).toMatchObject({
      bid: '1.1',
      limitedBy: ['weeklyChange', 'maxBid'],
    });
    expect(suggestBid(input({ limit: { min: '0.60', max: '5.00' } }))).toMatchObject({
      bid: '0.6',
      limitedBy: ['amazonMin'],
    });
    // Das Fenster der letzten 7 Tage kommt vom Aufrufer.
    expect(
      suggestBid(input({ guardrails: tight, base: '0.80', windowStart: '1.00' })),
    ).toMatchObject({
      bid: '0.75',
      base: '0.8',
    });
  });

  it('ohne Bestellung sinkt der Wert je Klick mit jedem Klick, der Boden hält das Gebot', () => {
    const noOrders = target({ metrics: sums(30, '24.00', '0') });
    // (0 + 12 × 2.9717) / 42 = 0.8491 je Klick → Zielgebot 0.1698, Boden 50 % von CPC 0.80
    expect(
      suggestBid(input({ ...noOrders, guardrails: { ...guardrails, maxBidChangePercent: 100 } })),
    ).toMatchObject({
      bid: '0.4',
      valuePerClick: '0.8491',
      limitedBy: ['bidFloor'],
    });
  });

  it('glättet wenige Klicks gegen Ad Group und Kampagne', () => {
    // 2 Klicks mit 50 Umsatz wären 25 je Klick; genug Ausgaben für einen Vorschlag.
    const few = target({ metrics: sums(2, '12.00', '50.00') });
    expect(suggestBid(input(few))).toMatchObject({ valuePerClick: '6.1186' });
  });

  it('rechnet ohne Daten der Ebenen darüber mit dem eigenen Wert je Klick', () => {
    const alone = input({
      adGroup: { state: 'ENABLED', defaultBid: null, metrics: null },
      campaign: { state: 'ENABLED', costType: null, metrics: null },
    });
    expect(suggestBid(alone)).toMatchObject({ valuePerClick: '2.5', bid: '0.5', limitedBy: [] });
  });

  it('schlägt für Targets ohne eigenes Gebot ein eigenes vor, ausgehend vom Standardgebot der Ad Group', () => {
    expect(suggestBid(input(target({ bid: null })))).toMatchObject({
      kind: 'suggestion',
      base: '0.6',
      hasOwnBid: false,
      bid: '0.53',
    });
  });

  it('rechnet in jeder Währung gleich (Beträge in der Währung des Profils)', () => {
    const sek = input({
      target: { state: 'ENABLED', bid: '12.00', metrics: sums(40, '480.00', '1200.00') },
      adGroup: { state: 'ENABLED', defaultBid: null, metrics: null },
      campaign: { state: 'ENABLED', costType: null, metrics: null },
      goalAcos: '25',
      guardrails: { ...guardrails, minSpend: '115.00', maxBid: '34.50' },
    });
    // 30 je Klick × 25 % = 7.50; Boden 50 % von CPC 12.00
    expect(suggestBid(sek)).toMatchObject({ bid: '7.5', limitedBy: [] });
  });

  it.each([
    ['zu wenig Daten', target({ metrics: sums(14, '9.99', '80.00') }), 'insufficientData'],
    ['kein Ziel', { goalAcos: null }, 'noGoal'],
    ['pausiertes Target', target({ state: 'PAUSED' }), 'inactive'],
    ['archivierte Ad Group', { adGroup: { ...input().adGroup, state: 'ARCHIVED' } }, 'inactive'],
    ['pausierte Kampagne', { campaign: { ...input().campaign, state: 'PAUSED' } }, 'inactive'],
    ['vCPM-Kampagne', { campaign: { ...input().campaign, costType: 'VCPM' } }, 'vcpm'],
    [
      'kein Gebot und kein Standardgebot',
      { ...target({ bid: null }), adGroup: { ...input().adGroup, defaultBid: null } },
      'noBase',
    ],
  ] as const)('kein Vorschlag: %s', (_name, patch, reason) => {
    expect(suggestBid(input(patch as Partial<BidSuggestionInput>))).toEqual({
      kind: 'none',
      reason,
    });
  });

  it('kein Vorschlag, wenn das Gebot schon passt oder eine Leitplanke es festhält', () => {
    expect(suggestBid(input({ goalAcos: '38.33' }))).toEqual({ kind: 'none', reason: 'unchanged' });
    // Basis liegt schon unter dem Boden (CPC 1.00 → 0.50): nicht weiter senken.
    expect(suggestBid(input({ goalAcos: '10', base: '0.45', windowStart: '0.45' }))).toEqual({
      kind: 'none',
      reason: 'unchanged',
    });
  });
});
