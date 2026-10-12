import { gzipSync } from 'node:zlib';
import type { AmazonAdsRegion } from '@profitbash/amazon-ads';
import { createAmazonSpClient, type AmazonSpClient, type AmazonSpClientOptions } from './client';
import { spMarketplaceFor } from './marketplaces';
import { AMAZON_SP_REGIONS } from './regions';

/**
 * Mock-Anbieter (`AMAZON_SP_USE_MOCK=true`): der echte Client, dessen `fetch` LwA, die Sellers- und die
 * Reports-API sowie den Download im Prozess beantwortet. Kein Aufruf verlässt den Rechner. Alle Daten
 * sind erfunden (ADR 001: keine echten Kundendaten im Repo).
 */

/** Diesen Refresh-Token nimmt der Mock an; jeder andere gilt als widerrufen (`invalid_grant`). */
export const MOCK_AMAZON_SP_REFRESH_TOKEN = 'Atzr|mock-sp-refresh';
export const MOCK_AMAZON_SP_SELLER_ID = 'A1MOCKSELLER01';

const ACCESS_TOKEN = 'Atza|mock-sp-access';
const ORDER_REPORT_TYPES = [
  'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
  'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
];

/** [Marktplatz-ID, Domain, nimmt teil] */
const PARTICIPATIONS: Record<AmazonAdsRegion, Array<[string, string, boolean]>> = {
  eu: [
    ['A1PA6795UKMFR9', 'www.amazon.de', true],
    ['A13V1IB3VIYZZH', 'www.amazon.fr', true],
    ['A1F83G8C2ARO7P', 'www.amazon.co.uk', false],
  ],
  na: [['ATVPDKIKX0DER', 'www.amazon.com', true]],
  fe: [],
};

export interface MockAmazonSpSimulation {
  /** Uhr des Mocks (Tests). Standard `Date.now`. */
  now?: () => number;
  /** So lange sind Berichte in Arbeit. Standard 5 s. */
  processingMs?: number;
}

export interface MockAmazonSpClientOptions extends Pick<AmazonSpClientOptions, 'store' | 'logger'> {
  /** Standard: feste Mock-Zugangsdaten. */
  credentialsFor?: AmazonSpClientOptions['credentialsFor'];
  simulation?: MockAmazonSpSimulation;
  http?: Pick<NonNullable<AmazonSpClientOptions['http']>, 'sleep'>;
}

export function createMockAmazonSpClient(options: MockAmazonSpClientOptions): AmazonSpClient {
  return createAmazonSpClient({
    credentialsFor:
      options.credentialsFor ??
      (async () => ({ clientId: 'amzn1.application-oa2-client.mock-sp', clientSecret: 'mock' })),
    store: options.store,
    ...(options.logger && { logger: options.logger }),
    http: { ...options.http, fetch: createMockFetch(options.simulation ?? {}) },
  });
}

/** Auftrag im Mock. Die ID kodiert ihn ganz, damit auch ein neu gestarteter Prozess ihn abholen kann. */
interface MockReport {
  type: string;
  marketplaceIds: string[];
  start: string;
  end: string;
  createdAt: number;
}

const encode = (report: MockReport) => Buffer.from(JSON.stringify(report)).toString('base64url');

function decode(id: string): MockReport | null {
  try {
    return JSON.parse(Buffer.from(id, 'base64url').toString('utf8')) as MockReport;
  } catch {
    return null;
  }
}

const spError = (status: number, code: string, message: string) =>
  Response.json({ errors: [{ code, message }] }, { status });

