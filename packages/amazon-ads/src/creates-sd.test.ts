import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient } from './client';
import { applyCreates, type AmazonAdsCreateOperation } from './creates';
import { createRequestMeter } from './http';
import { noopLogger } from './logger';

/**
 * Neue Kampagnen-Strukturen für **Sponsored Display v3** (4.9, geprüft gegen die SD-3.0-Spec): Listen von Einträgen,
 * IDs als JSON-Zahl, Zustände klein, Startdatum `YYYYMMDD`, Antwort als Liste `{ code, <id> }` in der Reihenfolge der
 * Anfrage.
 */

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';
const API = 'https://advertising-api-eu.amazon.com';
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
  const client = createAmazonAdsClient({
    credentials: { clientId: 'client-1', clientSecret: 's', redirectUri: 'https://app.test/cb' },
    store,
    http: { sleep: async () => {}, maxAttempts: 3 },
    rateLimit: { requestsPerSecond: 1000 },
  });
  return { request: client.request, logger: noopLogger };
}

const calls: { path: string; contentType: string | null; body: string }[] = [];
afterEach(() => {
  calls.length = 0;
});

/** `POST /sd/<path>`: Erfolg je Eintrag mit fortlaufenden IDs (als JSON-Zahl wie in der Spec). */
function succeed(path: string, idKey: string, firstId: bigint) {
  server.use(
    http.post(`${API}/sd/${path}`, async ({ request }) => {
      const body = await request.text();
      calls.push({ path, contentType: request.headers.get('content-type'), body });
      const items = JSON.parse(body) as unknown[];
      const list = items.map(
        (_, index) => `{"code":"SUCCESS","${idKey}":${firstId + BigInt(index)}}`,
      );
      return new HttpResponse(`[${list.join(',')}]`, {
        status: 207,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
}

const operations: AmazonAdsCreateOperation[] = [
  {
    ref: 'c',
    entity: 'sdCampaign',
    name: 'SD | RT-VIEW | Flaschen',
    state: 'PAUSED',
    dailyBudget: '10.50',
    startDate: '2099-10-10',
    tactic: 'T00030',
    costType: 'cpc',
    amazonPortfolioId: '7001',
  },
  {
    ref: 'g',
    entity: 'sdAdGroup',
    campaignRef: 'c',
    name: 'SD | RT-VIEW | Flaschen',
    defaultBid: '0.55',
    bidOptimization: 'conversions',
    state: 'ENABLED',
  },
  {
    ref: 'a',
    entity: 'sdProductAd',
    campaignRef: 'c',
    adGroupRef: 'g',
    sku: 'FL-750',
    asin: null,
    state: 'ENABLED',
  },
  {
    ref: 'v',
    entity: 'sdTarget',
    campaignRef: 'c',
    adGroupRef: 'g',
    expression: { type: 'views', lookbackDays: 30 },
    bid: '0.60',
    state: 'ENABLED',
  },
  {
    ref: 't',
    entity: 'sdTarget',
    campaignRef: 'c',
    adGroupRef: 'g',
    expression: { type: 'asinCategorySameAs', value: '12345' },
    bid: null,
    state: 'ENABLED',
  },
  { ref: 'n', entity: 'sdNegativeTarget', campaignRef: 'c', adGroupRef: 'g', asin: 'B0FREMD002' },
];

describe('applyCreates: Sponsored Display', () => {
  it('legt Kampagne, Ad Group, Anzeige, Ziele und Negative nacheinander an und setzt die IDs ein', async () => {
    const deps = setup();
    succeed('campaigns', 'campaignId', 91000000000000001n);
    succeed('adGroups', 'adGroupId', 92000000000000001n);
    succeed('productAds', 'adId', 93000000000000001n);
    succeed('targets', 'targetId', 94000000000000001n);
    succeed('negativeTargets', 'targetId', 95000000000000001n);

    const result = await applyCreates(
      deps,
      connection,
      { amazonProfileId: PROFILE_ID, operations },
      { meter: createRequestMeter() },
    );

    expect(result.throttled).toBe(false);
    expect(result.results).toEqual([
      { ref: 'c', status: 'applied', amazonId: '91000000000000001' },
      { ref: 'g', status: 'applied', amazonId: '92000000000000001' },
      { ref: 'a', status: 'applied', amazonId: '93000000000000001' },
      { ref: 'v', status: 'applied', amazonId: '94000000000000001' },
      { ref: 't', status: 'applied', amazonId: '94000000000000002' },
      { ref: 'n', status: 'applied', amazonId: '95000000000000001' },
    ]);
    expect(calls.map((call) => [call.path, call.contentType])).toEqual([
      ['campaigns', 'application/json'],
      ['adGroups', 'application/json'],
      ['productAds', 'application/json'],
      ['targets', 'application/json'],
      ['negativeTargets', 'application/json'],
    ]);
    // IDs als JSON-Zahl mit allen Ziffern, Zustände klein, Startdatum ohne Bindestriche.
    expect(calls.map((call) => call.body)).toEqual([
      '[{"name":"SD | RT-VIEW | Flaschen","state":"paused","budgetType":"daily","budget":10.50,"startDate":"20991010","tactic":"T00030","costType":"cpc","portfolioId":7001}]',
      '[{"campaignId":91000000000000001,"name":"SD | RT-VIEW | Flaschen","defaultBid":0.55,"bidOptimization":"conversions","state":"enabled"}]',
      '[{"campaignId":91000000000000001,"adGroupId":92000000000000001,"sku":"FL-750","state":"enabled"}]',
      '[{"adGroupId":92000000000000001,"expressionType":"manual","expression":[{"type":"views","value":[{"type":"exactProduct"},{"type":"lookback","value":"30"}]}],"state":"enabled","bid":0.60},{"adGroupId":92000000000000001,"expressionType":"manual","expression":[{"type":"asinCategorySameAs","value":"12345"}],"state":"enabled"}]',
      '[{"adGroupId":92000000000000001,"expressionType":"manual","expression":[{"type":"asinSameAs","value":"B0FREMD002"}],"state":"enabled"}]',
    ]);
  });

  it('lehnt ungültige SD-Werte je Eintrag ab und mischt keine Eltern anderer Anzeigentypen', async () => {
    const deps = setup();
    succeed('campaigns', 'campaignId', 91000000000000001n);
    succeed('adGroups', 'adGroupId', 92000000000000001n);
    const result = await applyCreates(
      deps,
      connection,
      {
        amazonProfileId: PROFILE_ID,
        operations: [
          operations[0]!,
          operations[1]!,
          {
            ...(operations[1] as Extract<AmazonAdsCreateOperation, { entity: 'sdAdGroup' }>),
            ref: 'cpc-reach',
            // `reach` gehört zu vCPM.
            bidOptimization: 'reach',
          },
          {
            ref: 'lookback',
            entity: 'sdTarget',
            campaignRef: 'c',
            adGroupRef: 'g',
            expression: { type: 'purchases', lookbackDays: 45 },
            bid: null,
            state: 'ENABLED',
          },
          // Eine SP-Ad-Group unter einer SD-Kampagne passt nicht.
          {
            ref: 'sp-group',
            entity: 'adGroup',
            campaignRef: 'c',
            name: 'G',
            defaultBid: '0.50',
            state: 'ENABLED',
          },
        ],
      },
      { meter: createRequestMeter() },
    );
    expect(result.results.map((entry) => [entry.ref, entry.status])).toEqual([
      ['c', 'applied'],
      ['g', 'applied'],
      ['cpc-reach', 'failed'],
      ['lookback', 'failed'],
      ['sp-group', 'failed'],
    ]);
    expect(calls.map((call) => call.path)).toEqual(['campaigns', 'adGroups']);
  });
});
