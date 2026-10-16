import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { amazonSpAccounts, amazonSpDailySales, amazonSpOrderItems, connections } from './schema';
import {
  createSpReportRequests,
  deleteFinishedSpReportRequestsBefore,
  importSpOrderItems,
  lastSpReportRequestAt,
  listActiveSpConnections,
  listDueSpReportRequests,
  listSpConnectionsWithDueReports,
  listSpOrderSyncAccounts,
  nextSpReportPollAt,
  updateSpReportRequest,
  type SpOrderItemInput,
} from './sp-orders';
import { createTestConnection, createTestOrganization } from './test-fixtures';
import { createTestDatabase, type TestDatabase } from './testing';

let testDb: TestDatabase;
const ids = { org: '', connection: '', adsConnection: '', de: '', fr: '' };
const NOW = new Date('2026-10-16T06:00:00Z');
const ORDERS = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL';

beforeAll(async () => {
  testDb = await createTestDatabase();
  const { db } = testDb;
  ids.org = await createTestOrganization(db, 'muuv');
  ids.connection = await createTestConnection(db, ids.org, 'A1SELLER', 'amazon_sp');
  ids.adsConnection = await createTestConnection(db, ids.org, 'ads-1');
  const account = (marketplaceId: string, countryCode: string) => ({
    organizationId: ids.org,
    connectionId: ids.connection,
    amazonSellerId: 'A1SELLER',
    marketplaceId,
    storeName: 'Nordwind',
    countryCode,
    currencyCode: 'EUR',
    timezone: 'Europe/Berlin',
  });
  const rows = await db
    .insert(amazonSpAccounts)
    .values([account('A1PA6795UKMFR9', 'DE'), account('A13V1IB3VIYZZH', 'FR')])
    .returning({ id: amazonSpAccounts.id });
  [ids.de, ids.fr] = rows.map((row) => row.id) as [string, string];
});

afterAll(async () => {
  await testDb.close();
});

const item = (overrides: Partial<SpOrderItemInput> = {}): SpOrderItemInput => ({
  amazonOrderId: '302-1',
  sku: 'NW-TEE-001',
  asin: 'B0MOCK0001',
  purchasedAt: new Date('2026-10-01T09:00:00Z'),
  purchaseDate: '2026-10-01',
  lastUpdatedAt: new Date('2026-10-01T10:00:00Z'),
  orderStatus: 'Shipped',
  itemStatus: 'Shipped',
  fulfillmentChannel: 'Amazon',
  salesChannel: 'Amazon.de',
  quantity: 1,
  currency: 'EUR',
  itemPrice: '24.99',
  itemTax: '3.99',
  shippingPrice: null,
  shippingTax: null,
  giftWrapPrice: null,
  giftWrapTax: null,
  itemPromotionDiscount: null,
  shipPromotionDiscount: null,
  isBusinessOrder: false,
  ...overrides,
});

const importItems = (items: SpOrderItemInput[], sellerAccountId = ids.de) =>
  testDb.db.transaction((tx) =>
    importSpOrderItems(tx, { organizationId: ids.org, sellerAccountId, items }),
  );

const daily = (sellerAccountId = ids.de) =>
  testDb.db
    .select()
    .from(amazonSpDailySales)
    .where(eq(amazonSpDailySales.sellerAccountId, sellerAccountId))
    .orderBy(amazonSpDailySales.date, amazonSpDailySales.sku);

