import { describe, expect, it } from 'vitest';
import {
  BULK_PERIOD_MAX_AGE_DAYS,
  BULK_PERIOD_MAX_DAYS,
  bulkPeriodIssue,
  fileDataStaleness,
  parseBulkPeriod,
  todayInTimezone,
} from './file-imports';

describe('parseBulkPeriod', () => {
  it('liest den Zeitraum aus dem Dateinamen der Werbekonsole', () => {
    expect(parseBulkPeriod('bulk-a1b2c3d4e5-20260922-20261007-1791399063312.xlsx')).toEqual({
      startDate: '2026-09-22',
      endDate: '2026-10-07',
    });
    // Vom Browser nummerierte Kopie.
    expect(parseBulkPeriod('bulk-a1b2c3-20260901-20260930-1 (2).xlsx')).toEqual({
      startDate: '2026-09-01',
      endDate: '2026-09-30',
    });
  });

  it('liest auch groß geschriebene Namen und Konto-IDs mit Bindestrich', () => {
    const period = { startDate: '2026-09-01', endDate: '2026-09-30' };
    expect(parseBulkPeriod('BULK-A1B2C3-20260901-20260930-17.XLSX')).toEqual(period);
    expect(parseBulkPeriod('bulk-a1-b2-20260901-20260930-17.xlsx')).toEqual(period);
  });

  it('liefert null bei umbenannten Dateien, unmöglichen Tagen und verdrehtem Zeitraum', () => {
    expect(parseBulkPeriod('bulk-test.xlsx')).toBeNull();
    expect(parseBulkPeriod('kunde-oktober.xlsx')).toBeNull();
    expect(parseBulkPeriod('bulk-a1-20260231-20260301-1.xlsx')).toBeNull();
    expect(parseBulkPeriod('bulk-a1-20261007-20260922-1.xlsx')).toBeNull();
  });
});

describe('bulkPeriodIssue', () => {
  const today = '2026-10-07';
  const issue = (
    startDate: string | null,
    endDate: string | null,
    day: string | undefined = today,
  ) => bulkPeriodIssue({ startDate, endDate }, day);

  it('lässt keine Angabe und einen gültigen Zeitraum durch (auch einen einzelnen Tag bis heute)', () => {
    expect(issue(null, null)).toBeNull();
    expect(issue('', '')).toBeNull();
    expect(issue('2026-09-01', '2026-09-30')).toBeNull();
    expect(issue('2026-10-07', '2026-10-07')).toBeNull();
  });

  it('verlangt beide Tage oder keinen', () => {
    expect(issue('2026-09-01', null)).toBe('incomplete');
    expect(issue('', '2026-09-30')).toBe('incomplete');
  });

  it('lehnt unmögliche Tage und fremde Schreibweisen ab', () => {
    expect(issue('2026-02-30', '2026-03-01')).toBe('invalidDate');
    expect(issue('01.09.2026', '30.09.2026')).toBe('invalidDate');
  });

  it('lehnt einen verdrehten Zeitraum ab', () => {
    expect(issue('2026-09-30', '2026-09-01')).toBe('startAfterEnd');
  });

  it('lehnt Tage in der Zukunft ab, ohne „heute“ prüft es das nicht', () => {
    expect(issue('2026-10-01', '2026-10-08')).toBe('future');
    expect(bulkPeriodIssue({ startDate: '2026-10-01', endDate: '2026-10-08' })).toBeNull();
  });

  it(`lässt höchstens ${BULK_PERIOD_MAX_DAYS} Tage zwischen erstem und letztem Tag zu`, () => {
    expect(BULK_PERIOD_MAX_DAYS).toBe(60);
    expect(issue('2026-08-01', '2026-09-30')).toBeNull();
    expect(issue('2026-08-01', '2026-10-01')).toBe('tooLong');
    // Über die Umstellung auf Winterzeit hinweg zählen Kalendertage, nicht Stunden.
    expect(issue('2026-10-01', '2026-11-30', '2026-12-31')).toBeNull();
  });

  it(`lässt den ersten Tag höchstens ${BULK_PERIOD_MAX_AGE_DAYS} Tage vor „heute“ liegen, ohne „heute“ prüft es das nicht`, () => {
    expect(BULK_PERIOD_MAX_AGE_DAYS).toBe(365);
    // Heute ist der 07.10.2026: Genau 365 Tage zurück liegt der 07.10.2025, der Tag selbst ist erlaubt.
    expect(issue('2025-10-07', '2025-10-31')).toBeNull();
    expect(issue('2025-10-06', '2025-10-31')).toBe('tooOld');
    // Der Tippfehler im Jahr.
    expect(issue('2025-09-01', '2025-09-30')).toBe('tooOld');
    expect(bulkPeriodIssue({ startDate: '2025-09-01', endDate: '2025-09-30' })).toBeNull();
    // Über einen Schalttag hinweg zählen Kalendertage: 365 Tage vor dem 01.03.2028 ist der 02.03.2027.
    expect(issue('2027-03-02', '2027-03-31', '2028-03-01')).toBeNull();
    expect(issue('2027-03-01', '2027-03-31', '2028-03-01')).toBe('tooOld');
  });

  it('meldet bei zu langem und zu altem Zeitraum die Länge (die prüft auch die API ohne „heute“)', () => {
    expect(issue('2025-09-01', '2026-09-30')).toBe('tooLong');
  });
});

