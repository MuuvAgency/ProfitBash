import type { Db, Membership } from '@profitbash/db';
import type { OrgRole, PlatformRole } from '@profitbash/shared';
import type { RequestIdVariables } from 'hono/request-id';
import type { Auth } from './auth';
import type { Logger } from './logger';

/** Abhängigkeiten der App. Werden beim Start (bzw. im Test) übergeben, nie global importiert. */
export interface AppDeps {
  db: Db;
  auth: Auth;
  /** Öffentliche Origin der App (APP_URL); Grundlage für den CSRF-Schutz. */
  appUrl: string;
  /** Ausgelieferte Version, z. B. Git-Commit. */
  version: string;
  logger: Logger;
  /** Zeit bis `/api/health` eine nicht antwortende DB als Fehler meldet (Standard 3 s). */
  healthTimeoutMs?: number;
}

/** Angemeldeter Nutzer mit aufgelöster aktiver Organisation (gesetzt von `requireSession`). */
export interface AuthState {
  user: { id: string; email: string; name: string; role: PlatformRole };
  sessionId: string;
  memberships: Membership[];
  /** `null`, wenn der Nutzer keiner Organisation angehört. */
  activeOrganization: Membership | null;
  /** Rolle in der aktiven Organisation. */
  orgRole: OrgRole | null;
}

export interface AppEnv {
  Variables: RequestIdVariables & { auth: AuthState };
}
