import { describe, expect, it } from 'vitest';
import { fileDataStaleness } from './file-imports';

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
