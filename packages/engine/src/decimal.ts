import Decimal from 'decimal.js';

/** Signifikante Stellen je Rechenschritt (wie IEEE 754 decimal128); gerundet wird erst bei der Anzeige. */
export const DECIMAL_PRECISION = 34;

/**
 * Die eine konfigurierte Kopie von decimal.js für alle Berechnungen (ADR 003). Die globale Konfiguration
 * bleibt unverändert, damit andere Pakete (z. B. `amazonDecimalSchema`) nicht betroffen sind.
 */
export const Dec = Decimal.clone({
  precision: DECIMAL_PRECISION,
  rounding: Decimal.ROUND_HALF_EVEN,
});

export type Dec = InstanceType<typeof Dec>;

/** Betrag oder Zähler als Dezimalzahl in Textform ohne Exponent, z. B. `-12.50` (API, `numeric`, SQL-Summen). */
export type DecimalString = string;

const DECIMAL_STRING = /^-?\d+(\.\d+)?$/;

/** Liest einen Decimal-String exakt; alles andere (Exponent, Leerzeichen, `NaN`) ist ein Programmfehler. */
export function parseDecimal(value: DecimalString): Dec {
  if (!DECIMAL_STRING.test(value)) {
    throw new TypeError(`Kein Decimal-String: ${JSON.stringify(value.slice(0, 64))}`);
  }
  return new Dec(value);
}

/** Schreibt einen Wert exakt und ohne Exponent; `-0` wird `0`. */
export function formatDecimal(value: Dec): DecimalString {
  return value.isZero() ? '0' : value.toFixed();
}
