import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient } from './client';
import { createRequestMeter } from './http';
import type { AmazonAdsWriteOperation } from './writes';

/**
 * Schreib-Client für Sponsored Brands (v4, Keywords und Targets v3) und Sponsored Display (`phase-3.md` 3.2c):
 * Abbildung, Antwortformen je Endpunkt, Ergebnis je Änderung.
 */

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';
const API = 'https://advertising-api-eu.amazon.com';
const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };
const PROFILE_ID = '9007199254740993';
const SB = 'SPONSORED_BRANDS';
const SD = 'SPONSORED_DISPLAY';
/** Größer als `Number.MAX_SAFE_INTEGER`: darf weder beim Schreiben noch beim Lesen gerundet werden. */
const BIG = '9007199254740993123';

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
  return createAmazonAdsClient({
    credentials: { clientId: 'client-1', clientSecret: 's', redirectUri: 'https://app.test/cb' },
    store,
    http: { sleep: async () => {}, maxAttempts: 3 },
    rateLimit: { requestsPerSecond: 1000 },
  });
}

interface Seen {
  contentType: string | null;
  accept: string | null;
  body: string;
}

function capture(
  method: 'put' | 'post',
  path: string,
  respond: (body: string, call: number) => string,
  status = 207,
): Seen[] {
  const seen: Seen[] = [];
  server.use(
    http[method](`${API}${path}`, async ({ request }) => {
      const body = await request.text();
      seen.push({
        contentType: request.headers.get('content-type'),
        accept: request.headers.get('accept'),
        body,
      });
      return new HttpResponse(respond(body, seen.length), {
        status,
        headers: { 'Content-Type': 'application/json' },
      });
    }),
  );
  return seen;
}

const apply = (
  client: ReturnType<typeof setup>,
  adProduct: string,
  operations: AmazonAdsWriteOperation[],
) =>
  client.applyChanges(
    connection,
    { amazonProfileId: PROFILE_ID, adProduct, operations },
    { meter: createRequestMeter() },
  );

const parents = { amazonCampaignId: '1001', amazonAdGroupId: '2001' };
const notSupported = (ref: string) => ({
  ref,
  status: 'failed',
  code: 'NOT_SUPPORTED',
  message: expect.any(String) as string,
});

