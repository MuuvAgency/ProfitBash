import { describe, expect, it } from 'vitest';
import { goalValueIssue, setGoalRequestSchema, targetAcosRequestSchema } from './goals';

const ID = '0b7e1a6c-3c2a-4a7e-9a52-4b8d8b0d2f11';

describe('goalValueIssue', () => {
  it('ACoS über 0 bis 100 %, ROAS 1 bis 100, höchstens zwei Nachkommastellen', () => {
    expect(goalValueIssue('acos', '25')).toBeNull();
    expect(goalValueIssue('acos', '100')).toBeNull();
    expect(goalValueIssue('acos', '0.01')).toBeNull();
    expect(goalValueIssue('acos', '0')).toBe('range');
    expect(goalValueIssue('acos', '100.01')).toBe('range');
    expect(goalValueIssue('roas', '1')).toBeNull();
    expect(goalValueIssue('roas', '0.99')).toBe('range');
    expect(goalValueIssue('roas', '100.5')).toBe('range');
    expect(goalValueIssue('acos', '25.123')).toBe('format');
    expect(goalValueIssue('acos', '-5')).toBe('format');
    expect(goalValueIssue('acos', '1e2')).toBe('format');
  });
});

describe('setGoalRequestSchema', () => {
  it('nimmt Komma als Dezimaltrennzeichen und prüft den Bereich je Kennzahl', () => {
    expect(
      setGoalRequestSchema.parse({
        scope: { type: 'client', id: ID },
        metric: 'acos',
        value: ' 22,5 ',
      }),
    ).toEqual({ scope: { type: 'client', id: ID }, metric: 'acos', value: '22.5' });
    expect(
      setGoalRequestSchema.safeParse({
        scope: { type: 'profile', id: ID },
        metric: 'roas',
        value: '0.5',
      }).success,
    ).toBe(false);
    expect(
      setGoalRequestSchema.safeParse({
        scope: { type: 'team', id: ID },
        metric: 'acos',
        value: '5',
      }).success,
    ).toBe(false);
  });
});

describe('targetAcosRequestSchema', () => {
  it('verlangt einen Preis über 0 und eine Marge bis 100 %', () => {
    const base = { price: '29,99', unitCost: '9.5', fees: '8.2', margin: '10' };
    expect(targetAcosRequestSchema.parse(base)).toEqual({ ...base, price: '29.99' });
    expect(targetAcosRequestSchema.safeParse({ ...base, price: '0' }).success).toBe(false);
    expect(targetAcosRequestSchema.safeParse({ ...base, margin: '101' }).success).toBe(false);
    expect(targetAcosRequestSchema.safeParse({ ...base, fees: '-1' }).success).toBe(false);
  });
});
