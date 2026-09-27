import { z } from 'zod';
import type { Logger } from './logger';
import { isKnownCurrencyCode } from './money';

/**
 * Hilfen für die Normalisierung von Amazon-Antworten in das eigene Modell (Phase 1, 1.6).
 * Unbekannte Enum-Werte und Währungen werden durchgereicht und geloggt, nie verworfen: Ein neuer
 * Amazon-Wert darf den Sync nicht brechen.
 */

/** Ad-Typen, die Amazon in Entities nennt. */
export const KNOWN_AD_PRODUCTS: ReadonlySet<string> = new Set([
  'SPONSORED_PRODUCTS',
  'SPONSORED_BRANDS',
  'SPONSORED_DISPLAY',
]);

/** Zustände von Entities (Kampagnen, Ad Groups, Targets, Ads, Portfolios). */
export const KNOWN_ENTITY_STATES: ReadonlySet<string> = new Set(['ENABLED', 'PAUSED', 'ARCHIVED']);

export interface UnknownValueReporter {
  /** Loggt `value`, falls es nicht in `known` liegt (je Feld und Wert einmal). */
  check(field: string, value: string | null | undefined, known: ReadonlySet<string>): void;
  /** Loggt einen Währungscode, den `Intl` nicht kennt (je Wert einmal). */
  checkCurrency(field: string, code: string | null | undefined): void;
  /**
   * Loggt ein erwartetes, aber fehlendes Feld als `amazon_ads.unexpected_shape` (je Feld einmal), z. B. wenn
   * der echte Export anders verschachtelt ist als die Doku.
   */
  missing(field: string): void;
}

/**
 * Meldet unbekannte Werte als `amazon_ads.unknown_enum_value`, je Feld und Wert höchstens einmal
 * (ein Export mit 100 000 Zeilen soll nicht 100 000 Logzeilen erzeugen).
 */
export function createUnknownValueReporter(
  logger: Logger,
  context: { operation: string } & Record<string, unknown>,
): UnknownValueReporter {
  const seen = new Set<string>();
  const missingFields = new Set<string>();
  function report(field: string, value: string) {
    const key = `${field}\u0000${value}`;
    if (seen.has(key)) return;
    seen.add(key);
    logger({
      level: 'warn',
      msg: 'amazon_ads.unknown_enum_value',
      ...context,
      field,
      value: value.slice(0, 64),
    });
  }
  return {
    check(field, value, known) {
      if (value !== null && value !== undefined && !known.has(value)) report(field, value);
    },
    checkCurrency(field, code) {
      if (code !== null && code !== undefined && !isKnownCurrencyCode(code)) report(field, code);
    },
    missing(field) {
      if (missingFields.has(field)) return;
      missingFields.add(field);
      logger({ level: 'warn', msg: 'amazon_ads.unexpected_shape', ...context, field });
    },
  };
}

/** Zeitpunkt aus Amazon (ISO 8601) oder `null`, wenn er fehlt oder nicht lesbar ist. */
export function parseAmazonTimestamp(value: string | null | undefined): Date | null {
  if (value === null || value === undefined) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Entfernt Schlüssel mit `undefined` bzw. `null` (für `extra`). */
export function compact(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(record).filter(([, value]) => value !== undefined && value !== null),
  );
}

/**
 * Tag `YYYY-MM-DD` oder `null`. Zeitstempel werden auf den Tag gekürzt; Unlesbares wird leer, statt eine
 * ganze Entity scheitern zu lassen (die DB-Spalte `date` nähme es nicht an).
 */
export const amazonDateSchema = z
  .string()
  .nullish()
  .transform((value) => (value && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : null));

/**
 * Feld, das nur in `extra` landet: jede Form erlaubt. Eine unerwartete Form darf nie die ganze Entity
 * ungültig machen (fehlende Entities gälten in 1.7 sonst als entfernt).
 */
export const extraFieldSchema = z.unknown().optional();
