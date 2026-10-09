import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient } from './client';
import { AmazonAdsHttpError } from './errors';
import { createRequestMeter } from './http';
import {
  AmazonAdsWriteAbortedError,
  MAX_WRITE_BATCH_SIZE,
  type AmazonAdsWriteOperation,
} from './writes';

/** Schreib-Client für Sponsored Products (3.2a): Abbildung auf SP v3, Ergebnis je Änderung, Teilfehler, Rate-Limits. */

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN_URL = 'https://api.amazon.co.uk/auth/o2/token';
const API = 'https://advertising-api-eu.amazon.com';
const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };
const PROFILE_ID = '9007199254740993';
const SP = 'SPONSORED_PRODUCTS';

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
  method: string;
  path: string;
  contentType: string | null;
  accept: string | null;
  scope: string | null;
  body: string;
}

/** Fängt einen Schreib-Endpunkt ab; `respond` bekommt den Body und die Nummer des Aufrufs. */
function capture(
  method: 'put' | 'post',
  path: string,
  respond: (body: string, call: number) => Response | string,
): Seen[] {
  const seen: Seen[] = [];
  server.use(
    http[method](`${API}${path}`, async ({ request }) => {
      const body = await request.text();
      seen.push({
        method: request.method,
        path: new URL(request.url).pathname,
        contentType: request.headers.get('content-type'),
        accept: request.headers.get('accept'),
        scope: request.headers.get('amazon-advertising-api-scope'),
        body,
      });
      const response = respond(body, seen.length);
      return typeof response === 'string'
        ? new HttpResponse(response, {
            status: 207,
            headers: { 'Content-Type': 'application/json' },
          })
        : response;
    }),
  );
  return seen;
}

const apply = (
  client: ReturnType<typeof setup>,
  operations: AmazonAdsWriteOperation[],
  adProduct = SP,
  meter = createRequestMeter(),
) =>
  client.applyChanges(
    connection,
    { amazonProfileId: PROFILE_ID, adProduct, operations },
    { meter },
  );

