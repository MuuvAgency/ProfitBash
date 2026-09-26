import type { Db, Membership } from '@profitbash/db';
import type { OrgRole, PlatformRole } from '@profitbash/shared';
import type { Keyring } from '@profitbash/shared/crypto';
import type { RequestIdVariables } from 'hono/request-id';
import type { AmazonAdsDeps } from './amazon';
import type { Auth } from './auth';
import type { JobQueue } from './jobs';
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
  /** Amazon-Client (echt oder Mock, siehe `createAmazonAdsDeps`). */
  amazonAds: AmazonAdsDeps;
  /** Schlüssel für Refresh-Tokens (`ENCRYPTION_*`). */
  keyring: Keyring;
  /** HMAC-Secret für den OAuth-`state` (`OAUTH_STATE_SECRET`). */
  oauthStateSecret: string;
  jobs: JobQueue;
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
