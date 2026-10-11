import { describe, expect, it } from 'vitest';
import { computePacing, monthInTimeZone, type PacingCampaign } from './pacing';

/** Pacing (`phase-5.md` 5.9a): Ist im Monat aus Zeitraumsummen, Soll linear, Prognose zum Monatsende. */

const campaign = (
  cost: string,
  periodStart: string,
  periodEnd: string,
  rest: Partial<PacingCampaign> = {},
): PacingCampaign => ({ cost, periodStart, periodEnd, active: true, dailyBudget: null, ...rest });

const pacing = (campaigns: PacingCampaign[], month = '2026-10', cap = '1000') =>
  computePacing({ month, cap, warnPercents: [80, 100], campaigns });

describe('computePacing', () => {
  it('Zeitraum ganz im Monat: Ist exakt, Soll linear bis zum Datenstand, Prognose mit dem Tagesschnitt', () => {
    expect(pacing([campaign('300', '2026-10-01', '2026-10-10')])).toEqual({
      daysInMonth: 31,
      elapsedDays: 10,
      dataThrough: '2026-10-10',
      exact: true,
      actual: { value: '300', low: '300', high: '300' },
      planned: '322.58',
      // 30 je Tag für die übrigen 21 Tage.
      forecast: { value: '930', low: '930', high: '930' },
      warnLevel: null,
      forecastOver: false,
    });
  });

  it('Datei über zwei Monate: anteilig geschätzt, Spanne ± die Hälfte des kleineren Teils', () => {
    // 30 Tage, davon 10 im Oktober: 100 anteilig, außerhalb 200.
    const result = pacing([campaign('300', '2026-09-11', '2026-10-10')]);
    expect(result.exact).toBe(false);
    expect(result.actual).toEqual({ value: '100', low: '50', high: '150' });
    expect(result.forecast).toEqual({ value: '310', low: '260', high: '360' });
    // 27 von 30 Tagen im Monat: die Spanne wird schmal.
    expect(pacing([campaign('300', '2026-09-28', '2026-10-27')]).actual).toEqual({
      value: '270',
      low: '255',
      high: '285',
    });
  });

  it('Monatswechsel: Daten enden vor dem Monat → kein Ist, Prognose über den ganzen Monat', () => {
    expect(pacing([campaign('300', '2026-09-01', '2026-09-30')])).toMatchObject({
      elapsedDays: 0,
      dataThrough: null,
      exact: false,
      actual: { value: '0', low: '0', high: '0' },
      planned: '0',
      forecast: { value: '310', low: '310', high: '310' },
    });
    // Ein vergangener Monat hat keine übrigen Tage; der Februar hat 28.
    expect(pacing([campaign('280', '2026-02-01', '2026-02-28')], '2026-02')).toMatchObject({
      daysInMonth: 28,
      elapsedDays: 28,
      planned: '1000',
      forecast: { value: '280' },
    });
    expect(pacing([campaign('300', '2026-10-01', '2026-10-10')], '2026-09').forecast.value).toBe(
      '0',
    );
  });

  it('Prognose: pausierte Kampagnen geben nichts mehr aus, das Tagesbudget deckelt den Tagesschnitt', () => {
    expect(
      pacing([campaign('300', '2026-10-01', '2026-10-10', { active: false })]).forecast.value,
    ).toBe('300');
    expect(
      pacing([campaign('300', '2026-10-01', '2026-10-10', { dailyBudget: '20' })]).forecast.value,
    ).toBe('720');
    expect(
      pacing([campaign('300', '2026-10-01', '2026-10-10', { dailyBudget: '50' })]).forecast.value,
    ).toBe('930');
  });

  it('mehrere Kampagnen mit eigenem Datenstand werden einzeln gerechnet und summiert', () => {
    const result = pacing([
      campaign('300', '2026-10-01', '2026-10-10'),
      campaign('120.50', '2026-10-01', '2026-10-20'),
      campaign('0', '2026-10-01', '2026-10-20'),
    ]);
    expect(result).toMatchObject({
      dataThrough: '2026-10-20',
      elapsedDays: 20,
      exact: true,
      actual: { value: '420.5' },
      planned: '645.16',
      // 300 + 21 × 30 und 120,50 + 11 × 6,025
      forecast: { value: '1116.78' },
      forecastOver: true,
    });
  });

  it('Warnschwelle: die höchste erreichte, gemessen am geschätzten Ist', () => {
    const at = (cost: string, cap = '1000') =>
      pacing([campaign(cost, '2026-10-01', '2026-10-10', { active: false })], '2026-10', cap);
    expect(at('799.99').warnLevel).toBeNull();
    expect(at('800').warnLevel).toBe(80);
    expect(at('1000')).toMatchObject({ warnLevel: 100, forecastOver: false });
    expect(at('1000.01').forecastOver).toBe(true);
    expect(computePacing({ month: '2026-10', cap: '1000', warnPercents: [], campaigns: [] })).toMatchObject({
      warnLevel: null,
      actual: { value: '0' },
      forecast: { value: '0' },
    });
  });
});

describe('monthInTimeZone', () => {
  it('nimmt den Monat in der Zeitzone des Profils', () => {
    const now = new Date('2026-10-31T23:30:00Z');
    expect(monthInTimeZone(now, 'Europe/Berlin')).toBe('2026-11');
    expect(monthInTimeZone(now, 'America/Los_Angeles')).toBe('2026-10');
    expect(monthInTimeZone(new Date('2026-01-01T02:00:00Z'), 'America/Los_Angeles')).toBe(
      '2025-12',
    );
  });
});
