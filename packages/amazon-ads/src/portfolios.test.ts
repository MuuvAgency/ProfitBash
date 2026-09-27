import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient } from './client';
import { AmazonAdsResponseError } from './errors';
import { createRequestMeter } from './http';
import type { LogEntry } from './logger';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';
const LIST_URL = 'https://advertising-api-eu.amazon.com/portfolios/list';
const CONTENT_TYPE = 'application/vnd.spPortfolio.v3+json';
const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };
const PROFILE_ID = '9007199254740993';

const store: RefreshTokenStore = {
  async withRefreshToken(_id, refresh) {
    return (await refresh('Atzr|stored')).result;
  },
};

function setup() {
  server.use(
    http.post(TOKEN_URL, () =>
      HttpResponse.json({
        access_token: 'Atza|access',
        refresh_token: 'Atzr|stored',
        token_type: 'bearer',
        expires_in: 3600,
      }),
    ),
  );
  const logs: LogEntry[] = [];
  const client = createAmazonAdsClient({
    credentials: { clientId: 'client-1', clientSecret: 's', redirectUri: 'https://app.test/cb' },
    store,
    logger: (entry) => logs.push(entry),
    http: { sleep: async () => {} },
    rateLimit: { requestsPerSecond: 100 },
  });
  return { client, logs };
}

function jsonText(text: string) {
  return new HttpResponse(text, { headers: { 'Content-Type': CONTENT_TYPE } });
}

const PAGE_1 = `{
  "portfolios": [
    {"portfolioId": 9007199254740993123, "name": "Marke A", "state": "ENABLED", "inBudget": true,
     "budget": {"amount": 1234567.89, "currencyCode": "EUR", "policy": "DATE_RANGE",
                "startDate": "2026-09-01", "endDate": "2026-09-30"},
     "budgetControls": {"campaignUnspentBudgetSharing": {"featureState": "ENABLED"}},
     "extendedData": {"servingStatus": "PORTFOLIO_STATUS_ENABLED",
                      "lastUpdateDateTime": "2026-09-20T10:15:00.123Z",
                      "creationDateTime": "2026-01-02T03:04:05Z"}}
  ],
  "nextToken": "page-2",
  "totalResults": 2
}`;

const PAGE_2 = `{
  "portfolios": [
    {"portfolioId": "4711", "name": "Ohne Budget", "state": "ENABLED",
     "budget": {"amount": 0.12345678901234567890, "currencyCode": "XYZ", "policy": "NO_CAP"}}
  ],
  "totalResults": 2
}`;

describe('listPortfolios', () => {
  it('liest alle Seiten mit dem v3-Content-Type und normalisiert verlustfrei', async () => {
    const bodies: unknown[] = [];
    const headers: Array<Record<string, string | null>> = [];
    server.use(
      http.post(LIST_URL, async ({ request }) => {
        const body = (await request.json()) as { nextToken?: string };
        bodies.push(body);
        headers.push({
          contentType: request.headers.get('content-type'),
          accept: request.headers.get('accept'),
          scope: request.headers.get('amazon-advertising-api-scope'),
        });
        return jsonText(body.nextToken === 'page-2' ? PAGE_2 : PAGE_1);
      }),
    );
    const { client } = setup();

    const portfolios = await client.listPortfolios(connection, PROFILE_ID);

    expect(bodies).toEqual([
      { includeExtendedDataFields: true },
      { includeExtendedDataFields: true, nextToken: 'page-2' },
    ]);
    expect(headers[0]).toEqual({
      contentType: CONTENT_TYPE,
      accept: CONTENT_TYPE,
      scope: PROFILE_ID,
    });
    expect(portfolios).toEqual([
      {
        amazonPortfolioId: '9007199254740993123',
        name: 'Marke A',
        state: 'ENABLED',
        budgetAmount: '1234567.89',
        budgetCurrencyCode: 'EUR',
        budgetPolicy: 'DATE_RANGE',
        budgetStartDate: '2026-09-01',
        budgetEndDate: '2026-09-30',
        inBudget: true,
        amazonUpdatedAt: new Date('2026-09-20T10:15:00.123Z'),
        extra: {
          servingStatus: 'PORTFOLIO_STATUS_ENABLED',
          creationDateTime: '2026-01-02T03:04:05Z',
          budgetControls: { campaignUnspentBudgetSharing: { featureState: 'ENABLED' } },
        },
      },
      {
        amazonPortfolioId: '4711',
        name: 'Ohne Budget',
        state: 'ENABLED',
        budgetAmount: '0.1234567890123456789',
        budgetCurrencyCode: 'XYZ',
        budgetPolicy: 'NO_CAP',
        budgetStartDate: null,
        budgetEndDate: null,
        inBudget: null,
        amazonUpdatedAt: null,
        extra: {},
      },
    ]);
  });

  it('reicht unbekannte Währungen und Zustände durch und loggt sie je Wert einmal', async () => {
    server.use(
      http.post(LIST_URL, () =>
        jsonText(`{"portfolios": [
          {"portfolioId": "1", "name": "a", "state": "PENDING_REVIEW", "budget": {"currencyCode": "XYZ"}},
          {"portfolioId": "2", "name": "b", "state": "PENDING_REVIEW", "budget": {"currencyCode": "XYZ"}}
        ]}`),
      ),
    );
    const { client, logs } = setup();
    const portfolios = await client.listPortfolios(connection, PROFILE_ID);
    expect(portfolios.map((p) => [p.state, p.budgetCurrencyCode])).toEqual([
      ['PENDING_REVIEW', 'XYZ'],
      ['PENDING_REVIEW', 'XYZ'],
    ]);
    const unknown = logs.filter((l) => l.msg === 'amazon_ads.unknown_enum_value');
    expect(unknown).toEqual([
      expect.objectContaining({
        operation: 'portfolios.list',
        field: 'state',
        value: 'PENDING_REVIEW',
      }),
      expect.objectContaining({
        operation: 'portfolios.list',
        field: 'budget.currencyCode',
        value: 'XYZ',
      }),
    ]);
  });

  it('scheitert laut an einem ungültigen Portfolio (sonst gälte es später als entfernt)', async () => {
    server.use(
      http.post(LIST_URL, () =>
        jsonText(`{"portfolios": [{"portfolioId": "1", "name": "a", "state": "ENABLED",
          "budget": {"amount": "12,50"}}]}`),
      ),
    );
    const { client } = setup();
    await expect(client.listPortfolios(connection, PROFILE_ID)).rejects.toBeInstanceOf(
      AmazonAdsResponseError,
    );
  });

  it('bricht ab, wenn Amazon denselben nextToken erneut liefert (keine Endlosschleife)', async () => {
    server.use(http.post(LIST_URL, () => jsonText('{"portfolios": [], "nextToken": "same"}')));
    const { client } = setup();
    await expect(client.listPortfolios(connection, PROFILE_ID)).rejects.toBeInstanceOf(
      AmazonAdsResponseError,
    );
  });

  it('wiederholt 429 und zählt Anfragen im Meter', async () => {
    let calls = 0;
    server.use(
      http.post(LIST_URL, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: 'THROTTLED' }, { status: 429 })
          : jsonText('{"portfolios": []}');
      }),
    );
    const { client } = setup();
    const meter = createRequestMeter();
    await expect(client.listPortfolios(connection, PROFILE_ID, { meter })).resolves.toEqual([]);
    expect(meter).toEqual({ requests: 2, throttled: 1, retries: 1 });
  });
});
