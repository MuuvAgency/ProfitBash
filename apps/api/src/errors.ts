import type { ErrorResponse } from '@profitbash/shared';
import type { Context, ErrorHandler, NotFoundHandler } from 'hono';
import { HTTPException } from 'hono/http-exception';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { AppEnv } from './context';
import type { Logger } from './logger';

/** Erwarteter Fehler mit Code für den Client. Wird als `{ error: { code, message } }` ausgeliefert. */
export class ApiError extends Error {
  constructor(
    public readonly status: ContentfulStatusCode,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const CODE_BY_STATUS: Partial<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  409: 'CONFLICT',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  429: 'TOO_MANY_REQUESTS',
};

export function errorBody(code: string, message: string): ErrorResponse {
  return { error: { code, message } };
}

export function errorResponse(
  c: Context,
  status: ContentfulStatusCode,
  code: string,
  message: string,
) {
  return c.json(errorBody(code, message), status);
}

/**
 * Felder für das Log eines unerwarteten Fehlers. Fehlgeschlagene Drizzle-Abfragen tragen die
 * Parameterwerte in Meldung und Stack (verschlüsselte Tokens, E-Mails); geloggt werden dann nur SQL
 * mit Platzhaltern, Postgres-Code und Constraint. Auch die Postgres-Meldung bleibt draußen, sie
 * zitiert Eingabewerte.
 */
export function errorLogFields(err: unknown): Record<string, unknown> {
  if (!(err instanceof Error)) return { error: String(err) };
  if ('query' in err && typeof err.query === 'string' && 'params' in err) {
    const cause = (err.cause ?? {}) as { code?: unknown; constraint_name?: unknown };
    return {
      error: 'Datenbankabfrage fehlgeschlagen.',
      query: err.query,
      dbCode: cause.code,
      dbConstraint: cause.constraint_name,
      stack: err.stack
        ?.split('\n')
        .filter((line) => line.trimStart().startsWith('at '))
        .join('\n'),
    };
  }
  return { error: err.message, stack: err.stack };
}

export function createErrorHandler(logger: Logger): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (err instanceof ApiError) return errorResponse(c, err.status, err.code, err.message);
    if (err instanceof HTTPException) {
      const status = err.status as ContentfulStatusCode;
      const code = CODE_BY_STATUS[status] ?? (status >= 500 ? 'INTERNAL_ERROR' : 'BAD_REQUEST');
      return errorResponse(c, status, code, err.message || code);
    }
    logger({
      level: 'error',
      msg: 'unhandled error',
      requestId: c.get('requestId'),
      ...errorLogFields(err),
    });
    return errorResponse(c, 500, 'INTERNAL_ERROR', 'Interner Fehler.');
  };
}

export const notFoundHandler: NotFoundHandler<AppEnv> = (c) =>
  errorResponse(c, 404, 'NOT_FOUND', 'Nicht gefunden.');
