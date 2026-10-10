import { describe, expect, it } from 'vitest';
import { calculateTargetAcos, effectiveGoal, goalValues, type GoalSetting } from './goals';

/** Ziele (`phase-5.md` 5.3): Umrechnung, wirksames Ziel nach Vorrang, Rechner. */

describe('goalValues', () => {
  it('rechnet ACoS (Prozent) und ROAS ineinander um; der gesetzte Wert bleibt exakt', () => {
    expect(goalValues('acos', '25')).toEqual({ acos: '25', roas: '4' });
    expect(goalValues('acos', '30')).toEqual({ acos: '30', roas: '3.33' });
    expect(goalValues('roas', '3')).toEqual({ acos: '33.33', roas: '3' });
    expect(goalValues('roas', '2.5')).toEqual({ acos: '40', roas: '2.5' });
  });
});

describe('effectiveGoal', () => {
  const goal = (
    scope: GoalSetting['scope'],
    id: string,
    metric: GoalSetting['metric'],
    value: string,
  ): GoalSetting => ({ scope, scopeId: id, metric, value });
  const goals = [
    goal('client', 'c1', 'acos', '30'),
    goal('profile', 'p1', 'acos', '25'),
    goal('productGroup', 'g1', 'acos', '20'),
    goal('productGroup', 'g2', 'roas', '6'), // = 16.67 % ACoS, strenger als g1
  ];

  it('Produktgruppe vor Profil vor Client', () => {
    expect(
      effectiveGoal(goals, { clientId: 'c1', profileId: 'p1', productGroupIds: ['g1'] }),
    ).toMatchObject({ source: 'productGroup', scopeId: 'g1', acos: '20' });
    expect(
      effectiveGoal(goals, { clientId: 'c1', profileId: 'p1', productGroupIds: [] }),
    ).toMatchObject({ source: 'profile', scopeId: 'p1', acos: '25' });
    expect(
      effectiveGoal(goals, { clientId: 'c1', profileId: 'p2', productGroupIds: ['g9'] }),
    ).toMatchObject({ source: 'client', scopeId: 'c1', acos: '30', roas: '3.33' });
  });

  it('mehrere Produktgruppen: das strengste Ziel (niedrigster ACoS) gilt', () => {
    expect(
      effectiveGoal(goals, { clientId: 'c1', profileId: 'p1', productGroupIds: ['g1', 'g2'] }),
    ).toMatchObject({
      source: 'productGroup',
      scopeId: 'g2',
      metric: 'roas',
      value: '6',
      acos: '16.67',
    });
  });

  it('ohne passendes Ziel (oder Profil ohne Client) nichts', () => {
    expect(
      effectiveGoal(goals, { clientId: null, profileId: 'p2', productGroupIds: [] }),
    ).toBeNull();
    expect(
      effectiveGoal([], { clientId: 'c1', profileId: 'p1', productGroupIds: ['g1'] }),
    ).toBeNull();
  });
});

describe('calculateTargetAcos', () => {
  it('Break-even-ACoS aus Preis, Kosten je Einheit und Gebühren; Ziel = Break-even minus Marge', () => {
    // (29.99 − 9.50 − 8.20) / 29.99 = 40.98 %
    expect(
      calculateTargetAcos({ price: '29.99', unitCost: '9.50', fees: '8.20', margin: '10' }),
    ).toEqual({ breakEvenAcos: '40.98', targetAcos: '30.98', targetRoas: '3.23' });
  });

  it('ohne Marge ist das Ziel der Break-even', () => {
    expect(calculateTargetAcos({ price: '20', unitCost: '5', fees: '5', margin: '0' })).toEqual({
      breakEvenAcos: '50',
      targetAcos: '50',
      targetRoas: '2',
    });
  });

  it('kein Ziel, wenn nach Kosten nichts für Werbung bleibt', () => {
    expect(calculateTargetAcos({ price: '10', unitCost: '6', fees: '5', margin: '0' })).toEqual({
      breakEvenAcos: '-10',
      targetAcos: null,
      targetRoas: null,
    });
    expect(calculateTargetAcos({ price: '20', unitCost: '5', fees: '5', margin: '50' })).toEqual({
      breakEvenAcos: '50',
      targetAcos: null,
      targetRoas: null,
    });
  });
});
