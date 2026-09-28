import { describe, expect, it } from 'vitest';
import {
  comparisonRange,
  isPeriodPreset,
  PERIOD_PRESETS,
  resolvePeriod,
  rangeDays,
  todayInBrowser,
} from './periods';

// Donnerstag, 10.09.2026
const TODAY = '2026-09-10';

describe('resolvePeriod', () => {
  it.each([
    ['yesterday', '2026-09-09', '2026-09-09'],
    ['last7', '2026-09-03', '2026-09-09'],
    ['last14', '2026-08-27', '2026-09-09'],
    ['last30', '2026-08-11', '2026-09-09'],
    // Wochen beginnen am Montag
    ['thisWeek', '2026-09-07', '2026-09-10'],
    ['lastWeek', '2026-08-31', '2026-09-06'],
    ['thisMonth', '2026-09-01', '2026-09-10'],
    ['lastMonth', '2026-08-01', '2026-08-31'],
    ['monthBeforeLast', '2026-07-01', '2026-07-31'],
    ['thirdLastMonth', '2026-06-01', '2026-06-30'],
    ['last12Months', '2025-09-01', '2026-08-31'],
    ['yearToDate', '2026-01-01', '2026-09-10'],
    ['lastYear', '2025-01-01', '2025-12-31'],
  ] as const)('%s', (preset, from, to) => {
    expect(resolvePeriod({ preset }, TODAY)).toEqual({ from, to });
  });

  it('„Diese Woche“ am Sonntag beginnt am Montag davor', () => {
    expect(resolvePeriod({ preset: 'thisWeek' }, '2026-09-13')).toEqual({
      from: '2026-09-07',
      to: '2026-09-13',
    });
  });

  it('Monate über den Jahreswechsel', () => {
    expect(resolvePeriod({ preset: 'monthBeforeLast' }, '2026-02-15')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
    expect(resolvePeriod({ preset: 'lastMonth' }, '2024-03-05')).toEqual({
      from: '2024-02-01',
      to: '2024-02-29',
    });
  });

  it('frei gewählt: der übergebene Zeitraum', () => {
    const range = { from: '2026-05-01', to: '2026-05-20' };
    expect(resolvePeriod({ preset: 'custom', range }, TODAY)).toEqual(range);
  });

  it('frei gewählt ohne Zeitraum: Standard (Letzte 30 Tage)', () => {
    expect(resolvePeriod({ preset: 'custom' }, TODAY)).toEqual(
      resolvePeriod({ preset: 'last30' }, TODAY),
    );
  });

  it('kennt alle Voreinstellungen aus F5', () => {
    expect(PERIOD_PRESETS).toHaveLength(14);
    expect(isPeriodPreset('last30')).toBe(true);
    expect(isPeriodPreset('last90')).toBe(false);
  });
});

describe('comparisonRange', () => {
  it('Vorperiode gleicher Länge direkt davor', () => {
    expect(comparisonRange({ from: '2026-09-01', to: '2026-09-10' }, 'previous')).toEqual({
      from: '2026-08-22',
      to: '2026-08-31',
    });
  });

  it('Vorjahr: dieselben Tage ein Jahr früher, 29. Februar wird 28.', () => {
    expect(comparisonRange({ from: '2026-08-01', to: '2026-08-31' }, 'previousYear')).toEqual({
      from: '2025-08-01',
      to: '2025-08-31',
    });
    expect(comparisonRange({ from: '2024-02-01', to: '2024-02-29' }, 'previousYear')).toEqual({
      from: '2023-02-01',
      to: '2023-02-28',
    });
  });

  it('aus: kein Vergleich', () => {
    expect(comparisonRange({ from: '2026-09-01', to: '2026-09-10' }, 'off')).toBeNull();
  });
});

describe('rangeDays', () => {
  it('zählt beide Enden mit, auch über die Zeitumstellung', () => {
    expect(rangeDays({ from: '2026-10-20', to: '2026-10-30' })).toBe(11);
  });
});

describe('todayInBrowser', () => {
  it('nimmt den Kalendertag der lokalen Zeit', () => {
    expect(todayInBrowser(new Date(2026, 8, 10, 23, 30))).toBe('2026-09-10');
    expect(todayInBrowser(new Date(2026, 0, 1, 0, 5))).toBe('2026-01-01');
  });
});