describe('Sponsored Brands', () => {
  it('ändert Zustand und Budget einer Kampagne über v4 (IDs als Text, Betrag als unveränderte Zahl)', async () => {
    const client = setup();
    const seen = capture(
      'put',
      '/sb/v4/campaigns',
      () => `{"campaigns":{"success":[{"index":0,"campaignId":"${BIG}"}],"error":[]}}`,
    );

    const outcome = await apply(client, SB, [
      {
        ref: 'a',
        type: 'update',
        entity: 'campaign',
        amazonId: BIG,
        state: 'PAUSED',
        dailyBudget: '25.50',
      },
    ]);

    expect(seen).toEqual([
      {
        contentType: 'application/vnd.sbcampaignresource.v4+json',
        accept: 'application/vnd.sbcampaignresource.v4+json',
        body: `{"campaigns":[{"campaignId":"${BIG}","state":"PAUSED","budget":25.50}]}`,
      },
    ]);
    expect(outcome.results).toEqual([{ ref: 'a', status: 'applied', amazonId: BIG }]);
  });

  it('schickt höchstens 10 Kampagnen je Aufruf und meldet Teilfehler je Eintrag', async () => {
    const client = setup();
    const seen = capture('put', '/sb/v4/campaigns', (body, call) => {
      const count = (JSON.parse(body) as { campaigns: unknown[] }).campaigns.length;
      const success = Array.from({ length: count }, (_, index) => ({
        index,
        campaignId: String(1000 + (call - 1) * 10 + index),
      }));
      return call === 2
        ? JSON.stringify({
            campaigns: {
              success: [],
              error: [
                {
                  index: 0,
                  errors: [
                    {
                      errorType: 'budgetError',
                      errorValue: {
                        budgetError: { reason: 'BUDGET_TOO_LOW', message: 'Budget zu klein' },
                      },
                    },
                  ],
                },
              ],
            },
          })
        : JSON.stringify({ campaigns: { success, error: [] } });
    });

    const outcome = await apply(
      client,
      SB,
      Array.from({ length: 11 }, (_, index): AmazonAdsWriteOperation => ({
        ref: `c${index}`,
        type: 'update',
        entity: 'campaign',
        amazonId: String(1000 + index),
        dailyBudget: '0.10',
      })),
    );

    expect(
      seen.map((call) => (JSON.parse(call.body) as { campaigns: unknown[] }).campaigns.length),
    ).toEqual([10, 1]);
    expect(outcome.results.slice(0, 10).every((r) => r.status === 'applied')).toBe(true);
    expect(outcome.results[10]).toEqual({
      ref: 'c10',
      status: 'failed',
      code: 'BUDGET_TOO_LOW',
      message: 'Budget zu klein',
    });
  });

  it('ändert Ad Groups und Ads über v4 (nur der Zustand)', async () => {
    const client = setup();
    const adGroups = capture(
      'put',
      '/sb/v4/adGroups',
      () => `{"adGroups":{"success":[{"index":0,"adGroupId":"2001"}],"error":[]}}`,
    );
    const ads = capture(
      'put',
      '/sb/v4/ads',
      () => `{"ads":{"success":[{"index":0,"adId":"4001"}],"error":[]}}`,
    );

    const outcome = await apply(client, SB, [
      { ref: 'g', type: 'update', entity: 'adGroup', amazonId: '2001', state: 'PAUSED' },
      { ref: 'a', type: 'update', entity: 'productAd', amazonId: '4001', state: 'ENABLED' },
    ]);

    expect(adGroups[0]).toMatchObject({
      contentType: 'application/vnd.sbadgroupresource.v4+json',
      body: '{"adGroups":[{"adGroupId":"2001","state":"PAUSED"}]}',
    });
    expect(ads[0]).toMatchObject({
      contentType: 'application/vnd.sbadresource.v4+json',
      body: '{"ads":[{"adId":"4001","state":"ENABLED"}]}',
    });
    expect(outcome.results.map((r) => r.status)).toEqual(['applied', 'applied']);
  });

  it('ändert Keywords über v3: IDs als Zahl, Eltern-IDs dabei, Zustand klein, Antwort in der Reihenfolge der Anfrage', async () => {
    const client = setup();
    const seen = capture(
      'put',
      '/sb/keywords',
      () =>
        `[{"keywordId":${BIG},"code":"SUCCESS"},{"code":"INVALID_ARGUMENT","description":"Gebot zu hoch"}]`,
    );

    const outcome = await apply(client, SB, [
      {
        ref: 'k1',
        type: 'update',
        entity: 'keyword',
        amazonId: BIG,
        ...parents,
        state: 'PAUSED',
        bid: '0.75',
      },
      { ref: 'k2', type: 'update', entity: 'keyword', amazonId: '3002', ...parents, bid: '99.00' },
    ]);

    expect(seen).toEqual([
      {
        contentType: 'application/json',
        accept: 'application/vnd.sbkeywordresponse.v3+json',
        body: `[{"keywordId":${BIG},"adGroupId":2001,"campaignId":1001,"state":"paused","bid":0.75},{"keywordId":3002,"adGroupId":2001,"campaignId":1001,"bid":99.00}]`,
      },
    ]);
    expect(outcome.results).toEqual([
      { ref: 'k1', status: 'applied', amazonId: BIG },
      { ref: 'k2', status: 'failed', code: 'INVALID_ARGUMENT', message: 'Gebot zu hoch' },
    ]);
  });

  it('lehnt ein Keyword ohne Eltern-IDs ab, ohne Amazon zu fragen', async () => {
    const client = setup();

    const outcome = await apply(client, SB, [
      { ref: 'k', type: 'update', entity: 'keyword', amazonId: '3001', bid: '0.75' },
    ]);

    expect(outcome.results).toEqual([
      { ref: 'k', status: 'failed', code: 'PARENT_IDS_MISSING', message: expect.any(String) },
    ]);
  });

  it('ändert Produkt-Targets über v3 und ordnet die Antwort über `targetRequestIndex` zu', async () => {
    const client = setup();
    const seen = capture(
      'put',
      '/sb/targets',
      () =>
        `{"updateTargetSuccessResults":[{"targetId":5002,"targetRequestIndex":1}],"updateTargetErrorResults":[{"code":"BID_OUT_OF_RANGE","details":"zu niedrig","targetRequestIndex":0}]}`,
      200,
    );

    const outcome = await apply(client, SB, [
      { ref: 't1', type: 'update', entity: 'target', amazonId: '5001', ...parents, bid: '0.01' },
      {
        ref: 't2',
        type: 'update',
        entity: 'target',
        amazonId: '5002',
        ...parents,
        state: 'ENABLED',
      },
    ]);

    expect(seen[0]!.body).toBe(
      '{"targets":[{"targetId":5001,"adGroupId":2001,"campaignId":1001,"bid":0.01},{"targetId":5002,"adGroupId":2001,"campaignId":1001,"state":"enabled"}]}',
    );
    expect(outcome.results).toEqual([
      { ref: 't1', status: 'failed', code: 'BID_OUT_OF_RANGE', message: 'zu niedrig' },
      { ref: 't2', status: 'applied', amazonId: '5002' },
    ]);
  });

  it('archiviert: Kampagne über v4 (ID-Filter), Keywords und Negatives über den Zustand `archived`', async () => {
    const client = setup();
    const campaigns = capture(
      'post',
      '/sb/v4/campaigns/delete',
      () => `{"campaigns":{"success":[{"index":0,"campaignId":"1001"}],"error":[]}}`,
    );
    const keywords = capture('put', '/sb/keywords', () => `[{"keywordId":3001,"code":"SUCCESS"}]`);
    const negativeKeywords = capture(
      'put',
      '/sb/negativeKeywords',
      () => `[{"keywordId":6001,"code":"SUCCESS"}]`,
    );
    const negativeTargets = capture(
      'put',
      '/sb/negativeTargets',
      () => `{"updateTargetSuccessResults":[{"targetId":7001,"targetRequestIndex":0}]}`,
      200,
    );

    const outcome = await apply(client, SB, [
      { ref: 'c', type: 'archive', entity: 'campaign', amazonId: '1001' },
      { ref: 'k', type: 'archive', entity: 'keyword', amazonId: '3001', ...parents },
      { ref: 'nk', type: 'archive', entity: 'negativeKeyword', amazonId: '6001', ...parents },
      { ref: 'nt', type: 'archive', entity: 'negativeTarget', amazonId: '7001', ...parents },
    ]);

    expect(campaigns[0]!.body).toBe('{"campaignIdFilter":{"include":["1001"]}}');
    expect(keywords[0]!.body).toBe(
      '[{"keywordId":3001,"adGroupId":2001,"campaignId":1001,"state":"archived"}]',
    );
    expect(negativeKeywords[0]!.body).toBe(
      '[{"keywordId":6001,"adGroupId":2001,"campaignId":1001,"state":"archived"}]',
    );
    expect(negativeTargets[0]!.body).toBe(
      '{"negativeTargets":[{"targetId":7001,"adGroupId":2001,"state":"archived"}]}',
    );
    expect(outcome.results.map((r) => r.status)).toEqual([
      'applied',
      'applied',
      'applied',
      'applied',
    ]);
  });

  it('legt Negatives in der Ad Group an und nennt die neue ID', async () => {
    const client = setup();
    const keywords = capture(
      'post',
      '/sb/negativeKeywords',
      () => `[{"keywordId":${BIG},"code":"SUCCESS"}]`,
    );
    const targets = capture(
      'post',
      '/sb/negativeTargets',
      () => `{"createTargetSuccessResults":[{"targetRequestIndex":0,"targetId":7002}]}`,
      200,
    );

    const outcome = await apply(client, SB, [
      {
        ref: 'nk',
        type: 'createNegative',
        ...parents,
        negative: { type: 'keyword', keywordText: 'gebraucht', matchType: 'PHRASE' },
      },
      {
        ref: 'nt',
        type: 'createNegative',
        ...parents,
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
    ]);

    expect(keywords[0]!.body).toBe(
      '[{"adGroupId":2001,"campaignId":1001,"keywordText":"gebraucht","matchType":"negativePhrase"}]',
    );
    expect(targets[0]!.body).toBe(
      '{"negativeTargets":[{"adGroupId":2001,"campaignId":1001,"expressions":[{"type":"asinSameAs","value":"B0FREMD001"}]}]}',
    );
    expect(outcome.results).toEqual([
      { ref: 'nk', status: 'applied', amazonId: BIG },
      { ref: 'nt', status: 'applied', amazonId: '7002' },
    ]);
  });

  it('liest eine einzelne Keyword-Antwort auch als Objekt und Fehler negativer Targets mit eigenem Index-Schlüssel', async () => {
    const client = setup();
    capture('put', '/sb/keywords', () => `{"keywordId":3001,"code":"SUCCESS"}`);
    capture(
      'put',
      '/sb/negativeTargets',
      () =>
        `{"updateTargetErrorResults":[{"code":"NOT_FOUND","details":"gibt es nicht","negativeTargetRequestIndex":0}]}`,
      200,
    );

    const outcome = await apply(client, SB, [
      { ref: 'k', type: 'update', entity: 'keyword', amazonId: '3001', ...parents, bid: '0.75' },
      {
        ref: 'nt',
        type: 'archive',
        entity: 'negativeTarget',
        amazonId: '7001',
        amazonAdGroupId: '2001',
      },
    ]);

    expect(outcome.results).toEqual([
      { ref: 'k', status: 'applied', amazonId: '3001' },
      { ref: 'nt', status: 'failed', code: 'NOT_FOUND', message: 'gibt es nicht' },
    ]);
  });

  it('lehnt ab, was es bei SB nicht gibt, ohne Amazon zu fragen', async () => {
    const client = setup();

    const outcome = await apply(client, SB, [
      {
        ref: 'bidding',
        type: 'update',
        entity: 'campaign',
        amazonId: '1001',
        bidding: { strategy: 'NONE', placements: [] },
      },
      {
        ref: 'defaultBid',
        type: 'update',
        entity: 'adGroup',
        amazonId: '2001',
        defaultBid: '0.50',
      },
      {
        ref: 'campaignNegative',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: 'x', matchType: 'EXACT' },
      },
      { ref: 'archive', type: 'archive', entity: 'campaignNegativeKeyword', amazonId: '6001' },
    ]);

    expect(outcome.results).toEqual(
      ['bidding', 'defaultBid', 'campaignNegative', 'archive'].map(notSupported),
    );
  });
});

