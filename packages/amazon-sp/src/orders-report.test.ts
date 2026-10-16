import { describe, expect, it } from 'vitest';
import { parseOrdersReport } from './orders-report';

const COLUMNS = [
  'amazon-order-id',
  'merchant-order-id',
  'purchase-date',
  'last-updated-date',
  'order-status',
  'fulfillment-channel',
  'sales-channel',
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
  'is-business-order',
] as const;

type Row = Partial<Record<(typeof COLUMNS)[number], string>>;

const BASE: Row = {
  'amazon-order-id': '302-0000001-0000001',
  'purchase-date': '2026-10-01T09:00:00+00:00',
  'last-updated-date': '2026-10-02T10:00:00+00:00',
  'order-status': 'Shipped',
  'fulfillment-channel': 'Amazon',
  'sales-channel': 'Amazon.de',
  'product-name': 'Nordwind T-Shirt',
  sku: 'NW-TEE-001',
  asin: 'B0MOCK0001',
  'item-status': 'Shipped',
  quantity: '1',
  currency: 'EUR',
  'item-price': '24.99',
  'item-tax': '3.99',
  'ship-city': 'Musterstadt',
  'ship-state': 'Bayern',
  'ship-postal-code': '12345',
  'ship-country': 'DE',
  'is-business-order': 'false',
};

const file = (...rows: Row[]) =>
  [COLUMNS.join('\t'), ...rows.map((row) => COLUMNS.map((c) => row[c] ?? '').join('\t'))].join(
    '\r\n',
  ) + '\r\n';

const parse = (text: string) => parseOrdersReport(text, { timeZone: 'Europe/Berlin' });

describe('parseOrdersReport', () => {
  it('liest eine Position mit Beträgen als Decimal-Strings und IDs als Text', () => {
    const { items, invalidRowCount } = parse(file(BASE));

    expect(invalidRowCount).toBe(0);
    expect(items).toEqual([
      {
        amazonOrderId: '302-0000001-0000001',
        sku: 'NW-TEE-001',
        asin: 'B0MOCK0001',
        purchasedAt: new Date('2026-10-01T09:00:00Z'),
        purchaseDate: '2026-10-01',
        lastUpdatedAt: new Date('2026-10-02T10:00:00Z'),
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
      },
    ]);
  });

  it('verwirft Adressspalten und Produktnamen (keine Käuferdaten in der DB)', () => {
    const { items } = parse(file(BASE));
    const text = JSON.stringify(items);

    for (const value of ['Musterstadt', 'Bayern', '12345', 'Nordwind T-Shirt']) {
      expect(text).not.toContain(value);
    }
  });

  it('rechnet das Kaufdatum in die Zeitzone des Marktplatzes (22:30 UTC ist in Berlin der nächste Tag)', () => {
    const { items } = parse(file({ ...BASE, 'purchase-date': '2026-10-01T22:30:00+00:00' }));

    expect(items[0]!.purchasedAt).toEqual(new Date('2026-10-01T22:30:00Z'));
    expect(items[0]!.purchaseDate).toBe('2026-10-02');
  });

  it('lässt fehlende Preise leer (selbst versandt, „Pending“) und liest B2B', () => {
    const { items } = parse(
      file({
        ...BASE,
        'order-status': 'Pending',
        'fulfillment-channel': 'Merchant',
        'item-price': '',
        'item-tax': '',
        currency: '',
        'is-business-order': 'true',
      }),
    );

    expect(items[0]).toMatchObject({
      orderStatus: 'Pending',
      fulfillmentChannel: 'Merchant',
      itemPrice: null,
      itemTax: null,
      currency: null,
      isBusinessOrder: true,
    });
  });

  it('fasst doppelte Zeilen derselben Bestellung und SKU zusammen', () => {
    const { items } = parse(
      file(BASE, {
        ...BASE,
        quantity: '2',
        'item-price': '49.98',
        'item-tax': '7.98',
        'item-promotion-discount': '2.50',
        'last-updated-date': '2026-10-03T10:00:00+00:00',
      }),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      quantity: 3,
      itemPrice: '74.97',
      itemTax: '11.97',
      itemPromotionDiscount: '2.5',
      lastUpdatedAt: new Date('2026-10-03T10:00:00Z'),
    });
  });

  it('zählt ungültige Zeilen, ohne die übrigen zu verlieren', () => {
    const { items, invalidRowCount } = parse(
      file(
        BASE,
        { ...BASE, 'amazon-order-id': '302-2', quantity: 'zwei' },
        { ...BASE, 'amazon-order-id': '302-3', 'item-price': '1,5' },
        { ...BASE, 'amazon-order-id': '302-4', 'purchase-date': 'gestern' },
        { ...BASE, 'amazon-order-id': '' },
      ),
    );

    expect(items.map((item) => item.amazonOrderId)).toEqual(['302-0000001-0000001']);
    expect(invalidRowCount).toBe(4);
  });

  it('liefert für einen leeren Bericht (nur Kopfzeile oder gar nichts) keine Positionen', () => {
    expect(parse(file())).toEqual({ items: [], invalidRowCount: 0 });
    expect(parse('')).toEqual({ items: [], invalidRowCount: 0 });
  });

  it('wirft, wenn Pflichtspalten fehlen (anderes Format)', () => {
    expect(() => parse('order-id\tsku\n1\tA\n')).toThrow(/amazon-order-id/);
  });
});
