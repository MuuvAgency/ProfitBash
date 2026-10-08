import type { z } from 'zod';
import { AmazonAdsHttpError, AmazonAdsNetworkError, AmazonAdsResponseError } from './errors';
import { parseJsonLossless, type ParseJsonLosslessOptions } from './json';
import { noopLogger, type Logger } from './logger';

/**
 * HTTP-Kern für alle Aufrufe an Amazon (LWA und Ads-API):
 * - Wiederholung bei 429 (immer) und bei 5xx/Netzwerkfehlern (nur idempotente Aufrufe oder mit
 *   `retryServerErrors`), exponentieller Backoff mit Jitter, `Retry-After` hat Vorrang
 * - Timeout je Versuch
 * - verlustfreies JSON-Parsing und zod-Validierung jeder Antwort
 * - Logging nur mit Operation, Host, Pfad, Status und Amazon-Request-ID (nie Header, Query, Body)
 */

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpClientOptions {
  /** Standard: das globale `fetch` (zur Aufrufzeit gelesen, damit msw es abfangen kann). */
  fetch?: typeof fetch;
  logger?: Logger;
  /** Für Tests austauschbar. */
  sleep?: (ms: number) => Promise<void>;
  /** Zufallsquelle für den Jitter (0 ≤ x < 1). */
  random?: () => number;
  now?: () => number;
  /** Timeout je Versuch. Standard 30 s. */
  timeoutMs?: number;
  /** Versuche insgesamt (inkl. dem ersten). Standard 5. */
  maxAttempts?: number;
  /** Basis des exponentiellen Backoffs. Standard 1 s. */
  baseDelayMs?: number;
  /** Obergrenze des Backoffs. Standard 30 s. */
  maxDelayMs?: number;
  /**
   * Verlangt Amazon per `Retry-After` länger zu warten, bricht der Aufruf ab und gibt die Wartezeit
   * im Fehler weiter (`retryAfterMs`), damit ein Job später neu starten kann. Standard 60 s.
   */
  maxRetryAfterMs?: number;
}

export interface HttpRequest<S extends z.ZodType> {
  /** Name für Logs und Fehlermeldungen, z. B. `profiles.list`. */
  operation: string;
  method: HttpMethod;
  url: string | URL;
  headers?: Record<string, string>;
  body?: string | URLSearchParams;
  schema: S;
  /**
   * `string`: Dezimalzahlen der Antwort kommen als Quelltext-String (Beträge, siehe `parseJsonLossless`).
   * Standard `number`. Mit `string` gilt das für **alle** gebrochenen Werte; das Schema nimmt sie über
   * `amazonDecimalSchema`, nie `z.number()`.
   */
  decimals?: ParseJsonLosslessOptions['decimals'];
  /**
   * 5xx und Netzwerkfehler wiederholen. Standard: nur bei GET. Bei schreibenden Aufrufen könnte eine
   * Wiederholung sonst doppelt wirken.
   */
  retryServerErrors?: boolean;
  /** Zählt gesendete Anfragen, 429 und Wiederholungen (z. B. für `job_runs.counters`). */
  meter?: RequestMeter;
  /** Anfrage-Budget: vor jedem Versuch `acquire`, danach Rückmeldung zu 429 bzw. Erfolg. */
  pacing?: RequestPacing;
}

/** Zähler eines Jobs über alle seine Aufrufe an Amazon. */
export interface RequestMeter {
  /** Gesendete HTTP-Anfragen, jede Wiederholung einzeln. */
  requests: number;
  /** Antworten mit HTTP 429. */
  throttled: number;
  /** Wiederholungen (zweiter und weitere Versuche). */
  retries: number;
}

export function createRequestMeter(): RequestMeter {
  return { requests: 0, throttled: 0, retries: 0 };
}

