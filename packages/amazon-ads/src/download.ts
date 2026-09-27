import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { AmazonAdsDownloadTooLargeError, AmazonAdsResponseError } from './errors';
import { parseJsonLossless } from './json';

export interface DecodeGzipJsonOptions {
  /** Höchstgröße des entpackten Inhalts in Bytes. */
  maxBytes: number;
  /** Name für Fehlermeldungen. Standard `download`. */
  operation?: string;
}

/**
 * Entpackt eine gzip-Datei von Amazon (Reports, Exports) gestreamt und parst sie verlustfrei, mit
 * Dezimalzahlen als Quelltext (`parseJsonLossless(text, { decimals: 'string' })`). Das Entpacken bricht
 * ab, sobald der Inhalt `maxBytes` überschreitet; so bleibt auch eine stark komprimierte Datei im
 * Speicher begrenzt. Geparst wird erst der ganze Text (der Parser arbeitet nicht auf Streams).
 */
export async function decodeGzipJson(
  body: AsyncIterable<Uint8Array>,
  options: DecodeGzipJsonOptions,
): Promise<unknown> {
  const operation = options.operation ?? 'download';
  const chunks: Buffer[] = [];
  let size = 0;
  const collect = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      size += chunk.length;
      if (size > options.maxBytes) {
        callback(new AmazonAdsDownloadTooLargeError(operation, options.maxBytes));
        return;
      }
      chunks.push(chunk);
      callback();
    },
  });

  try {
    await pipeline(Readable.from(body), createGunzip(), collect);
  } catch (error) {
    // Nur Fehler von zlib (Codes `Z_…`) betreffen die Datei; Fehler des Bodys (Netzwerk) bleiben erhalten.
    if (!isZlibError(error)) throw error;
    throw new AmazonAdsResponseError(
      `${operation}: Die Datei ließ sich nicht entpacken.`,
      operation,
    );
  }

  try {
    return parseJsonLossless(Buffer.concat(chunks, size).toString('utf8'), { decimals: 'string' });
  } catch {
    // Keine Details aus dem Parser: Sie zitieren Teile des Inhalts.
    throw new AmazonAdsResponseError(`${operation}: Die Datei ist kein gültiges JSON.`, operation);
  }
}

function isZlibError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && code.startsWith('Z_');
}