function createMockFetch(simulation: MockAmazonSpSimulation): typeof fetch {
  const now = simulation.now ?? Date.now;
  const processingMs = simulation.processingMs ?? 5_000;
  const hosts = new Map<string, AmazonAdsRegion>();
  for (const [region, endpoints] of Object.entries(AMAZON_SP_REGIONS)) {
    hosts.set(new URL(endpoints.apiHost).host, region as AmazonAdsRegion);
  }

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/auth/o2/token') {
      const form = new URLSearchParams(await request.text());
      if (form.get('refresh_token') !== MOCK_AMAZON_SP_REFRESH_TOKEN) {
        return Response.json({ error: 'invalid_grant' }, { status: 400 });
      }
      return Response.json({
        access_token: ACCESS_TOKEN,
        refresh_token: MOCK_AMAZON_SP_REFRESH_TOKEN,
        token_type: 'bearer',
        expires_in: 3600,
      });
    }

    const download = /^\/mock-sp-report\/(.+)$/.exec(url.pathname);
    if (request.method === 'GET' && download && url.host.endsWith('.amazonaws.com')) {
      const report = decode(download[1]!);
      if (!report) return new Response(null, { status: 404 });
      // Cp1252 wie bei EU-Berichten (für die erfundenen Texte deckungsgleich mit Latin-1).
      return new Response(
        new Uint8Array(gzipSync(Buffer.from(mockOrderReport(report), 'latin1'))),
        {
          headers: { 'Content-Type': 'text/plain;charset=Cp1252' },
        },
      );
    }

    const region = hosts.get(url.host);
    if (!region) return spError(404, 'NotFound', 'Im Mock nicht vorhanden.');
    if (request.headers.get('x-amz-access-token') !== ACCESS_TOKEN) {
      return spError(403, 'Unauthorized', 'Access to requested resource is denied.');
    }

    if (request.method === 'GET' && url.pathname === '/sellers/v1/marketplaceParticipations') {
      return Response.json({
        payload: PARTICIPATIONS[region].map(([id, domainName, isParticipating]) => {
          const marketplace = spMarketplaceFor(id)!;
          return {
            marketplace: {
              id,
              name: domainName.replace('www.amazon', 'Amazon'),
              countryCode: marketplace.countryCode,
              defaultCurrencyCode: marketplace.currencyCode,
              defaultLanguageCode: 'de_DE',
              domainName,
            },
            participation: { isParticipating, hasSuspendedListings: false },
            storeName: 'Mock Seller',
          };
        }),
      });
    }

    if (request.method === 'POST' && url.pathname === '/reports/2021-06-30/reports') {
      const body = (await request.json()) as Partial<{
        reportType: string;
        marketplaceIds: string[];
        dataStartTime: string;
        dataEndTime: string;
      }>;
      if (
        !body.reportType ||
        !ORDER_REPORT_TYPES.includes(body.reportType) ||
        !body.marketplaceIds?.length ||
        !body.dataStartTime ||
        !body.dataEndTime
      ) {
        return spError(400, 'InvalidInput', 'Im Mock nicht unterstützt.');
      }
      const reportId = encode({
        type: body.reportType,
        marketplaceIds: body.marketplaceIds,
        start: body.dataStartTime,
        end: body.dataEndTime,
        createdAt: now(),
      });
      return Response.json({ reportId }, { status: 202 });
    }

    const reportMatch = /^\/reports\/2021-06-30\/reports\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && reportMatch) {
      const reportId = decodeURIComponent(reportMatch[1]!);
      const report = decode(reportId);
      if (!report) return spError(404, 'NotFound', 'Report not found.');
      const done = now() - report.createdAt >= processingMs;
      return Response.json({
        reportId,
        reportType: report.type,
        createdTime: new Date(report.createdAt).toISOString(),
        processingStatus: done ? 'DONE' : 'IN_PROGRESS',
        ...(done && { reportDocumentId: reportId }),
      });
    }

    const documentMatch = /^\/reports\/2021-06-30\/documents\/([^/]+)$/.exec(url.pathname);
    if (request.method === 'GET' && documentMatch) {
      const id = decodeURIComponent(documentMatch[1]!);
      if (!decode(id)) return spError(404, 'NotFound', 'Document not found.');
      return Response.json({
        reportDocumentId: id,
        url: `https://mock-sp-reports.s3.eu-west-1.amazonaws.com/mock-sp-report/${id}?X-Amz-Signature=mock`,
        compressionAlgorithm: 'GZIP',
      });
    }

    return spError(404, 'NotFound', 'Im Mock nicht vorhanden.');
  };
}

const ORDER_COLUMNS = [
  'amazon-order-id',
  'merchant-order-id',
  'purchase-date',
  'last-updated-date',
  'order-status',
  'fulfillment-channel',
  'sales-channel',
  'order-channel',
  'ship-service-level',
  'product-name',
  'sku',
  'asin',
  'item-status',
  'quantity',
  'currency',
  'item-price',
  'item-tax',
  'shipping-price',
  'shipping-tax',
  'gift-wrap-price',
  'gift-wrap-tax',
  'item-promotion-discount',
  'ship-promotion-discount',
  'ship-city',
  'ship-state',
  'ship-postal-code',
  'ship-country',
  'promotion-ids',
  'is-business-order',
  'purchase-order-number',
  'price-designation',
] as const;

