// Nur für das better-auth-CLI (`pnpm --filter @profitbash/api auth:schema`).
// Baut keine Datenbankverbindung auf und wird nie zur Laufzeit geladen.
import { createDb } from '@profitbash/db';
import { createAuth } from './auth';

export const auth = createAuth({
  db: createDb('postgres://localhost/schema-generation').db,
  secret: 'nur-fuer-die-schema-erzeugung-0000000000',
  baseURL: 'http://localhost:8787',
});
