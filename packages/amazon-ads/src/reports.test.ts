import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RefreshTokenStore } from './access-token';
import { createAmazonAdsClient } from './client';
import { AmazonAdsDuplicateReportError, AmazonAdsHttpError } from './errors';
import { createRequestMeter } from './http';
import { parseJsonLossless } from './json';
import type { LogEntry } from './logger';
import {
  createReportRowSchema,
  REPORT_DEFINITIONS,
  REPORT_TYPES_BY_AD_PRODUCT,
  reportTypesFor,
  type AmazonAdsReportType,
} from './reports';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const API = 'https://advertising-api-eu.amazon.com';
const CREATE_TYPE = 'application/vnd.createasyncreportrequest.v3+json';
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

const range = { startDate: '2026-08-28', endDate: '2026-09-26' };

describe('Report-Katalog', () => {
  it('kennt für SP fünf Ebenen; Ad Groups über spCampaigns mit groupBy adGroup', () => {
    expect(REPORT_TYPES_BY_AD_PRODUCT.SPONSORED_PRODUCTS).toEqual([
      'spCampaigns',
      'spAdGroups',
      'spTargeting',
      'spAdvertisedProduct',
      'spSearchTerm',
    ]);
    expect(REPORT_DEFINITIONS.spAdGroups).toMatchObject({
      reportTypeId: 'spCampaigns',
      groupBy: ['campaign', 'adGroup'],
      level: 'adGroup',
    });
    expect(REPORT_DEFINITIONS.spTargeting.level).toBe('target');
    expect(REPORT_DEFINITIONS.spAdvertisedProduct.level).toBe('productAd');
    expect(REPORT_DEFINITIONS.spSearchTerm.level).toBe('searchTerm');
    expect(REPORT_DEFINITIONS.spSearchTerm.retentionDays).toBe(65);
    expect(reportTypesFor('SPONSORED_PRODUCTS')).toBe(
      REPORT_TYPES_BY_AD_PRODUCT.SPONSORED_PRODUCTS,
    );
    expect(reportTypesFor('SPONSORED_DISPLAY')).toEqual([]);
    expect(reportTypesFor('toString')).toEqual([]);
  });

  it('fordert je Report Tag, IDs und die Attribution nach F7 an (7/14 Tage, same SKU)', () => {
    for (const reportType of REPORT_TYPES_BY_AD_PRODUCT.SPONSORED_PRODUCTS) {
      const { columns } = REPORT_DEFINITIONS[reportType];
      expect(columns).toEqual(
        expect.arrayContaining([
          'date',
          'campaignId',
          'impressions',
          'clicks',
          'cost',
          'sales7d',
          'sales14d',
          'attributedSalesSameSku7d',
          'attributedSalesSameSku14d',
          'purchases7d',
          'purchases14d',
          'purchasesSameSku7d',
          'purchasesSameSku14d',
          'unitsSoldClicks7d',
          'unitsSoldClicks14d',
          'unitsSoldSameSku7d',
          'unitsSoldSameSku14d',
        ]),
      );
      expect(columns.some((c) => /(1|30)d$/.test(c))).toBe(false);
    }
  });
});

