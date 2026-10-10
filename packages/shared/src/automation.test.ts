import { describe, expect, it } from 'vitest';
import {
  DEFAULT_GUARDRAILS,
  guardrailsSchema,
  setClientAutomationRequestSchema,
} from './automation';

describe('guardrailsSchema', () => {
  it('nimmt die Startwerte an', () => {
    expect(guardrailsSchema.parse(DEFAULT_GUARDRAILS)).toEqual(DEFAULT_GUARDRAILS);
  });

  it('nimmt Beträge mit Komma und gibt Decimal-Strings zurück', () => {
    const parsed = guardrailsSchema.parse({ ...DEFAULT_GUARDRAILS, maxBidEur: ' 2,50 ' });
    expect(parsed.maxBidEur).toBe('2.50');
  });

  it.each([
    ['maxBidChangePercent', 0],
    ['maxBidChangePercent', 101],
    ['maxBidChangePercent', 12.5],
    ['bidFloorCpcPercent', -1],
    ['maxBudgetDecreasePercent', 0],
    ['minClicks', -1],
    ['maxBidEur', '0'],
    ['maxBidEur', '1.234'],
    ['minSpendEur', null],
    ['minSpendEur', 'abc'],
  ])('lehnt %s = %s ab', (key, value) => {
    expect(guardrailsSchema.safeParse({ ...DEFAULT_GUARDRAILS, [key]: value }).success).toBe(false);
  });
});

describe('setClientAutomationRequestSchema', () => {
  it('nimmt einzelne überschriebene Werte; fehlende erben, null heißt „keiner“', () => {
    const parsed = setClientAutomationRequestSchema.parse({
      mode: 'shadow',
      responsibleUserId: null,
      overrides: { maxBidChangePercent: 10, maxBidEur: null },
    });
    expect(parsed.overrides).toEqual({ maxBidChangePercent: 10, maxBidEur: null });
  });

  it('lehnt unbekannte Modi und Felder ab', () => {
    const base = { mode: 'shadow', responsibleUserId: null, overrides: {} };
    expect(setClientAutomationRequestSchema.safeParse({ ...base, mode: 'auto' }).success).toBe(false);
    expect(
      setClientAutomationRequestSchema.safeParse({ ...base, overrides: { foo: 1 } }).success,
    ).toBe(false);
  });
});
