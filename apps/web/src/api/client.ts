import type { MeResponse, Settings } from '@profitbash/shared';
import createClient, { type Middleware } from 'openapi-fetch';
import { ApiError, toApiError } from './errors';
import type { paths } from './schema.gen';

export interface ApiOptions {
  /**
   * Wird aufgerufen, wenn ein eigener Endpunkt mit 401 antwortet (Session abgelaufen oder widerrufen).
   * Fehlgeschlagene Logins unter `/api/auth/*` lösen es nicht aus.
   */
  onUnauthorized?: () => void;
}

export interface SignInInput {
  email: string;
  password: string;
}

const AUTH_PREFIX = '/api/auth/';

/** Nur Requests an dieselbe Origin: Cookies und CSRF-Schutz der API setzen das voraus. */
const sameOrigin = { credentials: 'same-origin' } as const;

function origin(): string {
  return globalThis.location.origin;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Liefert `data` oder wirft den Fehler als `ApiError` (auch bei Verbindungsfehlern). */
async function unwrap<T>(
  call: Promise<{ data?: T; error?: unknown; response: Response }>,
): Promise<T> {
  let result: Awaited<typeof call>;
  try {
    result = await call;
  } catch (cause) {
    throw cause instanceof ApiError ? cause : ApiError.network(cause);
  }
  if (!result.response.ok) throw toApiError(result.response.status, result.error ?? null);
  // Ohne Body (z. B. 204) liefert openapi-fetch `undefined`; das ist ein Erfolg.
  return result.data as T;
}

export function createApi(options: ApiOptions = {}) {
  const client = createClient<paths>({
    baseUrl: origin(),
    // Erst beim Request auflösen, damit Tests `fetch` austauschen können.
    fetch: (request) => globalThis.fetch(request),
    ...sameOrigin,
  });

  const unauthorizedMiddleware: Middleware = {
    onResponse({ response }) {
      if (response.status === 401) options.onUnauthorized?.();
    },
  };
  client.use(unauthorizedMiddleware);

  /** better-auth-Endpunkte (nicht im OpenAPI-Dokument). Immer POST mit JSON-Body. */
  async function postAuth<T>(path: string, body: unknown): Promise<T> {
    let response: Response;
    try {
      response = await globalThis.fetch(
        new Request(`${origin()}${AUTH_PREFIX}${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
          ...sameOrigin,
        }),
      );
    } catch (cause) {
      throw ApiError.network(cause);
    }
    const data = await readBody(response);
    if (!response.ok) throw toApiError(response.status, data);
    return data as T;
  }

  return {
    client,

    me: (): Promise<MeResponse> => unwrap(client.GET('/api/me')),

    updateSettings: (settings: Settings): Promise<Settings> =>
      unwrap(client.PUT('/api/settings', { body: settings })),

    async getUiState(scope: string, key: string): Promise<unknown> {
      const { value } = await unwrap(
        client.GET('/api/settings/ui-state/{scope}/{key}', { params: { path: { scope, key } } }),
      );
      return value;
    },

    async putUiState(scope: string, key: string, value: unknown): Promise<void> {
      await unwrap(
        client.PUT('/api/settings/ui-state/{scope}/{key}', {
          params: { path: { scope, key } },
          body: { value },
        }),
      );
    },

    auth: {
      signIn: (input: SignInInput) => postAuth<unknown>('sign-in/email', input),
      signOut: () => postAuth<unknown>('sign-out', {}),
      setActiveOrganization: (organizationId: string) =>
        postAuth<unknown>('organization/set-active', { organizationId }),
    },
  };
}

export type Api = ReturnType<typeof createApi>;