describe('requestReport', () => {
  it('sendet die Konfiguration mit Content-Type v3 und liefert die Report-ID', async () => {
    const seen: unknown[] = [];
    server.use(
      http.post(`${API}/reporting/reports`, async ({ request }) => {
        seen.push({
          body: await request.json(),
          contentType: request.headers.get('content-type'),
          scope: request.headers.get('amazon-advertising-api-scope'),
        });
        return HttpResponse.json({ reportId: 'rep-1', status: 'PENDING' });
      }),
    );
    const { client } = setup();
    const meter = createRequestMeter();
    const result = await client.requestReport(
      connection,
      { amazonProfileId: PROFILE_ID, reportType: 'spAdGroups', ...range },
      { meter },
    );
    expect(result).toEqual({ reportId: 'rep-1' });
    expect(seen).toEqual([
      {
        body: {
          name: 'profitbash spAdGroups 2026-08-28..2026-09-26',
          startDate: '2026-08-28',
          endDate: '2026-09-26',
          configuration: {
            adProduct: 'SPONSORED_PRODUCTS',
            reportTypeId: 'spCampaigns',
            groupBy: ['campaign', 'adGroup'],
            columns: REPORT_DEFINITIONS.spAdGroups.columns,
            timeUnit: 'DAILY',
            format: 'GZIP_JSON',
          },
        },
        contentType: CREATE_TYPE,
        scope: PROFILE_ID,
      },
    ]);
    expect(meter.requests).toBe(1);
  });

  it('meldet 425 als eigenen Fehler und übernimmt die ID des laufenden Reports aus detail', async () => {
    server.use(
      http.post(`${API}/reporting/reports`, () =>
        HttpResponse.json(
          {
            code: '425',
            detail: 'The Request is a duplicate of : 0f3a9c2e-1b2d-4e5f-8a9b-0c1d2e3f4a5b',
          },
          { status: 425 },
        ),
      ),
    );
    const { client } = setup();
    const error = await client
      .requestReport(connection, {
        amazonProfileId: PROFILE_ID,
        reportType: 'spCampaigns',
        ...range,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsDuplicateReportError);
    expect(error).toBeInstanceOf(AmazonAdsHttpError);
    expect(error).toMatchObject({
      status: 425,
      duplicateOfReportId: '0f3a9c2e-1b2d-4e5f-8a9b-0c1d2e3f4a5b',
    });
    expect((error as Error).message).toContain('läuft bereits');
  });

  it('meldet 425 ohne erkennbare ID mit duplicateOfReportId null', async () => {
    server.use(
      http.post(`${API}/reporting/reports`, () =>
        HttpResponse.json({ code: '425', detail: 'Too early' }, { status: 425 }),
      ),
    );
    const { client } = setup();
    const error = await client
      .requestReport(connection, {
        amazonProfileId: PROFILE_ID,
        reportType: 'spCampaigns',
        ...range,
      })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AmazonAdsDuplicateReportError);
    expect(error).toMatchObject({ duplicateOfReportId: null });
  });

  it('wiederholt 429 beim Anfordern', async () => {
    let calls = 0;
    server.use(
      http.post(`${API}/reporting/reports`, () => {
        calls += 1;
        return calls === 1
          ? HttpResponse.json({ code: '429' }, { status: 429 })
          : HttpResponse.json({ reportId: 'rep-2', status: 'PENDING' });
      }),
    );
    const { client } = setup();
    await expect(
      client.requestReport(connection, {
        amazonProfileId: PROFILE_ID,
        reportType: 'spCampaigns',
        ...range,
      }),
    ).resolves.toEqual({ reportId: 'rep-2' });
  });

  it('lehnt Zeiträume über 31 Tage ab, ohne Amazon aufzurufen', async () => {
    const { client } = setup();
    await expect(
      client.requestReport(connection, {
        amazonProfileId: PROFILE_ID,
        reportType: 'spCampaigns',
        startDate: '2026-08-01',
        endDate: '2026-09-01',
      }),
    ).rejects.toThrow(/31 Tage/);
  });
});

describe('getReport', () => {
  function statusEndpoint(body: Record<string, unknown>, status = 200) {
    server.use(
      http.get(`${API}/reporting/reports/:reportId`, ({ params }) => {
        expect(params.reportId).toBe('rep-1');
        return HttpResponse.json(body, { status });
      }),
    );
  }
  const ref = { amazonProfileId: PROFILE_ID, reportId: 'rep-1' };

  it.each(['PENDING', 'PROCESSING'] as const)('meldet %s', async (status) => {
    statusEndpoint({ reportId: 'rep-1', status });
    const { client } = setup();
    await expect(client.getReport(connection, ref)).resolves.toEqual({ status });
  });

  it('liefert bei COMPLETED die URL', async () => {
    const url = 'https://offline-report-storage-eu-west-1-prod.s3.amazonaws.com/r.json.gz?sig=1';
    statusEndpoint({ reportId: 'rep-1', status: 'COMPLETED', url, fileSize: 1234.0 });
    const { client } = setup();
    await expect(client.getReport(connection, ref)).resolves.toEqual({ status: 'COMPLETED', url });
  });

  it.each(['FAILED', 'FAILURE'])('meldet %s als FAILURE mit Grund', async (status) => {
    statusEndpoint({ reportId: 'rep-1', status, failureReason: 'Internal error' });
    const { client } = setup();
    await expect(client.getReport(connection, ref)).resolves.toEqual({
      status: 'FAILURE',
      failureReason: 'Internal error',
    });
  });

  it('meldet 404 als NOT_FOUND', async () => {
    statusEndpoint({ code: '404', detail: 'not found' }, 404);
    const { client } = setup();
    await expect(client.getReport(connection, ref)).resolves.toEqual({ status: 'NOT_FOUND' });
  });
});

function parseRows(reportType: AmazonAdsReportType, text: string) {
  const schema = createReportRowSchema(reportType);
  return (parseJsonLossless(text, { decimals: 'string' }) as unknown[]).map((row) =>
    schema.safeParse(row),
  );
}

const METRICS = `"impressions": 2216, "clicks": 13, "cost": 14.50,
  "sales7d": 1234567.89, "sales14d": 0.1, "attributedSalesSameSku7d": 0.005, "attributedSalesSameSku14d": 0,
  "purchases7d": 2, "purchases14d": 3, "purchasesSameSku7d": 1, "purchasesSameSku14d": 1,
  "unitsSoldClicks7d": 2, "unitsSoldClicks14d": 4, "unitsSoldSameSku7d": 1, "unitsSoldSameSku14d": 1`;

