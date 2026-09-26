/**
 * Amazon liefert Ländercodes im Stil von ISO 3166-1 alpha-2, mit einer Ausnahme:
 * das Vereinigte Königreich heißt dort `UK` (ISO: `GB`).
 */
const AMAZON_TO_ISO: Record<string, string> = { UK: 'GB' };

/** ISO-3166-1-alpha-2-Code in Großbuchstaben oder `null`, wenn der Wert keiner ist. */
export function isoCountryCode(code: string): string | null {
  const upper = code.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper)) return null;
  return AMAZON_TO_ISO[upper] ?? upper;
}

const regionNames = new Intl.DisplayNames(['de'], { type: 'region', fallback: 'none' });

/** Landesname auf Deutsch; unbekannte Werte erscheinen unverändert. */
export function countryName(code: string): string {
  const iso = isoCountryCode(code);
  return (iso && regionNames.of(iso)) || code;
}
