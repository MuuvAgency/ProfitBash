import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';

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

const postgresUrl = z.url({ protocol: /^postgres(ql)?$/ });

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