const VALUES = {
  impressions: 2216,
  clicks: 13,
  cost: '14.5',
  sales7d: '1234567.89',
  sales14d: '0.1',
  salesSameSku7d: '0.005',
  salesSameSku14d: '0',
  purchases7d: 2,
  purchases14d: 3,
  purchasesSameSku7d: 1,
  purchasesSameSku14d: 1,
  units7d: 2,
  units14d: 4,
  unitsSameSku7d: 1,
  unitsSameSku14d: 1,
  extra: {},
};

describe('Zeilen-Schemas der Reports', () => {
  it('spCampaigns → Kampagnen-Kennzahl mit exakten Beträgen und großer ID', () => {
    const [result] = parseRows(
      'spCampaigns',
      `[{"date": "2026-09-25", "campaignId": 9007199254740993001, "campaignName": "Kampagne A", ${METRICS}}]`,
    );
    expect(result?.data).toEqual({
      date: '2026-09-25',
      amazonCampaignId: '9007199254740993001',
      campaignName: 'Kampagne A',
      ...VALUES,
    });
  });

  it('spAdGroups → Ad-Group-Kennzahl', () => {
    const [result] = parseRows(
      'spAdGroups',
      `[{"date": "2026-09-25", "campaignId": 1, "campaignName": "K", "adGroupId": 2, "adGroupName": "AG", ${METRICS}}]`,
    );
    expect(result?.data).toEqual({
      date: '2026-09-25',
      amazonCampaignId: '1',
      campaignName: 'K',
      amazonAdGroupId: '2',
      adGroupName: 'AG',
      ...VALUES,
    });
  });

  it('spTargeting → Target-Kennzahl (keywordId ist die Target-ID)', () => {
    const [result] = parseRows(
      'spTargeting',
      `[{"date": "2026-09-25", "campaignId": 1, "campaignName": "K", "adGroupId": 2, "adGroupName": "AG",
         "keywordId": 9007199254740993011, "keyword": "laufschuhe", "matchType": "EXACT", ${METRICS}}]`,
    );
    expect(result?.data).toEqual({
      date: '2026-09-25',
      amazonCampaignId: '1',
      campaignName: 'K',
      amazonAdGroupId: '2',
      adGroupName: 'AG',
      amazonTargetId: '9007199254740993011',
      ...VALUES,
    });
  });

  it('spAdvertisedProduct → Product-Ad-Kennzahl mit ASIN und SKU (Vendor ohne SKU)', () => {
    const results = parseRows(
      'spAdvertisedProduct',
      `[{"date": "2026-09-25", "campaignId": 1, "adGroupId": 2, "adId": 3, "advertisedAsin": "B000TEST01",
         "advertisedSku": "SKU-1", ${METRICS}},
        {"date": "2026-09-25", "campaignId": 1, "adGroupId": 2, "adId": 4, "advertisedAsin": "B000TEST02", ${METRICS}}]`,
    );
    expect(results.map((r) => r.data)).toMatchObject([
      { amazonAdId: '3', amazonAdGroupId: '2', asin: 'B000TEST01', sku: 'SKU-1' },
      { amazonAdId: '4', asin: 'B000TEST02', sku: null },
    ]);
  });

  it('spSearchTerm → Suchbegriff-Kennzahl bezogen auf das Target', () => {
    const [result] = parseRows(
      'spSearchTerm',
      `[{"date": "2026-09-25", "campaignId": 1, "adGroupId": 2, "keywordId": 11, "searchTerm": "laufschuhe herren", ${METRICS}}]`,
    );
    expect(result?.data).toMatchObject({
      amazonTargetId: '11',
      amazonAdGroupId: '2',
      searchTerm: 'laufschuhe herren',
      cost: '14.5',
    });
  });

  it('lässt fehlende Attributionswerte leer (null), nicht 0', () => {
    const [result] = parseRows(
      'spCampaigns',
      '[{"date": "2026-09-25", "campaignId": 1, "impressions": 5, "clicks": 0, "cost": 0}]',
    );
    expect(result?.data).toMatchObject({
      cost: '0',
      sales7d: null,
      purchases14d: null,
      units7d: null,
    });
  });

  it('lehnt Beträge als gebrochene number, fehlende IDs und kaputte Daten ab', () => {
    const schema = createReportRowSchema('spCampaigns');
    const base = { date: '2026-09-25', campaignId: '1', impressions: 1, clicks: 1, cost: '1.5' };
    expect(schema.safeParse(base).success).toBe(true);
    expect(schema.safeParse({ ...base, cost: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ ...base, campaignId: undefined }).success).toBe(false);
    expect(schema.safeParse({ ...base, date: '25.09.2026' }).success).toBe(false);
    expect(schema.safeParse({ ...base, clicks: -1 }).success).toBe(false);
  });
});
