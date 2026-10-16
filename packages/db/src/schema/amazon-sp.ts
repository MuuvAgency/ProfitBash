import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { amazonAdsRequestStatus, clients, connections } from './app';
import { createdAt, id, organizationId, updatedAt } from './columns';

// ---------------------------------------------------------------------------
// Amazon SP-API (Phase 7): Zugangsdaten der App je Connection und Seller-Konten
// ---------------------------------------------------------------------------

/**
 * Client-ID und Secret der SP-API-App, über die eine Connection autorisiert wurde (`phase-7.md` F1: private
 * App, je Kunde eine eigene oder Public App). Das Secret ist verschlüsselt wie der Refresh-Token
 * (`spClientSecretAad`); die Schlüsselrotation verschlüsselt beide neu.
 */
export const amazonSpCredentials = pgTable(
  'amazon_sp_credentials',
  {
    connectionId: uuid('connection_id').primaryKey(),
    organizationId: organizationId(),
    clientId: text('client_id').notNull(),
    /** Verschlüsselt über `@profitbash/shared/crypto`. Nie im Klartext speichern, loggen oder ausliefern. */
    clientSecretEncrypted: text('client_secret_encrypted').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    foreignKey({
      name: 'amazon_sp_credentials_connection_org_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }).onDelete('cascade'),
  ],
);

/**
 * Seller-Konto: ein Verkäuferkonto auf einem Marktplatz, Gegenstück zum Ads-Profil. Intern
 * `sellerAccountId`, bei Amazon `amazonSellerId` + `marketplaceId`. Sichtbarkeit nur über den Access-Layer
 * (`visibleSellerAccountsScope`).
 */
export const amazonSpAccounts = pgTable(
  'amazon_sp_accounts',
  {
    id: id(),
    organizationId: organizationId(),
    connectionId: uuid('connection_id').notNull(),
    /** Zugeordneter Client derselben Organisation (zusammengesetzter FK). */
    clientId: uuid('client_id').references(() => clients.id, { onDelete: 'set null' }),
    amazonSellerId: text('amazon_seller_id').notNull(),
    marketplaceId: text('marketplace_id').notNull(),
    storeName: text('store_name').notNull(),
    countryCode: text('country_code').notNull(),
    currencyCode: text('currency_code').notNull(),
    timezone: text('timezone').notNull(),
    /** Vom Nutzer ausgeblendet. */
    isHidden: boolean('is_hidden').notNull().default(false),
    /** Der Verkäufer nimmt am Marktplatz nicht mehr teil. Wird beim erneuten Auftauchen zurückgesetzt. */
    removedAt: timestamp('removed_at', { withTimezone: true, mode: 'date' }),
    syncedAt: timestamp('synced_at', { withTimezone: true, mode: 'date' }),
    /** Die Bestell-Historie (12 Monate, F8) ist angefordert (7.3); danach nur noch das rollierende Fenster. */
    ordersHistoryRequestedAt: timestamp('orders_history_requested_at', {
      withTimezone: true,
      mode: 'date',
    }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    unique('amazon_sp_accounts_org_seller_marketplace_uq').on(
      t.organizationId,
      t.amazonSellerId,
      t.marketplaceId,
    ),
    foreignKey({
      name: 'amazon_sp_accounts_connection_org_fk',
      columns: [t.connectionId, t.organizationId],
      foreignColumns: [connections.id, connections.organizationId],
    }).onDelete('cascade'),
    foreignKey({
      name: 'amazon_sp_accounts_client_org_fk',
      columns: [t.clientId, t.organizationId],
      foreignColumns: [clients.id, clients.organizationId],
    }),
    index('amazon_sp_accounts_connection_idx').on(t.connectionId),
    index('amazon_sp_accounts_client_idx').on(t.clientId),
    // Ziel zusammengesetzter Fremdschlüssel der Verkaufsdaten (ab 7.3).
    unique('amazon_sp_accounts_id_org_uq').on(t.id, t.organizationId),
  ],
);

/**
 * Berichts-Aufträge der Reports-API je Seller-Konto (7.3), Gegenstück zu `amazon_ads_report_requests` mit
 * denselben Zuständen. Die Dokument-URL wird nie gespeichert (signiert, läuft nach 5 Minuten ab).
 */
export const amazonSpReportRequests = pgTable(
  'amazon_sp_report_requests',
  {
    id: id(),
    organizationId: organizationId(),
    sellerAccountId: uuid('seller_account_id').notNull(),
    /** z. B. `GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL` */
    reportType: text('report_type').notNull(),
    dataStart: timestamp('data_start', { withTimezone: true, mode: 'date' }).notNull(),
    dataEnd: timestamp('data_end', { withTimezone: true, mode: 'date' }).notNull(),
    amazonReportId: text('amazon_report_id'),
    status: amazonAdsRequestStatus('status').notNull().default('pending_request'),
    /** Status-Abfragen seit dem (letzten) Anfordern. */
    attempts: integer('attempts').notNull().default(0),
    importAttempts: integer('import_attempts').notNull().default(0),
    /** Vorübergehende Fehler in Folge; jede Antwort von Amazon setzt zurück. */
    errorCount: integer('error_count').notNull().default(0),
    /** Anforderungen bei Amazon; begrenzt das Neu-Anfordern. */
    requestCount: integer('request_count').notNull().default(0),
    nextPollAt: timestamp('next_poll_at', { withTimezone: true, mode: 'date' }),
    requestedAt: timestamp('requested_at', { withTimezone: true, mode: 'date' }),
    importedAt: timestamp('imported_at', { withTimezone: true, mode: 'date' }),
    /** Gekürzt, ohne URLs und Rohdaten. */
    failureReason: text('failure_reason'),
    rowCount: integer('row_count'),
    invalidRowCount: integer('invalid_row_count'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    // Betriebszustand, keine Historie: verschwindet mit dem Konto.
    foreignKey({
      name: 'amazon_sp_report_requests_account_org_fk',
      columns: [t.sellerAccountId, t.organizationId],
      foreignColumns: [amazonSpAccounts.id, amazonSpAccounts.organizationId],
    }).onDelete('cascade'),
    uniqueIndex('amazon_sp_report_requests_open_uq')
      .on(t.sellerAccountId, t.reportType, t.dataStart, t.dataEnd)
      .where(sql`status in ('pending_request', 'requested', 'completed')`),
    index('amazon_sp_report_requests_due_idx')
      .on(t.nextPollAt)
      .where(sql`status in ('pending_request', 'requested', 'completed')`),
  ],
);

const money = (name: string) => numeric(name, { mode: 'string' });

/**
 * Bestellpositionen aus dem Bericht „Alle Bestellungen“ (7.3), je Bestellung und SKU. Keine Käuferdaten
 * (ADR 007). Beträge so, wie Amazon sie liefert, in der Währung der Position; Steuer getrennt (F6).
 */
export const amazonSpOrderItems = pgTable(
  'amazon_sp_order_items',
  {
    organizationId: organizationId(),
    sellerAccountId: uuid('seller_account_id').notNull(),
    amazonOrderId: text('amazon_order_id').notNull(),
    sku: text('sku').notNull(),
    asin: text('asin'),
    purchasedAt: timestamp('purchased_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Kaufdatum in der Zeitzone des Marktplatzes. */
    purchaseDate: date('purchase_date', { mode: 'string' }).notNull(),
    lastUpdatedAt: timestamp('last_updated_at', { withTimezone: true, mode: 'date' }).notNull(),
    orderStatus: text('order_status').notNull(),
    itemStatus: text('item_status'),
    /** `Amazon` (FBA) oder `Merchant` (FBM). */
    fulfillmentChannel: text('fulfillment_channel'),
    salesChannel: text('sales_channel'),
    quantity: integer('quantity').notNull(),
    currency: text('currency'),
    itemPrice: money('item_price'),
    itemTax: money('item_tax'),
    shippingPrice: money('shipping_price'),
    shippingTax: money('shipping_tax'),
    giftWrapPrice: money('gift_wrap_price'),
    giftWrapTax: money('gift_wrap_tax'),
    itemPromotionDiscount: money('item_promotion_discount'),
    shipPromotionDiscount: money('ship_promotion_discount'),
    isBusinessOrder: boolean('is_business_order').notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    primaryKey({ columns: [t.sellerAccountId, t.amazonOrderId, t.sku] }),
    // Historie: Ein Konto mit Verkaufsdaten lässt sich nicht beiläufig löschen.
    foreignKey({
      name: 'amazon_sp_order_items_account_org_fk',
      columns: [t.sellerAccountId, t.organizationId],
      foreignColumns: [amazonSpAccounts.id, amazonSpAccounts.organizationId],
    }),
    index('amazon_sp_order_items_account_date_idx').on(t.sellerAccountId, t.purchaseDate),
  ],
);

/**
 * Tageswerte je Seller-Konto, Kaufdatum und SKU (7.3), verdichtet aus `amazon_sp_order_items` ohne
 * stornierte Positionen. Werden je betroffenem Tag neu berechnet.
 */
export const amazonSpDailySales = pgTable(
  'amazon_sp_daily_sales',
  {
    organizationId: organizationId(),
    sellerAccountId: uuid('seller_account_id').notNull(),
    date: date('date', { mode: 'string' }).notNull(),
    sku: text('sku').notNull(),
    asin: text('asin'),
    currency: text('currency'),
    units: integer('units').notNull(),
    orders: integer('orders').notNull(),
    /** Stück ohne Preis (selbst versandt, noch „Pending“): Der Umsatz ist dafür noch unbekannt. */
    unpricedUnits: integer('unpriced_units').notNull(),
    itemPrice: money('item_price').notNull(),
    itemTax: money('item_tax').notNull(),
    shippingPrice: money('shipping_price').notNull(),
    shippingTax: money('shipping_tax').notNull(),
    giftWrapPrice: money('gift_wrap_price').notNull(),
    giftWrapTax: money('gift_wrap_tax').notNull(),
    itemPromotionDiscount: money('item_promotion_discount').notNull(),
    shipPromotionDiscount: money('ship_promotion_discount').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.sellerAccountId, t.date, t.sku] }),
    foreignKey({
      name: 'amazon_sp_daily_sales_account_org_fk',
      columns: [t.sellerAccountId, t.organizationId],
      foreignColumns: [amazonSpAccounts.id, amazonSpAccounts.organizationId],
    }),
  ],
);
