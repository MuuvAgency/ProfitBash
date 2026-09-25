import { setupServer } from 'msw/node';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { AmazonAdsHttpError, AmazonAdsReauthRequiredError } from './errors';
import {
  createMockAmazonAdsClient,
  MOCK_AMAZON_ADS_AUTHORIZATION_CODE,
  MOCK_AMAZON_ADS_IDENTITY,
  renderMockConsentPage,
} from './mock';

// Ohne Handler: Jeder echte Netzwerkaufruf würde den Test scheitern lassen.
const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterAll(() => server.close());

const REDIRECT_URI = 'http://localhost:5173/api/amazon/oauth/callback';
const CONSENT_URL = 'http://localhost:5173/api/amazon/mock/consent';
const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };

function storeWith(refreshToken: string): RefreshTokenStore {
  return {
    async withRefreshToken(_id, refresh) {
      return (await refresh(refreshToken)).result;
    },
  };
}

function setup(refreshToken = 'unused') {
  return createMockAmazonAdsClient({
    redirectUri: REDIRECT_URI,
    consentUrl: CONSENT_URL,
    store: storeWith(refreshToken),
  });
}

describe('Mock-Anbieter', () => {
  it('leitet die Einwilligung auf die simulierte Seite statt zu Amazon', () => {
    const url = new URL(setup().buildAuthorizeUrl({ region: 'eu', state: 'abc' }));
    expect(`${url.origin}${url.pathname}`).toBe(CONSENT_URL);
    expect(url.searchParams.get('state')).toBe('abc');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
  });

  it('spielt den kompletten Ablauf durch: Code tauschen, Identität, Profile', async () => {
    const client = setup();
    const tokens = await client.exchangeCode({
      region: 'eu',
      code: MOCK_AMAZON_ADS_AUTHORIZATION_CODE,
    });
    expect(tokens.refreshToken).toMatch(/^Atzr\|mock-/);
    expect(tokens.accessToken).toMatch(/^Atza\|mock-/);

    const identity = await client.getAccountIdentity({
      region: 'eu',
      accessToken: tokens.accessToken,
    });
    expect(identity).toEqual(MOCK_AMAZON_ADS_IDENTITY);

    const withStoredToken = createMockAmazonAdsClient({
      redirectUri: REDIRECT_URI,
      consentUrl: CONSENT_URL,
      store: storeWith(tokens.refreshToken),
    });
    const profiles = await withStoredToken.listProfiles(connection);
    expect(profiles.length).toBeGreaterThanOrEqual(3);
    expect(new Set(profiles.map((p) => p.accountType))).toEqual(
      new Set(['seller', 'vendor', 'agency']),
    );
    const bigId = profiles.find((p) => p.amazonProfileId === '9007199254740993');
    expect(bigId).toBeDefined();
    expect(BigInt(bigId?.amazonProfileId ?? '0') > BigInt(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it('lehnt einen falschen Code wie Amazon mit invalid_grant ab', async () => {
    const error = await setup()
      .exchangeCode({ region: 'eu', code: 'falsch' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsHttpError);
    expect(error).toMatchObject({ status: 400, code: 'invalid_grant' });
  });

  it('meldet einen nicht vom Mock ausgestellten Refresh-Token als Neu-Verbinden-Fall', async () => {
    await expect(setup('Atzr|revoked').listProfiles(connection)).rejects.toBeInstanceOf(
      AmazonAdsReauthRequiredError,
    );
  });

  it('liefert in NA und FE eigene Profile (Region wird respektiert)', async () => {
    const client = setup('Atzr|mock-refresh');
    const na = await client.listProfiles({ id: 'c', organizationId: 'org-1', region: 'na' });
    expect(na.map((p) => p.countryCode)).toEqual(['US']);
    await expect(
      client.listProfiles({ id: 'c', organizationId: 'org-1', region: 'fe' }),
    ).resolves.toEqual([]);
  });
});

describe('renderMockConsentPage', () => {
  it('verlinkt Erlauben und Ablehnen nur auf die konfigurierte Redirect-URI', () => {
    const html = renderMockConsentPage({ redirectUri: REDIRECT_URI, state: 'st-1' });
    const allow = new URL(
      `${REDIRECT_URI}?code=${MOCK_AMAZON_ADS_AUTHORIZATION_CODE}&scope=advertising%3A%3Acampaign_management+profile&state=st-1`,
    );
    expect(html).toContain(allow.toString().replaceAll('&', '&amp;'));
    expect(html).toContain('error=access_denied');
    expect(html).toContain('Mock');
  });

  it('escaped den state (kein HTML aus der Query)', () => {
    const html = renderMockConsentPage({
      redirectUri: REDIRECT_URI,
      state: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>');
  });
});
