import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient } from './client';
import { AmazonAdsHttpError, AmazonAdsResponseError } from './errors';
import { createRequestMeter } from './http';
import type { LogEntry } from './logger';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';
const PROFILES_URL = 'https://advertising-api-eu.amazon.com/v2/profiles';
const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };

const store: RefreshTokenStore = {
  async withRefreshToken(_connectionId, refresh) {
    const { result } = await refresh('Atzr|stored-refresh');
    return result;
  },
};

function setup() {
  const logs: LogEntry[] = [];
  const client = createAmazonAdsClient({
    credentials: {
      clientId: 'amzn1.application-oa2-client.test',
      clientSecret: 'SECRET-CLIENT',
      redirectUri: 'https://app.test/api/amazon/oauth/callback',
    },
    store,
    logger: (entry) => logs.push(entry),
    http: { sleep: async () => {} },
  });
  return { client, logs };
}

/** LWA liefert nummerierte Access-Tokens. */
function tokenEndpoint() {
  let n = 0;
  server.use(
    http.post(TOKEN_URL, () => {
      n += 1;
      return HttpResponse.json({
        access_token: `Atza|access-${n}`,
        refresh_token: 'Atzr|stored-refresh',
        token_type: 'bearer',
        expires_in: 3600,
      });
    }),
  );
}

/** Roher JSON-Text wie von Amazon: Die Profil-ID ist eine Zahl größer als MAX_SAFE_INTEGER. */
const PROFILES_JSON = `[
  {
    "profileId": 9007199254740993,
    "countryCode": "DE",
    "currencyCode": "EUR",
    "dailyBudget": 999999999.99,
    "timezone": "Europe/Paris",
    "accountInfo": {
      "marketplaceStringId": "A1PA6795UKMFR9",
      "id": "A2EXAMPLESELLER",
      "type": "seller",
      "name": "Nordwind DE",
      "validPaymentMethod": true
    }
  },
  {
    "profileId": 3456789012345,
    "countryCode": "UK",
    "currencyCode": "GBP",
    "timezone": "Europe/London",
    "accountInfo": {
      "marketplaceStringId": "A1F83G8C2ARO7P",
      "id": "ENTITY2EXAMPLE",
      "type": "vendor",
      "name": "Lindenhof UK",
      "validPaymentMethod": false
    }
  }
]`;

