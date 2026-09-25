import { schema, type Db } from '@profitbash/db';
import {
  orgAccessControl,
  orgRoles,
  platformAccessControl,
  platformRoles,
} from '@profitbash/shared/access-control';
import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { admin, organization } from 'better-auth/plugins';

export interface CreateAuthOptions {
  db: Db;
  secret: string;
  /** Öffentliche Origin der App (APP_URL). */
  baseURL: string;
  trustedOrigins?: string[];
}

/**
 * better-auth-Konfiguration. Änderungen an Plugins oder Feldern erfordern ein neues Schema:
 * `pnpm --filter @profitbash/api auth:schema`, danach `pnpm db:generate`.
 */
export function createAuth({ db, secret, baseURL, trustedOrigins = [] }: CreateAuthOptions) {
  return betterAuth({
    secret,
    baseURL,
    basePath: '/api/auth',
    trustedOrigins,
    database: drizzleAdapter(db, { provider: 'pg', schema, usePlural: true }),
    advanced: { database: { generateId: 'uuid' } },
    emailAndPassword: {
      enabled: true,
      // Keine öffentliche Registrierung: Nutzer legen Admins an (Seed, später Mitgliederverwaltung).
      disableSignUp: true,
      minPasswordLength: 12,
    },
    plugins: [
      organization({
        ac: orgAccessControl,
        roles: orgRoles,
        creatorRole: 'admin',
        allowUserToCreateOrganization: false,
        schema: {
          organization: {
            additionalFields: {
              // internal = Agentur (Muuv), client = Kundenorganisation.
              // input: false → Clients können den Typ nicht setzen oder ändern, nur der Server.
              type: { type: 'string', required: true, defaultValue: 'client', input: false },
            },
          },
        },
      }),
      admin({
        ac: platformAccessControl,
        roles: platformRoles,
        adminRoles: ['superadmin'],
        defaultRole: 'user',
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
