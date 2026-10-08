/**
 * Verlustfreies JSON-Parsing für Amazon-Antworten.
 *
 * Amazon liefert IDs (Profile, Kampagnen …) als JSON-Zahlen, die größer als `Number.MAX_SAFE_INTEGER`
 * sein können. `JSON.parse` würde sie still runden. Hier werden solche Ganzzahlen aus dem Quelltext
 * als String übernommen (JSON.parse mit Quelltext-Zugriff im Reviver, ab Node 21). Sichere Ganzzahlen
 * bleiben Zahlen; die zod-Schemas machen daraus bei IDs Strings.
 *
 * Dezimalzahlen bleiben standardmäßig Zahlen. Mit `{ decimals: 'string' }` kommen sie (und jede Zahl in
 * Exponentialschreibweise) als Quelltext-String, für Beträge ohne Umweg über `number`.
 */

const INTEGER_SOURCE = /^-?\d+$/;

interface ReviverContext {
  source?: string;
}

export interface ParseJsonLosslessOptions {
  /** `number` (Standard): Dezimalzahlen als Zahl. `string`: als unveränderter Quelltext. */
  decimals?: 'number' | 'string';
}

function sourceOf(context: ReviverContext | undefined): string {
  const source = context?.source;
  if (source === undefined) {
    // Ohne Quelltext-Zugriff ließe sich die Zahl nicht mehr exakt herstellen. Lieber laut scheitern.
    throw new Error('JSON.parse ohne Quelltext-Zugriff: Node.js >= 22 erforderlich.');
  }
  return source;
}

function integerReviver(_key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== 'number' || Number.isSafeInteger(value)) return value;
  const source = sourceOf(context);
  return INTEGER_SOURCE.test(source) ? source : value;
}

function decimalStringReviver(_key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== 'number') return value;
  const source = sourceOf(context);
  // Sichere Ganzzahlen ohne Exponent bleiben Zahlen (Zähler wie `clicks`), alles andere Quelltext.
  return Number.isSafeInteger(value) && INTEGER_SOURCE.test(source) ? value : source;
}

export function parseJsonLossless(text: string, options: ParseJsonLosslessOptions = {}): unknown {
  const reviver = options.decimals === 'string' ? decimalStringReviver : integerReviver;
  // Die TypeScript-Typen kennen das dritte Reviver-Argument (Quelltext-Kontext) noch nicht.
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}

// ---------------------------------------------------------------------------
// Schreiben: Beträge als JSON-Zahl ohne Umweg über `number`
// ---------------------------------------------------------------------------

const PLAIN_DECIMAL = /^\d+(\.\d+)?$/;

interface RawJson {
  rawJSON(text: string): unknown;
}

/**
 * Betrag für einen Anfrage-Body: Amazons Schreib-Endpunkte erwarten Gebote und Budgets als JSON-Zahl. Der
 * Decimal-String wird unverändert als Zahl-Literal geschrieben (`"0.10"` → `0.10`), nie über `number`.
 * Nur mit `stringifyJsonLossless` bzw. `JSON.stringify` verwenden.
 */
export function jsonDecimal(value: string): unknown {
  if (!PLAIN_DECIMAL.test(value)) {
    throw new TypeError('jsonDecimal: Wert ist keine einfache Dezimalzahl.');
  }
  // `JSON.rawJSON` (Node.js >= 22) gehört zum selben Vorschlag wie der Quelltext-Zugriff im Reviver oben.
  const { rawJSON } = JSON as unknown as Partial<RawJson>;
  if (!rawJSON) throw new Error('JSON.rawJSON fehlt: Node.js >= 22 erforderlich.');
  return rawJSON(value);
}

/** `JSON.stringify` für Anfrage-Bodys mit `jsonDecimal`-Werten. */
export function stringifyJsonLossless(value: unknown): string {
  return JSON.stringify(value);
}