describe('request', () => {
  it('setzt Authorization, Client-ID und bei Bedarf den Profil-Scope', async () => {
    tokenEndpoint();
    const seen: Array<Record<string, string | null>> = [];
    server.use(
      http.get('https://advertising-api-eu.amazon.com/test', ({ request }) => {
        seen.push({
          authorization: request.headers.get('authorization'),
          clientId: request.headers.get('amazon-advertising-api-clientid'),
          scope: request.headers.get('amazon-advertising-api-scope'),
        });
        return HttpResponse.json({ ok: true });
      }),
    );
    const { client } = setup();
    const schema = z.object({ ok: z.boolean() });
    await client.request(connection, { operation: 't', method: 'GET', path: '/test', schema });
    await client.request(connection, {
      operation: 't',
      method: 'GET',
      path: '/test',
      amazonProfileId: '9007199254740993',
      schema,
    });
    expect(seen).toEqual([
      {
        authorization: 'Bearer Atza|access-1',
        clientId: 'amzn1.application-oa2-client.test',
        scope: null,
      },
      {
        authorization: 'Bearer Atza|access-1',
        clientId: 'amzn1.application-oa2-client.test',
        scope: '9007199254740993',
      },
    ]);
  });

  it('holt nach 401 einmal ein frisches Access-Token und wiederholt die Anfrage', async () => {
    tokenEndpoint();
    const tokens: Array<string | null> = [];
    server.use(
      http.get('https://advertising-api-eu.amazon.com/test', ({ request }) => {
        tokens.push(request.headers.get('authorization'));
        return tokens.length === 1
          ? HttpResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 })
          : HttpResponse.json({ ok: true });
      }),
    );
    const { client } = setup();
    await client.request(connection, {
      operation: 't',
      method: 'GET',
      path: '/test',
      schema: z.object({ ok: z.boolean() }),
    });
    expect(tokens).toEqual(['Bearer Atza|access-1', 'Bearer Atza|access-2']);
  });

  it('gibt auf, wenn auch das frische Token mit 401 abgelehnt wird', async () => {
    tokenEndpoint();
    let calls = 0;
    server.use(
      http.get('https://advertising-api-eu.amazon.com/test', () => {
        calls += 1;
        return HttpResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 });
      }),
    );
    const { client } = setup();
    const error = await client
      .request(connection, { operation: 't', method: 'GET', path: '/test', schema: z.unknown() })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsHttpError);
    expect(error).toMatchObject({ status: 401 });
    expect(calls).toBe(2);
  });

  it('erzwingt nach 401 höchstens einen Token-Refresh pro Minute und Connection', async () => {
    let refreshes = 0;
    server.use(
      http.post(TOKEN_URL, () => {
        refreshes += 1;
        return HttpResponse.json({
          access_token: `Atza|access-${refreshes}`,
          token_type: 'bearer',
          expires_in: 3600,
        });
      }),
      // Profil nicht (mehr) zugänglich: Amazon antwortet 401, obwohl das Token gültig ist.
      http.get('https://advertising-api-eu.amazon.com/test', () =>
        HttpResponse.json({ code: 'UNAUTHORIZED' }, { status: 401 }),
      ),
    );
    const { client } = setup();
    const call = (amazonProfileId: string) =>
      client
        .request(connection, {
          operation: 't',
          method: 'GET',
          path: '/test',
          amazonProfileId,
          schema: z.unknown(),
        })
        .catch((e: unknown) => e);
    await expect(call('1')).resolves.toMatchObject({ status: 401 });
    await expect(call('2')).resolves.toMatchObject({ status: 401 });
    await expect(call('3')).resolves.toMatchObject({ status: 401 });
    expect(refreshes).toBe(2);
  });

  it('akzeptiert nur Pfade, keine vollständigen URLs (Tokens gehen nur an Amazon-Hosts)', async () => {
    const { client } = setup();
    await expect(
      client.request(connection, {
        operation: 't',
        method: 'GET',
        path: 'https://evil.test/steal',
        schema: z.unknown(),
      }),
    ).rejects.toThrow(TypeError);
  });
});

