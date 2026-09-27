import { describe, expect, it } from 'vitest';
import { consentExpiryStatus, refreshTokenExpiresAt } from './consent';

describe('refreshTokenExpiresAt', () => {
  it('liegt 365 Tage nach der Einwilligung', () => {
    expect(refreshTokenExpiresAt(new Date('2026-09-27T10:15:00.000Z'))).toEqual(
      new Date('2027-09-27T10:15:00.000Z'),
    );
    // Schaltjahr: 365 Tage, nicht „ein Jahr später“.
    expect(refreshTokenExpiresAt(new Date('2027-03-01T00:00:00.000Z'))).toEqual(
      new Date('2028-02-29T00:00:00.000Z'),
    );
  });

  it('ist ohne Einwilligungszeitpunkt unbekannt', () => {
    expect(refreshTokenExpiresAt(null)).toBeNull();
  });
});

describe('consentExpiryStatus', () => {
  const now = new Date('2026-09-27T12:00:00.000Z');

  it('ist unbekannt ohne Ablaufzeitpunkt', () => {
    expect(consentExpiryStatus(null, now)).toBe('unknown');
  });

  it('warnt ab 30 Tagen vor dem Ablauf', () => {
    expect(consentExpiryStatus('2026-10-27T12:00:00.001Z', now)).toBe('valid');
    expect(consentExpiryStatus('2026-10-27T12:00:00.000Z', now)).toBe('expiring');
    expect(consentExpiryStatus('2026-09-27T12:00:00.001Z', now)).toBe('expiring');
  });

  it('ist ab dem Ablaufzeitpunkt abgelaufen', () => {
    expect(consentExpiryStatus('2026-09-27T12:00:00.000Z', now)).toBe('expired');
    expect(consentExpiryStatus('2025-01-01T00:00:00.000Z', now)).toBe('expired');
  });

  it('behandelt einen ungültigen Zeitpunkt als unbekannt', () => {
    expect(consentExpiryStatus('kein Datum', now)).toBe('unknown');
  });
});