describe('Bestellpositionen und Tageswerte', () => {
  beforeEach(async () => {
    await testDb.db.delete(amazonSpDailySales);
    await testDb.db.delete(amazonSpOrderItems);
  });

  it('verdichtet Positionen zu Tageswerten je SKU, ohne Stornierte, mit Stück ohne Preis', async () => {
    await importItems([
      item(),
      item({ amazonOrderId: '302-2', quantity: 2, itemPrice: '49.98', itemTax: '7.98' }),
      item({ amazonOrderId: '302-3', orderStatus: 'Cancelled', itemStatus: 'Cancelled' }),
      item({ amazonOrderId: '302-4', orderStatus: 'Pending', itemPrice: null, itemTax: null }),
      item({ amazonOrderId: '302-5', sku: 'NW-CAP-002', purchaseDate: '2026-10-02' }),
    ]);

    expect(await daily()).toEqual([
      expect.objectContaining({
        date: '2026-10-01',
        sku: 'NW-TEE-001',
        asin: 'B0MOCK0001',
        currency: 'EUR',
        units: 4,
        orders: 3,
        unpricedUnits: 1,
        itemPrice: '74.97',
        itemTax: '11.97',
        shippingPrice: '0',
        itemPromotionDiscount: '0',
      }),
      expect.objectContaining({ date: '2026-10-02', sku: 'NW-CAP-002', units: 1, orders: 1 }),
    ]);
  });

  it('übernimmt eine spätere Änderung (Storno) und berechnet den Tag neu', async () => {
    await importItems([item(), item({ amazonOrderId: '302-2' })]);
    await importItems([
      item({
        orderStatus: 'Cancelled',
        itemStatus: 'Cancelled',
        lastUpdatedAt: new Date('2026-10-02T08:00:00Z'),
      }),
    ]);

    expect(await daily()).toEqual([expect.objectContaining({ units: 1, orders: 1 })]);
  });

  it('überschreibt keine neuere Position mit einem älteren Bericht', async () => {
    await importItems([
      item({ orderStatus: 'Cancelled', lastUpdatedAt: new Date('2026-10-03T08:00:00Z') }),
    ]);
    await importItems([item()]);

    const [row] = await testDb.db.select().from(amazonSpOrderItems);
    expect(row!.orderStatus).toBe('Cancelled');
    expect(await daily()).toEqual([]);
  });

  it('entfernt den Tageswert, wenn am Tag nichts mehr zählt', async () => {
    await importItems([item()]);
    await importItems([
      item({ orderStatus: 'Cancelled', lastUpdatedAt: new Date('2026-10-05T00:00:00Z') }),
    ]);

    expect(await daily()).toEqual([]);
  });

  it('trennt die Konten', async () => {
    await importItems([item()], ids.de);
    await importItems([item({ quantity: 5 })], ids.fr);

    expect((await daily(ids.de))[0]!.units).toBe(1);
    expect((await daily(ids.fr))[0]!.units).toBe(5);
  });
});

describe('Berichts-Aufträge', () => {
  it('legt Aufträge an, ohne offene doppelt anzulegen, und merkt die Historie', async () => {
    const { db } = testDb;
    const requests = [
      { reportType: ORDERS, dataStart: new Date('2026-09-16T00:00:00Z'), dataEnd: NOW },
    ];
    const first = await createSpReportRequests(db, {
      organizationId: ids.org,
      sellerAccountId: ids.de,
      requests,
      markHistory: true,
      now: NOW,
    });
    const second = await createSpReportRequests(db, {
      organizationId: ids.org,
      sellerAccountId: ids.de,
      requests,
      markHistory: false,
      now: NOW,
    });

    expect(first).toBe(1);
    expect(second).toBe(0);
    const [account] = await db
      .select()
      .from(amazonSpAccounts)
      .where(eq(amazonSpAccounts.id, ids.de));
    expect(account!.ordersHistoryRequestedAt).toEqual(NOW);
    expect(
      await lastSpReportRequestAt(db, { sellerAccountId: ids.de, reportType: ORDERS }),
    ).toEqual(expect.any(Date));
    expect(await lastSpReportRequestAt(db, { sellerAccountId: ids.fr, reportType: ORDERS })).toBe(
      null,
    );
  });

  it('listet fällige Aufträge der Connection und plant den nächsten Poll', async () => {
    const { db } = testDb;
    const ref = { organizationId: ids.org, connectionId: ids.connection };
    const due = await listDueSpReportRequests(db, { ...ref, now: NOW, limit: 10 });
    expect(due).toHaveLength(1);
    expect(await listSpConnectionsWithDueReports(db, NOW)).toEqual([
      { id: ids.connection, organizationId: ids.org },
    ]);

    const later = new Date(NOW.getTime() + 60_000);
    await updateSpReportRequest(db, due[0]!, { status: 'requested', nextPollAt: later });
    expect(await listDueSpReportRequests(db, { ...ref, now: NOW, limit: 10 })).toEqual([]);
    expect(await nextSpReportPollAt(db, ref)).toEqual(later);

    await updateSpReportRequest(db, due[0]!, { status: 'imported', nextPollAt: null });
    expect(await nextSpReportPollAt(db, ref)).toBe(null);
    expect(await listSpConnectionsWithDueReports(db, later)).toEqual([]);
    expect(await deleteFinishedSpReportRequestsBefore(db, new Date(Date.now() + 60_000))).toBe(1);
  });

  it('nennt aktive SP-Connections (ohne Ads) und deren Konten ohne entfernte', async () => {
    const { db } = testDb;
    await db
      .update(amazonSpAccounts)
      .set({ removedAt: NOW })
      .where(eq(amazonSpAccounts.id, ids.fr));

    expect(await listActiveSpConnections(db)).toEqual([
      { id: ids.connection, organizationId: ids.org },
    ]);
    expect(
      (
        await listSpOrderSyncAccounts(db, { organizationId: ids.org, connectionId: ids.connection })
      ).map((account) => account.id),
    ).toEqual([ids.de]);

    await db
      .update(connections)
      .set({ status: 'reauth_required' })
      .where(and(eq(connections.id, ids.connection)));
    expect(await listActiveSpConnections(db)).toEqual([]);
  });
});
