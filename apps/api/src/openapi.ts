import { fileURLToPath } from 'node:url';
import { createDb } from '@profitbash/db';
import { parseKeyring } from '@profitbash/shared/crypto';
import { createAmazonAdsDeps } from './amazon';
import { createApp } from './app';
import { createAuth } from './auth';
import { AMAZON_OAUTH_CALLBACK_PATH } from './env';

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
    // Das Dokument hängt nicht vom Modus ab: Die Mock-Einwilligungsseite steht nicht im Vertrag.
    const keyring = parseKeyring({
      ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
      ENCRYPTION_KEY_ID: 'openapi',
    });
    const logger = () => {};
    const app = createApp({
      db,
      auth,
      appUrl,
      version: CONTRACT_VERSION,
      logger,
      amazonAds: createAmazonAdsDeps({
        env: {
          APP_URL: appUrl,
          AMAZON_ADS_REDIRECT_URI: `${appUrl}${AMAZON_OAUTH_CALLBACK_PATH}`,
          AMAZON_ADS_USE_MOCK: true,
        },
        db,
        keyring,
      }),
      keyring,
      oauthStateSecret: 'openapi-export-ohne-echtes-secret-000000',
      // Das Dokument plant nie etwas ein.
      jobs: {
        enqueueProfilesSync: () => Promise.reject(new Error('Keine Job-Queue beim Export.')),
        enqueueFileImport: () => Promise.reject(new Error('Keine Job-Queue beim Export.')),
        enqueueAdChangesSubmit: () => Promise.reject(new Error('Keine Job-Queue beim Export.')),
      },
    });
    const res = await app.request('/api/openapi.json');
    if (!res.ok) throw new Error(`OpenAPI-Dokument nicht erzeugt: ${res.status}`);
    return `${JSON.stringify(await res.json(), null, 2)}\n`;
  } finally {
    await close();
  }
}
