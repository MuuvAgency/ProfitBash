// Test-Hilfen für die API. Nur aus Tests importieren.
import { randomBytes } from 'node:crypto';
import { createTestDatabase, type TestDatabase } from '@profitbash/db/testing';
import { schema } from '@profitbash/db';
import type { OrgRole, PlatformRole } from '@profitbash/shared';
import { parseKeyring, type Keyring } from '@profitbash/shared/crypto';
import { createAmazonAdsDeps } from './amazon';
import { createApp } from './app';
import { createAuth, type Auth } from './auth';
import type { AppDeps } from './context';
import { AMAZON_OAUTH_CALLBACK_PATH } from './env';
import type { JobQueue, ProfilesSyncJob } from './jobs';
import type { LogEntry } from './logger';
import { seed, type SeedResult } from './seed';

export const TEST_APP_URL = 'http://localhost:5173';
export const TEST_PASSWORD = 'ein-sicheres-passwort-123';
export const TEST_OAUTH_STATE_SECRET = 'test-oauth-state-secret-mit-32-zeichen-00';
export const TEST_REDIRECT_URI = `${TEST_APP_URL}${AMAZON_OAUTH_CALLBACK_PATH}`;

/** Job-Queue für Tests: merkt sich eingeplante Jobs; `failNext` lässt den nächsten Aufruf scheitern. */
export interface RecordingJobQueue extends JobQueue {
  profilesSync: ProfilesSyncJob[];
  failNext: boolean;
}

function createRecordingJobQueue(): RecordingJobQueue {
  const queue: RecordingJobQueue = {
    profilesSync: [],
    failNext: false,
    enqueueProfilesSync(job) {
      if (queue.failNext) {
        queue.failNext = false;
        return Promise.reject(new Error('Queue nicht erreichbar'));
      }
      queue.profilesSync.push(job);
      return Promise.resolve();
    },
  };
  return queue;
}

export interface TestContext {
  testDb: TestDatabase;
  auth: Auth;
  app: ReturnType<typeof createApp>;
  /** Abhängigkeiten der App, z. B. um eine zweite App mit Abweichungen zu bauen. */
  deps: AppDeps;
  logs: LogEntry[];
  jobs: RecordingJobQueue;
  keyring: Keyring;
  /** Seed-Admin (Superadmin, Org-Admin von Muuv). */
  seeded: SeedResult & { email: string };
  close(): Promise<void>;
}

export async function createTestContext(): Promise<TestContext> {
  const testDb = await createTestDatabase();
  const auth = createAuth({
    db: testDb.db,
    secret: 'test-secret-mit-mindestens-32-zeichen-000',
    baseURL: TEST_APP_URL,
    trustedOrigins: [TEST_APP_URL],
  });
  const logs: LogEntry[] = [];
  const logger = (entry: LogEntry) => logs.push(entry);
  const keyring = parseKeyring({
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    ENCRYPTION_KEY_ID: 'k1',
  });
  const jobs = createRecordingJobQueue();
  const deps: AppDeps = {
    db: testDb.db,
    auth,
    appUrl: TEST_APP_URL,
    version: 'test-version',
    logger,
    amazonAds: createAmazonAdsDeps({
      env: {
        APP_URL: TEST_APP_URL,
        AMAZON_ADS_REDIRECT_URI: TEST_REDIRECT_URI,
        AMAZON_ADS_USE_MOCK: true,
      },
      db: testDb.db,
      keyring,
      logger,
    }),
    keyring,
    oauthStateSecret: TEST_OAUTH_STATE_SECRET,
    jobs,
  };
  const app = createApp(deps);
  const email = 'admin@muuv.test';
  const seeded = await seed({ db: testDb.db, auth, admin: { email, password: TEST_PASSWORD } });
  return {
    testDb,
    auth,
    app,
    deps,
    logs,
    jobs,
    keyring,
    seeded: { ...seeded, email },
    close: () => testDb.close(),
  };
}

/** Legt einen Nutzer an und fügt ihn optional einer Organisation mit Rolle hinzu. */
export async function createUser(
  ctx: TestContext,
  input: { email: string; role?: PlatformRole; org?: { id: string; role: OrgRole } },
): Promise<{ id: string; email: string }> {
  const { user } = await ctx.auth.api.createUser({
    body: { email: input.email, password: TEST_PASSWORD, name: input.email, role: input.role },
  });
  if (input.org) {
    await ctx.testDb.db.insert(schema.members).values({
      organizationId: input.org.id,
      userId: user.id,
      role: input.org.role,
      createdAt: new Date(),
    });
  }
  return { id: user.id, email: user.email };
}

export interface RequestOptions {
  method?: string;
  cookie?: string;
  json?: unknown;
  headers?: Record<string, string>;
}

/** Request wie aus dem Browser der App (gleiche Origin). */
export function request(ctx: TestContext, path: string, options: RequestOptions = {}) {
  const headers = new Headers({ origin: TEST_APP_URL, ...options.headers });
  if (options.cookie) headers.set('cookie', options.cookie);
  let body: string | undefined;
  if (options.json !== undefined) {
    if (!headers.has('content-type')) headers.set('content-type', 'application/json');
    body = JSON.stringify(options.json);
  }
  return ctx.app.request(path, { method: options.method ?? 'GET', headers, body });
}

/** Meldet sich über die HTTP-API an und liefert den Session-Cookie. */
export async function signIn(ctx: TestContext, email: string): Promise<string> {
  const res = await request(ctx, '/api/auth/sign-in/email', {
    method: 'POST',
    json: { email, password: TEST_PASSWORD },
  });
  if (res.status !== 200) throw new Error(`Anmeldung fehlgeschlagen: ${res.status}`);
  const cookie = res.headers.get('set-cookie')?.split(';')[0];
  if (!cookie) throw new Error('Kein Session-Cookie erhalten.');
  return cookie;
}

/** Liest den JSON-Body mit dem erwarteten Typ (die Werte prüfen die Tests selbst). */
export async function readJson<T>(res: Response): Promise<T> {
  return (await res.json()) as T;
}
