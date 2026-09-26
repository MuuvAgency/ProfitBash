import { randomBytes } from 'node:crypto';
import { EnvValidationError } from '@profitbash/shared/env';
import { describe, expect, it } from 'vitest';
import { healthcheckUrls, loadWorkerEnv } from './env';

const base = {
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  DATABASE_URL_DIRECT: 'postgres://user:pass@localhost:5432/db',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ENCRYPTION_KEY_ID: 'k1',
  AMAZON_ADS_REDIRECT_URI: 'http://localhost:5173/api/amazon/oauth/callback',
  AMAZON_ADS_USE_MOCK: 'true',
};

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as Error).message;
  }
  throw new Error('Erwarteter EnvValidationError blieb aus.');
}

describe('loadWorkerEnv', () => {
  it('liefert Werte, Keyring und Standardmodus inline', () => {
    const env = loadWorkerEnv({ source: base });
    expect(env.WORKER_MODE).toBe('inline');
    expect(env.keyring.current.id).toBe('k1');
    expect(env.AMAZON_ADS_USE_MOCK).toBe(true);
  });

  it('prüft den Schlüssel wie die API', () => {
    const message = messageOf(() =>
      loadWorkerEnv({ source: { ...base, ENCRYPTION_KEY: 'zu-kurz' } }),
    );
    expect(message).toMatch(/ENCRYPTION_KEY/);
  });

  it('verlangt ohne Mock Client-ID und Secret', () => {
    const message = messageOf(() =>
      loadWorkerEnv({ source: { ...base, AMAZON_ADS_USE_MOCK: 'false' } }),
    );
    expect(message).toMatch(/AMAZON_ADS_CLIENT_ID/);
    expect(message).toMatch(/AMAZON_ADS_CLIENT_SECRET/);
  });

  it('verlangt die direkte Datenbank-URL für pg-boss', () => {
    const message = messageOf(() =>
      loadWorkerEnv({ source: { ...base, DATABASE_URL_DIRECT: undefined } }),
    );
    expect(message).toMatch(/DATABASE_URL_DIRECT/);
  });
});

describe('healthcheckUrls', () => {
  it('ordnet die Ping-URLs den Jobs zu', () => {
    expect(
      healthcheckUrls({
        HEALTHCHECKS_TOKEN_REFRESH_URL: 'https://hc-ping.com/a',
        HEALTHCHECKS_PROFILES_SYNC_URL: undefined,
      }),
    ).toEqual({ 'token-refresh': 'https://hc-ping.com/a', 'profiles-sync': undefined });
  });
});
