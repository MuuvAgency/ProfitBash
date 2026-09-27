import { describe, expect, it } from 'vitest';
import { subtractDateRanges } from './date-ranges';

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
