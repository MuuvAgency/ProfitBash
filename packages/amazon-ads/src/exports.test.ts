import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient } from './client';
import { AmazonAdsHttpError, AmazonAdsResponseError } from './errors';
import { createExportRowSchema, EXPORT_CONTENT_TYPES, type AmazonAdsExportType } from './exports';
import { createRequestMeter } from './http';
import { parseJsonLossless } from './json';
import type { LogEntry } from './logger';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

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
    http.post('https://api.amazon.co.uk/auth/o2/token', () =>
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

describe('requestExport', () => {
  it.each([
    ['campaigns', '/campaigns/export', 'application/vnd.campaignsexport.v1+json'],
    ['adGroups', '/adGroups/export', 'application/vnd.adgroupsexport.v1+json'],
    ['targets', '/targets/export', 'application/vnd.targetsexport.v1+json'],
    ['ads', '/ads/export', 'application/vnd.adsexport.v1+json'],
  ] as const)(
    'fordert %s mit eigenem Pfad und Content-Type an, inkl. archivierter Entities',
    async (exportType, path, contentType) => {
      const seen: unknown[] = [];
      server.use(
        http.post(`${API}${path}`, async ({ request }) => {
          seen.push({
            body: await request.json(),
            contentType: request.headers.get('content-type'),
            accept: request.headers.get('accept'),
            scope: request.headers.get('amazon-advertising-api-scope'),
          });
          return HttpResponse.json(
            { exportId: 'exp-1', status: 'PROCESSING' },
            { status: 202, headers: { 'Content-Type': contentType } },
          );
        }),
      );
      const { client } = setup();
      const meter = createRequestMeter();
      const result = await client.requestExport(
        connection,
        { amazonProfileId: PROFILE_ID, exportType, adProduct: 'SPONSORED_PRODUCTS' },
        { meter },
      );
      expect(result).toEqual({ exportId: 'exp-1' });
      expect(EXPORT_CONTENT_TYPES[exportType]).toBe(contentType);
      expect(seen).toEqual([
        {
          body: {
            adProductFilter: ['SPONSORED_PRODUCTS'],
            stateFilter: ['ENABLED', 'PAUSED', 'ARCHIVED'],
          },
          contentType,
          accept: contentType,
          scope: PROFILE_ID,
        },
      ]);
      expect(meter.requests).toBe(1);
    },
  );

  it('wiederholt 429 beim Anfordern', async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/ads/export`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: 'THROTTLED' }, { status: 429 })
          : HttpResponse.json({ exportId: 'exp-2', status: 'PROCESSING' }, { status: 202 });
      }),
    );
    const { client } = setup();
    await expect(
      client.requestExport(connection, {
        amazonProfileId: PROFILE_ID,
        exportType: 'ads',
        adProduct: 'SPONSORED_PRODUCTS',
      }),
    ).resolves.toEqual({ exportId: 'exp-2' });
  });

  it('gibt Ablehnungen (400) als HTTP-Fehler weiter und wiederholt sie nicht', async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/campaigns/export`, () => {
        calls += 1;
        return HttpResponse.json({ code: 'BAD_REQUEST', message: 'nein' }, { status: 400 });
      }),
    );
    const { client } = setup();
    const error = await client
      .requestExport(connection, {
        amazonProfileId: PROFILE_ID,
        exportType: 'campaigns',
        adProduct: 'SPONSORED_PRODUCTS',
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsHttpError);
    expect(error).toMatchObject({ status: 400 });
    expect(calls).toBe(1);
  });
});