const PRODUCTS = [
  {
    sku: 'NW-TEE-001',
    asin: 'B0MOCK0001',
    name: 'Nordwind T-Shirt Größe M',
    price: '24.99',
    tax: '3.99',
  },
  { sku: 'NW-CAP-002', asin: 'B0MOCK0002', name: 'Nordwind Kappe', price: '14.90', tax: '2.38' },
] as const;

const DAY_MS = 86_400_000;

/**
 * Erfundene Bestellpositionen je Tag und Marktplatz im Zeitraum `[start, end)`, immer gleich für dieselbe
 * Anfrage: täglich zwei versendete Bestellungen (eine um 22:30 UTC, in Berlin schon der nächste Tag),
 * dazu regelmäßig eine stornierte, eine selbst versandte ohne Preis („Pending“) und eine B2B-Bestellung.
 */
function mockOrderReport(report: MockReport): string {
  const lines = [ORDER_COLUMNS.join('\t')];
  const end = Date.parse(report.end);
  for (const marketplaceId of report.marketplaceIds) {
    const marketplace = spMarketplaceFor(marketplaceId);
    const domainName = Object.values(PARTICIPATIONS)
      .flat()
      .find(([id]) => id === marketplaceId)?.[1];
    if (!marketplace || !domainName) continue;
    const domain = domainName.replace('www.amazon', 'Amazon');
    for (
      let day = Math.floor(Date.parse(report.start) / DAY_MS) * DAY_MS;
      day < end;
      day += DAY_MS
    ) {
      const n = day / DAY_MS;
      const orders: Array<
        Partial<Record<(typeof ORDER_COLUMNS)[number], string>> & { hour: number }
      > = [
        { hour: 9, 'order-status': 'Shipped' },
        { hour: 22.5, 'order-status': 'Shipped', quantity: '2', 'item-promotion-discount': '2.50' },
        ...(n % 3 === 0
          ? [{ hour: 11, 'order-status': 'Cancelled', 'item-status': 'Cancelled' }]
          : []),
        ...(n % 2 === 0
          ? [
              {
                hour: 13,
                'order-status': 'Pending',
                'fulfillment-channel': 'Merchant',
                'item-price': '',
                'item-tax': '',
              },
            ]
          : []),
        ...(n % 4 === 0
          ? [{ hour: 15, 'order-status': 'Shipped', 'is-business-order': 'true' }]
          : []),
      ];
      orders.forEach(({ hour, ...overrides }, index) => {
        const product = PRODUCTS[(n + index) % PRODUCTS.length]!;
        const purchased = new Date(day + hour * 3_600_000).toISOString().replace('.000Z', '+00:00');
        const row: Record<(typeof ORDER_COLUMNS)[number], string> = {
          'amazon-order-id': `302-${String(n).padStart(7, '0')}-${String(index + 1).padStart(7, '0')}`,
          'merchant-order-id': '',
          'purchase-date': purchased,
          'last-updated-date': purchased,
          'order-status': 'Shipped',
          'fulfillment-channel': 'Amazon',
          'sales-channel': domain,
          'order-channel': '',
          'ship-service-level': 'Standard',
          'product-name': product.name,
          sku: product.sku,
          asin: product.asin,
          'item-status': 'Shipped',
          quantity: '1',
          currency: marketplace.currencyCode,
          'item-price': product.price,
          'item-tax': product.tax,
          'shipping-price': '',
          'shipping-tax': '',
          'gift-wrap-price': '',
          'gift-wrap-tax': '',
          'item-promotion-discount': '',
          'ship-promotion-discount': '',
          'ship-city': 'Musterstadt',
          'ship-state': '',
          'ship-postal-code': '12345',
          'ship-country': marketplace.countryCode === 'UK' ? 'GB' : marketplace.countryCode,
          'promotion-ids': '',
          'is-business-order': 'false',
          'purchase-order-number': '',
          'price-designation': '',
          ...overrides,
        };
        lines.push(ORDER_COLUMNS.map((column) => row[column]).join('\t'));
      });
    }
  }
  return `${lines.join('\n')}\n`;
}
