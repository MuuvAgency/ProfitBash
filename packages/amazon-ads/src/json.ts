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
