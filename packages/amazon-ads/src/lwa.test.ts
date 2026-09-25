import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { AmazonAdsReauthRequiredError, AmazonAdsResponseError } from './errors';
import { createHttpClient } from './http';
import { createLwaClient } from './lwa';
import { AMAZON_ADS_REGIONS } from './regions';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const credentials = {
  clientId: 'amzn1.application-oa2-client.test',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:5173/api/amazon/oauth/callback',
};

function setup() {
  const lwa = createLwaClient({
    credentials,
    http: createHttpClient({ sleep: async () => {}, maxAttempts: 3 }),
  });
  return { lwa };
}

describe('AMAZON_ADS_REGIONS', () => {
  it('enthält die dokumentierten Endpunkte je Region', () => {
    expect(AMAZON_ADS_REGIONS.eu).toEqual({
      authorizeUrl: 'https://eu.account.amazon.com/ap/oa',
      tokenUrl: 'https://api.amazon.co.uk/auth/o2/token',
      userProfileUrl: 'https://api.amazon.co.uk/user/profile',
      apiHost: 'https://advertising-api-eu.amazon.com',
    });
    expect(AMAZON_ADS_REGIONS.na.apiHost).toBe('https://advertising-api.amazon.com');
    expect(AMAZON_ADS_REGIONS.na.authorizeUrl).toBe('https://www.amazon.com/ap/oa');
    expect(AMAZON_ADS_REGIONS.fe.tokenUrl).toBe('https://api.amazon.co.jp/auth/o2/token');
    expect(AMAZON_ADS_REGIONS.fe.authorizeUrl).toBe('https://apac.account.amazon.com/ap/oa');
  });
});

describe('buildAuthorizeUrl', () => {
  it('baut die Einwilligungs-URL der Region mit Scopes, Redirect und state', () => {
    const { lwa } = setup();
    const url = new URL(lwa.buildAuthorizeUrl({ region: 'eu', state: 'signed.state' }));
    expect(`${url.origin}${url.pathname}`).toBe('https://eu.account.amazon.com/ap/oa');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: credentials.clientId,
      scope: 'advertising::campaign_management profile',
      response_type: 'code',
      redirect_uri: credentials.redirectUri,
      state: 'signed.state',
    });
  });

  it('lehnt einen leeren state ab (CSRF-Schutz)', () => {
    const { lwa } = setup();
    expect(() => lwa.buildAuthorizeUrl({ region: 'eu', state: '' })).toThrow(TypeError);
  });
});

describe('exchangeCode', () => {
  it('tauscht den Code am Token-Endpunkt der Region gegen Tokens', async () => {
    let form: URLSearchParams | undefined;
    server.use(
      http.post('https://api.amazon.co.uk/auth/o2/token', async ({ request }) => {
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: 'Atza|access',
          refresh_token: 'Atzr|refresh',
          token_type: 'bearer',
          expires_in: 3600,
        });
      }),
    );
    const { lwa } = setup();
    await expect(lwa.exchangeCode({ region: 'eu', code: 'auth-code' })).resolves.toEqual({
      accessToken: 'Atza|access',
      refreshToken: 'Atzr|refresh',
      expiresInSeconds: 3600,
    });
    expect(Object.fromEntries(form ?? [])).toEqual({
      grant_type: 'authorization_code',
      code: 'auth-code',
      redirect_uri: credentials.redirectUri,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });
  });

  it('wiederholt den Code-Tausch bei 5xx nicht (der Code ist nur einmal gültig)', async () => {
    let calls = 0;
    server.use(
      http.post('https://api.amazon.co.uk/auth/o2/token', () => {
        calls += 1;
        return HttpResponse.json({ error: 'server_error' }, { status: 500 });
      }),
    );
    const { lwa } = setup();
    await expect(lwa.exchangeCode({ region: 'eu', code: 'c' })).rejects.toMatchObject({
      status: 500,
    });
    expect(calls).toBe(1);
  });

  it('verlangt einen Refresh-Token in der Antwort', async () => {
    server.use(
      http.post('https://api.amazon.co.uk/auth/o2/token', () =>
        HttpResponse.json({ access_token: 'Atza|a', token_type: 'bearer', expires_in: 3600 }),
      ),
    );
    const { lwa } = setup();
    await expect(lwa.exchangeCode({ region: 'eu', code: 'c' })).rejects.toBeInstanceOf(
      AmazonAdsResponseError,
    );
  });
});

