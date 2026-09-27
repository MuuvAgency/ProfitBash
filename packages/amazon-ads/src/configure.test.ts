import { describe, expect, it } from 'vitest';
import { z } from 'zod';
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

  it('reicht die konfigurierte Anfragerate je Profil an den Client weiter', async () => {
    // Mock-Modus: Aufrufe bleiben im Prozess (unbekannte Pfade antworten 404).
    const client = createAmazonAdsClientFromConfig({
      config: { ...base, useMock: true, requestsPerSecond: 1_000 },
      store: {
        async withRefreshToken(_connectionId, refresh) {
          const { result } = await refresh('Atzr|mock-refresh-test');
          return result;
        },
      },
    });
    const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };
    const request = {
      operation: 't',
      method: 'GET' as const,
      path: '/unbekannt',
      amazonProfileId: '111',
      schema: z.unknown(),
    };
    const started = Date.now();
    await expect(client.request(connection, request)).rejects.toThrow(/404/);
    await expect(client.request(connection, request)).rejects.toThrow(/404/);
    // Mit dem Standard (2/s) läge die zweite Anfrage 500 ms nach der ersten.
    expect(Date.now() - started).toBeLessThan(400);
  });

  it('verlangt ohne Mock Client-ID und Secret', () => {
    expect(() =>
      createAmazonAdsClientFromConfig({ config: { ...base, useMock: false }, store }),
    ).toThrow(/AMAZON_ADS_CLIENT_ID/);
  });
});
