/**
 * Eingaben von Dezimalzahlen als Text (Regeln der Suchbegriff-Analyse): nie über `number`, damit Beträge und Anteile
 * exakt bleiben. ACoS zeigt die Oberfläche in Prozent, gespeichert wird der Bruch (0.25 = 25 %).
 */

const UNSIGNED_DECIMAL = /^\d+(\.\d+)?$/;

/** Eingabe mit Komma oder Punkt → Decimal-String ohne Vorzeichen; `null`, wenn sie keine Zahl ist. */
export function parseDecimalInput(text: string): string | null {
  const normalized = text.trim().replace(/\s/g, '').replace(',', '.').replace(/^\./, '0.');
  return UNSIGNED_DECIMAL.test(normalized) ? normalized : null;
}

/** Ohne führende Nullen und ohne Nullen am Ende des Bruchteils („025.50“ → „25.5“). */
function trim(value: string): string {
  const [integer = '0', fraction = ''] = value.split('.');
  const digits = integer.replace(/^0+(?=\d)/, '');
  const rest = fraction.replace(/0+$/, '');
  return rest ? `${digits}.${rest}` : digits;
}

/** Prozent → Bruch („30.5“ → „0.305“). */
export function percentToFraction(percent: string): string {
  const [integer = '0', fraction = ''] = percent.split('.');
  const padded = integer.padStart(3, '0');
  return trim(`${padded.slice(0, -2)}.${padded.slice(-2)}${fraction}`);
}

/** Bruch → Prozent („0.305“ → „30.5“). */
export function fractionToPercent(fraction: string): string {
  const [integer = '0', rest = ''] = fraction.split('.');
  const padded = rest.padEnd(2, '0');
  return trim(`${integer}${padded.slice(0, 2)}.${padded.slice(2)}`);
}
