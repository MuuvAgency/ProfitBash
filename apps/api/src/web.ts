import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono, type Context, type MiddlewareHandler } from 'hono';

/** Alles, was eine `fetch`-Methode hat, z. B. die API-App aus `createApp`. */
export interface FetchHandler {
  fetch(request: Request, env?: unknown): Response | Promise<Response>;
}

export interface ServerAppOptions {
  api: FetchHandler;
  /**
   * Gebautes Web (`apps/web/dist`). Ohne Angabe beantwortet der Server nur die API
   * (Entwicklung: Vite liefert das Web und leitet `/api` weiter).
   */
  webDistDir?: string | undefined;
}

/** Vite legt gehashte Dateien unter `assets/` ab; die ändern sich nie. */
const IMMUTABLE = 'public, max-age=31536000, immutable';

function isHashedAsset(path: string): boolean {
  return path.startsWith('/assets/');
}

/** Letztes Pfadsegment mit Endung (`/robots.txt`) = Datei, keine Client-Route. */
function looksLikeFile(path: string): boolean {
  const lastSegment = path.slice(path.lastIndexOf('/') + 1);
  return lastSegment.includes('.');
}

/**
 * Der Server für Produktion: `/api/*` geht an die API, alles andere liefert das gebaute Web
 * (gleiche Origin, kein CORS). Unbekannte Pfade ohne Dateiendung bekommen `index.html`
 * (SPA-Fallback, der Vue-Router entscheidet). Fehlende Dateien und andere Methoden beantwortet
 * die API mit ihrem JSON-404.
 */
export function createServerApp({ api, webDistDir }: ServerAppOptions) {
  const app = new Hono();
  const toApi = (c: Context) => api.fetch(c.req.raw, c.env);

  if (webDistDir) {
    const root = resolve(webDistDir);
    if (!existsSync(join(root, 'index.html'))) {
      throw new Error(`${join(root, 'index.html')} fehlt. Erst das Web bauen (pnpm build).`);
    }
    const staticFile = serveStatic({ root });
    const indexHtml = serveStatic({ root, path: 'index.html' });

    /** Liefert die Datei mit Cache-Header oder `undefined`, wenn es sie nicht gibt. */
    async function serve(handler: MiddlewareHandler, c: Context, cacheControl: string) {
      let found = true;
      const res = await handler(c, async () => {
        found = false;
      });
      if (!found || !res) return undefined;
      res.headers.set('Cache-Control', cacheControl);
      return res;
    }

    app.all('/api/*', toApi);
    app.on(['GET', 'HEAD'], '*', async (c, next) => {
      const cacheControl = isHashedAsset(c.req.path) ? IMMUTABLE : 'no-cache';
      return (await serve(staticFile, c, cacheControl)) ?? next();
    });
    app.on(['GET', 'HEAD'], '*', async (c, next) => {
      if (looksLikeFile(c.req.path)) return next();
      return (await serve(indexHtml, c, 'no-cache')) ?? next();
    });
  }

  app.all('*', toApi);
  return app;
}