export interface RequestPacing {
  /**
   * Wartet auf den nächsten Zeitschlitz (`null`). Pausiert das Budget länger als `maxPauseMs`
   * (`Retry-After` eines früheren Aufrufs), liefert es die Restdauer, ohne zu warten.
   */
  acquire(maxPauseMs: number): Promise<{ pausedForMs: number } | null>;
  onThrottled(retryAfterMs: number | null): void;
  onSuccess(): void;
}

export interface HttpClient {
  send<S extends z.ZodType>(request: HttpRequest<S>): Promise<z.output<S>>;
}

const MAX_DETAIL_LENGTH = 200;

export function createHttpClient(options: HttpClientOptions = {}): HttpClient {
  const fetchImpl: typeof fetch = options.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const logger = options.logger ?? noopLogger;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const random = options.random ?? Math.random;
  const now = options.now ?? Date.now;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const baseDelayMs = options.baseDelayMs ?? 1_000;
  const maxDelayMs = options.maxDelayMs ?? 30_000;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? 60_000;

  /** Equal Jitter: halbe Wartezeit fest, halbe zufällig. Verteilt parallele Wiederholungen. */
  function backoff(attempt: number): number {
    const cap = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
    return Math.round(cap / 2 + random() * (cap / 2));
  }

  async function send<S extends z.ZodType>(request: HttpRequest<S>): Promise<z.output<S>> {
    const url = new URL(request.url);
    const retryServerErrors = request.retryServerErrors ?? request.method === 'GET';
    const logContext = {
      operation: request.operation,
      method: request.method,
      host: url.host,
      path: url.pathname,
    };
    const startedAt = now();

    const { meter, pacing } = request;
    for (let attempt = 1; ; attempt += 1) {
      const paused = pacing ? await pacing.acquire(maxRetryAfterMs) : null;
      if (paused) {
        // Nicht senden: Amazon hat für dieses Profil eine längere Pause verlangt. Der Aufruf endet wie
        // ein zu langes `Retry-After`, damit ein Job später neu starten kann.
        logger({
          level: 'warn',
          msg: 'amazon_ads.request_failed',
          ...logContext,
          status: 429,
          code: 'PROFILE_PAUSED',
          attempts: attempt - 1,
          retryAfterMs: paused.pausedForMs,
        });
        throw httpError(
          request.operation,
          429,
          'PROFILE_PAUSED',
          'Amazon hat für dieses Profil eine Pause verlangt',
          null,
          paused.pausedForMs,
        );
      }
      if (meter) {
        meter.requests += 1;
        if (attempt > 1) meter.retries += 1;
      }
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(url, {
          method: request.method,
          headers: { Accept: 'application/json', ...request.headers },
          ...(request.body !== undefined && { body: request.body }),
          signal: AbortSignal.timeout(timeoutMs),
        });
        text = await response.text();
      } catch (error) {
        const timedOut = error instanceof DOMException && error.name === 'TimeoutError';
        if (retryServerErrors && attempt < maxAttempts) {
          const delayMs = backoff(attempt);
          logger({
            level: 'warn',
            msg: 'amazon_ads.retry',
            ...logContext,
            attempt,
            delayMs,
            reason: timedOut ? 'timeout' : 'network',
          });
          await sleep(delayMs);
          continue;
        }
        logger({
          level: 'warn',
          msg: 'amazon_ads.request_failed',
          ...logContext,
          attempts: attempt,
          reason: timedOut ? 'timeout' : 'network',
        });
        throw new AmazonAdsNetworkError(request.operation, timedOut, { cause: error });
      }

      const amazonRequestId =
        response.headers.get('x-amz-request-id') ?? response.headers.get('x-amzn-requestid');

      if (response.ok) {
        pacing?.onSuccess();
        logger({
          level: 'info',
          msg: 'amazon_ads.request',
          ...logContext,
          status: response.status,
          attempts: attempt,
          durationMs: now() - startedAt,
          amazonRequestId,
        });
        return parseAndValidate(request, text);
      }

      const status = response.status;
      const retryable = status === 429 || (status >= 500 && retryServerErrors);
      const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'), now());
      const { code, details } = parseErrorBody(text);
      if (status === 429) {
        if (meter) meter.throttled += 1;
        pacing?.onThrottled(retryAfterMs);
      }

      const tooLongToWait = retryAfterMs !== null && retryAfterMs > maxRetryAfterMs;
      if (retryable && attempt < maxAttempts && !tooLongToWait) {
        const delayMs = retryAfterMs ?? backoff(attempt);
        logger({
          level: 'warn',
          msg: 'amazon_ads.retry',
          ...logContext,
          status,
          attempt,
          delayMs,
          amazonRequestId,
        });
        await sleep(delayMs);
        continue;
      }

      // `retryAfterMs` im Fehler: Ein Job kann damit später neu planen.
      const failedRetryAfterMs = retryable ? retryAfterMs : null;
      logger({
        level: 'warn',
        msg: 'amazon_ads.request_failed',
        ...logContext,
        status,
        code,
        attempts: attempt,
        retryAfterMs: failedRetryAfterMs,
        amazonRequestId,
      });
      throw httpError(
        request.operation,
        status,
        code,
        details,
        amazonRequestId,
        failedRetryAfterMs,
      );
    }
  }

  return { send };
}

