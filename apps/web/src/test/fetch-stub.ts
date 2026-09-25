import { vi } from 'vitest';

export interface RecordedRequest {
  method: string;
  path: string;
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

/**
 * Ersetzt `fetch` durch eine Routing-Tabelle (`'GET /api/me'` → Antwort) und zeichnet alle Requests auf.
 * Unbekannte Routen antworten mit 404.
 */
export function stubFetch(routes: Record<string, Responder | Response>) {
  const requests: RecordedRequest[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const text = await request.text();
    const recorded: RecordedRequest = {
      method: request.method,
      path: new URL(request.url).pathname,
      headers: request.headers,
      body: text ? (JSON.parse(text) as unknown) : undefined,
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
