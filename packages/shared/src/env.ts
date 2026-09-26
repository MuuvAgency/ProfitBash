import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import { KeyringError, parseKeyring, type KeyringEnv } from './crypto';

/**
 * Bausteine für die Env-Schemas der Apps. Jede App setzt daraus ihr Schema zusammen
 * und validiert beim Start nur, was sie tatsächlich braucht.
 */
export const nodeEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
});

export const appUrlSchema = z.object({
  APP_URL: z.url(),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
});

export const workerModeSchema = z.object({
  WORKER_MODE: z.enum(['inline', 'separate']).default('inline'),
});

export const postgresUrlSchema = z.url({ protocol: /^postgres(ql)?$/ });
const postgresUrl = postgresUrlSchema;

export const databaseUrlSchema = z.object({ DATABASE_URL: postgresUrl });
export const databaseDirectUrlSchema = z.object({ DATABASE_URL_DIRECT: postgresUrl });
export const databaseTestUrlSchema = z.object({ DATABASE_URL_TEST: postgresUrl });

export const authSecretSchema = z.object({
  BETTER_AUTH_SECRET: z.string().min(32, 'mindestens 32 Zeichen (openssl rand -base64 32)'),
});

export const seedAdminSchema = z.object({
  SEED_ADMIN_EMAIL: z.email(),
  SEED_ADMIN_PASSWORD: z.string().min(12, 'mindestens 12 Zeichen'),
});

/** Leere Werte aus `.env` (`NAME=`) gelten als nicht gesetzt. */
const optionalString = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.string().optional(),
);

/**
 * Schlüssel für verschlüsselte Secrets (`@profitbash/shared/crypto`). Nur die Form wird hier geprüft;
 * den Inhalt prüft `refineKeyring` über `parseKeyring`.
 */
export const encryptionEnvSchema = z.object({
  ENCRYPTION_KEY: z.string().min(1, 'fehlt (openssl rand -base64 32)'),
  ENCRYPTION_KEY_ID: z.string().min(1, 'fehlt (z. B. k1)'),
  ENCRYPTION_KEYS_PREVIOUS: optionalString,
});

/** Prüft die Schlüssel mit `parseKeyring`. Für `superRefine` des App-Schemas. */
export function refineKeyring(env: KeyringEnv, ctx: z.RefinementCtx): void {
  try {
    parseKeyring(env);
  } catch (error) {
    // KeyringError-Meldungen nennen die Variable, aber nie Schlüsselmaterial.
    if (!(error instanceof KeyringError)) throw error;
    ctx.addIssue({ code: 'custom', path: ['ENCRYPTION_KEY'], message: error.message });
  }
}

export const oauthStateSecretSchema = z.object({
  OAUTH_STATE_SECRET: z.string().min(32, 'mindestens 32 Zeichen (openssl rand -base64 32)'),
});

/**
 * Amazon Ads (Login with Amazon). `AMAZON_ADS_USE_MOCK=true` nutzt den Mock-Anbieter, dann sind
 * Client-ID und Secret nicht nötig (siehe `refineAmazonAdsCredentials`).
 */
export const amazonAdsEnvSchema = z.object({
  AMAZON_ADS_CLIENT_ID: optionalString,
  AMAZON_ADS_CLIENT_SECRET: optionalString,
  AMAZON_ADS_REDIRECT_URI: z.url({ protocol: /^https?$/ }),
  AMAZON_ADS_USE_MOCK: z
    .enum(['true', 'false'])
    .default('false')
    .transform((value) => value === 'true'),
});

/** Ohne Mock sind Client-ID und Secret Pflicht. Für `superRefine` des App-Schemas. */
export function refineAmazonAdsCredentials(
  env: z.output<typeof amazonAdsEnvSchema>,
  ctx: z.RefinementCtx,
): void {
  if (env.AMAZON_ADS_USE_MOCK) return;
  for (const name of ['AMAZON_ADS_CLIENT_ID', 'AMAZON_ADS_CLIENT_SECRET'] as const) {
    if (!env[name]) {
      ctx.addIssue({
        code: 'custom',
        path: [name],
        message: 'fehlt (Pflicht, solange AMAZON_ADS_USE_MOCK nicht true ist)',
      });
    }
  }
}

export class EnvValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Ungültige Umgebungsvariablen:\n${issues.map((issue) => `  - ${issue}`).join('\n')}`);
    this.name = 'EnvValidationError';
  }
}

/** Sucht ab `startDir` aufwärts nach einer `.env`-Datei (z. B. im Repo-Root). */
export function findEnvFile(
  startDir: string = process.cwd(),
  fileName = '.env',
): string | undefined {
  let dir = resolve(startDir);
  for (;;) {
    const candidate = join(dir, fileName);
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

export interface LoadEnvOptions {
  /** Quelle der Variablen. Standard: `process.env`. */
  source?: Record<string, string | undefined>;
  /**
   * `.env`-Datei, die vorher in `process.env` geladen wird. Standard: automatisch suchen,
   * außer in Produktion. Bereits gesetzte Variablen werden nicht überschrieben.
   */
  envFile?: string | false;
}

/**
 * Validiert die Umgebungsvariablen gegen ein zod-Schema und gibt sie typisiert zurück.
 * Fehlermeldungen nennen nur Variablennamen, nie Werte (Secrets bleiben aus Logs heraus).
 */
export function loadEnv<S extends z.ZodType>(schema: S, options: LoadEnvOptions = {}): z.output<S> {
  const source = options.source ?? process.env;

  if (options.source === undefined && options.envFile !== false) {
    const envFile =
      options.envFile ?? (process.env.NODE_ENV === 'production' ? undefined : findEnvFile());
    if (envFile) loadEnvFileWithoutOverride(envFile);
  }

  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvValidationError(
      result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    );
  }
  return result.data;
}

/** Lädt eine `.env`-Datei, ohne bereits gesetzte Variablen zu überschreiben. */
function loadEnvFileWithoutOverride(path: string): void {
  const before = { ...process.env };
  process.loadEnvFile(path);
  for (const [key, value] of Object.entries(before)) {
    process.env[key] = value;
  }
}