function parseAndValidate<S extends z.ZodType>(request: HttpRequest<S>, text: string): z.output<S> {
  let data: unknown;
  try {
    data =
      text === '' ? undefined : parseJsonLossless(text, { decimals: request.decimals ?? 'number' });
  } catch {
    throw new AmazonAdsResponseError(
      `${request.operation}: Antwort von Amazon ist kein gültiges JSON.`,
      request.operation,
    );
  }
  const result = request.schema.safeParse(data);
  if (!result.success) {
    // Nur Pfade und Meldungen der Probleme, nie die empfangenen Werte.
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new AmazonAdsResponseError(
      `${request.operation}: Antwort von Amazon passt nicht zum Schema (${issues}).`,
      request.operation,
    );
  }
  return result.data;
}

/** `Retry-After` als Sekunden oder HTTP-Datum → Millisekunden, sonst `null`. */
function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null) return null;
  const trimmed = value.trim();
  if (/^\d+$/.test(trimmed)) return Number(trimmed) * 1000;
  const date = Date.parse(trimmed);
  if (Number.isNaN(date)) return null;
  return Math.max(0, date - nowMs);
}

/** Liest `code`/`details` (Ads-API) bzw. `error`/`error_description` (LWA) aus einer Fehlerantwort. */
function parseErrorBody(text: string): { code: string | null; details: string | null } {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return { code: null, details: null };
  }
  if (typeof body !== 'object' || body === null) return { code: null, details: null };
  const record = body as Record<string, unknown>;
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = record[key];
      if (typeof value === 'string' && value.length > 0) return value;
    }
    return null;
  };
  const code = pick('code', 'error');
  // `detail` liefert Reporting v3 (z. B. bei 425 mit der ID des laufenden Reports).
  const details = pick('details', 'detail', 'message', 'error_description');
  return {
    code: code === null ? null : sanitize(code, 64),
    details: details === null ? null : sanitize(details, MAX_DETAIL_LENGTH),
  };
}

/** Entfernt Steuerzeichen (Log-Injection) und mögliche Tokens, kürzt auf `max` Zeichen. */
export function sanitize(value: string, max: number): string {
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/Atz[ra]\|\S+/g, '[token]');
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function httpError(
  operation: string,
  status: number,
  code: string | null,
  details: string | null,
  amazonRequestId: string | null,
  retryAfterMs: number | null,
): AmazonAdsHttpError {
  const message =
    `${operation}: Amazon antwortete mit HTTP ${status}` +
    (code ? ` (${code})` : '') +
    (details ? `: ${details}` : '') +
    '.';
  return new AmazonAdsHttpError(
    message,
    operation,
    status,
    code,
    amazonRequestId,
    retryAfterMs,
    details,
  );
}
