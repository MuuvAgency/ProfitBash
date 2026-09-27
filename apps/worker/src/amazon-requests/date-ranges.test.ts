import { describe, expect, it } from 'vitest';
import { addDays, splitDateRange, subtractDateRanges, todayIn } from './date-ranges';

const range = (startDate: string, endDate: string) => ({ startDate, endDate });

describe('subtractDateRanges', () => {
  it('lässt den Zeitraum unverändert, wenn nichts ihn abdeckt', () => {
    expect(subtractDateRanges(range('2026-09-01', '2026-09-30'), [])).toEqual([
      range('2026-09-01', '2026-09-30'),
    ]);
    expect(
      subtractDateRanges(range('2026-09-01', '2026-09-30'), [range('2026-10-01', '2026-10-05')]),
    ).toEqual([range('2026-09-01', '2026-09-30')]);
  });

  it('schneidet abgedeckte Tage am Rand und in der Mitte heraus', () => {
    expect(
      subtractDateRanges(range('2026-09-01', '2026-09-30'), [
        range('2026-08-20', '2026-09-03'),
        range('2026-09-10', '2026-09-12'),
        range('2026-09-29', '2026-10-10'),
      ]),
    ).toEqual([range('2026-09-04', '2026-09-09'), range('2026-09-13', '2026-09-28')]);
  });

  it('kommt mit überlappenden und unsortierten Abdeckungen und Monatsgrenzen zurecht', () => {
    expect(
      subtractDateRanges(range('2026-02-25', '2026-03-05'), [
        range('2026-03-01', '2026-03-02'),
        range('2026-02-27', '2026-03-01'),
      ]),
    ).toEqual([range('2026-02-25', '2026-02-26'), range('2026-03-03', '2026-03-05')]);
  });

  it('liefert nichts, wenn alle Tage abgedeckt sind', () => {
    expect(
      subtractDateRanges(range('2026-09-01', '2026-09-30'), [
        range('2026-09-01', '2026-09-15'),
        range('2026-09-16', '2026-09-30'),
      ]),
    ).toEqual([]);
  });

  it('behandelt einzelne Tage', () => {
    expect(
      subtractDateRanges(range('2026-09-01', '2026-09-03'), [range('2026-09-02', '2026-09-02')]),
    ).toEqual([range('2026-09-01', '2026-09-01'), range('2026-09-03', '2026-09-03')]);
  });
});

describe('todayIn', () => {
  it('liefert den Kalendertag in der Zeitzone des Profils', () => {
    const now = new Date('2026-09-27T23:30:00Z');
    expect(todayIn('Europe/Berlin', now)).toBe('2026-09-28');
    expect(todayIn('America/Los_Angeles', now)).toBe('2026-09-27');
    expect(todayIn('UTC', now)).toBe('2026-09-27');
  });

  it('scheitert laut bei einer unbekannten Zeitzone', () => {
    expect(() => todayIn('Mars/Olympus', new Date())).toThrow(RangeError);
  });
});

describe('addDays', () => {
  it('rechnet über Monats- und Jahresgrenzen und die Zeitumstellung', () => {
    expect(addDays('2026-09-27', -1)).toBe('2026-09-26');
    expect(addDays('2026-03-01', -1)).toBe('2026-02-28');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-10-25', 1)).toBe('2026-10-26');
  });
});

describe('splitDateRange', () => {
  it('teilt einen Zeitraum in Stücke von höchstens n Tagen, von vorn beginnend', () => {
    expect(splitDateRange(range('2026-06-01', '2026-08-04'), 31)).toEqual([
      range('2026-06-01', '2026-07-01'),
      range('2026-07-02', '2026-08-01'),
      range('2026-08-02', '2026-08-04'),
    ]);
    expect(splitDateRange(range('2026-06-01', '2026-06-01'), 31)).toEqual([
      range('2026-06-01', '2026-06-01'),
    ]);
  });
});
