import { vi } from 'vitest';

export interface RecordedRequest {
  method: string;
  path: string;
  /** Query-String inkl. `?` (leer ohne Parameter). */
  search: string;
  headers: Headers;
  body: unknown;
  credentials: RequestCredentials;
}

type Responder = (request: RecordedRequest) => Response | Promise<Response>;

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** JSON wie gesendet; Multipart als Objekt der Felder, Dateien als `{ name, size }`. */
async function readBody(request: Request): Promise<unknown> {
  if (request.headers.get('content-type')?.startsWith('multipart/form-data')) {
    const form = await request.formData();
    return Object.fromEntries(
      [...form.entries()].map(([key, value]) => [
        key,
        typeof value === 'string' ? value : { name: value.name, size: value.size },
      ]),
    );
  }
  const text = await request.text();
  return text ? (JSON.parse(text) as unknown) : undefined;
}

/**
 * Ersetzt `fetch` durch eine Routing-Tabelle (`'GET /api/me'` → Antwort) und zeichnet alle Requests auf.
 * Unbekannte Routen antworten mit 404.
 */
export function stubFetch(routes: Record<string, Responder | Response>) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const url = new URL(request.url);
    const recorded: RecordedRequest = {
      method: request.method,
      path: url.pathname,
      search: url.search,
      headers: request.headers,
      body: await readBody(request),
      credentials: request.credentials,
    };
    requests.push(recorded);
    const route = routes[`${recorded.method} ${recorded.path}`];
    if (!route) return json({ error: { code: 'NOT_FOUND', message: 'Nicht gefunden.' } }, 404);
    return route instanceof Response ? route.clone() : route(recorded);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { requests, fetchMock };
}
