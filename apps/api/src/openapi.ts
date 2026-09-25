import { fileURLToPath } from 'node:url';
import { createDb } from '@profitbash/db';
import { createApp } from './app';
import { createAuth } from './auth';

/**
 * Eingechecktes OpenAPI-Dokument. Quelle für den generierten API-Client im Web
 * (`pnpm api:generate`); ein Test prüft, dass es zur aktuellen API passt.
 */
export const OPENAPI_FILE = fileURLToPath(new URL('../openapi.json', import.meta.url));

/** Feste Version im eingecheckten Dokument, damit es nicht bei jedem Commit abweicht. */
const CONTRACT_VERSION = '0.0.0';

/**
 * Erzeugt `/api/openapi.json` ohne Server und ohne Datenbank: Die Verbindung von postgres.js
 * entsteht erst bei der ersten Abfrage, und das Dokument fragt nichts ab.
 */
export async function renderOpenApiDocument(): Promise<string> {
  const appUrl = 'http://localhost:5173';
  const { db, close } = createDb('postgres://openapi@localhost:1/openapi', { max: 1 });
  try {
    const auth = createAuth({
      db,
      secret: 'openapi-export-ohne-echtes-secret-000000',
      baseURL: appUrl,
    });
    const app = createApp({ db, auth, appUrl, version: CONTRACT_VERSION, logger: () => {} });
    const res = await app.request('/api/openapi.json');
    if (!res.ok) throw new Error(`OpenAPI-Dokument nicht erzeugt: ${res.status}`);
    return `${JSON.stringify(await res.json(), null, 2)}\n`;
  } finally {
    await close();
  }
}
