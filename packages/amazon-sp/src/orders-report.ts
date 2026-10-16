import { amazonDecimalSchema } from '@profitbash/amazon-ads';
import { Decimal } from 'decimal.js';

/**
 * Parser des Berichts „Alle Bestellungen“ (`GET_FLAT_FILE_ALL_ORDERS_DATA_BY_…_GENERAL`, Tab-getrennt, schon
 * dekodiert). Gelesen werden nur die Spalten unten; Adressteile (`ship-city`, `ship-postal-code` …) und der
 * Produktname werden nie angefasst (ADR 007: keine Käuferdaten). Beträge so, wie Amazon sie liefert (ob
 * `item-price` in der EU brutto ist, klärt 7.12), als Decimal-Strings; leere Beträge bleiben `null`.
 */

export interface SpOrderItem {
  amazonOrderId: string;
  sku: string;
  asin: string | null;
  purchasedAt: Date;
  /** Kaufdatum in der Zeitzone des Marktplatzes (`YYYY-MM-DD`). */
  purchaseDate: string;
  lastUpdatedAt: Date;
  orderStatus: string;
  itemStatus: string | null;
  /** `Amazon` (FBA) oder `Merchant` (FBM). */
  fulfillmentChannel: string | null;
  salesChannel: string | null;
  quantity: number;
  currency: string | null;
  itemPrice: string | null;
  itemTax: string | null;
  shippingPrice: string | null;
  shippingTax: string | null;
  giftWrapPrice: string | null;
  giftWrapTax: string | null;
  itemPromotionDiscount: string | null;
  shipPromotionDiscount: string | null;
  isBusinessOrder: boolean;
}

const REQUIRED = [
  'amazon-order-id',
  'purchase-date',
  'last-updated-date',
  'order-status',
  'sku',
  'quantity',
] as const;

const AMOUNTS = {
  itemPrice: 'item-price',
  itemTax: 'item-tax',
  shippingPrice: 'shipping-price',
  shippingTax: 'shipping-tax',
  giftWrapPrice: 'gift-wrap-price',
  giftWrapTax: 'gift-wrap-tax',
  itemPromotionDiscount: 'item-promotion-discount',
  shipPromotionDiscount: 'ship-promotion-discount',
} as const;
type AmountKey = keyof typeof AMOUNTS;
const AMOUNT_KEYS = Object.keys(AMOUNTS) as AmountKey[];

class InvalidRow extends Error {}

export function parseOrdersReport(
  text: string,
  options: { timeZone: string },
): { items: SpOrderItem[]; invalidRowCount: number } {
  const lines = text.split(/\r?\n/).filter((line) => line !== '');
  if (lines.length === 0) return { items: [], invalidRowCount: 0 };

  const header = lines[0]!.split('\t');
  const missing = REQUIRED.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error(`Bestellbericht ohne Pflichtspalten: ${missing.join(', ')}`);
  }
  const index = new Map(header.map((column, i) => [column, i]));
  const dayOf = new Intl.DateTimeFormat('en-CA', {
    timeZone: options.timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  const items = new Map<string, SpOrderItem>();
  let invalidRowCount = 0;
  for (const line of lines.slice(1)) {
    const cells = line.split('\t');
    const cell = (column: string): string | null => {
      const i = index.get(column);
      const value = i === undefined ? '' : (cells[i]?.trim() ?? '');
      return value === '' ? null : value;
    };
    try {
      const item = parseRow(cell, dayOf);
      const key = `${item.amazonOrderId}\t${item.sku}`;
      const existing = items.get(key);
      items.set(key, existing ? merge(existing, item) : item);
    } catch (error) {
      if (!(error instanceof InvalidRow)) throw error;
      invalidRowCount += 1;
    }
  }
  return { items: [...items.values()], invalidRowCount };
}

function parseRow(
  cell: (column: string) => string | null,
  dayOf: Intl.DateTimeFormat,
): SpOrderItem {
  const required = (column: string) => cell(column) ?? invalid();
  const purchasedAt = date(required('purchase-date'));
  const quantity = Number(required('quantity'));
  if (!Number.isSafeInteger(quantity) || quantity < 0) invalid();

  const amounts = {} as Record<AmountKey, string | null>;
  for (const key of AMOUNT_KEYS) {
    const raw = cell(AMOUNTS[key]);
    const parsed = raw === null ? null : amazonDecimalSchema.safeParse(raw);
    if (parsed && !parsed.success) invalid();
    amounts[key] = parsed ? parsed.data! : null;
  }

  return {
    amazonOrderId: required('amazon-order-id'),
    sku: required('sku'),
    asin: cell('asin'),
    purchasedAt,
    purchaseDate: dayOf.format(purchasedAt),
    lastUpdatedAt: date(required('last-updated-date')),
    orderStatus: required('order-status'),
    itemStatus: cell('item-status'),
    fulfillmentChannel: cell('fulfillment-channel'),
    salesChannel: cell('sales-channel'),
    quantity,
    currency: cell('currency'),
    ...amounts,
    isBusinessOrder: cell('is-business-order') === 'true',
  };
}

/** Zwei Zeilen derselben Bestellung und SKU: Mengen und Beträge addiert, jüngster Änderungszeitpunkt. */
function merge(a: SpOrderItem, b: SpOrderItem): SpOrderItem {
  const merged: SpOrderItem = {
    ...(b.lastUpdatedAt >= a.lastUpdatedAt ? b : a),
    quantity: a.quantity + b.quantity,
    currency: a.currency ?? b.currency,
  };
  for (const key of AMOUNT_KEYS) {
    const [x, y] = [a[key], b[key]];
    merged[key] = x === null ? y : y === null ? x : new Decimal(x).plus(y).toFixed();
  }
  return merged;
}

function date(value: string): Date {
  const time = Date.parse(value);
  return Number.isNaN(time) ? invalid() : new Date(time);
}

function invalid(): never {
  throw new InvalidRow();
}