describe('refreshAccessToken', () => {
  it('holt mit dem Refresh-Token ein neues Access-Token', async () => {
    let form: URLSearchParams | undefined;
    server.use(
      http.post('https://api.amazon.com/auth/o2/token', async ({ request }) => {
        form = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: 'Atza|new',
          refresh_token: 'Atzr|same',
          token_type: 'bearer',
          expires_in: 3600,
        });
      }),
    );
    const { lwa } = setup();
    await expect(
      lwa.refreshAccessToken({ region: 'na', refreshToken: 'Atzr|same' }),
    ).resolves.toEqual({
      accessToken: 'Atza|new',
      refreshToken: 'Atzr|same',
      expiresInSeconds: 3600,
    });
    expect(Object.fromEntries(form ?? [])).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'Atzr|same',
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    });
  });

  it('liefert refreshToken = null, wenn Amazon keinen mitschickt', async () => {
    server.use(
      http.post('https://api.amazon.co.uk/auth/o2/token', () =>
        HttpResponse.json({ access_token: 'Atza|new', token_type: 'bearer', expires_in: 3600 }),
      ),
    );
    const { lwa } = setup();
    const result = await lwa.refreshAccessToken({ region: 'eu', refreshToken: 'Atzr|x' });
    expect(result.refreshToken).toBeNull();
  });

  it('wiederholt 5xx beim Refresh', async () => {
    let calls = 0;
    server.use(
      http.post('https://api.amazon.co.uk/auth/o2/token', () => {
        calls += 1;
        return calls === 1
          ? new HttpResponse(null, { status: 503 })
          : HttpResponse.json({ access_token: 'Atza|n', token_type: 'bearer', expires_in: 3600 });
      }),
    );
    const { lwa } = setup();
    await lwa.refreshAccessToken({ region: 'eu', refreshToken: 'Atzr|x' });
    expect(calls).toBe(2);
  });

  it('meldet invalid_grant als AmazonAdsReauthRequiredError', async () => {
    server.use(
      http.post('https://api.amazon.co.uk/auth/o2/token', () =>
        HttpResponse.json(
          {
            error: 'invalid_grant',
            error_description:
              "The request has an invalid grant parameter : refresh_token. User may have revoked or didn't grant the permission.",
          },
          { status: 400 },
        ),
      ),
    );
    const { lwa } = setup();
    const error = await lwa
      .refreshAccessToken({ region: 'eu', refreshToken: 'Atzr|revoked' })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsReauthRequiredError);
    expect((error as Error).message).not.toContain('Atzr|revoked');
  });
});

describe('getAccountIdentity', () => {
  it('liest user_id, E-Mail und Name vom LWA-Profil der Region', async () => {
    let authorization: string | null = null;
    server.use(
      http.get('https://api.amazon.co.uk/user/profile', ({ request }) => {
        authorization = request.headers.get('authorization');
        return HttpResponse.json({
          user_id: 'amzn1.account.ABC123',
          email: 'ads@muuv.test',
          name: 'Muuv Ads',
        });
      }),
    );
    const { lwa } = setup();
    await expect(
      lwa.getAccountIdentity({ region: 'eu', accessToken: 'Atza|access' }),
    ).resolves.toEqual({
      userId: 'amzn1.account.ABC123',
      email: 'ads@muuv.test',
      name: 'Muuv Ads',
    });
    expect(authorization).toBe('Bearer Atza|access');
  });

  it('erlaubt fehlende E-Mail und fehlenden Namen', async () => {
    server.use(
      http.get('https://api.amazon.co.uk/user/profile', () =>
        HttpResponse.json({ user_id: 'amzn1.account.ABC123' }),
      ),
    );
    const { lwa } = setup();
    await expect(
      lwa.getAccountIdentity({ region: 'eu', accessToken: 'Atza|access' }),
    ).resolves.toEqual({ userId: 'amzn1.account.ABC123', email: null, name: null });
  });

  it('verlangt eine user_id', async () => {
    server.use(
      http.get('https://api.amazon.co.uk/user/profile', () =>
        HttpResponse.json({ email: 'x@y.z' }),
      ),
    );
    const { lwa } = setup();
    await expect(
      lwa.getAccountIdentity({ region: 'eu', accessToken: 'Atza|access' }),
    ).rejects.toBeInstanceOf(AmazonAdsResponseError);
  });
});
