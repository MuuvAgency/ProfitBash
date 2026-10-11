import { describe, expect, it } from 'vitest';
import { budgetCapInputSchema, DEFAULT_CAP_WARN_PERCENTS } from './budgets';

const ID = '0b7e1a6c-3c2a-4a7e-9a52-4b8d8b0d2f11';
const base = { profileId: ID, scope: { type: 'profile', ids: [] }, amount: '1500' };
const ok = (input: object) => budgetCapInputSchema.safeParse({ ...base, ...input }).success;

describe('budgetCapInputSchema', () => {
  it('nimmt Komma im Betrag, belegt Ausnahmen und Warnschwellen vor', () => {
    expect(budgetCapInputSchema.parse({ ...base, amount: ' 1500,50 ' })).toEqual({
      ...base,
      amount: '1500.50',
      monthAmounts: {},
      warnPercents: DEFAULT_CAP_WARN_PERCENTS,
    });
    expect(DEFAULT_CAP_WARN_PERCENTS).toEqual([80, 100]);
  });

  it('Betrag über 0 mit höchstens zwei Nachkommastellen, auch je Monat', () => {
    expect(ok({ amount: '0' })).toBe(false);
    expect(ok({ amount: '10.123' })).toBe(false);
    expect(ok({ amount: '-5' })).toBe(false);
    expect(ok({ monthAmounts: { '2026-11': '3000,00' } })).toBe(true);
    expect(ok({ monthAmounts: { '2026-13': '3000' } })).toBe(false);
    expect(ok({ monthAmounts: { '2026-11': '0' } })).toBe(false);
  });

  it('Umfang: ganzes Profil ohne IDs, Portfolios und Tags mit mindestens einer', () => {
    expect(ok({ scope: { type: 'profile', ids: [ID] } })).toBe(false);
    expect(ok({ scope: { type: 'portfolios', ids: [] } })).toBe(false);
    expect(ok({ scope: { type: 'tags', ids: [ID] } })).toBe(true);
    expect(ok({ scope: { type: 'tags', ids: [ID, ID] } })).toBe(false);
  });

  it('Warnschwellen: bis zu drei verschiedene ganze Prozentwerte von 1 bis 100', () => {
    expect(ok({ warnPercents: [] })).toBe(true);
    expect(ok({ warnPercents: [50, 90, 100] })).toBe(true);
    expect(ok({ warnPercents: [80, 80] })).toBe(false);
    expect(ok({ warnPercents: [0] })).toBe(false);
    expect(ok({ warnPercents: [101] })).toBe(false);
    expect(ok({ warnPercents: [10, 20, 30, 40] })).toBe(false);
  });
});