describe('applyChanges: Feldänderungen', () => {
  it('ändert Gebot und Zustand eines Keywords und schreibt den Betrag als unveränderte JSON-Zahl', async () => {
    const client = setup();
    const seen = capture(
      'put',
      '/sp/keywords',
      () => `{"keywords":{"success":[{"index":0,"keywordId":9007199254740993123}],"error":[]}}`,
    );

    const outcome = await apply(client, [
      {
        ref: 'c1',
        type: 'update',
        entity: 'keyword',
        amazonId: '9007199254740993123',
        bid: '0.10',
        state: 'PAUSED',
      },
    ]);

    expect(seen).toEqual([
      {
        method: 'PUT',
        path: '/sp/keywords',
        contentType: 'application/vnd.spKeyword.v3+json',
        accept: 'application/vnd.spKeyword.v3+json',
        scope: PROFILE_ID,
        body: '{"keywords":[{"keywordId":"9007199254740993123","state":"PAUSED","bid":0.10}]}',
      },
    ]);
    expect(outcome).toEqual({
      results: [{ ref: 'c1', status: 'applied', amazonId: '9007199254740993123' }],
      throttled: false,
      retryAfterMs: null,
    });
  });

  it('bildet Budget, Gebotsstrategie und Platzierungen einer Kampagne auf SP v3 ab', async () => {
    const client = setup();
    const seen = capture(
      'put',
      '/sp/campaigns',
      () =>
        `{"campaigns":{"success":[{"index":0,"campaignId":"1001"},{"index":1,"campaignId":"1002"}]}}`,
    );

    await apply(client, [
      {
        ref: 'a',
        type: 'update',
        entity: 'campaign',
        amazonId: '1001',
        dailyBudget: '35.50',
        bidding: {
          strategy: 'SALES_DOWN_ONLY',
          placements: [
            { placement: 'PLACEMENT_TOP', percentage: '120' },
            { placement: 'SITE_AMAZON_BUSINESS', percentage: '0' },
          ],
        },
      },
      {
        ref: 'b',
        type: 'update',
        entity: 'campaign',
        amazonId: '1002',
        state: 'ENABLED',
        bidding: { strategy: 'NONE', placements: [] },
      },
    ]);

    expect(seen[0]!.contentType).toBe('application/vnd.spCampaign.v3+json');
    expect(seen[0]!.body).toBe(
      '{"campaigns":[' +
        '{"campaignId":"1001","budget":{"budgetType":"DAILY","budget":35.50},' +
        '"dynamicBidding":{"strategy":"LEGACY_FOR_SALES","placementBidding":[' +
        '{"placement":"PLACEMENT_TOP","percentage":120},{"placement":"SITE_AMAZON_BUSINESS","percentage":0}]}},' +
        '{"campaignId":"1002","state":"ENABLED","dynamicBidding":{"strategy":"MANUAL","placementBidding":[]}}' +
        ']}',
    );
  });

  it('kennt die Strategie „hoch und runter“', async () => {
    const client = setup();
    const seen = capture(
      'put',
      '/sp/campaigns',
      () => `{"campaigns":{"success":[{"index":0,"campaignId":"1001"}]}}`,
    );

    await apply(client, [
      {
        ref: 'a',
        type: 'update',
        entity: 'campaign',
        amazonId: '1001',
        bidding: { strategy: 'SALES_UP_AND_DOWN', placements: [] },
      },
    ]);

    expect(seen[0]!.body).toContain('"strategy":"AUTO_FOR_SALES"');
  });

  it('schickt Ad Groups, Produkt-Targets und Product Ads an ihre Endpunkte', async () => {
    const client = setup();
    const adGroups = capture(
      'put',
      '/sp/adGroups',
      () => `{"adGroups":{"success":[{"index":0,"adGroupId":"1101"}]}}`,
    );
    const targets = capture(
      'put',
      '/sp/targets',
      () => `{"targetingClauses":{"success":[{"index":0,"targetId":"3001"}]}}`,
    );
    const ads = capture(
      'put',
      '/sp/productAds',
      () => `{"productAds":{"success":[{"index":0,"adId":"4001"}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'g', type: 'update', entity: 'adGroup', amazonId: '1101', defaultBid: '0.45' },
      { ref: 't', type: 'update', entity: 'target', amazonId: '3001', bid: '1' },
      { ref: 'p', type: 'update', entity: 'productAd', amazonId: '4001', state: 'PAUSED' },
    ]);

    expect(adGroups[0]).toMatchObject({
      contentType: 'application/vnd.spAdGroup.v3+json',
      body: '{"adGroups":[{"adGroupId":"1101","defaultBid":0.45}]}',
    });
    expect(targets[0]).toMatchObject({
      contentType: 'application/vnd.spTargetingClause.v3+json',
      body: '{"targetingClauses":[{"targetId":"3001","bid":1}]}',
    });
    expect(ads[0]).toMatchObject({
      contentType: 'application/vnd.spProductAd.v3+json',
      body: '{"productAds":[{"adId":"4001","state":"PAUSED"}]}',
    });
    expect(outcome.results.map((r) => [r.ref, r.status])).toEqual([
      ['g', 'applied'],
      ['t', 'applied'],
      ['p', 'applied'],
    ]);
  });

  it('liefert die Ergebnisse in der Reihenfolge der Eingabe, auch über mehrere Endpunkte', async () => {
    const client = setup();
    capture(
      'put',
      '/sp/keywords',
      () =>
        `{"keywords":{"success":[{"index":0,"keywordId":"2001"},{"index":1,"keywordId":"2002"}]}}`,
    );
    capture(
      'put',
      '/sp/adGroups',
      () => `{"adGroups":{"success":[{"index":0,"adGroupId":"1101"}]}}`,
    );

    const outcome = await apply(client, [
      { ref: '1', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
      { ref: '2', type: 'update', entity: 'adGroup', amazonId: '1101', state: 'PAUSED' },
      { ref: '3', type: 'update', entity: 'keyword', amazonId: '2002', bid: '0.6' },
    ]);

    expect(outcome.results.map((r) => r.ref)).toEqual(['1', '2', '3']);
  });

  it('teilt mehr als 1000 Änderungen eines Endpunkts auf mehrere Anfragen auf', async () => {
    const client = setup();
    const seen = capture('put', '/sp/keywords', (body) => {
      const { keywords } = JSON.parse(body) as { keywords: { keywordId: string }[] };
      const success = keywords.map(({ keywordId }, index) => ({ index, keywordId }));
      return JSON.stringify({ keywords: { success } });
    });
    const operations = Array.from(
      { length: MAX_WRITE_BATCH_SIZE + 1 },
      (_, i): AmazonAdsWriteOperation => ({
        ref: `r${i}`,
        type: 'update',
        entity: 'keyword',
        amazonId: String(10_000 + i),
        bid: '0.5',
      }),
    );

    const outcome = await apply(client, operations);

    expect(
      seen.map((s) => (JSON.parse(s.body) as { keywords: unknown[] }).keywords.length),
    ).toEqual([MAX_WRITE_BATCH_SIZE, 1]);
    expect(outcome.results.every((r) => r.status === 'applied')).toBe(true);
    expect(outcome.results).toHaveLength(MAX_WRITE_BATCH_SIZE + 1);
  });

  it('lehnt eine Änderung ohne Feld ab, ohne Amazon zu fragen', async () => {
    const client = setup();

    const outcome = await apply(client, [
      { ref: 'x', type: 'update', entity: 'keyword', amazonId: '2001' },
    ]);

    expect(outcome.results).toEqual([
      { ref: 'x', status: 'failed', code: 'NOTHING_TO_CHANGE', message: expect.any(String) },
    ]);
  });
});

describe('applyChanges: Teilfehler', () => {
  it('ordnet Erfolge und Fehler einer 207-Antwort über den Index zu und übernimmt Grund und Text von Amazon', async () => {
    const client = setup();
    capture(
      'put',
      '/sp/keywords',
      () => `{"keywords":{
        "success":[{"index":2,"keywordId":"2003"},{"index":0,"keywordId":"2001"}],
        "error":[{"index":1,"errors":[{"errorType":"biddingError","errorValue":{"biddingError":{
          "reason":"BID_OUT_OF_MARKET_PLACE_RANGE","marketplace":"DE","lowerLimit":"0.02","upperLimit":"1000",
          "cause":{"location":"$.keywords[1].bid"},"message":"Bid  must be between\\n0.02 and 1000"}}}]}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
      { ref: 'b', type: 'update', entity: 'keyword', amazonId: '2002', bid: '5000' },
      { ref: 'c', type: 'update', entity: 'keyword', amazonId: '2003', bid: '0.7' },
    ]);

    expect(outcome.results).toEqual([
      { ref: 'a', status: 'applied', amazonId: '2001' },
      {
        ref: 'b',
        status: 'failed',
        code: 'BID_OUT_OF_MARKET_PLACE_RANGE',
        message: 'Bid must be between 0.02 and 1000',
      },
      { ref: 'c', status: 'applied', amazonId: '2003' },
    ]);
    expect(outcome.retryAfterMs).toBeNull();
  });

  it('nimmt den Fehlertyp als Code, wenn Amazon keinen Grund nennt, und kürzt lange Texte', async () => {
    const client = setup();
    capture(
      'put',
      '/sp/keywords',
      () =>
        `{"keywords":{"error":[{"index":0,"errors":[{"errorType":"otherError","errorValue":{"otherError":{"message":"${'x'.repeat(600)}"}}}]}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
    ]);

    const [result] = outcome.results;
    expect(result).toMatchObject({ status: 'failed', code: 'otherError' });
    expect(result!.status === 'failed' && result!.message.length).toBeLessThanOrEqual(300);
  });

  it('meldet `unknown`, wenn die Antwort eine Änderung weder als Erfolg noch als Fehler nennt', async () => {
    const client = setup();
    capture(
      'put',
      '/sp/keywords',
      () => `{"keywords":{"success":[{"index":0,"keywordId":"2001"}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
      { ref: 'b', type: 'update', entity: 'keyword', amazonId: '2002', bid: '0.6' },
    ]);

    expect(outcome.results[1]).toEqual({
      ref: 'b',
      status: 'unknown',
      message: expect.any(String),
    });
  });

  it('lässt nach einem abgelehnten Aufruf (400) die übrigen Endpunkte weiterlaufen', async () => {
    const client = setup();
    capture('put', '/sp/keywords', () =>
      HttpResponse.json(
        { code: 'INVALID_ARGUMENT', message: 'keywords[0].bid is malformed' },
        { status: 400 },
      ),
    );
    capture(
      'put',
      '/sp/adGroups',
      () => `{"adGroups":{"success":[{"index":0,"adGroupId":"1101"}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'k', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
      { ref: 'g', type: 'update', entity: 'adGroup', amazonId: '1101', state: 'PAUSED' },
    ]);

    expect(outcome.results).toEqual([
      {
        ref: 'k',
        status: 'failed',
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('malformed'),
      },
      { ref: 'g', status: 'applied', amazonId: '1101' },
    ]);
  });
});

describe('applyChanges: Archivieren und Negatives', () => {
  it('archiviert über die delete-Endpunkte (v3 kennt `ARCHIVED` beim Update nicht)', async () => {
    const client = setup();
    const keywords = capture(
      'post',
      '/sp/keywords/delete',
      () =>
        `{"keywords":{"success":[{"index":0,"keywordId":"2001"}],"error":[{"index":1,"errors":[{"errorType":"entityNotFoundError","errorValue":{"entityNotFoundError":{"reason":"ENTITY_NOT_FOUND","entityId":"2002","entityType":"KEYWORD","message":"Keyword not found"}}}]}]}}`,
    );
    const negatives = capture(
      'post',
      '/sp/campaignNegativeKeywords/delete',
      () =>
        `{"campaignNegativeKeywords":{"success":[{"index":0,"campaignNegativeKeywordId":"5001"}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'archive', entity: 'keyword', amazonId: '2001' },
      { ref: 'b', type: 'archive', entity: 'keyword', amazonId: '2002' },
      { ref: 'c', type: 'archive', entity: 'campaignNegativeKeyword', amazonId: '5001' },
    ]);

    expect(keywords[0]).toMatchObject({
      method: 'POST',
      contentType: 'application/vnd.spKeyword.v3+json',
      body: '{"keywordIdFilter":{"include":["2001","2002"]}}',
    });
    expect(negatives[0]!.body).toBe('{"campaignNegativeKeywordIdFilter":{"include":["5001"]}}');
    expect(outcome.results).toEqual([
      { ref: 'a', status: 'applied', amazonId: '2001' },
      { ref: 'b', status: 'failed', code: 'ENTITY_NOT_FOUND', message: 'Keyword not found' },
      { ref: 'c', status: 'applied', amazonId: '5001' },
    ]);
  });

  it.each([
    ['campaign', '/sp/campaigns/delete', 'campaignIdFilter', 'campaigns', 'campaignId'],
    ['adGroup', '/sp/adGroups/delete', 'adGroupIdFilter', 'adGroups', 'adGroupId'],
    ['target', '/sp/targets/delete', 'targetIdFilter', 'targetingClauses', 'targetId'],
    ['productAd', '/sp/productAds/delete', 'adIdFilter', 'productAds', 'adId'],
    [
      'negativeKeyword',
      '/sp/negativeKeywords/delete',
      'negativeKeywordIdFilter',
      'negativeKeywords',
      'negativeKeywordId',
    ],
    [
      'negativeTarget',
      '/sp/negativeTargets/delete',
      'negativeTargetIdFilter',
      'negativeTargetingClauses',
      'targetId',
    ],
    [
      'campaignNegativeTarget',
      '/sp/campaignNegativeTargets/delete',
      'campaignNegativeTargetIdFilter',
      'campaignNegativeTargetingClauses',
      'campaignNegativeTargetingClauseId',
    ],
  ] as const)('archiviert %s über %s', async (entity, path, filter, listKey, idKey) => {
    const client = setup();
    const seen = capture(
      'post',
      path,
      () => `{"${listKey}":{"success":[{"index":0,"${idKey}":6001}]},"requestId":"abc"}`,
    );

    const outcome = await apply(client, [{ ref: 'a', type: 'archive', entity, amazonId: '6001' }]);

    expect(seen[0]!.body).toBe(`{"${filter}":{"include":["6001"]}}`);
    expect(outcome.results).toEqual([{ ref: 'a', status: 'applied', amazonId: '6001' }]);
  });

  it('legt negative Keywords in Ad Group und Kampagne an und liefert die neue ID verlustfrei', async () => {
    const client = setup();
    const adGroup = capture(
      'post',
      '/sp/negativeKeywords',
      () =>
        `{"negativeKeywords":{"success":[{"index":0,"negativeKeywordId":9007199254740993555}]}}`,
    );
    const campaign = capture(
      'post',
      '/sp/campaignNegativeKeywords',
      () =>
        `{"campaignNegativeKeywords":{"success":[{"index":0,"campaignNegativeKeywordId":"7002"}]}}`,
    );

    const outcome = await apply(client, [
      {
        ref: 'a',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        negative: { type: 'keyword', keywordText: 'gebraucht "lampe"', matchType: 'EXACT' },
      },
      {
        ref: 'b',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: 'kinder', matchType: 'PHRASE' },
      },
    ]);

    expect(adGroup[0]).toMatchObject({
      contentType: 'application/vnd.spNegativeKeyword.v3+json',
      body:
        '{"negativeKeywords":[{"campaignId":"1001","adGroupId":"1101","keywordText":"gebraucht \\"lampe\\"",' +
        '"matchType":"NEGATIVE_EXACT","state":"ENABLED"}]}',
    });
    expect(campaign[0]).toMatchObject({
      contentType: 'application/vnd.spCampaignNegativeKeyword.v3+json',
      body:
        '{"campaignNegativeKeywords":[{"campaignId":"1001","keywordText":"kinder",' +
        '"matchType":"NEGATIVE_PHRASE","state":"ENABLED"}]}',
    });
    expect(outcome.results).toEqual([
      { ref: 'a', status: 'applied', amazonId: '9007199254740993555' },
      { ref: 'b', status: 'applied', amazonId: '7002' },
    ]);
  });

  it('legt negative ASINs in Ad Group und Kampagne an', async () => {
    const client = setup();
    const adGroup = capture(
      'post',
      '/sp/negativeTargets',
      () => `{"negativeTargetingClauses":{"success":[{"index":0,"targetId":"8001"}]}}`,
    );
    const campaign = capture(
      'post',
      '/sp/campaignNegativeTargets',
      () =>
        `{"campaignNegativeTargetingClauses":{"success":[{"index":0,"campaignNegativeTargetingClauseId":"8002"}]}}`,
    );

    const outcome = await apply(client, [
      {
        ref: 'a',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        negative: { type: 'product', asin: 'B0FREMD001' },
      },
      {
        ref: 'b',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: null,
        negative: { type: 'product', asin: 'B0FREMD002' },
      },
    ]);

    expect(adGroup[0]).toMatchObject({
      contentType: 'application/vnd.spNegativeTargetingClause.v3+json',
      body:
        '{"negativeTargetingClauses":[{"campaignId":"1001","adGroupId":"1101",' +
        '"expression":[{"type":"ASIN_SAME_AS","value":"B0FREMD001"}],"state":"ENABLED"}]}',
    });
    expect(campaign[0]).toMatchObject({
      contentType: 'application/vnd.spCampaignNegativeTargetingClause.v3+json',
      body:
        '{"campaignNegativeTargetingClauses":[{"campaignId":"1001",' +
        '"expression":[{"type":"ASIN_SAME_AS","value":"B0FREMD002"}],"state":"ENABLED"}]}',
    });
    expect(outcome.results.map((r) => r.status === 'applied' && r.amazonId)).toEqual([
      '8001',
      '8002',
    ]);
  });
});

describe('applyChanges: Rate-Limits und Ausfälle', () => {
  it('wiederholt nach 429 und zählt die Drosselung', async () => {
    const client = setup();
    const seen = capture('put', '/sp/keywords', (_body, call) =>
      call === 1
        ? HttpResponse.json({ code: 'THROTTLED', message: 'Too many requests' }, { status: 429 })
        : `{"keywords":{"success":[{"index":0,"keywordId":"2001"}]}}`,
    );
    const meter = createRequestMeter();

    const outcome = await apply(
      client,
      [{ ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' }],
      SP,
      meter,
    );

    expect(seen).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
    expect(meter).toMatchObject({ requests: 2, throttled: 1, retries: 1 });
  });

  it('hört bei anhaltender Drosselung auf: der Rest ist `unsent`, mit der Wartezeit von Amazon', async () => {
    const client = setup();
    capture(
      'put',
      '/sp/campaigns',
      () => `{"campaigns":{"success":[{"index":0,"campaignId":"1001"}]}}`,
    );
    const keywords = capture('put', '/sp/keywords', () =>
      HttpResponse.json(
        { code: 'THROTTLED', message: 'Too many requests' },
        { status: 429, headers: { 'Retry-After': '120' } },
      ),
    );
    const negatives = capture('post', '/sp/negativeKeywords', () => `{}`);

    const outcome = await apply(client, [
      {
        ref: 'n',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        negative: { type: 'keyword', keywordText: 'x', matchType: 'EXACT' },
      },
      { ref: 'k', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
      { ref: 'c', type: 'update', entity: 'campaign', amazonId: '1001', state: 'PAUSED' },
    ]);

    expect(outcome.results).toEqual([
      { ref: 'n', status: 'unsent' },
      { ref: 'k', status: 'unsent' },
      { ref: 'c', status: 'applied', amazonId: '1001' },
    ]);
    expect(outcome).toMatchObject({ throttled: true, retryAfterMs: 120_000 });
    expect(keywords.length).toBeGreaterThanOrEqual(1);
    expect(negatives).toHaveLength(0);
  });

  it('wiederholt Updates nach 5xx, weil sie denselben Zielwert setzen', async () => {
    const client = setup();
    const seen = capture('put', '/sp/keywords', (_body, call) =>
      call === 1
        ? HttpResponse.json({ code: 'INTERNAL_ERROR', message: 'boom' }, { status: 500 })
        : `{"keywords":{"success":[{"index":0,"keywordId":"2001"}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
    ]);

    expect(seen).toHaveLength(2);
    expect(outcome.results[0]).toMatchObject({ status: 'applied' });
  });

  it('wiederholt Anlagen nach 5xx nicht und meldet sie als `unknown` (könnten angelegt sein)', async () => {
    const client = setup();
    const seen = capture('post', '/sp/negativeKeywords', () =>
      HttpResponse.json({ code: 'INTERNAL_ERROR', message: 'boom' }, { status: 500 }),
    );
    capture(
      'put',
      '/sp/keywords',
      () => `{"keywords":{"success":[{"index":0,"keywordId":"2001"}]}}`,
    );

    const outcome = await apply(client, [
      {
        ref: 'n',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        negative: { type: 'keyword', keywordText: 'x', matchType: 'EXACT' },
      },
      { ref: 'k', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
    ]);

    expect(seen).toHaveLength(1);
    expect(outcome.results).toEqual([
      { ref: 'n', status: 'unknown', message: expect.any(String) },
      { ref: 'k', status: 'applied', amazonId: '2001' },
    ]);
  });

  it('meldet `unknown`, wenn die Antwort nicht lesbar ist', async () => {
    const client = setup();
    capture('put', '/sp/keywords', () => `{"keywords":"kaputt"}`);

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
    ]);

    expect(outcome.results[0]).toMatchObject({ ref: 'a', status: 'unknown' });
  });

  it('bricht bei 403 ab und nennt im Fehler, was schon angewendet ist', async () => {
    const client = setup();
    capture(
      'put',
      '/sp/campaigns',
      () => `{"campaigns":{"success":[{"index":0,"campaignId":1001}]}}`,
    );
    capture('put', '/sp/keywords', () =>
      HttpResponse.json({ code: 'ACCESS_DENIED', message: 'no access' }, { status: 403 }),
    );
    const negatives = capture('post', '/sp/negativeKeywords', () => `{}`);

    const error = await apply(client, [
      { ref: 'k', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
      { ref: 'c', type: 'update', entity: 'campaign', amazonId: '1001', state: 'PAUSED' },
      {
        ref: 'n',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        negative: { type: 'keyword', keywordText: 'x', matchType: 'EXACT' },
      },
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AmazonAdsWriteAbortedError);
    const aborted = error as AmazonAdsWriteAbortedError;
    expect(aborted.cause).toBeInstanceOf(AmazonAdsHttpError);
    expect(aborted.cause).toMatchObject({ status: 403 });
    expect(aborted.results).toEqual([
      { ref: 'k', status: 'unsent' },
      { ref: 'c', status: 'applied', amazonId: '1001' },
      { ref: 'n', status: 'unsent' },
    ]);
    expect(negatives).toHaveLength(0);
  });

  it('bricht ab, wenn schon das Access-Token nicht zu holen ist: nichts wurde gesendet', async () => {
    const client = setup();
    server.use(
      http.post(TOKEN_URL, () => HttpResponse.json({ error: 'server_error' }, { status: 500 })),
    );
    const keywords = capture('put', '/sp/keywords', () => `{}`);

    const error = await apply(client, [
      { ref: 'k', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AmazonAdsWriteAbortedError);
    expect((error as AmazonAdsWriteAbortedError).results).toEqual([{ ref: 'k', status: 'unsent' }]);
    expect(keywords).toHaveLength(0);
  });

  it('meldet Updates nach anhaltenden 5xx als `unknown`', async () => {
    const client = setup();
    const seen = capture('put', '/sp/keywords', () =>
      HttpResponse.json({ code: 'INTERNAL_ERROR', message: 'boom' }, { status: 503 }),
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
    ]);

    expect(seen).toHaveLength(3);
    expect(outcome.results[0]).toMatchObject({ status: 'unknown' });
  });

  it('meldet eine Anlage nach einem Netzwerkfehler als `unknown`, ohne Wiederholung', async () => {
    const client = setup();
    const seen = capture('post', '/sp/negativeKeywords', () => HttpResponse.error());

    const outcome = await apply(client, [
      {
        ref: 'n',
        type: 'createNegative',
        amazonCampaignId: '1001',
        amazonAdGroupId: '1101',
        negative: { type: 'keyword', keywordText: 'x', matchType: 'EXACT' },
      },
    ]);

    expect(seen).toHaveLength(1);
    expect(outcome.results[0]).toMatchObject({ status: 'unknown' });
  });
});

describe('applyChanges: Eingaben und widersprüchliche Antworten', () => {
  it('meldet ungültige Werte und IDs je Änderung als `failed` und sendet die übrigen', async () => {
    const client = setup();
    const seen = capture(
      'put',
      '/sp/keywords',
      () => `{"keywords":{"success":[{"index":0,"keywordId":2001}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'exp', type: 'update', entity: 'keyword', amazonId: '2002', bid: '1e3' },
      { ref: 'zero', type: 'update', entity: 'keyword', amazonId: '2003', bid: '007' },
      { ref: 'id', type: 'update', entity: 'keyword', amazonId: 'K1', bid: '0.5' },
      {
        ref: 'pct',
        type: 'update',
        entity: 'campaign',
        amazonId: '1001',
        bidding: {
          strategy: 'NONE',
          placements: [{ placement: 'PLACEMENT_TOP', percentage: '12.5' }],
        },
      },
      {
        ref: 'parent',
        type: 'createNegative',
        amazonCampaignId: 'C1',
        amazonAdGroupId: null,
        negative: { type: 'keyword', keywordText: 'x', matchType: 'EXACT' },
      },
      { ref: 'ok', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
    ]);

    expect(
      outcome.results.map((r) => [r.ref, r.status, r.status === 'failed' ? r.code : null]),
    ).toEqual([
      ['exp', 'failed', 'INVALID_VALUE'],
      ['zero', 'failed', 'INVALID_VALUE'],
      ['id', 'failed', 'INVALID_VALUE'],
      ['pct', 'failed', 'INVALID_VALUE'],
      ['parent', 'failed', 'INVALID_VALUE'],
      ['ok', 'applied', null],
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.body).toBe('{"keywords":[{"keywordId":"2001","bid":0.5}]}');
  });

  it('lehnt eine zweite Änderung derselben Entity am selben Endpunkt ab (Zuordnung über den Index)', async () => {
    const client = setup();
    const seen = capture(
      'put',
      '/sp/keywords',
      () => `{"keywords":{"success":[{"index":0,"keywordId":2001}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
      { ref: 'b', type: 'update', entity: 'keyword', amazonId: '2001', state: 'PAUSED' },
    ]);

    expect(outcome.results).toEqual([
      { ref: 'a', status: 'applied', amazonId: '2001' },
      { ref: 'b', status: 'failed', code: 'DUPLICATE_OPERATION', message: expect.any(String) },
    ]);
    expect(seen[0]!.body).toBe('{"keywords":[{"keywordId":"2001","bid":0.5}]}');
  });

  it('meldet `unknown`, wenn die Antwort eine andere ID nennt oder einen Index doppelt', async () => {
    const client = setup();
    capture(
      'put',
      '/sp/keywords',
      () => `{"keywords":{
        "success":[{"index":0,"keywordId":9999},{"index":1,"keywordId":2002},{"index":2,"keywordId":2003},{"index":7,"keywordId":1}],
        "error":[{"index":1,"errors":[{"errorType":"otherError","errorValue":{"otherError":{"message":"x"}}}]}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
      { ref: 'b', type: 'update', entity: 'keyword', amazonId: '2002', bid: '0.5' },
      { ref: 'c', type: 'update', entity: 'keyword', amazonId: '2003', bid: '0.5' },
    ]);

    expect(outcome.results.map((r) => r.status)).toEqual(['unknown', 'unknown', 'applied']);
  });

  it('ordnet Drosselung und Serverfehler je Eintrag als `unsent` bzw. `unknown` ein, nicht als abgelehnt', async () => {
    const client = setup();
    capture(
      'put',
      '/sp/keywords',
      () => `{"keywords":{"error":[
        {"index":0,"errors":[{"errorType":"throttledError","errorValue":{"throttledError":{"reason":"THROTTLED","message":"slow down"}}}]},
        {"index":1,"errors":[{"errorType":"internalServerError","errorValue":{"internalServerError":{"reason":"INTERNAL_ERROR","message":"boom"}}}]}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
      { ref: 'b', type: 'update', entity: 'keyword', amazonId: '2002', bid: '0.5' },
    ]);

    expect(outcome.results).toEqual([
      { ref: 'a', status: 'unsent' },
      { ref: 'b', status: 'unknown', message: expect.any(String) },
    ]);
    expect(outcome.throttled).toBe(true);
  });

  it('übernimmt als Code nur einfache Bezeichner und entfernt Tokens aus dem Text', async () => {
    const client = setup();
    capture(
      'put',
      '/sp/keywords',
      () =>
        `{"keywords":{"error":[{"index":0,"errors":[{"errorType":"otherError","errorValue":{"otherError":{"reason":"<script>alert(1)</script>","message":"bad Atza|geheim123 token"}}}]}]}}`,
    );

    const outcome = await apply(client, [
      { ref: 'a', type: 'update', entity: 'keyword', amazonId: '2001', bid: '0.5' },
    ]);

    expect(outcome.results[0]).toEqual({
      ref: 'a',
      status: 'failed',
      code: 'otherError',
      message: 'bad [token] token',
    });
  });

  it('liefert für eine leere Liste ein leeres Ergebnis, ohne Amazon zu fragen', async () => {
    expect(await apply(setup(), [])).toEqual({ results: [], throttled: false, retryAfterMs: null });
  });
});

describe('applyChanges: andere Ad-Typen', () => {
  it('lehnt Sponsored Brands und Display ab, ohne Amazon zu fragen (kommt mit 3.2c)', async () => {
    const client = setup();

    const outcome = await apply(
      client,
      [{ ref: 'a', type: 'update', entity: 'campaign', amazonId: '1001', state: 'PAUSED' }],
      'SPONSORED_TV',
    );

    expect(outcome.results).toEqual([
      { ref: 'a', status: 'failed', code: 'AD_PRODUCT_NOT_SUPPORTED', message: expect.any(String) },
    ]);
  });
});
