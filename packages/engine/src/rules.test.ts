import type { AutomationRule } from '@profitbash/shared/automation-rules';
import { describe, expect, it } from 'vitest';
import { firstMatchingRule, ruleProposal, type RuleSubject } from './rules';

/** Regeln (`phase-5.md` 5.6a): erste passende Regel gewinnt; Aktion → gewünschter Wert vor den Leitplanken. */

const rule = (patch: Partial<AutomationRule>): AutomationRule => ({
  id: patch.name ?? 'r',
  name: 'r',
  level: 'target',
  conditions: [{ metric: 'clicks', comparator: 'gte', value: '30' }],
  action: { type: 'changePercent', field: 'bid', value: '-20' },
  clientId: null,
  enabled: true,
  ...patch,
});
const subject = (patch: Partial<RuleSubject> = {}): RuleSubject => ({
  level: 'target',
  clientId: 'c1',
  metrics: { impressions: 5000, clicks: 40, orders: 2, spend: '40.00', sales: '100.00' },
  goalAcos: '20',
  eurRate: '1',
  ...patch,
});
const metrics = (patch: Partial<RuleSubject['metrics']>) => ({
  metrics: { ...subject().metrics, ...patch },
});
const matches = (conditions: AutomationRule['conditions'], s = subject()) =>
  firstMatchingRule([rule({ conditions })], s) !== null;

describe('firstMatchingRule', () => {
  it('nimmt die erste passende Regel in der Reihenfolge der Liste', () => {
    const rules = [
      rule({ name: 'a', conditions: [{ metric: 'clicks', comparator: 'gte', value: '100' }] }),
      rule({ name: 'b' }),
      rule({ name: 'c' }),
    ];
    expect(firstMatchingRule(rules, subject())?.name).toBe('b');
    expect(firstMatchingRule(rules, subject(metrics({ clicks: 5 })))).toBeNull();
  });

  it('überspringt abgeschaltete Regeln, andere Ebenen und Regeln anderer Clients', () => {
    expect(firstMatchingRule([rule({ enabled: false })], subject())).toBeNull();
    expect(firstMatchingRule([rule({ level: 'campaign' })], subject())).toBeNull();
    expect(firstMatchingRule([rule({ clientId: 'c2' })], subject())).toBeNull();
    expect(firstMatchingRule([rule({ clientId: 'c1' })], subject())).not.toBeNull();
    // Regeln für alle gelten auch für Profile ohne Client, Regeln eines Clients nicht.
    expect(firstMatchingRule([rule({})], subject({ clientId: null }))).not.toBeNull();
    expect(firstMatchingRule([rule({ clientId: 'c1' })], subject({ clientId: null }))).toBeNull();
  });

  it('verlangt alle Bedingungen und kennt alle Vergleiche', () => {
    expect(
      matches([
        { metric: 'clicks', comparator: 'gt', value: '39' },
        { metric: 'orders', comparator: 'lte', value: '2' },
        { metric: 'impressions', comparator: 'lt', value: '5001' },
      ]),
    ).toBe(true);
    expect(
      matches([
        { metric: 'clicks', comparator: 'gt', value: '40' },
        { metric: 'orders', comparator: 'lte', value: '2' },
      ]),
    ).toBe(false);
  });

  it('rechnet ACoS (Prozent) und CPC aus den Summen', () => {
    expect(matches([{ metric: 'acos', comparator: 'gte', value: '40' }])).toBe(true);
    expect(matches([{ metric: 'acos', comparator: 'gt', value: '40' }])).toBe(false);
    expect(matches([{ metric: 'cpc', comparator: 'lte', value: '1' }])).toBe(true);
    // Ausgaben ohne Umsatz: ACoS über jeder Schwelle. Ohne Ausgaben bzw. Klicks gibt es keinen Wert.
    const noSales = subject(metrics({ sales: '0', orders: 0 }));
    expect(matches([{ metric: 'acos', comparator: 'gt', value: '9999' }], noSales)).toBe(true);
    expect(matches([{ metric: 'acos', comparator: 'lt', value: '9999' }], noSales)).toBe(false);
    const nothing = subject(metrics({ clicks: 0, spend: '0', sales: '0', orders: 0 }));
    expect(matches([{ metric: 'acos', comparator: 'gt', value: '1' }], nothing)).toBe(false);
    expect(matches([{ metric: 'acos', comparator: 'lt', value: '1' }], nothing)).toBe(false);
    expect(matches([{ metric: 'cpc', comparator: 'lt', value: '1' }], nothing)).toBe(false);
  });

  it('vergleicht relativ zum Ziel; ohne Ziel passt die Bedingung nicht', () => {
    const relative = (value: string) =>
      [{ metric: 'acos', comparator: 'gte', value, relativeToGoal: true }] as const;
    // ACoS 40 %, Ziel 20 % → 200 % des Ziels
    expect(matches([...relative('200')])).toBe(true);
    expect(matches([...relative('201')])).toBe(false);
    expect(matches([...relative('150')], subject({ goalAcos: null }))).toBe(false);
  });

  it('rechnet Beträge der Regel aus EUR in die Währung des Profils um', () => {
    const sek = subject({ ...metrics({ spend: '460.00', sales: '1150.00' }), eurRate: '11.5' });
    expect(matches([{ metric: 'spend', comparator: 'gte', value: '40' }], sek)).toBe(true);
    expect(matches([{ metric: 'spend', comparator: 'gt', value: '40' }], sek)).toBe(false);
    expect(matches([{ metric: 'cpc', comparator: 'gte', value: '1' }], sek)).toBe(true);
    // Zähler und Prozente bleiben, wie sie sind.
    expect(matches([{ metric: 'clicks', comparator: 'gte', value: '40' }], sek)).toBe(true);
  });
});

describe('ruleProposal', () => {
  it('ändert um Prozent oder Betrag, setzt oder pausiert', () => {
    const on = (action: AutomationRule['action'], eurRate = '1') =>
      ruleProposal(action, '2.00', eurRate);
    expect(on({ type: 'changePercent', field: 'bid', value: '-20' })).toEqual({ value: '1.6' });
    expect(on({ type: 'changePercent', field: 'bid', value: '12.5' })).toEqual({ value: '2.25' });
    expect(on({ type: 'changeAbsolute', field: 'bid', value: '-0.30' })).toEqual({ value: '1.7' });
    expect(on({ type: 'set', field: 'bid', value: '0.75' })).toEqual({ value: '0.75' });
    expect(on({ type: 'pause' })).toEqual({ pause: true });
    // Beträge in EUR, umgerechnet; nie unter 0.
    expect(on({ type: 'changeAbsolute', field: 'bid', value: '0.10' }, '11.5')).toEqual({
      value: '3.15',
    });
    expect(on({ type: 'set', field: 'bid', value: '0.75' }, '11.5')).toEqual({ value: '8.625' });
    expect(on({ type: 'changeAbsolute', field: 'bid', value: '-5' })).toEqual({ value: '0' });
  });
});
