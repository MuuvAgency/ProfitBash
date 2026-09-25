import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  appUrlSchema,
  databaseUrlSchema,
  EnvValidationError,
  findEnvFile,
  loadEnv,
  nodeEnvSchema,
} from './env';

const schema = nodeEnvSchema.extend(appUrlSchema.shape).extend(databaseUrlSchema.shape);
const validSource = {
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
};

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'profitbash-env-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('loadEnv', () => {
  it('liefert typisierte Werte mit Defaults und wandelt Zahlen um', () => {
    const env = loadEnv(schema, { source: { ...validSource, API_PORT: '9000' } });
    expect(env).toEqual({
      NODE_ENV: 'development',
      APP_URL: 'http://localhost:5173',
      API_PORT: 9000,
      DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
    });
  });

  it('nennt fehlende Variablen, aber nie deren Werte', () => {
    const secret = 'postgres://user:super-geheim@localhost/db';
    let error: unknown;
    try {
      loadEnv(schema, { source: { DATABASE_URL: secret, API_PORT: 'kein-port' } });
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(EnvValidationError);
    const message = (error as EnvValidationError).message;
    expect(message).toContain('APP_URL');
    expect(message).toContain('API_PORT');
    expect(message).not.toContain('super-geheim');
  });

  it('akzeptiert für DATABASE_URL nur Postgres-URLs', () => {
    expect(() =>
      loadEnv(schema, { source: { ...validSource, DATABASE_URL: 'mysql://localhost/db' } }),
    ).toThrow(EnvValidationError);
    expect(() =>
      loadEnv(schema, { source: { ...validSource, DATABASE_URL: 'postgresql://localhost/db' } }),
    ).not.toThrow();
  });

  it('lädt eine .env-Datei, ohne gesetzte Variablen zu überschreiben', () => {
    const dir = makeTempDir();
    const envFile = join(dir, '.env');
    writeFileSync(envFile, 'PB_TEST_FROM_FILE=aus-datei\nPB_TEST_ALREADY_SET=aus-datei\n');
    process.env.PB_TEST_ALREADY_SET = 'aus-prozess';

    try {
      const env = loadEnv(nodeEnvSchema.loose(), { envFile });
      expect(env.PB_TEST_FROM_FILE).toBe('aus-datei');
      expect(env.PB_TEST_ALREADY_SET).toBe('aus-prozess');
    } finally {
      delete process.env.PB_TEST_FROM_FILE;
      delete process.env.PB_TEST_ALREADY_SET;
    }
  });
});

describe('findEnvFile', () => {
  it('findet die .env in einem übergeordneten Ordner', () => {
    const root = makeTempDir();
    const nested = join(root, 'apps', 'api', 'src');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, '.env'), 'X=1\n');

    expect(findEnvFile(nested)).toBe(join(root, '.env'));
  });

  it('liefert undefined, wenn es keine .env gibt', () => {
    expect(findEnvFile(makeTempDir(), '.env.gibt-es-nicht')).toBeUndefined();
  });
});
