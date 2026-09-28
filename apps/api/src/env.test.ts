import { randomBytes } from 'node:crypto';
import { EnvValidationError } from '@profitbash/shared/env';
import { describe, expect, it } from 'vitest';
import { loadApiEnv } from './env';

const key = randomBytes(32).toString('base64');
const previousKey = randomBytes(32).toString('base64');

const base = {
  APP_URL: 'http://localhost:5173',
  DATABASE_URL: 'postgres://user:pass@localhost:5432/db',
  DATABASE_URL_DIRECT: 'postgres://user:pass@localhost:5432/db',
  BETTER_AUTH_SECRET: 'a'.repeat(32),
  ENCRYPTION_KEY: key,
  ENCRYPTION_KEY_ID: 'k1',
  OAUTH_STATE_SECRET: 'o'.repeat(32),
  AMAZON_ADS_REDIRECT_URI: 'http://localhost:5173/api/amazon/oauth/callback',
  AMAZON_ADS_USE_MOCK: 'true',
};

function load(source: Record<string, string | undefined>) {
  return loadApiEnv({ source });
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(EnvValidationError);
    return (error as Error).message;
  }
  throw new Error('Erwarteter EnvValidationError blieb aus.');
}

describe('loadApiEnv', () => {
  it('verlangt die direkte Datenbank-URL für pg-boss', () => {
    expect(messageOf(() => load({ ...base, DATABASE_URL_DIRECT: undefined }))).toMatch(
      /DATABASE_URL_DIRECT/,
    );
  });

  it('liest die Healthcheck-URLs für den Worker im API-Prozess', () => {
    const env = load({ ...base, HEALTHCHECKS_PROFILES_SYNC_URL: 'https://hc-ping.com/p' });
    expect(env.HEALTHCHECKS_PROFILES_SYNC_URL).toBe('https://hc-ping.com/p');
    expect(env.HEALTHCHECKS_TOKEN_REFRESH_URL).toBeUndefined();
  });

  it('lauscht in Produktion auf PORT (von Railway gesetzt) statt auf API_PORT', () => {
    const env = load({ ...base, NODE_ENV: 'production', PORT: '3000', API_PORT: '8787' });
    expect(env.port).toBe(3000);
  });

  it('nutzt in Produktion API_PORT (Standard 8787), wenn PORT fehlt oder leer ist', () => {
    expect(load({ ...base, NODE_ENV: 'production', API_PORT: '9000' }).port).toBe(9000);
    expect(load({ ...base, NODE_ENV: 'production', PORT: '' }).port).toBe(8787);
  });

  it('ignoriert PORT außerhalb von Produktion (der Vite-Proxy zielt auf API_PORT)', () => {
    // Dev-Werkzeuge setzen PORT oft für den Web-Server (z. B. 5173).
    expect(load({ ...base, NODE_ENV: 'development', PORT: '5173' }).port).toBe(8787);
  });

  it('lehnt einen ungültigen PORT ab', () => {
    expect(messageOf(() => load({ ...base, PORT: 'abc' }))).toMatch(/PORT/);
  });

  it('baut den Keyring aus ENCRYPTION_* (inkl. vorheriger Schlüssel)', () => {
    const env = load({ ...base, ENCRYPTION_KEYS_PREVIOUS: `k0:${previousKey}` });
    expect(env.keyring.current.id).toBe('k1');
    expect(env.keyring.previous.map((k) => k.id)).toEqual(['k0']);
  });

  it('nennt einen ungültigen Schlüssel, ohne seinen Wert zu zeigen', () => {
    const shortKey = randomBytes(16).toString('base64');
    const message = messageOf(() => load({ ...base, ENCRYPTION_KEY: shortKey }));
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).not.toContain(shortKey);
  });

  it('verlangt ENCRYPTION_KEY, ENCRYPTION_KEY_ID und OAUTH_STATE_SECRET', () => {
    const message = messageOf(() =>
      load({
        ...base,
        ENCRYPTION_KEY: undefined,
        ENCRYPTION_KEY_ID: '',
        OAUTH_STATE_SECRET: 'zu-kurz',
      }),
    );
    expect(message).toContain('ENCRYPTION_KEY');
    expect(message).toContain('ENCRYPTION_KEY_ID');
    expect(message).toContain('OAUTH_STATE_SECRET');
    expect(message).not.toContain('zu-kurz');
  });

  it('Mock-Modus braucht keine Amazon-Zugangsdaten', () => {
    const env = load({ ...base, AMAZON_ADS_CLIENT_ID: '', AMAZON_ADS_CLIENT_SECRET: '' });
    expect(env.AMAZON_ADS_USE_MOCK).toBe(true);
    expect(env.AMAZON_ADS_CLIENT_ID).toBeUndefined();
  });

  it('ohne Mock sind Client-ID und Secret Pflicht (Standard ist kein Mock)', () => {
    const message = messageOf(() => load({ ...base, AMAZON_ADS_USE_MOCK: undefined }));
    expect(message).toContain('AMAZON_ADS_CLIENT_ID');
    expect(message).toContain('AMAZON_ADS_CLIENT_SECRET');

    const env = load({
      ...base,
      AMAZON_ADS_USE_MOCK: 'false',
      AMAZON_ADS_CLIENT_ID: 'amzn1.application-oa2-client.x',
      AMAZON_ADS_CLIENT_SECRET: 'geheim',
    });
    expect(env.AMAZON_ADS_USE_MOCK).toBe(false);
    expect(env.AMAZON_ADS_CLIENT_ID).toBe('amzn1.application-oa2-client.x');
  });

  it('AMAZON_ADS_MOCK_SCALE=large nur mit Mock und nicht in Produktion', () => {
    expect(load({ ...base, AMAZON_ADS_MOCK_SCALE: 'large' }).AMAZON_ADS_MOCK_SCALE).toBe('large');
    expect(
      messageOf(() =>
        load({
          ...base,
          AMAZON_ADS_USE_MOCK: 'false',
          AMAZON_ADS_CLIENT_ID: 'amzn1.application-oa2-client.x',
          AMAZON_ADS_CLIENT_SECRET: 'geheim',
          AMAZON_ADS_MOCK_SCALE: 'large',
        }),
      ),
    ).toContain('AMAZON_ADS_MOCK_SCALE');
    expect(
      messageOf(() => load({ ...base, NODE_ENV: 'production', AMAZON_ADS_MOCK_SCALE: 'large' })),
    ).toContain('AMAZON_ADS_MOCK_SCALE');
  });

  it('lehnt andere Werte als true/false für AMAZON_ADS_USE_MOCK ab', () => {
    expect(messageOf(() => load({ ...base, AMAZON_ADS_USE_MOCK: 'yes' }))).toContain(
      'AMAZON_ADS_USE_MOCK',
    );
  });

  it('verlangt die Callback-URL auf der Origin von APP_URL (Session-Cookie)', () => {
    const otherOrigin = messageOf(() =>
      load({
        ...base,
        AMAZON_ADS_REDIRECT_URI: 'http://localhost:8787/api/amazon/oauth/callback',
      }),
    );
    expect(otherOrigin).toContain('AMAZON_ADS_REDIRECT_URI');

    const otherPath = messageOf(() =>
      load({ ...base, AMAZON_ADS_REDIRECT_URI: 'http://localhost:5173/callback' }),
    );
    expect(otherPath).toContain('AMAZON_ADS_REDIRECT_URI');
  });

  it('meldet kaputte URLs als Env-Fehler statt mit einem TypeError abzubrechen', () => {
    const message = messageOf(() =>
      load({
        ...base,
        APP_URL: 'kaputt',
        AMAZON_ADS_REDIRECT_URI: 'auch-kaputt',
      }),
    );
    expect(message).toContain('APP_URL');
    expect(message).toContain('AMAZON_ADS_REDIRECT_URI');
  });
});
