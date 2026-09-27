import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import {
  AmazonAdsDownloadTooLargeError,
  AmazonAdsHttpError,
  AmazonAdsNetworkError,
  AmazonAdsResponseError,
} from './errors';
import { parseJsonLossless } from './json';
import type { Logger } from './logger';

/**
 * Hosts, von denen Report- und Export-Dateien geladen werden (signierte S3-URLs aus den Status-Antworten).
 * Geprüft am 2026-09-27 an den Beispielen der Doku: Reports `offline-report-storage-<region>-prod.s3.amazonaws.com`,
 * Exports `snapshots-prod-<region>.s3.<region>.amazonaws.com`. Andere Hosts werden nicht aufgerufen; ein neuer
 * Bucket-Name fällt so laut auf (Import scheitert), statt Anfragen an unbekannte Hosts zu schicken. Beim ersten
 * echten Lauf (1.10) gegen die EU-Hosts abgleichen.
 */
export const AMAZON_ADS_DOWNLOAD_HOST_PATTERNS: readonly RegExp[] = [
  /^offline-report-storage-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/,
  /^snapshots-prod-[a-z0-9-]+\.s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/,
];

/** Nur `https`, ohne Zugangsdaten in der URL und nur von den erlaubten Hosts. */
export function isAllowedDownloadUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.port !== '') {
    return false;
  }
  return AMAZON_ADS_DOWNLOAD_HOST_PATTERNS.some((pattern) => pattern.test(url.hostname));
}

/** Ergebnis eines Downloads: der rohe (gzip-)Body oder `expired` (URL abgelaufen bzw. Datei weg). */
export type AmazonAdsDownload =
  { status: 'ok'; body: AsyncIterable<Uint8Array> } | { status: 'expired' };

export interface DownloadOptions {
  fetch: typeof fetch;
  logger: Logger;
  /** Für den ganzen Download inkl. Body. */
  timeoutMs: number;
}

/**
 * Lädt eine Datei von einer signierten URL aus einer Amazon-Antwort. Ohne Authorization- und Amazon-Header
 * (Tokens gehen nie an fremde Hosts, Regel aus 0.5), ohne Weiterleitungen, ohne Wiederholung (die
 * Zustandsmaschine versucht es beim nächsten Poll erneut). 403/404 vom Speicher heißt: signierte URL
 * abgelaufen oder Datei gelöscht (`expired`). Logs und Fehler nennen nur den Host, nie die URL (Signatur).
 */
export async function downloadFile(
  value: string,
  options: DownloadOptions,
): Promise<AmazonAdsDownload> {
  const operation = 'download';
  if (!isAllowedDownloadUrl(value)) {
    throw new AmazonAdsResponseError(
      `${operation}: Download-URL von Amazon ist nicht erlaubt (Host ${safeHost(value)}).`,
      operation,
    );
  }
  const url = new URL(value);
  const logContext = { operation, method: 'GET', host: url.host };
  let response: Response;
  try {
    response = await options.fetch(url, {
      method: 'GET',
      redirect: 'error',
      signal: AbortSignal.timeout(options.timeoutMs),
    });
  } catch (error) {
    const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
    options.logger({
      level: 'warn',
      msg: 'amazon_ads.request_failed',
      ...logContext,
      reason: timedOut ? 'timeout' : 'network',
    });
    throw new AmazonAdsNetworkError(operation, timedOut, { cause: error });
  }
  if (response.ok && response.body) {
    options.logger({ level: 'info', msg: 'amazon_ads.request', ...logContext, status: 200 });
    return { status: 'ok', body: response.body as unknown as AsyncIterable<Uint8Array> };
  }
  // Fehler-Body verwerfen, ohne auf ihn zu warten (das Abbrechen kann hängen, bis der Server schließt).
  response.body?.cancel().catch(() => {});
  options.logger({
    level: 'warn',
    msg: 'amazon_ads.request_failed',
    ...logContext,
    status: response.status,
  });
  if (response.status === 403 || response.status === 404) return { status: 'expired' };
  throw new AmazonAdsHttpError(
    `${operation}: Der Download-Host antwortete mit HTTP ${response.status}.`,
    operation,
    response.status,
    null,
    null,
  );
}

function safeHost(value: string): string {
  try {
    return new URL(value).host || 'unbekannt';
  } catch {
    return 'ungültig';
  }
}

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
