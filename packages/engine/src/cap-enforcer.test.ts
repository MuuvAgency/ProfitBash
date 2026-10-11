import { describe, expect, it } from 'vitest';
import { enforceCap, type CapCampaign } from './cap-enforcer';

/** Enforcer (`phase-5.md` 5.9b, F6): Prognose über Cap → Tagesbudgets anteilig senken, im Zweifel pausieren. */

const campaign = (
  id: string,
  cost: string,
  dailyBudget: string | null,
  rest: Partial<CapCampaign> = {},
): CapCampaign => ({
  id,
  cost,
  periodStart: '2026-10-01',
  periodEnd: '2026-10-10',
  active: true,
  dailyBudget,
  limit: null,
  ...rest,
});
const enforce = (campaigns: CapCampaign[], maxBudgetDecreasePercent = 100, cap = '1000') =>
  enforceCap({ month: '2026-10', cap, campaigns, maxBudgetDecreasePercent });

describe('enforceCap', () => {
  it('tut nichts, solange die Prognose den Cap hält', () => {
    // 300 + 21 × 30 = 930
    expect(enforce([campaign('a', '300', '50')])).toEqual([]);
  });

  it('senkt die Tagesbudgets anteilig, bis die Prognose den Cap trifft', () => {
    // Ist 900, je Tag 60 + 30; übrig sind 100 für 21 Tage: Faktor 100 / 1890.
    expect(enforce([campaign('a', '600', '100'), campaign('b', '300', '40')])).toEqual([
      { id: 'a', field: 'budget', before: '100', after: '3.17', desired: '3.17', limitedBy: [] },
      { id: 'b', field: 'budget', before: '40', after: '1.59', desired: '1.59', limitedBy: [] },
    ]);
  });

  it('hält die Budget-Leitplanke (höchste Senkung je Lauf) und Amazons Grenzen', () => {
    expect(enforce([campaign('a', '600', '100')], 20)).toEqual([
      {
        id: 'a',
        field: 'budget',
        before: '100',
        after: '80',
        desired: '19.05',
        limitedBy: ['budgetDecrease'],
      },
    ]);
    const [limited] = enforce([
      campaign('a', '600', '100', { limit: { min: '25', max: '1000000' } }),
    ]);
    expect(limited).toMatchObject({ after: '25', limitedBy: ['amazonMin'] });
  });

  it('lässt aus, was sich nicht senken lässt: pausiert, ohne Tagesbudget, ohne Ausgaben, schon am Minimum', () => {
    // Ist 1300, Prognose 2581 bei einem Cap von 2000.
    expect(
      enforce(
        [
          campaign('a', '100', '100', { active: false }),
          campaign('b', '0', '100'),
          campaign('c', '600', null),
          campaign('d', '600', '1', { limit: { min: '1', max: '1000000' } }),
        ],
        100,
        '2000',
      ),
    ).toEqual([]);
  });

  it('pausiert alle aktiven Kampagnen, wenn schon die untere Schätzung über dem Cap liegt', () => {
    expect(
      enforce([
        campaign('a', '900', '100'),
        campaign('b', '200', null),
        campaign('c', '50', '10', { active: false }),
      ]),
    ).toEqual([
      { id: 'a', field: 'state' },
      { id: 'b', field: 'state' },
    ]);
  });

  it('geschätztes Ist über dem Cap, untere Schätzung darunter: senken statt pausieren', () => {
    // 30 Tage, 20 im Oktober: Ist ≈ 1200, untere Schätzung 900.
    const [action] = enforce(
      [campaign('a', '1800', '100', { periodStart: '2026-09-21', periodEnd: '2026-10-20' })],
      20,
    );
    expect(action).toMatchObject({ field: 'budget', after: '80', desired: '0' });
  });
});
