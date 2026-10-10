import { describe, expect, it } from 'vitest';
import { applyBidGuardrails, applyBudgetGuardrail, hasMinimumData } from './guardrails';

/** Leitplanken (`phase-5.md` 5.4): begrenzter Wert und Grund, je Leitplanke und zusammen mit Amazons Grenzen. */

const guardrails = {
  maxBidChangePercent: 25,
  bidFloorCpcPercent: 50,
  bidFloor: null,
  maxBid: null,
};
const bid = (input: Partial<Parameters<typeof applyBidGuardrails>[0]>) =>
  applyBidGuardrails({
    proposed: '1.00',
    base: '1.00',
    windowStart: '1.00',
    cpc: null,
    guardrails,
    limit: null,
    ...input,
  });

describe('applyBidGuardrails', () => {
  it('lässt einen Vorschlag innerhalb aller Grenzen unverändert', () => {
    expect(bid({ proposed: '1.10' })).toEqual({ value: '1.1', limitedBy: [] });
  });

  it('begrenzt die Änderung je 7 Tage in beide Richtungen', () => {
    expect(bid({ proposed: '2.00' })).toEqual({ value: '1.25', limitedBy: ['weeklyChange'] });
    expect(bid({ proposed: '0.10' })).toEqual({ value: '0.75', limitedBy: ['weeklyChange'] });
  });

  it('zählt Änderungen im Fenster mit: Basis ist der Wert zu Beginn der 7 Tage', () => {
    // Vor 7 Tagen 1.00, inzwischen von Hand auf 1.20: bis 1.25 ist noch Platz.
    expect(bid({ proposed: '2.00', base: '1.20' })).toEqual({
      value: '1.25',
      limitedBy: ['weeklyChange'],
    });
    // Schon über dem Rahmen (von Hand auf 1.40): nicht weiter erhöhen, aber auch nicht zurückdrehen.
    expect(bid({ proposed: '2.00', base: '1.40' })).toEqual({
      value: '1.4',
      limitedBy: ['weeklyChange'],
    });
    // Senken zurück in den Rahmen bleibt erlaubt.
    expect(bid({ proposed: '1.10', base: '1.40' })).toEqual({ value: '1.1', limitedBy: [] });
  });

  it('rundet auf zwei Stellen zur Basis hin, nie über die Grenze', () => {
    expect(bid({ proposed: '1.00', base: '0.33', windowStart: '0.33' }).value).toBe('0.41'); // 0.4125
    expect(bid({ proposed: '0.01', base: '0.33', windowStart: '0.33' }).value).toBe('0.25'); // 0.2475
  });

  it('senkt nicht unter den Boden aus CPC-Anteil und absolutem Wert (der höhere gilt)', () => {
    expect(bid({ proposed: '0.80', cpc: '1.80' })).toEqual({ value: '0.9', limitedBy: ['bidFloor'] });
    expect(
      bid({ proposed: '0.80', cpc: '1.00', guardrails: { ...guardrails, bidFloor: '0.85' } }),
    ).toEqual({ value: '0.85', limitedBy: ['bidFloor'] });
    // Basis schon unter dem Boden: nicht senken, aber auch nicht anheben.
    expect(bid({ proposed: '0.80', cpc: '2.40' })).toEqual({ value: '1', limitedBy: ['bidFloor'] });
    // Erhöhungen berührt der Boden nicht.
    expect(bid({ proposed: '1.10', cpc: '4.00' })).toEqual({ value: '1.1', limitedBy: [] });
  });

  it('erhöht nicht über das Höchstgebot', () => {
    const capped = { ...guardrails, maxBid: '1.10' };
    expect(bid({ proposed: '1.20', guardrails: capped })).toEqual({
      value: '1.1',
      limitedBy: ['maxBid'],
    });
    // Basis schon darüber: nicht erhöhen, nicht zwangsweise senken.
    expect(
      bid({ proposed: '1.60', base: '1.50', windowStart: '1.50', guardrails: capped }),
    ).toEqual({ value: '1.5', limitedBy: ['maxBid'] });
  });

  it('hält Amazons Grenzen zuletzt und in jedem Fall', () => {
    const limit = { min: '0.90', max: '1.20' };
    expect(bid({ proposed: '0.10', limit })).toEqual({
      value: '0.9',
      limitedBy: ['weeklyChange', 'amazonMin'],
    });
    expect(bid({ proposed: '5.00', limit })).toEqual({
      value: '1.2',
      limitedBy: ['weeklyChange', 'amazonMax'],
    });
    // Auch gegen die Basis: ein Gebot unter Amazons Minimum lässt sich nicht übermitteln.
    expect(bid({ proposed: '0.02', base: '0.02', windowStart: '0.02', limit })).toEqual({
      value: '0.9',
      limitedBy: ['amazonMin'],
    });
  });
});

describe('applyBudgetGuardrail', () => {
  const budget = (proposed: string, limit: { min: string; max: string } | null = null) =>
    applyBudgetGuardrail({ proposed, base: '100.00', maxDecreasePercent: 20, limit });

  it('begrenzt die Senkung je Lauf, Erhöhungen nicht', () => {
    expect(budget('50.00')).toEqual({ value: '80', limitedBy: ['budgetDecrease'] });
    expect(budget('85.00')).toEqual({ value: '85', limitedBy: [] });
    expect(budget('300.00')).toEqual({ value: '300', limitedBy: [] });
  });

  it('hält Amazons Grenzen', () => {
    expect(budget('50.00', { min: '90.00', max: '200.00' })).toEqual({
      value: '90',
      limitedBy: ['budgetDecrease', 'amazonMin'],
    });
    expect(budget('300.00', { min: '1.00', max: '200.00' })).toEqual({
      value: '200',
      limitedBy: ['amazonMax'],
    });
  });
});

describe('hasMinimumData', () => {
  const minimum = { minClicks: 15, minSpend: '10.00' };
  it('reicht mit genug Klicks oder genug Ausgaben', () => {
    expect(hasMinimumData({ clicks: 15, spend: '1.00' }, minimum)).toBe(true);
    expect(hasMinimumData({ clicks: 3, spend: '10.00' }, minimum)).toBe(true);
    expect(hasMinimumData({ clicks: 14, spend: '9.99' }, minimum)).toBe(false);
  });
});
