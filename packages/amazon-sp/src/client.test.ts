import { gzipSync } from 'node:zlib';
import {
  AmazonAdsHttpError,
  AmazonAdsResponseError,
  createRequestMeter,
  type LogEntry,
  type RefreshTokenStore,
} from '@profitbash/amazon-ads';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAmazonSpClient } from './client';
import { AmazonSpRoleMissingError } from './errors';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const TOKEN_URL = 'https://api.amazon.com/auth/o2/token';
const API = 'https://sellingpartnerapi-eu.amazon.com';
const DOC_URL =
  'https://tortuga-prod-eu.s3-eu-west-1.amazonaws.com/doc-1?X-Amz-Signature=SECRET-SIG';
const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };

const store: RefreshTokenStore = {
  async withRefreshToken(_connection, refresh) {
    const { result } = await refresh('Atzr|stored-refresh');
    return result;
  },
};

function setup() {
  const logs: LogEntry[] = [];
  const sleeps: number[] = [];
  const client = createAmazonSpClient({
    credentialsFor: async (ref) => ({
      clientId: `client-of-${ref.id}`,
      clientSecret: 'SECRET-CLIENT',
    }),
    store,
    logger: (entry) => logs.push(entry),
    http: {
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      now: () => Date.UTC(2026, 9, 12, 8, 30, 0),
    },
  });
  return { client, logs, sleeps };
}

/** LWA liefert nummerierte Access-Tokens und merkt sich die Formulare. */
function tokenEndpoint() {
  const forms: URLSearchParams[] = [];
  server.use(
    http.post(TOKEN_URL, async ({ request }) => {
      forms.push(new URLSearchParams(await request.text()));
      return HttpResponse.json({
        access_token: `Atza|access-${forms.length}`,
        refresh_token: 'Atzr|stored-refresh',
        token_type: 'bearer',
        expires_in: 3600,
      });
    }),
  );
  return forms;
}

const PARTICIPATIONS = {
  payload: [
    {
      marketplace: {
        id: 'A1PA6795UKMFR9',
        name: 'Amazon.de',
        countryCode: 'DE',
        defaultCurrencyCode: 'EUR',
        defaultLanguageCode: 'de_DE',
        domainName: 'www.amazon.de',
      },
      participation: { isParticipating: true, hasSuspendedListings: false },
      storeName: 'Nordwind',
    },
    {
      marketplace: {
        id: 'A1F83G8C2ARO7P',
        name: 'Amazon.co.uk',
        countryCode: 'UK',
        defaultCurrencyCode: 'GBP',
        defaultLanguageCode: 'en_GB',
        domainName: 'www.amazon.co.uk',
      },
      participation: { isParticipating: false, hasSuspendedListings: false },
      storeName: 'Nordwind',
    },
  ],
};

