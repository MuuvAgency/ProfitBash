import { randomBytes } from 'node:crypto';
import { createDb } from '@profitbash/db';
import { parseKeyring } from '@profitbash/shared/crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { createAmazonAdsDeps, MOCK_CONSENT_PATH } from './amazon';

// Lazy: postgres.js verbindet erst bei der ersten Abfrage, und hier wird nichts abgefragt.
const { db, close } = createDb('postgres://amazon-test@localhost:1/none', { max: 1 });
const keyring = parseKeyring({
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ENCRYPTION_KEY_ID: 'k1',
});
const env = {
  APP_URL: 'http://localhost:5173',
  AMAZON_ADS_REDIRECT_URI: 'http://localhost:5173/api/amazon/oauth/callback',
};

afterAll(async () => {
  await close();
});

describe('createAmazonAdsDeps', () => {
  it('nutzt im Mock-Modus die simulierte Einwilligungsseite der App', () => {
    const deps = createAmazonAdsDeps({
      env: { ...env, AMAZON_ADS_USE_MOCK: true },
      db,
      keyring,
    });
    expect(deps.mockConsent).toEqual({ redirectUri: env.AMAZON_ADS_REDIRECT_URI });

    const url = new URL(deps.client.buildAuthorizeUrl({ region: 'eu', state: 'abc' }));
    expect(`${url.origin}${url.pathname}`).toBe(`${env.APP_URL}${MOCK_CONSENT_PATH}`);
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe(env.AMAZON_ADS_REDIRECT_URI);
  });

  it('nutzt ohne Mock Amazon mit den konfigurierten Zugangsdaten', () => {
    const deps = createAmazonAdsDeps({
      env: {
        ...env,
        AMAZON_ADS_USE_MOCK: false,
        AMAZON_ADS_CLIENT_ID: 'amzn1.application-oa2-client.echt',
        AMAZON_ADS_CLIENT_SECRET: 'geheim',
      },
      db,
      keyring,
    });
    expect(deps.mockConsent).toBeNull();

    const url = new URL(deps.client.buildAuthorizeUrl({ region: 'eu', state: 'abc' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://eu.account.amazon.com/ap/oa');
    expect(url.searchParams.get('client_id')).toBe('amzn1.application-oa2-client.echt');
    expect(url.toString()).not.toContain('geheim');
  });

  it('verlangt ohne Mock Client-ID und Secret', () => {
    expect(() =>
      createAmazonAdsDeps({ env: { ...env, AMAZON_ADS_USE_MOCK: false }, db, keyring }),
    ).toThrow(/AMAZON_ADS_CLIENT_ID/);
  });
});
