import {
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
  type RefreshTokenStore,
} from '@profitbash/amazon-ads';
import { describe, expect, it } from 'vitest';
import { createMockAmazonSpClient, MOCK_AMAZON_SP_REFRESH_TOKEN } from './mock';

const connection = { id: 'conn-1', organizationId: 'org-1', region: 'eu' as const };
const ORDERS = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL';

const storeWith = (refreshToken: string): RefreshTokenStore => ({
  async withRefreshToken(_connection, refresh) {
    return (await refresh(refreshToken)).result;
  },
});

function setup(refreshToken: string = MOCK_AMAZON_SP_REFRESH_TOKEN) {
  let time = Date.UTC(2026, 9, 12, 8, 0, 0);
  const options = {
    store: storeWith(refreshToken),
    simulation: { now: () => time, processingMs: 5_000 },
    http: { sleep: async () => {} },
  };
  return {
    client: createMockAmazonSpClient(options),
    restart: () => createMockAmazonSpClient(options),
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('createMockAmazonSpClient', () => {
  it('liefert die Marktplatz-Teilnahmen eines erfundenen Verkäufers je Region', async () => {
    const { client } = setup();

    const eu = await client.getMarketplaceParticipations(connection);
    const na = await client.getMarketplaceParticipations({ ...connection, id: 'c2', region: 'na' });

    expect(eu.map((p) => [p.countryCode, p.currencyCode, p.isParticipating])).toEqual([
      ['DE', 'EUR', true],
      ['FR', 'EUR', true],
      ['UK', 'GBP', false],
    ]);
    expect(na.map((p) => p.marketplaceId)).toEqual(['ATVPDKIKX0DER']);
  });

  it('lehnt fremde Refresh-Tokens wie Amazon mit invalid_grant ab', async () => {
    const { client } = setup('irgendwas');
    await expect(client.getMarketplaceParticipations(connection)).rejects.toBeInstanceOf(
      AmazonAdsReauthRequiredError,
    );
  });

  it('führt einen Bestellbericht von der Anfrage bis zur Datei, auch über einen Neustart', async () => {
    const { client, restart, advance } = setup();
    const { reportId } = await client.createReport(connection, {
      reportType: ORDERS,
      marketplaceIds: ['A1PA6795UKMFR9'],
      dataStartTime: '2026-10-01T00:00:00Z',
      dataEndTime: '2026-10-03T00:00:00Z',
    });
    expect(await client.getReport(connection, { reportId })).toEqual({ status: 'IN_PROGRESS' });

    advance(5_000);
    const afterRestart = restart();
    const status = await afterRestart.getReport(connection, { reportId });
    if (status.status !== 'DONE') throw new Error(`unerwarteter Status ${status.status}`);
    const document = await afterRestart.getReportDocument(connection, status);
    const file = await afterRestart.downloadReportDocument(document, { maxBytes: 1024 * 1024 });
    if (file.status !== 'ok') throw new Error('Datei fehlt');

    const [header, ...lines] = file.text.trimEnd().split('\n');
    const columns = header!.split('\t');
    expect(columns).toEqual(
      expect.arrayContaining([
        'amazon-order-id',
        'purchase-date',
        'last-updated-date',
        'order-status',
        'fulfillment-channel',
        'sales-channel',
        'sku',
        'asin',
        'quantity',
        'currency',
        'item-price',
        'item-tax',
        'item-promotion-discount',
        'is-business-order',
        // Adressteile liefert Amazon mit; der Import (7.3) muss sie verwerfen.
        'ship-city',
        'ship-postal-code',
      ]),
    );
    const rows = lines.map((line) =>
      Object.fromEntries(line.split('\t').map((v, i) => [columns[i], v])),
    );
    expect(rows.length).toBeGreaterThan(3);
    expect(
      rows.every((row) => row['sales-channel'] === 'Amazon.de' && row.currency === 'EUR'),
    ).toBe(true);
    expect(rows.every((row) => /^2026-10-0[12]T/.test(row['purchase-date']!))).toBe(true);
    expect(new Set(rows.map((row) => row['order-status']))).toEqual(
      new Set(['Shipped', 'Cancelled', 'Pending']),
    );
    // Umlaute überstehen den Zeichensatz der Datei (Cp1252 wie bei EU-Berichten).
    expect(file.text).toContain('Größe');
    // Dieselbe Anfrage liefert dieselben Daten (Upsert im Import bleibt prüfbar).
    const again = await afterRestart.downloadReportDocument(document, { maxBytes: 1024 * 1024 });
    expect(again).toEqual(file);
  });

  it('lehnt unbekannte Berichtstypen mit 400 ab', async () => {
    const { client } = setup();
    await expect(
      client.createReport(connection, {
        reportType: 'GET_SOMETHING_ELSE',
        marketplaceIds: ['A1PA6795UKMFR9'],
        dataStartTime: '2026-10-01T00:00:00Z',
        dataEndTime: '2026-10-03T00:00:00Z',
      }),
    ).rejects.toMatchObject({ status: 400 } satisfies Partial<AmazonAdsHttpError>);
  });
});