describe('getExport', () => {
  function statusEndpoint(body: Record<string, unknown>, status = 200) {
    const accepts: Array<string | null> = [];
    server.use(
      http.get(`${API}/exports/:exportId`, ({ request, params }) => {
        accepts.push(request.headers.get('accept'));
        expect(params.exportId).toBe('exp/1');
        return HttpResponse.json(body, { status });
      }),
    );
    return accepts;
  }
  const ref = {
    amazonProfileId: PROFILE_ID,
    exportType: 'targets' as const,
    exportId: 'exp/1',
  };

  it('fragt mit dem Accept-Header des Export-Typs ab und meldet PROCESSING', async () => {
    const accepts = statusEndpoint({ exportId: 'exp/1', status: 'PROCESSING' });
    const { client } = setup();
    await expect(client.getExport(connection, ref)).resolves.toEqual({ status: 'PROCESSING' });
    expect(accepts).toEqual(['application/vnd.targetsexport.v1+json']);
  });

  it('behandelt IN_PROGRESS (Schreibweise im Guide) wie PROCESSING', async () => {
    statusEndpoint({ exportId: 'exp/1', status: 'IN_PROGRESS' });
    const { client } = setup();
    await expect(client.getExport(connection, ref)).resolves.toEqual({ status: 'PROCESSING' });
  });

  it('liefert bei COMPLETED die URL', async () => {
    const url = 'https://snapshots-prod-eu-west-1.s3.eu-west-1.amazonaws.com/TARGET/x?sig=1';
    statusEndpoint({ exportId: 'exp/1', status: 'COMPLETED', url, fileSize: 794 });
    const { client } = setup();
    await expect(client.getExport(connection, ref)).resolves.toEqual({ status: 'COMPLETED', url });
  });

  it('meldet FAILED als FAILURE mit Fehlercode und Text', async () => {
    statusEndpoint({
      exportId: 'exp/1',
      status: 'FAILED',
      error: { errorCode: 'TIMED_OUT', message: 'zu groß' },
    });
    const { client } = setup();
    await expect(client.getExport(connection, ref)).resolves.toEqual({
      status: 'FAILURE',
      failureReason: 'TIMED_OUT: zu groß',
    });
  });

  it('wiederholt 429 bei der Status-Abfrage und scheitert laut an einer Antwort ohne Status', async () => {
    let calls = 0;
    server.use(
      http.get(`${API}/exports/:exportId`, () => {
        calls += 1;
        if (calls === 1) return HttpResponse.json({ code: 'THROTTLED' }, { status: 429 });
        return HttpResponse.json(calls === 2 ? { status: 'PROCESSING' } : { exportId: 'x' });
      }),
    );
    const { client } = setup();
    await expect(client.getExport(connection, ref)).resolves.toEqual({ status: 'PROCESSING' });
    await expect(client.getExport(connection, ref)).rejects.toBeInstanceOf(AmazonAdsResponseError);
  });

  it('meldet 404 als NOT_FOUND', async () => {
    statusEndpoint({ code: 'NOT_FOUND', details: 'weg' }, 404);
    const { client } = setup();
    await expect(client.getExport(connection, ref)).resolves.toEqual({ status: 'NOT_FOUND' });
  });

  it('wartet bei einem unbekannten Status weiter und loggt ihn', async () => {
    statusEndpoint({ exportId: 'exp/1', status: 'QUEUED' });
    const { client, logs } = setup();
    await expect(client.getExport(connection, ref)).resolves.toEqual({ status: 'PROCESSING' });
    expect(logs).toContainEqual(
      expect.objectContaining({
        msg: 'amazon_ads.unknown_enum_value',
        operation: 'exports.get',
        field: 'status',
        value: 'QUEUED',
      }),
    );
  });
});

/** Zeilen wie aus `decodeGzipJson` (verlustfrei, Dezimalzahlen als Quelltext). */
function rows(text: string): unknown[] {
  return parseJsonLossless(text, { decimals: 'string' }) as unknown[];
}

function parseRows(exportType: AmazonAdsExportType, text: string, logs: LogEntry[] = []) {
  const schema = createExportRowSchema(exportType, {
    adProduct: 'SPONSORED_PRODUCTS',
    logger: (entry) => logs.push(entry),
  });
  return rows(text).map((row) => schema.safeParse(row));
}