describe('Anfrage-Budget je Profil', () => {
  const TEST_URL = 'https://advertising-api-eu.amazon.com/test';
  const schema = z.object({ ok: z.boolean() });
  const scoped = (amazonProfileId?: string) => ({
    operation: 't',
    method: 'GET' as const,
    path: '/test',
    ...(amazonProfileId !== undefined && { amazonProfileId }),
    schema,
  });

  /** Die Uhr steht; jede Wartezeit (Budget und Backoff) landet in `sleeps`. */
  function budgetSetup(rateLimit?: { requestsPerSecond: number }) {
    const sleeps: number[] = [];
    const client = createAmazonAdsClient({
      credentials: {
        clientId: 'amzn1.application-oa2-client.test',
        clientSecret: 'SECRET-CLIENT',
        redirectUri: 'https://app.test/api/amazon/oauth/callback',
      },
      store,
      http: {
        now: () => 0,
        random: () => 0.5,
        baseDelayMs: 100,
        sleep: async (ms) => {
          sleeps.push(ms);
        },
      },
      ...(rateLimit && { rateLimit }),
    });
    return { client, sleeps };
  }

  it('verteilt Anfragen desselben Profils gleichmäßig (Standard 2/s), andere Profile unabhängig', async () => {
    tokenEndpoint();
    server.use(http.get(TEST_URL, () => HttpResponse.json({ ok: true })));
    const { client, sleeps } = budgetSetup();
    await client.request(connection, scoped('111'));
    await client.request(connection, scoped('111'));
    await client.request(connection, scoped('222'));
    // Ohne Profil-Scope (z. B. `/v2/profiles`) gilt kein Profil-Budget.
    await client.request(connection, scoped());
    expect(sleeps).toEqual([500]);
  });

  it('nimmt die konfigurierte Rate', async () => {
    tokenEndpoint();
    server.use(http.get(TEST_URL, () => HttpResponse.json({ ok: true })));
    const { client, sleeps } = budgetSetup({ requestsPerSecond: 4 });
    await client.request(connection, scoped('111'));
    await client.request(connection, scoped('111'));
    expect(sleeps).toEqual([250]);
  });

  it('halbiert nach einem 429 die Rate des Profils vor dem nächsten Versuch', async () => {
    tokenEndpoint();
    let calls = 0;
    server.use(
      http.get(TEST_URL, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: 'THROTTLED' }, { status: 429 })
          : HttpResponse.json({ ok: true });
      }),
    );
    const { client, sleeps } = budgetSetup();
    await client.request(connection, scoped('111'));
    // Backoff 75 ms, dann Abstand der halbierten Rate (1/s) statt 500 ms.
    expect(sleeps).toEqual([75, 1_000]);
  });

  it('zählt Anfragen im Meter des Aufrufers, auch bei listProfiles', async () => {
    tokenEndpoint();
    server.use(
      http.get(TEST_URL, () => HttpResponse.json({ ok: true })),
      http.get(PROFILES_URL, () => HttpResponse.json([])),
    );
    const { client } = budgetSetup();
    const meter = createRequestMeter();
    await client.request(connection, { ...scoped('111'), meter });
    await client.listProfiles(connection, { meter });
    expect(meter).toEqual({ requests: 2, throttled: 0, retries: 0 });
  });
});

describe('LWA unter der Sperre', () => {
  it('nutzt für den Token-Endpunkt knappe Limits (höchstens 3 Versuche)', async () => {
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, () => {
        calls += 1;
        return new HttpResponse(null, { status: 503 });
      }),
    );
    const { client } = setup();
    await expect(client.getAccessToken(connection)).rejects.toMatchObject({ status: 503 });
    expect(calls).toBe(3);
  });

  it('wartet beim Token-Endpunkt nicht auf langes Retry-After, sondern gibt es weiter', async () => {
    let calls = 0;
    server.use(
      http.post(TOKEN_URL, () => {
        calls += 1;
        return new HttpResponse(null, { status: 429, headers: { 'Retry-After': '30' } });
      }),
    );
    const { client } = setup();
    await expect(client.getAccessToken(connection)).rejects.toMatchObject({
      status: 429,
      retryAfterMs: 30_000,
    });
    expect(calls).toBe(1);
  });
});

