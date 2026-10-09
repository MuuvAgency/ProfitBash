import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient } from './client';
import { applySpCreates, type AmazonAdsCreateOperation } from './creates';
import { AmazonAdsHttpError } from './errors';
import { createRequestMeter } from './http';
import { noopLogger } from './logger';
import { AmazonAdsWriteAbortedError } from './writes';

/** Neue Kampagnen-Strukturen für Sponsored Products v3 (4.4): Reihenfolge, Eltern-IDs, Teilfehler, Drosselung. */

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

interface Seen {
  path: string;
  contentType: string | null;
  accept: string | null;
  body: string;
}

/** Alle Aufrufe in der Reihenfolge, in der sie bei Amazon ankommen. */
const calls: string[] = [];
afterEach(() => {
  calls.length = 0;
});

/** Fängt `POST <path>` ab; `respond` bekommt den Body und die Nummer des Aufrufs. */
function capture(path: string, respond: (body: string, call: number) => Response | string): Seen[] {
  const seen: Seen[] = [];
  server.use(
    http.post(`${API}${path}`, async ({ request }) => {
      const body = await request.text();
      calls.push(path);
      seen.push({
        path: new URL(request.url).pathname,
        contentType: request.headers.get('content-type'),
        accept: request.headers.get('accept'),
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

/** 207 mit Erfolg für jeden Eintrag des Bodys und fortlaufenden IDs ab `firstId`. */
function succeedAll(listKey: string, idKey: string, firstId: bigint) {
  return (body: string) => {
    const items = (JSON.parse(body) as Record<string, unknown[]>)[listKey] ?? [];
    const success = items.map(
      (_, index) => `{"index":${index},"${idKey}":"${firstId + BigInt(index)}"}`,
    );
    return `{"${listKey}":{"success":[${success.join(',')}],"error":[]}}`;
  };
}

const campaign = (
  ref: string,
  overrides: Partial<Extract<AmazonAdsCreateOperation, { entity: 'campaign' }>> = {},
): AmazonAdsCreateOperation => ({
  ref,
  entity: 'campaign',
  name: `Kampagne ${ref}`,
  targetingType: 'MANUAL',
  state: 'ENABLED',
  dailyBudget: '25.50',
  startDate: '2026-10-10',
  biddingStrategy: 'SALES_DOWN_ONLY',
  placements: [],
  amazonPortfolioId: null,
  offAmazon: null,
  ...overrides,
});

const adGroup = (ref: string, campaignRef: string): AmazonAdsCreateOperation => ({
  ref,
  entity: 'adGroup',
  campaignRef,
  name: `Gruppe ${ref}`,
  defaultBid: '0.75',
  state: 'ENABLED',
});

const keyword = (
  ref: string,
  campaignRef: string,
  adGroupRef: string,
): AmazonAdsCreateOperation => ({
  ref,
  entity: 'keyword',
  campaignRef,
  adGroupRef,
  keywordText: 'laufschuhe damen',
  matchType: 'EXACT',
  bid: '1.10',
  state: 'ENABLED',
});

const create = (
  deps: ReturnType<typeof setup>,
  operations: AmazonAdsCreateOperation[],
  created?: ReadonlyMap<string, string>,
  meter = createRequestMeter(),
) =>
  applySpCreates(
    deps,
    connection,
    { amazonProfileId: PROFILE_ID, operations, ...(created && { created }) },
    { meter },
  );

describe('applySpCreates: Reihenfolge und Eltern-IDs', () => {
  it('legt Kampagne, Ad Group und Kinder nacheinander an und setzt die IDs aus der Antwort ein', async () => {
    const deps = setup();
    const campaigns = capture(
      '/sp/campaigns',
      succeedAll('campaigns', 'campaignId', 9007199254740993001n),
    );
    const adGroups = capture(
      '/sp/adGroups',
      succeedAll('adGroups', 'adGroupId', 9007199254740993101n),
    );
    const productAds = capture('/sp/productAds', succeedAll('productAds', 'adId', 301n));
    const keywords = capture('/sp/keywords', succeedAll('keywords', 'keywordId', 401n));
    const targets = capture('/sp/targets', succeedAll('targetingClauses', 'targetId', 501n));
    const negativeKeywords = capture(
      '/sp/negativeKeywords',
      succeedAll('negativeKeywords', 'negativeKeywordId', 601n),
    );
    const negativeTargets = capture(
      '/sp/negativeTargets',
      succeedAll('negativeTargetingClauses', 'targetId', 701n),
    );

    // Absichtlich durcheinander: Die Reihenfolge der Aufrufe ergibt sich aus den Ebenen.
    const outcome = await create(deps, [
      {
        ref: 'nt',
        entity: 'negativeTarget',
        campaignRef: 'c',
        adGroupRef: 'g',
        asin: 'B0FREMD001',
      },
      keyword('k', 'c', 'g'),
      adGroup('g', 'c'),
      {
        ref: 'nk',
        entity: 'negativeKeyword',
        campaignRef: 'c',
        adGroupRef: 'g',
        keywordText: 'gebraucht',
        matchType: 'NEGATIVE_PHRASE',
      },
      {
        ref: 'pa',
        entity: 'productAd',
        campaignRef: 'c',
        adGroupRef: 'g',
        sku: 'SKU-1',
        asin: null,
        state: 'ENABLED',
      },
      campaign('c'),
      {
        ref: 't',
        entity: 'target',
        campaignRef: 'c',
        adGroupRef: 'g',
        expression: { type: 'ASIN_SAME_AS', value: 'B0ZIEL0001' },
        bid: null,
        state: 'PAUSED',
      },
    ]);

    expect(calls).toEqual([
      '/sp/campaigns',
      '/sp/adGroups',
      '/sp/productAds',
      '/sp/keywords',
      '/sp/targets',
      '/sp/negativeKeywords',
      '/sp/negativeTargets',
    ]);
    expect(campaigns[0]).toMatchObject({
      contentType: 'application/vnd.spCampaign.v3+json',
      accept: 'application/vnd.spCampaign.v3+json',
    });
    expect(adGroups[0]!.contentType).toBe('application/vnd.spAdGroup.v3+json');
    expect(adGroups[0]!.body).toBe(
      '{"adGroups":[{"campaignId":"9007199254740993001","name":"Gruppe g","defaultBid":0.75,"state":"ENABLED"}]}',
    );
    expect(productAds[0]!.contentType).toBe('application/vnd.spProductAd.v3+json');
    expect(productAds[0]!.body).toBe(
      '{"productAds":[{"campaignId":"9007199254740993001","adGroupId":"9007199254740993101","sku":"SKU-1","state":"ENABLED"}]}',
    );
    expect(keywords[0]!.contentType).toBe('application/vnd.spKeyword.v3+json');
    expect(keywords[0]!.body).toBe(
      '{"keywords":[{"campaignId":"9007199254740993001","adGroupId":"9007199254740993101",' +
        '"keywordText":"laufschuhe damen","matchType":"EXACT","state":"ENABLED","bid":1.10}]}',
    );
    expect(targets[0]!.contentType).toBe('application/vnd.spTargetingClause.v3+json');
    expect(targets[0]!.body).toBe(
      '{"targetingClauses":[{"campaignId":"9007199254740993001","adGroupId":"9007199254740993101",' +
        '"expressionType":"MANUAL","expression":[{"type":"ASIN_SAME_AS","value":"B0ZIEL0001"}],"state":"PAUSED"}]}',
    );
    expect(negativeKeywords[0]!.contentType).toBe('application/vnd.spNegativeKeyword.v3+json');
    expect(negativeKeywords[0]!.body).toBe(
      '{"negativeKeywords":[{"campaignId":"9007199254740993001","adGroupId":"9007199254740993101",' +
        '"keywordText":"gebraucht","matchType":"NEGATIVE_PHRASE","state":"ENABLED"}]}',
    );
    expect(negativeTargets[0]!.contentType).toBe(
      'application/vnd.spNegativeTargetingClause.v3+json',
    );
    expect(negativeTargets[0]!.body).toBe(
      '{"negativeTargetingClauses":[{"campaignId":"9007199254740993001","adGroupId":"9007199254740993101",' +
        '"expression":[{"type":"ASIN_SAME_AS","value":"B0FREMD001"}],"state":"ENABLED"}]}',
    );
    expect(outcome).toEqual({
      results: [
        { ref: 'nt', status: 'applied', amazonId: '701' },
        { ref: 'k', status: 'applied', amazonId: '401' },
        { ref: 'g', status: 'applied', amazonId: '9007199254740993101' },
        { ref: 'nk', status: 'applied', amazonId: '601' },
        { ref: 'pa', status: 'applied', amazonId: '301' },
        { ref: 'c', status: 'applied', amazonId: '9007199254740993001' },
        { ref: 't', status: 'applied', amazonId: '501' },
      ],
      throttled: false,
      retryAfterMs: null,
    });
  });

  it('bildet die Kampagne mit Budget, Startdatum, Strategie, Platzierungen, Portfolio und Off-Amazon ab', async () => {
    const deps = setup();
    const seen = capture('/sp/campaigns', succeedAll('campaigns', 'campaignId', 1001n));

    await create(deps, [
      campaign('a', {
        name: 'SP | Marke | Exact',
        dailyBudget: '35.50',
        startDate: '2026-11-01',
        biddingStrategy: 'SALES_UP_AND_DOWN',
        placements: [
          { placement: 'PLACEMENT_TOP', percentage: '120' },
          { placement: 'PLACEMENT_PRODUCT_PAGE', percentage: '0' },
        ],
        amazonPortfolioId: '9007199254740993555',
        offAmazon: 'limitSpend',
      }),
      campaign('b', {
        targetingType: 'AUTO',
        state: 'PAUSED',
        biddingStrategy: 'NONE',
        offAmazon: 'increaseReach',
      }),
      campaign('c', { biddingStrategy: 'SALES_DOWN_ONLY' }),
    ]);

    expect(seen[0]!.body).toBe(
      '{"campaigns":[' +
        '{"name":"SP | Marke | Exact","targetingType":"MANUAL","state":"ENABLED",' +
        '"budget":{"budgetType":"DAILY","budget":35.50},"startDate":"2026-11-01",' +
        '"dynamicBidding":{"strategy":"AUTO_FOR_SALES","placementBidding":[' +
        '{"placement":"PLACEMENT_TOP","percentage":120},{"placement":"PLACEMENT_PRODUCT_PAGE","percentage":0}]},' +
        '"portfolioId":"9007199254740993555","offAmazonSettings":{"offAmazonBudgetControlStrategy":"MINIMIZE_SPEND"}},' +
        '{"name":"Kampagne b","targetingType":"AUTO","state":"PAUSED",' +
        '"budget":{"budgetType":"DAILY","budget":25.50},"startDate":"2026-10-10",' +
        '"dynamicBidding":{"strategy":"MANUAL","placementBidding":[]},' +
        '"offAmazonSettings":{"offAmazonBudgetControlStrategy":"MAXIMIZE_REACH"}},' +
        '{"name":"Kampagne c","targetingType":"MANUAL","state":"ENABLED",' +
        '"budget":{"budgetType":"DAILY","budget":25.50},"startDate":"2026-10-10",' +
        '"dynamicBidding":{"strategy":"LEGACY_FOR_SALES","placementBidding":[]}}' +
        ']}',
    );
  });

  it('schickt Product Ads für Vendoren mit ASIN und Targets mit erweiterten Produkten und Kategorien', async () => {
    const deps = setup();
    const productAds = capture('/sp/productAds', succeedAll('productAds', 'adId', 301n));
    const targets = capture('/sp/targets', succeedAll('targetingClauses', 'targetId', 501n));
    const created = new Map([
      ['c', '1001'],
      ['g', '1101'],
    ]);

    const outcome = await create(
      deps,
      [
        {
          ref: 'pa',
          entity: 'productAd',
          campaignRef: 'c',
          adGroupRef: 'g',
          sku: null,
          asin: 'B0VENDOR01',
          state: 'ENABLED',
        },
        {
          ref: 'exp',
          entity: 'target',
          campaignRef: 'c',
          adGroupRef: 'g',
          expression: { type: 'ASIN_EXPANDED_FROM', value: 'B0ZIEL0001' },
          bid: '0.40',
          state: 'ENABLED',
        },
        {
          ref: 'cat',
          entity: 'target',
          campaignRef: 'c',
          adGroupRef: 'g',
          expression: { type: 'ASIN_CATEGORY_SAME_AS', value: '12345678901' },
          bid: null,
          state: 'ENABLED',
        },
      ],
      created,
    );

    expect(productAds[0]!.body).toBe(
      '{"productAds":[{"campaignId":"1001","adGroupId":"1101","asin":"B0VENDOR01","state":"ENABLED"}]}',
    );
    expect(targets[0]!.body).toBe(
      '{"targetingClauses":[' +
        '{"campaignId":"1001","adGroupId":"1101","expressionType":"MANUAL",' +
        '"expression":[{"type":"ASIN_EXPANDED_FROM","value":"B0ZIEL0001"}],"state":"ENABLED","bid":0.40},' +
        '{"campaignId":"1001","adGroupId":"1101","expressionType":"MANUAL",' +
        '"expression":[{"type":"ASIN_CATEGORY_SAME_AS","value":"12345678901"}],"state":"ENABLED"}]}',
    );
    expect(outcome.results.map((r) => r.status)).toEqual(['applied', 'applied', 'applied']);
  });

  it('teilt mehr als 1000 Anlagen eines Endpunkts auf mehrere Anfragen auf', async () => {
    const deps = setup();
    const seen = capture('/sp/keywords', succeedAll('keywords', 'keywordId', 1n));
    const operations = Array.from({ length: 1001 }, (_, i) => ({
      ...keyword(`k${i}`, 'c', 'g'),
      keywordText: `keyword ${i}`,
    })) as AmazonAdsCreateOperation[];

    const outcome = await create(
      deps,
      operations,
      new Map([
        ['c', '1001'],
        ['g', '1101'],
      ]),
    );

    expect(seen).toHaveLength(2);
    expect(outcome.results.every((r) => r.status === 'applied')).toBe(true);
  });
});

describe('applySpCreates: Teilfehler und Kaskade', () => {
  it('lehnt Kinder einer gescheiterten oder unklaren Elternanlage ab, ohne sie zu senden', async () => {
    const deps = setup();
    capture(
      '/sp/campaigns',
      () =>
        '{"campaigns":{"success":[{"index":0,"campaignId":"1001"}],"error":[' +
        '{"index":1,"errors":[{"errorType":"duplicateValueError","errorValue":{"duplicateValueError":' +
        '{"reason":"DUPLICATE_VALUE","message":"Name already exists"}}}]},' +
        '{"index":2,"errors":[{"errorType":"internalServerError","errorValue":{"internalServerError":' +
        '{"reason":"INTERNAL_ERROR","message":"boom"}}}]}]}}',
    );
    const adGroups = capture('/sp/adGroups', succeedAll('adGroups', 'adGroupId', 1101n));
    const keywords = capture('/sp/keywords', succeedAll('keywords', 'keywordId', 401n));

    const outcome = await create(deps, [
      campaign('ok'),
      campaign('dup'),
      campaign('boom'),
      adGroup('g-ok', 'ok'),
      adGroup('g-dup', 'dup'),
      adGroup('g-boom', 'boom'),
      keyword('k-ok', 'ok', 'g-ok'),
      keyword('k-dup', 'dup', 'g-dup'),
    ]);

    expect(outcome.results).toEqual([
      { ref: 'ok', status: 'applied', amazonId: '1001' },
      { ref: 'dup', status: 'failed', code: 'DUPLICATE_VALUE', message: 'Name already exists' },
      { ref: 'boom', status: 'unknown', message: 'boom' },
      { ref: 'g-ok', status: 'applied', amazonId: '1101' },
      { ref: 'g-dup', status: 'failed', code: 'PARENT_NOT_CREATED', message: expect.any(String) },
      { ref: 'g-boom', status: 'failed', code: 'PARENT_NOT_CREATED', message: expect.any(String) },
      { ref: 'k-ok', status: 'applied', amazonId: '401' },
      { ref: 'k-dup', status: 'failed', code: 'PARENT_NOT_CREATED', message: expect.any(String) },
    ]);
    expect(JSON.parse(adGroups[0]!.body)).toEqual({
      adGroups: [{ campaignId: '1001', name: 'Gruppe g-ok', defaultBid: 0.75, state: 'ENABLED' }],
    });
    expect(keywords).toHaveLength(1);
    expect(outcome.throttled).toBe(false);
  });

  it('meldet eine Anlage ohne ID in der Antwort als unklar und legt ihre Kinder nicht an', async () => {
    const deps = setup();
    capture('/sp/campaigns', () => '{"campaigns":{"success":[{"index":0}]}}');
    const adGroups = capture('/sp/adGroups', () => '{}');

    const outcome = await create(deps, [campaign('c'), adGroup('g', 'c')]);

    expect(outcome.results).toEqual([
      { ref: 'c', status: 'unknown', message: expect.any(String) },
      { ref: 'g', status: 'failed', code: 'PARENT_NOT_CREATED', message: expect.any(String) },
    ]);
    expect(adGroups).toHaveLength(0);
  });

  it('lässt nach einem abgelehnten Aufruf (400) die Anlagen ohne diese Eltern weiterlaufen', async () => {
    const deps = setup();
    capture('/sp/adGroups', () =>
      HttpResponse.json({ code: 'INVALID_ARGUMENT', message: 'bad request' }, { status: 400 }),
    );
    const keywords = capture('/sp/keywords', succeedAll('keywords', 'keywordId', 401n));

    const outcome = await create(
      deps,
      [adGroup('g', 'c'), keyword('k-neu', 'c', 'g'), keyword('k-alt', 'c', 'g-alt')],
      new Map([
        ['c', '1001'],
        ['g-alt', '1102'],
      ]),
    );

    expect(outcome.results).toEqual([
      {
        ref: 'g',
        status: 'failed',
        code: 'INVALID_ARGUMENT',
        message: expect.stringContaining('bad'),
      },
      { ref: 'k-neu', status: 'failed', code: 'PARENT_NOT_CREATED', message: expect.any(String) },
      { ref: 'k-alt', status: 'applied', amazonId: '401' },
    ]);
    expect(JSON.parse(keywords[0]!.body).keywords[0]).toMatchObject({ adGroupId: '1102' });
  });
});

describe('applySpCreates: Drosselung und Ausfälle', () => {
  it('hört bei anhaltender Drosselung auf und setzt mit `created` fort, ohne Angelegtes erneut zu senden', async () => {
    const deps = setup();
    capture('/sp/campaigns', succeedAll('campaigns', 'campaignId', 1001n));
    let throttle = true;
    const adGroups = capture('/sp/adGroups', (body) =>
      throttle
        ? HttpResponse.json(
            { code: 'THROTTLED', message: 'Too many requests' },
            { status: 429, headers: { 'Retry-After': '120' } },
          )
        : succeedAll('adGroups', 'adGroupId', 1101n)(body),
    );
    const keywords = capture('/sp/keywords', succeedAll('keywords', 'keywordId', 401n));
    const operations = [campaign('c'), adGroup('g', 'c'), keyword('k', 'c', 'g')];

    const first = await create(deps, operations);

    expect(first).toEqual({
      results: [
        { ref: 'c', status: 'applied', amazonId: '1001' },
        { ref: 'g', status: 'unsent' },
        { ref: 'k', status: 'unsent' },
      ],
      throttled: true,
      retryAfterMs: 120_000,
    });
    expect(keywords).toHaveLength(0);

    // Späterer Lauf (frischer Client: Der alte hält das Profil für die Wartezeit von Amazon zurück).
    throttle = false;
    calls.length = 0;
    const second = await create(setup(), operations, new Map([['c', '1001']]));

    expect(calls).toEqual(['/sp/adGroups', '/sp/keywords']);
    expect(JSON.parse(adGroups.at(-1)!.body).adGroups[0]).toMatchObject({ campaignId: '1001' });
    expect(second).toEqual({
      results: [
        { ref: 'c', status: 'applied', amazonId: '1001' },
        { ref: 'g', status: 'applied', amazonId: '1101' },
        { ref: 'k', status: 'applied', amazonId: '401' },
      ],
      throttled: false,
      retryAfterMs: null,
    });
  });

  it('lässt Kinder eines je Eintrag gedrosselten Elternteils `unsent`', async () => {
    const deps = setup();
    capture(
      '/sp/campaigns',
      () =>
        '{"campaigns":{"success":[{"index":0,"campaignId":"1001"}],"error":[{"index":1,"errors":[' +
        '{"errorType":"throttledError","errorValue":{"throttledError":{"reason":"THROTTLED","message":"slow"}}}]}]}}',
    );
    const adGroups = capture('/sp/adGroups', succeedAll('adGroups', 'adGroupId', 1101n));

    const outcome = await create(deps, [
      campaign('a'),
      campaign('b'),
      adGroup('ga', 'a'),
      adGroup('gb', 'b'),
    ]);

    expect(outcome.results).toEqual([
      { ref: 'a', status: 'applied', amazonId: '1001' },
      { ref: 'b', status: 'unsent' },
      { ref: 'ga', status: 'applied', amazonId: '1101' },
      { ref: 'gb', status: 'unsent' },
    ]);
    expect(outcome.throttled).toBe(true);
    expect(JSON.parse(adGroups[0]!.body).adGroups).toHaveLength(1);
  });

  it('wiederholt Anlagen nach 5xx nicht und meldet sie als `unknown`; Kinder scheitern', async () => {
    const deps = setup();
    const seen = capture('/sp/campaigns', () =>
      HttpResponse.json({ code: 'INTERNAL_ERROR', message: 'boom' }, { status: 500 }),
    );
    const adGroups = capture('/sp/adGroups', () => '{}');

    const outcome = await create(deps, [campaign('c'), adGroup('g', 'c')]);

    expect(seen).toHaveLength(1);
    expect(adGroups).toHaveLength(0);
    expect(outcome.results).toEqual([
      { ref: 'c', status: 'unknown', message: expect.any(String) },
      { ref: 'g', status: 'failed', code: 'PARENT_NOT_CREATED', message: expect.any(String) },
    ]);
  });

  it('bricht bei 401 ab und nennt im Fehler, was schon angelegt ist', async () => {
    const deps = setup();
    capture('/sp/campaigns', succeedAll('campaigns', 'campaignId', 1001n));
    capture('/sp/adGroups', () =>
      HttpResponse.json({ code: 'UNAUTHORIZED', message: 'no access' }, { status: 401 }),
    );

    const error = await create(deps, [
      campaign('c'),
      adGroup('g', 'c'),
      keyword('k', 'c', 'g'),
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(AmazonAdsWriteAbortedError);
    const aborted = error as AmazonAdsWriteAbortedError;
    expect(aborted.cause).toBeInstanceOf(AmazonAdsHttpError);
    expect(aborted.cause).toMatchObject({ status: 401 });
    expect(aborted.results).toEqual([
      { ref: 'c', status: 'applied', amazonId: '1001' },
      { ref: 'g', status: 'unsent' },
      { ref: 'k', status: 'unsent' },
    ]);
  });
});

describe('applySpCreates: Eingaben', () => {
  it('lehnt ungültige Werte je Eintrag ab, ohne Amazon zu fragen, und sendet die übrigen', async () => {
    const deps = setup();
    const campaigns = capture('/sp/campaigns', succeedAll('campaigns', 'campaignId', 1001n));
    const keywords = capture('/sp/keywords', succeedAll('keywords', 'keywordId', 401n));
    const created = new Map([
      ['c0', '1000'],
      ['g0', '1100'],
    ]);

    const outcome = await create(
      deps,
      [
        campaign('budget', { dailyBudget: '25,50' }),
        campaign('datum', { startDate: '2026-02-30' }),
        campaign('datum-form', { startDate: '10.10.2026' }),
        campaign('name', { name: '   ' }),
        campaign('prozent', { placements: [{ placement: 'PLACEMENT_TOP', percentage: '901' }] }),
        campaign('prozent-bruch', {
          placements: [{ placement: 'PLACEMENT_TOP', percentage: '12.5' }],
        }),
        campaign('platzierung', { placements: [{ placement: 'TOP', percentage: '10' }] }),
        campaign('portfolio', { amazonPortfolioId: 'abc' }),
        campaign('gut'),
        { ...keyword('kw-leer', 'c0', 'g0'), keywordText: ' ' } as AmazonAdsCreateOperation,
        { ...keyword('kw-gebot', 'c0', 'g0'), bid: '-1' } as AmazonAdsCreateOperation,
        {
          ref: 'asin',
          entity: 'negativeTarget',
          campaignRef: 'c0',
          adGroupRef: 'g0',
          asin: 'b0klein001',
        },
        {
          ref: 'asin-kurz',
          entity: 'target',
          campaignRef: 'c0',
          adGroupRef: 'g0',
          expression: { type: 'ASIN_SAME_AS', value: 'B0KURZ' },
          bid: null,
          state: 'ENABLED',
        },
        {
          ref: 'kategorie',
          entity: 'target',
          campaignRef: 'c0',
          adGroupRef: 'g0',
          expression: { type: 'ASIN_CATEGORY_SAME_AS', value: 'Schuhe' },
          bid: null,
          state: 'ENABLED',
        },
        {
          ref: 'ad-leer',
          entity: 'productAd',
          campaignRef: 'c0',
          adGroupRef: 'g0',
          sku: null,
          asin: null,
          state: 'ENABLED',
        },
        {
          ref: 'ad-beides',
          entity: 'productAd',
          campaignRef: 'c0',
          adGroupRef: 'g0',
          sku: 'SKU-1',
          asin: 'B0VENDOR01',
          state: 'ENABLED',
        },
        keyword('kw-gut', 'c0', 'g0'),
      ],
      created,
    );

    const failed = outcome.results.filter((r) => r.status === 'failed').map((r) => r.ref);
    expect(failed).toEqual([
      'budget',
      'datum',
      'datum-form',
      'name',
      'prozent',
      'prozent-bruch',
      'platzierung',
      'portfolio',
      'kw-leer',
      'kw-gebot',
      'asin',
      'asin-kurz',
      'kategorie',
      'ad-leer',
      'ad-beides',
    ]);
    for (const result of outcome.results) {
      if (result.status === 'failed') expect(result.code).toBe('INVALID_VALUE');
    }
    expect(JSON.parse(campaigns[0]!.body).campaigns).toHaveLength(1);
    expect(JSON.parse(keywords[0]!.body).keywords).toHaveLength(1);
  });

  it('lehnt unbekannte oder unpassende Eltern-refs als ungültig ab; ihre Kinder scheitern mit', async () => {
    const deps = setup();
    capture('/sp/campaigns', succeedAll('campaigns', 'campaignId', 1001n));
    const adGroups = capture('/sp/adGroups', succeedAll('adGroups', 'adGroupId', 1101n));
    capture('/sp/keywords', succeedAll('keywords', 'keywordId', 401n));

    const outcome = await create(deps, [
      campaign('c'),
      campaign('c2'),
      adGroup('g', 'c'),
      adGroup('g-fremd', 'gibt-es-nicht'),
      // Eltern-ref zeigt auf eine Ad Group statt auf eine Kampagne.
      adGroup('g-falsch', 'g'),
      { ...adGroup('g-gebot', 'c'), defaultBid: 'teuer' } as AmazonAdsCreateOperation,
      keyword('k-waise', 'c', 'g-gebot'),
      // Ad Group gehört zu einer anderen Kampagne.
      keyword('k-kreuz', 'c2', 'g'),
      keyword('k', 'c', 'g'),
    ]);

    expect(outcome.results).toEqual([
      { ref: 'c', status: 'applied', amazonId: '1001' },
      { ref: 'c2', status: 'applied', amazonId: '1002' },
      { ref: 'g', status: 'applied', amazonId: '1101' },
      { ref: 'g-fremd', status: 'failed', code: 'INVALID_VALUE', message: expect.any(String) },
      { ref: 'g-falsch', status: 'failed', code: 'INVALID_VALUE', message: expect.any(String) },
      { ref: 'g-gebot', status: 'failed', code: 'INVALID_VALUE', message: expect.any(String) },
      { ref: 'k-waise', status: 'failed', code: 'PARENT_NOT_CREATED', message: expect.any(String) },
      { ref: 'k-kreuz', status: 'failed', code: 'INVALID_VALUE', message: expect.any(String) },
      { ref: 'k', status: 'applied', amazonId: '401' },
    ]);
    expect(JSON.parse(adGroups[0]!.body).adGroups).toHaveLength(1);
  });

  it('lehnt eine doppelte ref ab', async () => {
    const deps = setup();
    capture('/sp/campaigns', succeedAll('campaigns', 'campaignId', 1001n));

    const outcome = await create(deps, [campaign('c'), campaign('c')]);

    expect(outcome.results).toEqual([
      { ref: 'c', status: 'applied', amazonId: '1001' },
      { ref: 'c', status: 'failed', code: 'DUPLICATE_OPERATION', message: expect.any(String) },
    ]);
  });

  it('liefert für Einträge aus `created` die bekannte ID und für eine leere Liste nichts, ohne Amazon zu fragen', async () => {
    const deps = setup();

    const outcome = await create(
      deps,
      [campaign('c'), adGroup('g', 'c')],
      new Map([
        ['c', '1001'],
        ['g', '1101'],
      ]),
    );
    const empty = await create(deps, []);

    expect(outcome.results).toEqual([
      { ref: 'c', status: 'applied', amazonId: '1001' },
      { ref: 'g', status: 'applied', amazonId: '1101' },
    ]);
    expect(empty).toEqual({ results: [], throttled: false, retryAfterMs: null });
    expect(calls).toEqual([]);
  });
});