describe('Zeilen-Schemas der Exports', () => {
  it('normalisiert Kampagnen (große IDs, Budget exakt, Gebotsstrategie, archiviert)', () => {
    const [result] = parseRows(
      'campaigns',
      `[{"campaignId": 9007199254740993001, "portfolioId": 9007199254740993123,
         "adProduct": "SPONSORED_PRODUCTS", "name": "Kampagne A", "state": "ARCHIVED",
         "startDate": "2026-01-15", "targetingSettings": "MANUAL",
         "optimization": {"bidStrategy": "SALES_DOWN_ONLY",
                          "placementBidAdjustments": [{"placement": "PLACEMENT_TOP", "percentage": 50}]},
         "budgetCaps": {"recurrenceTimePeriod": "DAILY", "budgetType": "MONETARY",
                        "budgetValue": {"monetaryBudget": {"currencyCode": "EUR", "amount": 25.50, "ruleAmount": 30.125}}},
         "tags": [{"key": "k", "value": "v"}],
         "deliveryStatus": "NOT_DELIVERING", "deliveryReasons": ["CAMPAIGN_ARCHIVED"],
         "lastUpdatedDateTime": "2026-09-20T10:15:00.123Z", "creationDateTime": "2026-01-15T08:00:00Z"}]`,
    );
    expect(result?.success).toBe(true);
    expect(result?.data).toEqual({
      amazonCampaignId: '9007199254740993001',
      amazonPortfolioId: '9007199254740993123',
      adProduct: 'SPONSORED_PRODUCTS',
      name: 'Kampagne A',
      state: 'ARCHIVED',
      targetingType: 'MANUAL',
      budgetAmount: '25.5',
      budgetCurrencyCode: 'EUR',
      budgetType: 'DAILY',
      biddingStrategy: 'SALES_DOWN_ONLY',
      startDate: '2026-01-15',
      endDate: null,
      amazonUpdatedAt: new Date('2026-09-20T10:15:00.123Z'),
      extra: {
        placementBidAdjustments: [{ placement: 'PLACEMENT_TOP', percentage: 50 }],
        budgetRuleAmount: '30.125',
        tags: [{ key: 'k', value: 'v' }],
        deliveryStatus: 'NOT_DELIVERING',
        deliveryReasons: ['CAMPAIGN_ARCHIVED'],
        creationDateTime: '2026-01-15T08:00:00Z',
      },
    });
  });

  it('nimmt den angeforderten Ad-Typ, wenn die Zeile keinen nennt', () => {
    const [result] = parseRows(
      'campaigns',
      '[{"campaignId": "1", "name": "a", "state": "ENABLED"}]',
    );
    expect(result?.data).toMatchObject({ adProduct: 'SPONSORED_PRODUCTS', budgetAmount: null });
  });

  it('lehnt Beträge ab, die schon als number ankommen (Parser-Option fehlt)', () => {
    const schema = createExportRowSchema('adGroups', {
      adProduct: 'SPONSORED_PRODUCTS',
      logger: () => {},
    });
    const result = schema.safeParse({
      adGroupId: '1',
      campaignId: '2',
      name: 'a',
      state: 'ENABLED',
      bid: { defaultBid: 0.75, currencyCode: 'EUR' },
    });
    expect(result.success).toBe(false);
  });

  it('normalisiert Ad Groups mit exaktem Standardgebot', () => {
    const [result] = parseRows(
      'adGroups',
      `[{"adGroupId": 9007199254740993002, "campaignId": 9007199254740993001,
         "adProduct": "SPONSORED_PRODUCTS", "name": "AG 1", "state": "ENABLED",
         "bid": {"defaultBid": 0.005, "currencyCode": "EUR"},
         "lastUpdatedDateTime": "2026-09-20T10:15:00Z"}]`,
    );
    expect(result?.data).toEqual({
      amazonAdGroupId: '9007199254740993002',
      amazonCampaignId: '9007199254740993001',
      adProduct: 'SPONSORED_PRODUCTS',
      name: 'AG 1',
      state: 'ENABLED',
      defaultBid: '0.005',
      defaultBidCurrencyCode: 'EUR',
      amazonUpdatedAt: new Date('2026-09-20T10:15:00Z'),
      extra: {},
    });
  });

  it('trennt Targets und Negatives; Negatives auf Kampagnen- und Ad-Group-Ebene', () => {
    const results = parseRows(
      'targets',
      `[
        {"targetId": 11, "adGroupId": 2, "campaignId": 1, "adProduct": "SPONSORED_PRODUCTS",
         "state": "ENABLED", "negative": false, "targetType": "KEYWORD",
         "bid": {"bid": 1.23456, "currencyCode": "EUR"},
         "targetDetails": {"matchType": "EXACT", "keyword": "laufschuhe", "nativeLanguageLocale": "de_DE"}},
        {"targetId": 12, "adGroupId": 2, "campaignId": 1, "adProduct": "SPONSORED_PRODUCTS",
         "state": "PAUSED", "negative": false, "targetType": "PRODUCT_CATEGORY",
         "targetDetails": {"productCategoryId": "123", "productPriceLessThan": 49.99}},
        {"targetId": 13, "adGroupId": 2, "campaignId": 1, "state": "ENABLED", "negative": false,
         "targetType": "AUTO", "bid": {"bid": 0.5, "currencyCode": "EUR"},
         "targetDetails": {"matchType": "SEARCH_LOOSE_MATCH"}},
        {"targetId": 21, "adGroupId": 2, "campaignId": 1, "state": "ENABLED", "negative": true,
         "targetType": "KEYWORD", "targetDetails": {"matchType": "EXACT", "keyword": "gratis"}},
        {"targetId": 22, "campaignId": 1, "state": "ENABLED", "negative": true,
         "targetType": "PRODUCT", "targetDetails": {"asin": "B000TEST01"}}
      ]`,
    );
    expect(results.every((r) => r.success)).toBe(true);
    const [keyword, category, auto, adGroupNegative, campaignNegative] = results.map((r) => r.data);
    expect(keyword).toEqual({
      kind: 'target',
      target: {
        amazonTargetId: '11',
        amazonCampaignId: '1',
        amazonAdGroupId: '2',
        adProduct: 'SPONSORED_PRODUCTS',
        targetType: 'keyword',
        keywordText: 'laufschuhe',
        matchType: 'EXACT',
        expression: { matchType: 'EXACT', keyword: 'laufschuhe', nativeLanguageLocale: 'de_DE' },
        state: 'ENABLED',
        bid: '1.23456',
        bidCurrencyCode: 'EUR',
        amazonUpdatedAt: null,
        extra: {},
      },
    });
    expect(category).toMatchObject({
      kind: 'target',
      target: {
        targetType: 'category',
        keywordText: null,
        matchType: null,
        bid: null,
        expression: { productCategoryId: '123', productPriceLessThan: '49.99' },
      },
    });
    expect(auto).toMatchObject({ kind: 'target', target: { targetType: 'auto', bid: '0.5' } });
    expect(adGroupNegative).toEqual({
      kind: 'negative',
      target: {
        amazonTargetId: '21',
        level: 'ad_group',
        amazonCampaignId: '1',
        amazonAdGroupId: '2',
        adProduct: 'SPONSORED_PRODUCTS',
        targetType: 'keyword',
        keywordText: 'gratis',
        matchType: 'EXACT',
        expression: { matchType: 'EXACT', keyword: 'gratis' },
        state: 'ENABLED',
        amazonUpdatedAt: null,
        extra: {},
      },
    });
    expect(campaignNegative).toMatchObject({
      kind: 'negative',
      target: { level: 'campaign', amazonCampaignId: '1', amazonAdGroupId: null },
    });
  });

  it('lehnt Targets ohne Kampagne und Ad Group bzw. Kampagnen-Negatives ohne Kampagne ab', () => {
    const results = parseRows(
      'targets',
      `[{"targetId": 1, "state": "ENABLED", "negative": false, "targetType": "KEYWORD"},
        {"targetId": 2, "state": "ENABLED", "negative": true, "targetType": "KEYWORD", "adGroupId": null}]`,
    );
    expect(results.map((r) => r.success)).toEqual([false, false]);
  });

  it('reicht unbekannte Target-Typen klein geschrieben durch und loggt sie einmal', () => {
    const logs: LogEntry[] = [];
    const results = parseRows(
      'targets',
      `[{"targetId": 1, "adGroupId": 2, "campaignId": 3, "state": "ENABLED", "negative": false, "targetType": "HOLOGRAM"},
        {"targetId": 4, "adGroupId": 2, "campaignId": 3, "state": "ENABLED", "negative": false, "targetType": "HOLOGRAM"}]`,
      logs,
    );
    expect(results.map((r) => r.data)).toMatchObject([
      { target: { targetType: 'hologram' } },
      { target: { targetType: 'hologram' } },
    ]);
    expect(logs.filter((l) => l.msg === 'amazon_ads.unknown_enum_value')).toEqual([
      expect.objectContaining({ field: 'targetType', value: 'HOLOGRAM' }),
    ]);
  });

  it('normalisiert Product Ads mit ASIN und SKU bzw. ohne SKU (Vendor)', () => {
    const results = parseRows(
      'ads',
      `[{"adId": 9007199254740993003, "adGroupId": 2, "adProduct": "SPONSORED_PRODUCTS",
         "state": "ENABLED", "adType": "PRODUCT_AD",
         "creative": {"products": [{"productIdType": "ASIN", "productId": "B000TEST01"},
                                   {"productIdType": "SKU", "productId": "SKU-1"}]}},
        {"adId": 5, "adGroupId": 2, "state": "PAUSED", "adType": "PRODUCT_AD",
         "creative": {"products": [{"productIdType": "ASIN", "productId": "B000TEST02"}], "headline": "Hallo"}}]`,
    );
    expect(results.map((r) => r.data)).toEqual([
      {
        amazonAdId: '9007199254740993003',
        amazonAdGroupId: '2',
        amazonCampaignId: null,
        adProduct: 'SPONSORED_PRODUCTS',
        asin: 'B000TEST01',
        sku: 'SKU-1',
        state: 'ENABLED',
        amazonUpdatedAt: null,
        extra: { adType: 'PRODUCT_AD' },
      },
      {
        amazonAdId: '5',
        amazonAdGroupId: '2',
        amazonCampaignId: null,
        adProduct: 'SPONSORED_PRODUCTS',
        asin: 'B000TEST02',
        sku: null,
        state: 'PAUSED',
        amazonUpdatedAt: null,
        extra: { adType: 'PRODUCT_AD', headline: 'Hallo' },
      },
    ]);
  });

  it('verwirft keine Entity, nur weil Felder für extra eine unerwartete Form haben', () => {
    const [campaign] = parseRows(
      'campaigns',
      `[{"campaignId": 1, "name": "a", "state": "ENABLED",
         "deliveryReasons": [{"reason": "X"}], "tags": {"k": "v"},
         "optimization": {"bidStrategy": "LEGACY_FOR_SALES", "placementBidAdjustments": {"placement": "TOP"}}}]`,
    );
    expect(campaign?.success).toBe(true);
    expect(campaign?.data).toMatchObject({
      biddingStrategy: 'LEGACY_FOR_SALES',
      extra: { deliveryReasons: [{ reason: 'X' }], tags: { k: 'v' } },
    });
    const [ad] = parseRows(
      'ads',
      '[{"adId": 1, "adGroupId": 2, "state": "ENABLED", "creative": {"products": "B000TEST01"}}]',
    );
    expect(ad?.success).toBe(true);
    expect(ad?.data).toMatchObject({ asin: null, sku: null });
  });

  it('loggt einmal, wenn ein Keyword-Target keinen Keyword-Text trägt (andere Form im Export)', () => {
    const logs: LogEntry[] = [];
    parseRows(
      'targets',
      `[{"targetId": 1, "adGroupId": 2, "campaignId": 3, "state": "ENABLED", "negative": false,
         "targetType": "KEYWORD", "targetDetails": {"keywordTarget": {"keyword": "x"}}},
        {"targetId": 4, "adGroupId": 2, "campaignId": 3, "state": "ENABLED", "negative": true,
         "targetType": "KEYWORD", "targetDetails": {}}]`,
      logs,
    );
    expect(logs.filter((l) => l.msg === 'amazon_ads.unexpected_shape')).toEqual([
      expect.objectContaining({ operation: 'exports.targets', field: 'targetDetails.keyword' }),
    ]);
  });

  it('loggt unbekannte Ad-Typen in Zeilen', () => {
    const logs: LogEntry[] = [];
    parseRows(
      'adGroups',
      '[{"adGroupId": 1, "campaignId": 2, "adProduct": "SPONSORED_HOLOGRAMS", "name": "a", "state": "ENABLED"}]',
      logs,
    );
    expect(logs).toContainEqual(
      expect.objectContaining({ field: 'adProduct', value: 'SPONSORED_HOLOGRAMS' }),
    );
  });

  it('lehnt Zeilen ohne Pflicht-ID ab', () => {
    const results = parseRows('ads', '[{"adGroupId": 2, "state": "ENABLED"}]');
    expect(results[0]?.success).toBe(false);
  });
});