describe('listProfiles', () => {
  it('normalisiert die Profile; eine ID über MAX_SAFE_INTEGER kommt unverändert an', async () => {
    tokenEndpoint();
    server.use(
      http.get(
        PROFILES_URL,
        () => new HttpResponse(PROFILES_JSON, { headers: { 'Content-Type': 'application/json' } }),
      ),
    );
    const { client } = setup();
    const profiles = await client.listProfiles(connection);
    expect(profiles).toEqual([
      {
        amazonProfileId: '9007199254740993',
        amazonAccountId: 'A2EXAMPLESELLER',
        accountName: 'Nordwind DE',
        countryCode: 'DE',
        currencyCode: 'EUR',
        timezone: 'Europe/Paris',
        marketplaceId: 'A1PA6795UKMFR9',
        accountType: 'seller',
      },
      {
        amazonProfileId: '3456789012345',
        amazonAccountId: 'ENTITY2EXAMPLE',
        accountName: 'Lindenhof UK',
        countryCode: 'UK',
        currencyCode: 'GBP',
        timezone: 'Europe/London',
        marketplaceId: 'A1F83G8C2ARO7P',
        accountType: 'vendor',
      },
    ]);
  });

  it('wiederholt 429 und liefert danach die Profile', async () => {
    tokenEndpoint();
    let calls = 0;
    server.use(
      http.get(PROFILES_URL, () => {
        calls += 1;
        return calls === 1
          ? new HttpResponse(null, { status: 429, headers: { 'Retry-After': '1' } })
          : new HttpResponse(PROFILES_JSON, { headers: { 'Content-Type': 'application/json' } });
      }),
    );
    const { client } = setup();
    await expect(client.listProfiles(connection)).resolves.toHaveLength(2);
    expect(calls).toBe(2);
  });

  it('reicht unbekannte Kontotypen durch und loggt sie als Warnung', async () => {
    tokenEndpoint();
    server.use(
      http.get(PROFILES_URL, () =>
        HttpResponse.json([
          {
            profileId: 42,
            countryCode: 'DE',
            currencyCode: 'EUR',
            timezone: 'Europe/Paris',
            accountInfo: { id: 'X1', type: 'brandRegistry', name: 'Neu' },
          },
        ]),
      ),
    );
    const { client, logs } = setup();
    const [profile] = await client.listProfiles(connection);
    expect(profile).toMatchObject({
      amazonProfileId: '42',
      accountType: 'brandRegistry',
      marketplaceId: null,
    });
    expect(logs).toContainEqual(
      expect.objectContaining({
        level: 'warn',
        msg: 'amazon_ads.unknown_enum_value',
        field: 'accountInfo.type',
        value: 'brandRegistry',
      }),
    );
  });

  it('nutzt die Konto-ID als Namen, wenn Amazon keinen Namen liefert', async () => {
    tokenEndpoint();
    server.use(
      http.get(PROFILES_URL, () =>
        HttpResponse.json([
          {
            profileId: 42,
            countryCode: 'DE',
            currencyCode: 'EUR',
            timezone: 'Europe/Paris',
            accountInfo: { id: 'A2NONAME', type: 'seller' },
          },
        ]),
      ),
    );
    const { client } = setup();
    const [profile] = await client.listProfiles(connection);
    expect(profile?.accountName).toBe('A2NONAME');
  });

  it('lehnt Antworten ohne Pflichtfelder ab', async () => {
    tokenEndpoint();
    server.use(
      http.get(PROFILES_URL, () =>
        HttpResponse.json([
          {
            profileId: 42,
            currencyCode: 'EUR',
            timezone: 'Europe/Paris',
            accountInfo: { type: 'seller' },
          },
        ]),
      ),
    );
    const { client } = setup();
    await expect(client.listProfiles(connection)).rejects.toBeInstanceOf(AmazonAdsResponseError);
  });

  it('lehnt Profil-IDs ab, die keine Ganzzahlen sind', async () => {
    tokenEndpoint();
    server.use(
      http.get(PROFILES_URL, () =>
        HttpResponse.json([
          {
            profileId: 1.5,
            countryCode: 'DE',
            currencyCode: 'EUR',
            timezone: 'Europe/Paris',
            accountInfo: { id: 'A', type: 'seller' },
          },
        ]),
      ),
    );
    const { client } = setup();
    await expect(client.listProfiles(connection)).rejects.toBeInstanceOf(AmazonAdsResponseError);
  });

  it('loggt weder Access-Token, Refresh-Token noch Client-Secret', async () => {
    tokenEndpoint();
    server.use(http.get(PROFILES_URL, () => HttpResponse.json([])));
    const { client, logs } = setup();
    await client.listProfiles(connection);
    const serialized = JSON.stringify(logs);
    expect(serialized).not.toMatch(/Atza\||Atzr\||SECRET-CLIENT/);
    expect(logs.map((l) => l.operation)).toEqual(['lwa.refresh', 'profiles.list']);
  });
});
