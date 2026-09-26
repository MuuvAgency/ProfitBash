import { Decimal } from 'decimal.js';
import { z } from 'zod';

/**
 * Beträge und Währungen aus Amazon-Antworten (ADR 003).
 *
 * Beträge kommen am besten als Quelltext-String aus `parseJsonLossless(text, { decimals: 'string' })`.
 * Sichere Zahlen werden auch angenommen (z. B. aus Antworten, die ohne die Option geparst wurden).
 * Ergebnis ist ein normalisierter Decimal-String: exakt, ohne Exponent, ohne überflüssige Nullen, `-0` als `0`.
 */

const DECIMAL_SOURCE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

/**
 * Größte Zehnerpotenz, die ein Betrag haben darf (in beide Richtungen). Amazon-Beträge liegen weit darunter;
 * der Deckel verhindert, dass `1e-1000000` zu einem String mit einer Million Zeichen wird.
 */
const MAX_DECIMAL_EXPONENT = 40;

function toDecimalString(value: string | number, ctx: z.RefinementCtx): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      ctx.addIssue({ code: 'custom', message: 'Betrag ist keine sichere Zahl' });
      return z.NEVER;
    }
  } else if (!DECIMAL_SOURCE.test(value)) {
    ctx.addIssue({ code: 'custom', message: 'Betrag ist keine Dezimalzahl' });
    return z.NEVER;
  }
  // Bei `number` ist `String(value)` die kürzeste Darstellung, die genau diese Zahl ergibt.
  const decimal = new Decimal(typeof value === 'number' ? String(value) : value);
  if (!decimal.isZero() && Math.abs(decimal.e) > MAX_DECIMAL_EXPONENT) {
    ctx.addIssue({ code: 'custom', message: 'Betrag liegt außerhalb des erlaubten Bereichs' });
    return z.NEVER;
  }
  // `toFixed()` ohne Argument rundet nicht; `-0` wird zu `0`.
  return decimal.toFixed();
}

export const amazonDecimalSchema = z.union([z.string(), z.number()]).transform(toDecimalString);

/** ISO-4217-Code, formal geprüft. Ob Intl ihn kennt, prüft `isKnownCurrencyCode` (unbekannte loggen, nicht verwerfen). */
export const currencyCodeSchema = z
  .string()
  .regex(/^[A-Z]{3}$/, 'Währungscode ist kein ISO-4217-Code');

const KNOWN_CURRENCY_CODES: ReadonlySet<string> = new Set(Intl.supportedValuesOf('currency'));

export function isKnownCurrencyCode(code: string): boolean {
  return KNOWN_CURRENCY_CODES.has(code);
}
