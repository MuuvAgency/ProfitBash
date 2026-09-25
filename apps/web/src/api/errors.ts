/**
 * Einheitlicher Fehler für alle Requests. Die eigene API antwortet mit `{ error: { code, message } }`,
 * better-auth unter `/api/auth/*` mit `{ code, message }`; beide landen hier im selben Format.
 * `message` stammt vom Server und ist nicht für die UI gedacht: Die UI übersetzt über `code`.
 */
export class ApiError extends Error {
  constructor(
    /** HTTP-Status, `0` bei Verbindungsfehlern. */
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }

  static network(cause?: unknown): ApiError {
    const error = new ApiError(0, 'NETWORK_ERROR', 'Server nicht erreichbar.');
    if (cause !== undefined) error.cause = cause;
    return error;
  }
}

interface ErrorFields {
  code: string;
  message: string;
}

function readErrorFields(value: unknown): ErrorFields | null {
  if (typeof value !== 'object' || value === null) return null;
  const { code, message } = value as Record<string, unknown>;
  if (typeof code !== 'string' || code === '') return null;
  return { code, message: typeof message === 'string' ? message : code };
}

export function toApiError(status: number, body: unknown): ApiError {
  const nested =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>).error : undefined;
  const fields = readErrorFields(nested) ?? readErrorFields(body);
  if (fields) return new ApiError(status, fields.code, fields.message);
  return new ApiError(status, `HTTP_${status}`, `Anfrage fehlgeschlagen (${status}).`);
}
