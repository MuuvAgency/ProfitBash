/**
 * Verlustfreies JSON-Parsing für Amazon-Antworten.
 *
 * Amazon liefert IDs (Profile, Kampagnen …) als JSON-Zahlen, die größer als `Number.MAX_SAFE_INTEGER`
 * sein können. `JSON.parse` würde sie still runden. Hier werden solche Ganzzahlen aus dem Quelltext
 * als String übernommen (JSON.parse mit Quelltext-Zugriff im Reviver, ab Node 21). Sichere Ganzzahlen
 * und Dezimalzahlen bleiben Zahlen; die zod-Schemas machen daraus bei IDs Strings.
 */

const INTEGER_SOURCE = /^-?\d+$/;

interface ReviverContext {
  source?: string;
}

function reviver(_key: string, value: unknown, context?: ReviverContext): unknown {
  if (typeof value !== 'number' || Number.isSafeInteger(value)) return value;
  const source = context?.source;
  if (source === undefined) {
    // Ohne Quelltext-Zugriff ließe sich die Zahl nicht mehr exakt herstellen. Lieber laut scheitern.
    throw new Error('JSON.parse ohne Quelltext-Zugriff: Node.js >= 22 erforderlich.');
  }
  return INTEGER_SOURCE.test(source) ? source : value;
}

export function parseJsonLossless(text: string): unknown {
  // Die TypeScript-Typen kennen das dritte Reviver-Argument (Quelltext-Kontext) noch nicht.
  return JSON.parse(text, reviver as (key: string, value: unknown) => unknown);
}
