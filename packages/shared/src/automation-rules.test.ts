import { describe, expect, it } from 'vitest';
import {
  automationRulesSchema,
  DEFAULT_AUTOMATION_RULES,
  MAX_AUTOMATION_RULES,
} from './automation-rules';

const rule = DEFAULT_AUTOMATION_RULES[0]!;
const parse = (patch: Record<string, unknown>) =>
  automationRulesSchema.safeParse([{ ...rule, ...patch }]);

describe('automationRulesSchema', () => {
  it('nimmt die Startregeln an; jede hat eine eigene ID', () => {
    expect(automationRulesSchema.parse(DEFAULT_AUTOMATION_RULES)).toEqual(DEFAULT_AUTOMATION_RULES);
    expect(new Set(DEFAULT_AUTOMATION_RULES.map((r) => r.id)).size).toBe(
      DEFAULT_AUTOMATION_RULES.length,
    );
  });

  it('Gebots- und Budgetaktionen passen nur zu ihrer Ebene', () => {
    expect(parse({ level: 'campaign' }).success).toBe(false);
    expect(
      parse({ level: 'campaign', action: { type: 'changePercent', field: 'budget', value: '-10' } })
        .success,
    ).toBe(true);
    expect(parse({ action: { type: 'pause' } }).success).toBe(true);
    expect(parse({ level: 'campaign', action: { type: 'pause' } }).success).toBe(true);
  });

  it('„relativ zum Ziel“ gibt es nur für den ACoS', () => {
    const condition = { metric: 'clicks', comparator: 'gte', value: '120', relativeToGoal: true };
    expect(parse({ conditions: [condition] }).success).toBe(false);
    expect(parse({ conditions: [{ ...condition, metric: 'acos' }] }).success).toBe(true);
  });

  it.each([
    ['ohne Bedingung', { conditions: [] }],
    ['leerer Name', { name: ' ' }],
    [
      'Senkung um mehr als 100 %',
      { action: { type: 'changePercent', field: 'bid', value: '-101' } },
    ],
    ['setzen auf 0', { action: { type: 'set', field: 'bid', value: '0' } }],
    ['unbekannte Kennzahl', { conditions: [{ metric: 'tacos', comparator: 'gt', value: '1' }] }],
  ])('lehnt ab: %s', (_name, patch) => {
    expect(parse(patch).success).toBe(false);
  });

  it('lehnt doppelte IDs und zu viele Regeln ab', () => {
    expect(automationRulesSchema.safeParse([rule, rule]).success).toBe(false);
    const many = Array.from({ length: MAX_AUTOMATION_RULES + 1 }, (_, i) => ({
      ...rule,
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
    }));
    expect(automationRulesSchema.safeParse(many).success).toBe(false);
  });
});
