import { and, desc, inArray, lte, max, sql } from 'drizzle-orm';
import type { DbOrTx } from './audit';
import { fxRates } from './schema';

/**
 * Wechselkurse (EZB, Phase 2, 2.2). Öffentliche Referenzdaten ohne Organisation (ADR 002,
 * Geltungsbereich): Schreiben nur der plattformweite Job `fx-rates-sync`, lesen darf jede Abfrage.
 */

/** 1 EUR = `rate` × `quote` am Tag `date` (`YYYY-MM-DD`). */
export interface FxRateInput {
  date: string;
  quote: string;
  /** Decimal-String größer 0. */
  rate: string;
}

export interface UpsertFxRatesResult {
  inserted: number;
  /** Bestehender Tag mit anderem Kurs (Korrektur der EZB). */
  updated: number;
  /** Bestehender Tag mit gleichem Kurs (auch bei anderer Schreibweise, z. B. `178.50`/`178.5`). */
  unchanged: number;
}

/** Zeilen je Anweisung (3 Parameter je Zeile, Postgres erlaubt 65 535). */
const UPSERT_CHUNK = 5_000;

/**
 * Speichert Kurse per Upsert auf (`quote`, `date`): Wiederholungen legen keine Duplikate an,
 * geänderte Kurse werden überschrieben. Doppelte Einträge in `rates` sind ein Fehler.
 */
export async function upsertFxRates(
  db: DbOrTx,
  rates: readonly FxRateInput[],
): Promise<UpsertFxRatesResult> {
  const result: UpsertFxRatesResult = { inserted: 0, updated: 0, unchanged: 0 };
  for (let start = 0; start < rates.length; start += UPSERT_CHUNK) {
    const chunk = rates.slice(start, start + UPSERT_CHUNK);
    const written = await db
      .insert(fxRates)
      .values(chunk.map(({ date, quote, rate }) => ({ date, quote, rate })))
      .onConflictDoUpdate({
        target: [fxRates.quote, fxRates.date],
        set: { rate: sql`excluded.rate`, updatedAt: sql`now()` },
        // Gleicher Wert: keine Schreibarbeit, zählt als unverändert (fehlt in `returning`).
        setWhere: sql`${fxRates.rate} <> excluded.rate`,
      })
      // `xmax = 0`: Die Zeile ist neu (bei einem Update trägt sie die Transaktions-ID).
      .returning({ inserted: sql<boolean>`xmax = 0` });
    const inserted = written.filter((row) => row.inserted).length;
    result.inserted += inserted;
    result.updated += written.length - inserted;
    result.unchanged += chunk.length - written.length;
  }
  return result;
}

/** Letzter Tag mit einem gespeicherten Kurs (irgendeiner Währung), sonst `null`. */
export async function latestFxRateDate(db: DbOrTx): Promise<string | null> {
  const [row] = await db.select({ date: max(fxRates.date) }).from(fxRates);
  return row?.date ?? null;
}

export interface FxRateOnDate {
  /** Tag der Veröffentlichung, an oder vor dem gefragten Tag. */
  date: string;
  rate: string;
}

/**
 * Kurs je Währung für Tag `date`: der letzte veröffentlichte Kurs an oder vor diesem Tag (Wochenenden
 * und Feiertage haben keinen eigenen). EUR ist die Basis und hat immer `1`. Währungen ohne Kurs bis
 * zu diesem Tag fehlen in der Antwort; der Aufrufer rechnet dann nicht um (nie mit 1 oder 0).
 */
export async function fxRatesOnOrBefore(
  db: DbOrTx,
  date: string,
  currencies: readonly string[],
): Promise<Map<string, FxRateOnDate>> {
  const result = new Map<string, FxRateOnDate>();
  if (currencies.includes('EUR')) result.set('EUR', { date, rate: '1' });
  const quotes = [...new Set(currencies)].filter((currency) => currency !== 'EUR');
  if (quotes.length === 0) return result;

  const rows = await db
    .selectDistinctOn([fxRates.quote], {
      quote: fxRates.quote,
      date: fxRates.date,
      rate: fxRates.rate,
    })
    .from(fxRates)
    .where(and(inArray(fxRates.quote, quotes), lte(fxRates.date, date)))
    .orderBy(fxRates.quote, desc(fxRates.date));
  for (const row of rows) result.set(row.quote, { date: row.date, rate: row.rate });
  return result;
}
