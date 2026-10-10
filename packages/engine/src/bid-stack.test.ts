import { describe, expect, it } from 'vitest';
import { simulateBidStack, type BidStackInput } from './bid-stack';

/**
 * Gebots-Stack-Simulator (`phase-4.md` 4.8, F12): höchstes und niedrigstes Gebot je Platzierung, Amazon Business und
 * Zielgruppe. Regeln laut SP-v3-Spec und Amazon-Guide (2026-10-10): Anpassungen multiplizieren sich, die Strategie
 * wirkt auf das angepasste Gebot (hoch und runter ±100 % auf allen Platzierungen, nur senken bis −100 %, fest 0 %).
 */

const input = (overrides: Partial<BidStackInput> = {}): BidStackInput => ({
  bid: '1.00',
  strategy: 'NONE',
  placements: { top: 50, productPages: 0, restOfSearch: 0 },
  amazonBusiness: null,
  audiences: [],
  ...overrides,
});
const row = (
  result: ReturnType<typeof simulateBidStack>,
  placement: 'top' | 'productPages' | 'restOfSearch',
  amazonBusiness = false,
  audience: string | null = null,
) =>
  result.rows.find(
    (entry) =>
      entry.placement === placement &&
      entry.amazonBusiness === amazonBusiness &&
      entry.audience === audience,
  );

describe('simulateBidStack', () => {
  it('rechnet bei festem Gebot nur mit den Platzierungen', () => {
    const result = simulateBidStack(input());
    expect(result.rows).toHaveLength(3);
    expect(row(result, 'top')).toMatchObject({ factor: '1.5', min: '1.50', max: '1.50' });
    expect(row(result, 'productPages')).toMatchObject({ min: '1.00', max: '1.00' });
  });

  it('multipliziert Platzierung, Amazon Business und Zielgruppe (Beispiele der Spec)', () => {
    const result = simulateBidStack(
      input({ amazonBusiness: 100, audiences: [{ label: 'Wiederkäufer', percentage: 100 }] }),
    );
    // 3 Platzierungen × (ohne/mit Amazon Business) × (ohne/mit Zielgruppe)
    expect(result.rows).toHaveLength(12);
    expect(row(result, 'top', true)).toMatchObject({ max: '3.00' });
    expect(row(result, 'productPages', true)).toMatchObject({ max: '2.00' });
    expect(row(result, 'top', false, 'Wiederkäufer')).toMatchObject({ max: '3.00' });
    expect(row(result, 'top', true, 'Wiederkäufer')).toMatchObject({ factor: '6', max: '6.00' });
  });

  it('gibt den dynamischen Strategien ihre Spanne', () => {
    const upAndDown = simulateBidStack(input({ strategy: 'SALES_UP_AND_DOWN' }));
    expect(row(upAndDown, 'top')).toMatchObject({ min: '0.00', max: '3.00' });
    expect(row(upAndDown, 'restOfSearch')).toMatchObject({ min: '0.00', max: '2.00' });
    const downOnly = simulateBidStack(input({ strategy: 'SALES_DOWN_ONLY' }));
    expect(row(downOnly, 'top')).toMatchObject({ min: '0.00', max: '1.50' });
  });

  it('rundet auf zwei Nachkommastellen (half-even) und nennt das höchste Gebot insgesamt', () => {
    const result = simulateBidStack(
      input({ bid: '0.35', placements: { top: 15, productPages: 0, restOfSearch: 0 } }),
    );
    // 0.35 × 1.15 = 0.4025 → 0.40
    expect(row(result, 'top')).toMatchObject({ max: '0.40' });
    expect(result.highest).toBe('0.40');
  });

  it('weist auf regelbasierte Gebote hin, die Amazon nicht beziffert', () => {
    const result = simulateBidStack(input({ strategy: 'RULE_BASED' }));
    expect(result.hints).toEqual(['ruleBasedUnknown']);
    expect(row(result, 'top')).toMatchObject({ min: '1.50', max: '1.50' });
  });

  it('lehnt ungültige Eingaben ab', () => {
    expect(() => simulateBidStack(input({ bid: '-1' }))).toThrow(RangeError);
    expect(() =>
      simulateBidStack(input({ placements: { top: 901, productPages: 0, restOfSearch: 0 } })),
    ).toThrow(RangeError);
    expect(() =>
      simulateBidStack(
        input({
          audiences: Array.from({ length: 11 }, (_, i) => ({ label: `A${i}`, percentage: 1 })),
        }),
      ),
    ).toThrow(RangeError);
  });
});