describe('todayInTimezone', () => {
  it('nennt den Kalendertag in der Zeitzone', () => {
    const now = new Date('2026-10-07T22:30:00Z');
    expect(todayInTimezone('Europe/Berlin', now)).toBe('2026-10-08');
    expect(todayInTimezone('America/Los_Angeles', now)).toBe('2026-10-07');
  });
});

describe('fileDataStaleness', () => {
  const now = new Date('2026-10-07T10:00:00Z');
  const fresh = { lastBulkImportAt: '2026-10-05T08:00:00Z', metricsImportedThrough: null };

  it('meldet nichts bei frischer Bulk-Datei und ohne Kennzahlen', () => {
    expect(fileDataStaleness({ ...fresh, timezone: 'Europe/Berlin' }, now)).toEqual([]);
  });

  it('meldet ein Profil ohne importierte Bulk-Datei', () => {
    expect(
      fileDataStaleness(
        { lastBulkImportAt: null, metricsImportedThrough: null, timezone: 'Europe/Berlin' },
        now,
      ),
    ).toEqual(['noBulk']);
  });

  it('meldet eine Bulk-Datei, die älter als sieben Tage ist', () => {
    const at = (iso: string) =>
      fileDataStaleness(
        { lastBulkImportAt: iso, metricsImportedThrough: null, timezone: 'Europe/Berlin' },
        now,
      );
    expect(at('2026-09-30T10:00:00Z')).toEqual([]);
    expect(at('2026-09-30T09:59:59Z')).toEqual(['bulkStale']);
  });

  it('meldet Kennzahlen, deren letzter Tag mehr als drei Tage zurückliegt (Zeitzone des Profils)', () => {
    const through = (day: string, timezone = 'Europe/Berlin') =>
      fileDataStaleness({ ...fresh, metricsImportedThrough: day, timezone }, now);
    // Heute ist in Berlin der 07.10.
    expect(through('2026-10-04')).toEqual([]);
    expect(through('2026-10-03')).toEqual(['metricsStale']);
    // Um 08:00 UTC ist in Los Angeles schon der 07.10. (01:00), in Honolulu noch der 06.10. (22:00).
    const early = new Date('2026-10-07T08:00:00Z');
    expect(
      fileDataStaleness(
        { ...fresh, metricsImportedThrough: '2026-10-03', timezone: 'America/Los_Angeles' },
        early,
      ),
    ).toEqual(['metricsStale']);
    expect(
      fileDataStaleness(
        { ...fresh, metricsImportedThrough: '2026-10-03', timezone: 'Pacific/Honolulu' },
        early,
      ),
    ).toEqual([]);
  });

  it('meldet beides zusammen', () => {
    expect(
      fileDataStaleness(
        {
          lastBulkImportAt: '2026-09-01T00:00:00Z',
          metricsImportedThrough: '2026-09-01',
          timezone: 'Europe/Berlin',
        },
        now,
      ),
    ).toEqual(['bulkStale', 'metricsStale']);
  });
});
