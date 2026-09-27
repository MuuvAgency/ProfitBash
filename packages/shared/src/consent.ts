const DAY_MS = 24 * 60 * 60 * 1000;

/** Amazon-Refresh-Tokens ab 30.07.2026 laufen so viele Tage nach der Einwilligung ab. */
export const AMAZON_ADS_CONSENT_LIFETIME_DAYS = 365;

/** Ab so vielen Tagen vor dem Ablauf warnt die Connections-Seite. */
export const CONSENT_EXPIRY_WARNING_DAYS = 30;

/**
 * Ablauf des Refresh-Tokens: Einwilligung + 365 Tage (feste Tage, kein Kalenderjahr). Ohne
 * Einwilligungszeitpunkt (Connections von vor der Einführung) unbekannt.
 */
export function refreshTokenExpiresAt(consentedAt: Date | null): Date | null {
  if (consentedAt === null) return null;
  return new Date(consentedAt.getTime() + AMAZON_ADS_CONSENT_LIFETIME_DAYS * DAY_MS);
}

export type ConsentExpiryStatus = 'unknown' | 'valid' | 'expiring' | 'expired';

/** Stand der Einwilligung zum Zeitpunkt `now`: gültig, läuft bald ab (30 Tage), abgelaufen. */
export function consentExpiryStatus(
  expiresAt: string | Date | null,
  now: Date,
): ConsentExpiryStatus {
  if (expiresAt === null) return 'unknown';
  const remaining = new Date(expiresAt).getTime() - now.getTime();
  if (Number.isNaN(remaining)) return 'unknown';
  if (remaining <= 0) return 'expired';
  return remaining <= CONSENT_EXPIRY_WARNING_DAYS * DAY_MS ? 'expiring' : 'valid';
}