describe('Sponsored Display', () => {
  it('ändert Kampagne, Ad Group, Target und Product Ad (JSON-Listen, IDs als Zahl, Zustand klein)', async () => {
    const client = setup();
    const campaigns = capture(
      'put',
      '/sd/campaigns',
      () => `[{"code":"SUCCESS","campaignId":${BIG}}]`,
    );
    const adGroups = capture('put', '/sd/adGroups', () => `[{"code":"SUCCESS","adGroupId":2001}]`);
    const targets = capture('put', '/sd/targets', () => `[{"code":"SUCCESS","targetId":5001}]`);
    const productAds = capture('put', '/sd/productAds', () => `[{"code":"SUCCESS","adId":4001}]`);

    const outcome = await apply(client, SD, [
      {
        ref: 'c',
        type: 'update',
        entity: 'campaign',
        amazonId: BIG,
        state: 'PAUSED',
        dailyBudget: '30.00',
      },
      { ref: 'g', type: 'update', entity: 'adGroup', amazonId: '2001', defaultBid: '0.60' },
      {
        ref: 't',
        type: 'update',
        entity: 'target',
        amazonId: '5001',
        bid: '0.45',
        state: 'ENABLED',
      },
      { ref: 'a', type: 'update', entity: 'productAd', amazonId: '4001', state: 'PAUSED' },
    ]);

    expect(campaigns).toEqual([
      {
        contentType: 'application/json',
        accept: 'application/json',
        body: `[{"campaignId":${BIG},"state":"paused","budget":30.00}]`,
      },
    ]);
    expect(adGroups[0]!.body).toBe('[{"adGroupId":2001,"defaultBid":0.60}]');
    expect(targets[0]!.body).toBe('[{"targetId":5001,"state":"enabled","bid":0.45}]');
    expect(productAds[0]!.body).toBe('[{"adId":4001,"state":"paused"}]');
    expect(outcome.results).toEqual([
      { ref: 'c', status: 'applied', amazonId: BIG },
      { ref: 'g', status: 'applied', amazonId: '2001' },
      { ref: 't', status: 'applied', amazonId: '5001' },
      { ref: 'a', status: 'applied', amazonId: '4001' },
    ]);
  });

  it('meldet Fehler je Eintrag; fehlende Einträge und abweichende IDs gelten als unklar', async () => {
    const client = setup();
    capture(
      'put',
      '/sd/targets',
      () =>
        `[{"code":"INVALID_ARGUMENT","description":"Bid is below the minimum"},{"code":"SUCCESS","targetId":9999}]`,
    );

    const outcome = await apply(client, SD, [
      { ref: 't1', type: 'update', entity: 'target', amazonId: '5001', bid: '0.01' },
      { ref: 't2', type: 'update', entity: 'target', amazonId: '5002', bid: '0.50' },
      { ref: 't3', type: 'update', entity: 'target', amazonId: '5003', bid: '0.50' },
    ]);

    expect(outcome.results).toEqual([
      {
        ref: 't1',
        status: 'failed',
        code: 'INVALID_ARGUMENT',
        message: 'Bid is below the minimum',
      },
      { ref: 't2', status: 'unknown', message: expect.any(String) },
      { ref: 't3', status: 'unknown', message: expect.any(String) },
    ]);
  });

  it('archiviert über den Zustand `archived` und legt negative ASINs in der Ad Group an', async () => {
    const client = setup();
    const campaigns = capture(
      'put',
      '/sd/campaigns',
      () => `[{"code":"SUCCESS","campaignId":1001}]`,
    );
    const negatives = capture(
      'put',
      '/sd/negativeTargets',
      () => `[{"code":"SUCCESS","targetId":7001}]`,
    );
    const created = capture(
      'post',
      '/sd/negativeTargets',
      () => `[{"code":"SUCCESS","targetId":${BIG}}]`,
    );

    const outcome = await apply(client, SD, [
      { ref: 'c', type: 'archive', entity: 'campaign', amazonId: '1001' },
      { ref: 'n', type: 'archive', entity: 'negativeTarget', amazonId: '7001' },
      {
        ref: 'new',
        type: 'createNegative',
        ...parents,
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
    ]);

    expect(campaigns[0]!.body).toBe('[{"campaignId":1001,"state":"archived"}]');
    expect(negatives[0]!.body).toBe('[{"targetId":7001,"state":"archived"}]');
    expect(created[0]!.body).toBe(
      '[{"adGroupId":2001,"state":"enabled","expressionType":"manual","expression":[{"type":"asinSameAs","value":"B0FREMD001"}]}]',
    );
    expect(outcome.results).toEqual([
      { ref: 'c', status: 'applied', amazonId: '1001' },
      { ref: 'n', status: 'applied', amazonId: '7001' },
      { ref: 'new', status: 'applied', amazonId: BIG },
    ]);
  });

  it('lehnt ab, was es bei SD nicht gibt (Keywords, Strategie, Negatives auf Kampagnenebene)', async () => {
    const client = setup();

    const outcome = await apply(client, SD, [
      { ref: 'keyword', type: 'update', entity: 'keyword', amazonId: '3001', bid: '0.50' },
      {
        ref: 'bidding',
        type: 'update',
        entity: 'campaign',
        amazonId: '1001',
        bidding: { strategy: 'NONE', placements: [] },
      },
      {
        ref: 'negativeKeyword',
        type: 'createNegative',
        ...parents,
        negative: { type: 'keyword', keywordText: 'x', matchType: 'EXACT' },
      },
      {
        ref: 'campaignNegative',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
    ]);

    expect(outcome.results).toEqual(
      ['keyword', 'bidding', 'negativeKeyword', 'campaignNegative'].map(notSupported),
    );
  });

  it('liest Codes vorsichtig: 2xx gilt als angenommen, ohne Code bleibt der Ausgang unklar', async () => {
    const client = setup();
    capture(
      'put',
      '/sd/targets',
      () =>
        `[{"code":"200","targetId":5001},{"targetId":5002},{"code":"404","description":"not found"},{"code":"THROTTLED"}]`,
    );

    const outcome = await apply(
      client,
      SD,
      ['5001', '5002', '5003', '5004'].map((amazonId): AmazonAdsWriteOperation => ({
        ref: amazonId,
        type: 'update',
        entity: 'target',
        amazonId,
        bid: '0.50',
      })),
    );

    expect(outcome.results).toEqual([
      { ref: '5001', status: 'applied', amazonId: '5001' },
      { ref: '5002', status: 'unknown', message: expect.any(String) },
      { ref: '5003', status: 'failed', code: 'HTTP_404', message: 'not found' },
      { ref: '5004', status: 'unsent' },
    ]);
    expect(outcome.throttled).toBe(true);
  });

  it('archiviert erst nach den Updates und lehnt dieselbe Entity in Update und Archivieren ab', async () => {
    const client = setup();
    const order: string[] = [];
    capture('put', '/sd/campaigns', (body) => {
      order.push(`campaigns ${body}`);
      return `[{"code":"SUCCESS","campaignId":1001}]`;
    });
    capture('put', '/sd/targets', (body) => {
      order.push(`targets ${body}`);
      return `[{"code":"SUCCESS","targetId":5001}]`;
    });

    const outcome = await apply(client, SD, [
      { ref: 'c', type: 'archive', entity: 'campaign', amazonId: '1001' },
      { ref: 't', type: 'update', entity: 'target', amazonId: '5001', bid: '0.50' },
      { ref: 'dup', type: 'update', entity: 'campaign', amazonId: '1001', state: 'PAUSED' },
    ]);

    expect(order).toEqual([
      'targets [{"targetId":5001,"bid":0.50}]',
      'campaigns [{"campaignId":1001,"state":"archived"}]',
    ]);
    expect(outcome.results.map((r) => (r.status === 'failed' ? r.code : r.status))).toEqual([
      'applied',
      'applied',
      'DUPLICATE_OPERATION',
    ]);
  });

  it('schickt höchstens 100 Einträge je Aufruf', async () => {
    const client = setup();
    const seen = capture('put', '/sd/targets', (body) =>
      JSON.stringify(
        (JSON.parse(body) as { targetId: number }[]).map(({ targetId }) => ({
          code: 'SUCCESS',
          targetId,
        })),
      ),
    );

    const outcome = await apply(
      client,
      SD,
      Array.from({ length: 101 }, (_, index): AmazonAdsWriteOperation => ({
        ref: `t${index}`,
        type: 'update',
        entity: 'target',
        amazonId: String(5000 + index),
        bid: '0.50',
      })),
    );

    expect(seen.map((call) => (JSON.parse(call.body) as unknown[]).length)).toEqual([100, 1]);
    expect(outcome.results.every((r) => r.status === 'applied')).toBe(true);
  });

  it('wiederholt Anlagen nach einem Serverfehler nicht (unklar), Updates schon', async () => {
    const client = setup();
    let createCalls = 0;
    server.use(
      http.post(`${API}/sd/negativeTargets`, () => {
        createCalls += 1;
        return new HttpResponse('{}', { status: 500 });
      }),
    );
    const updates = capture('put', '/sd/targets', () => `[{"code":"SUCCESS","targetId":5001}]`);

    const outcome = await apply(client, SD, [
      {
        ref: 'new',
        type: 'createNegative',
        ...parents,
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
      { ref: 't', type: 'update', entity: 'target', amazonId: '5001', bid: '0.50' },
    ]);

    expect(createCalls).toBe(1);
    expect(updates).toHaveLength(1);
    expect(outcome.results.map((r) => r.status)).toEqual(['unknown', 'applied']);
  });
});

describe('andere Ad-Typen', () => {
  it('lehnt unbekannte Ad-Typen je Änderung ab', async () => {
    const client = setup();

    const outcome = await apply(client, 'SPONSORED_TV', [
      { ref: 'a', type: 'update', entity: 'campaign', amazonId: '1001', state: 'PAUSED' },
    ]);

    expect(outcome.results).toEqual([
      { ref: 'a', status: 'failed', code: 'AD_PRODUCT_NOT_SUPPORTED', message: expect.any(String) },
    ]);
  });
});