describe('createAmazonSpClient', () => {
  it('ruft die SP-API mit dem LwA-Token im Header x-amz-access-token auf, ohne AWS-Signatur', async () => {
    const forms = tokenEndpoint();
    let headers = new Headers();
    server.use(
      http.get(`${API}/sellers/v1/marketplaceParticipations`, ({ request }) => {
        headers = request.headers;
        return HttpResponse.json(PARTICIPATIONS);
      }),
    );
    const { client, logs } = setup();

    const result = await client.getMarketplaceParticipations(connection);

    expect(result).toEqual([
      {
        marketplaceId: 'A1PA6795UKMFR9',
        countryCode: 'DE',
        currencyCode: 'EUR',
        domainName: 'www.amazon.de',
        storeName: 'Nordwind',
        isParticipating: true,
      },
      {
        marketplaceId: 'A1F83G8C2ARO7P',
        countryCode: 'UK',
        currencyCode: 'GBP',
        domainName: 'www.amazon.co.uk',
        storeName: 'Nordwind',
        isParticipating: false,
      },
    ]);
    expect(headers.get('x-amz-access-token')).toBe('Atza|access-1');
    expect(headers.get('x-amz-date')).toBe('20261012T083000Z');
    expect(headers.get('user-agent')).toMatch(/^ProfitBash\//);
    expect(headers.get('authorization')).toBeNull();
    // Zugangsdaten der App kommen je Connection (F1), nie aus dem Log.
    expect(forms[0]?.get('client_id')).toBe('client-of-conn-1');
    expect(forms[0]?.get('grant_type')).toBe('refresh_token');
    expect(JSON.stringify(logs)).not.toMatch(/Atz[ar]\||SECRET/);
  });

  it('holt nach einem 403 einmal ein frisches Token und meldet danach SP_ROLE_MISSING', async () => {
    const forms = tokenEndpoint();
    let calls = 0;
    server.use(
      http.get(`${API}/sellers/v1/marketplaceParticipations`, () => {
        calls += 1;
        return HttpResponse.json(
          {
            errors: [{ code: 'Unauthorized', message: 'Access to requested resource is denied.' }],
          },
          { status: 403 },
        );
      }),
    );
    const { client } = setup();
    const meter = createRequestMeter();

    const error = await client.getMarketplaceParticipations(connection, { meter }).catch((e) => e);

    expect(error).toBeInstanceOf(AmazonSpRoleMissingError);
    expect(error).toBeInstanceOf(AmazonAdsHttpError);
    expect(error).toMatchObject({ code: 'SP_ROLE_MISSING', status: 403 });
    expect(calls).toBe(2);
    expect(forms).toHaveLength(2);
    expect(meter).toMatchObject({ requests: 2, retries: 1 });
  });

  it('verteilt Anfragen derselben Operation nach der dokumentierten Rate', async () => {
    tokenEndpoint();
    server.use(
      http.post(`${API}/reports/2021-06-30/reports`, () =>
        HttpResponse.json({ reportId: 'ID323' }, { status: 202 }),
      ),
    );
    const { client, sleeps } = setup();
    const input = {
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
      marketplaceIds: ['A1PA6795UKMFR9'],
      dataStartTime: '2026-09-12T00:00:00Z',
      dataEndTime: '2026-10-12T00:00:00Z',
    };

    await client.createReport(connection, input);
    await client.createReport(connection, input);

    // createReport: 0,0167 Anfragen/s, also rund eine Minute Abstand.
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThan(59_000);
  });
});

describe('Reports-API 2021-06-30', () => {
  it('legt einen Bericht an und schickt Typ, Marktplätze und Zeitraum', async () => {
    tokenEndpoint();
    let body: unknown;
    server.use(
      http.post(`${API}/reports/2021-06-30/reports`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json({ reportId: 'ID323' }, { status: 202 });
      }),
    );
    const { client } = setup();

    const result = await client.createReport(connection, {
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
      marketplaceIds: ['A1PA6795UKMFR9'],
      dataStartTime: '2026-09-12T00:00:00Z',
      dataEndTime: '2026-10-12T00:00:00Z',
    });

    expect(result).toEqual({ reportId: 'ID323' });
    expect(body).toEqual({
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
      marketplaceIds: ['A1PA6795UKMFR9'],
      dataStartTime: '2026-09-12T00:00:00Z',
      dataEndTime: '2026-10-12T00:00:00Z',
    });
  });

  it('bildet den Status ab: in Arbeit, fertig mit Dokument, gescheitert, abgebrochen, unbekannt', async () => {
    tokenEndpoint();
    const report = (processingStatus: string, extra: object = {}) => ({
      reportId: 'ID323',
      reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
      createdTime: '2026-10-12T08:00:00+00:00',
      processingStatus,
      ...extra,
    });
    const replies: Response[] = [
      HttpResponse.json(report('IN_QUEUE')),
      HttpResponse.json(report('DONE', { reportDocumentId: 'DOC-1' })),
      HttpResponse.json(report('FATAL')),
      HttpResponse.json(report('CANCELLED')),
      HttpResponse.json({ errors: [{ code: 'NotFound', message: 'x' }] }, { status: 404 }),
    ];
    server.use(http.get(`${API}/reports/2021-06-30/reports/ID323`, () => replies.shift()!));
    const { client } = setup();
    const get = () => client.getReport(connection, { reportId: 'ID323' });

    expect(await get()).toEqual({ status: 'IN_QUEUE' });
    expect(await get()).toEqual({ status: 'DONE', reportDocumentId: 'DOC-1' });
    expect(await get()).toEqual({ status: 'FATAL' });
    expect(await get()).toEqual({ status: 'CANCELLED' });
    expect(await get()).toEqual({ status: 'NOT_FOUND' });
  });

  it('meldet DONE ohne Dokument als Antwortfehler', async () => {
    tokenEndpoint();
    server.use(
      http.get(`${API}/reports/2021-06-30/reports/ID323`, () =>
        HttpResponse.json({
          reportId: 'ID323',
          reportType: 'X',
          createdTime: '2026-10-12T08:00:00+00:00',
          processingStatus: 'DONE',
        }),
      ),
    );
    const { client } = setup();
    await expect(client.getReport(connection, { reportId: 'ID323' })).rejects.toBeInstanceOf(
      AmazonAdsResponseError,
    );
  });

  it('lädt ein gepacktes Dokument ohne Token und liest es im Zeichensatz der Datei', async () => {
    tokenEndpoint();
    let downloadHeaders = new Headers();
    server.use(
      http.get(`${API}/reports/2021-06-30/documents/DOC-1`, () =>
        HttpResponse.json({
          reportDocumentId: 'DOC-1',
          url: DOC_URL,
          compressionAlgorithm: 'GZIP',
        }),
      ),
      http.get('https://tortuga-prod-eu.s3-eu-west-1.amazonaws.com/doc-1', ({ request }) => {
        downloadHeaders = request.headers;
        // „Größe“ in Windows-1252: ö = 0xF6, ß = 0xDF.
        const bytes = Buffer.from([0x73, 0x6b, 0x75, 0x09, 0x47, 0x72, 0xf6, 0xdf, 0x65, 0x0a]);
        return new HttpResponse(new Uint8Array(gzipSync(bytes)), {
          headers: { 'Content-Type': 'text/plain;charset=Cp1252' },
        });
      }),
    );
    const { client, logs } = setup();

    const document = await client.getReportDocument(connection, { reportDocumentId: 'DOC-1' });
    const file = await client.downloadReportDocument(document, { maxBytes: 1024 });

    expect(document).toEqual({ url: DOC_URL, compressionAlgorithm: 'GZIP' });
    expect(file).toEqual({ status: 'ok', text: 'sku\tGröße\n' });
    expect(downloadHeaders.get('x-amz-access-token')).toBeNull();
    expect(JSON.stringify(logs)).not.toContain('SECRET-SIG');
  });

  it('liest ein ungepacktes Dokument ohne Zeichensatz als UTF-8 und meldet abgelaufene URLs', async () => {
    let status = 200;
    server.use(
      http.get('https://tortuga-prod-eu.s3-eu-west-1.amazonaws.com/doc-1', () =>
        status === 200 ? HttpResponse.text('sku\tGröße\n') : new HttpResponse(null, { status }),
      ),
    );
    const { client } = setup();
    const document = { url: DOC_URL, compressionAlgorithm: null };

    expect(await client.downloadReportDocument(document, { maxBytes: 1024 })).toEqual({
      status: 'ok',
      text: 'sku\tGröße\n',
    });
    status = 403;
    expect(await client.downloadReportDocument(document, { maxBytes: 1024 })).toEqual({
      status: 'expired',
    });
  });

  it('lädt nur von S3-Hosts unter amazonaws.com', async () => {
    const { client } = setup();
    await expect(
      client.downloadReportDocument(
        { url: 'https://evil.example/doc', compressionAlgorithm: null },
        { maxBytes: 1024 },
      ),
    ).rejects.toBeInstanceOf(AmazonAdsResponseError);
  });
});
