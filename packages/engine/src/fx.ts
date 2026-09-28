import { formatDecimal, parseDecimal, type DecimalString } from './decimal';

/**
 * Kurse eines Tages je Währung: 1 EUR = Kurs × Währung (EZB, `fx_rates`). EUR darf fehlen (Basis, 1).
 * Für Wochenenden und Feiertage liefert der Aufrufer den letzten Kurs davor (`fxRatesOnOrBefore`).
 */
export type DailyRates = ReadonlyMap<string, DecimalString>;

function rateOf(currency: string, rates: DailyRates) {
  if (currency === 'EUR') return parseDecimal('1');
  const rate = rates.get(currency);
  if (rate === undefined) return null;
  const value = parseDecimal(rate);
  if (!value.isPositive() || value.isZero()) {
    throw new RangeError(`Kurs für ${currency} muss größer 0 sein.`);
  }
  return value;
}

/**
 * Rechnet einen Betrag über EUR um (F3): Betrag ÷ Kurs der Quellwährung × Kurs der Zielwährung, beide
 * Kurse vom selben Tag. Fehlt einer, ist das Ergebnis `null`: Der Betrag bleibt dann unumgerechnet und
 * die Summe bekommt einen Hinweis (nie mit einem geratenen Kurs). Gleiche Währung: unverändert.
 */
export function convertAmount(
  amount: DecimalString,
  from: string,
  to: string,
  rates: DailyRates,
): DecimalString | null {
  if (from === to) return amount;
  const fromRate = rateOf(from, rates);
  const toRate = rateOf(to, rates);
  if (fromRate === null || toRate === null) return null;
  return formatDecimal(parseDecimal(amount).div(fromRate).mul(toRate));
}
