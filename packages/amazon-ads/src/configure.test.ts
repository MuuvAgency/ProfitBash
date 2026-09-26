import { describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClientFromConfig } from './configure';

const store: RefreshTokenStore = {
  withRefreshToken: () => Promise.reject(new Error('nicht benutzt')),
};
const base = {
  redirectUri: 'http://localhost:5173/api/amazon/oauth/callback',
  mockConsentUrl: 'http://localhost:5173/api/amazon/oauth/mock-consent',
};

describe('createAmazonAdsClientFromConfig', () => {
  it('nutzt im Mock-Modus die simulierte Einwilligungsseite', () => {
    const client = createAmazonAdsClientFromConfig({ config: { ...base, useMock: true }, store });
    const url = new URL(client.buildAuthorizeUrl({ region: 'eu', state: 'abc' }));
    expect(`${url.origin}${url.pathname}`).toBe(base.mockConsentUrl);
    expect(url.searchParams.get('redirect_uri')).toBe(base.redirectUri);
  });

  it('nutzt ohne Mock Amazon mit den konfigurierten Zugangsdaten', () => {
    const client = createAmazonAdsClientFromConfig({
      config: {
        ...base,
        useMock: false,
        clientId: 'amzn1.application-oa2-client.echt',
        clientSecret: 'geheim',
      },
      store,
    });
    const url = new URL(client.buildAuthorizeUrl({ region: 'eu', state: 'abc' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://eu.account.amazon.com/ap/oa');
    expect(url.searchParams.get('client_id')).toBe('amzn1.application-oa2-client.echt');
    expect(url.toString()).not.toContain('geheim');
  });

  it('verlangt ohne Mock Client-ID und Secret', () => {
    expect(() =>
      createAmazonAdsClientFromConfig({ config: { ...base, useMock: false }, store }),
    ).toThrow(/AMAZON_ADS_CLIENT_ID/);
  });
});
