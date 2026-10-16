import {
  and,
  asc,
  eq,
  getTableColumns,
  inArray,
  isNull,
  lt,
  lte,
  max,
  min,
  ne,
  or,
  sql,
} from 'drizzle-orm';
import type { DbOrTx } from './audit';
import {
  amazonSpAccounts,
  amazonSpDailySales,
  amazonSpOrderItems,
  amazonSpReportRequests,
  connections,
} from './schema';

/**
 * Bestellungen der SP-API (Phase 7, 7.3): Berichts-Aufträge, Bestellpositionen und Tageswerte.
 * Systemzugriff des Workers ohne Nutzerkontext, an die Organisation gebunden; Lesen für Nutzer läuft über
 * `visibleSellerAccountsScope` (ADR 002).
 */

export type SpReportRequest = typeof amazonSpReportRequests.$inferSelect;
export type SpReportRequestPatch = Partial<
  Pick<
    SpReportRequest,
    | 'amazonReportId'
    | 'status'
    | 'attempts'
    | 'importAttempts'
    | 'errorCount'
    | 'requestCount'
    | 'nextPollAt'
    | 'requestedAt'
    | 'importedAt'
    | 'failureReason'
    | 'rowCount'
    | 'invalidRowCount'
  >
>;
export type SpOrderItemInput = Omit<
  typeof amazonSpOrderItems.$inferInsert,
  'organizationId' | 'sellerAccountId' | 'createdAt' | 'updatedAt'
>;

const OPEN = ['pending_request', 'requested', 'completed'] as const;
/** So viele Positionen je INSERT (25 Spalten, Postgres erlaubt 65535 Parameter). */
const INSERT_CHUNK = 1000;

const byRef = (ref: { organizationId: string; id: string }) =>
  and(
    eq(amazonSpReportRequests.organizationId, ref.organizationId),
    eq(amazonSpReportRequests.id, ref.id),
  );

const onAccount = and(
  eq(amazonSpAccounts.id, amazonSpReportRequests.sellerAccountId),
  eq(amazonSpAccounts.organizationId, amazonSpReportRequests.organizationId),
);

/** Aktive SP-Connections aller Organisationen (täglicher Auslöser). Plattformweit, nur für den Worker. */
export async function listActiveSpConnections(
  db: DbOrTx,
): Promise<Array<{ id: string; organizationId: string }>> {
  return db
    .select({ id: connections.id, organizationId: connections.organizationId })
    .from(connections)
    .where(and(eq(connections.status, 'active'), eq(connections.provider, 'amazon_sp')))
    .orderBy(connections.createdAt, connections.id);
}

/** Aktive SP-Connections mit fälligen offenen Aufträgen (Auslöser alle 10 Min.). */
export async function listSpConnectionsWithDueReports(
  db: DbOrTx,
  now: Date,
): Promise<Array<{ id: string; organizationId: string }>> {
  return db
    .selectDistinct({ id: connections.id, organizationId: connections.organizationId })
    .from(amazonSpReportRequests)
    .innerJoin(amazonSpAccounts, onAccount)
    .innerJoin(
      connections,
      and(
        eq(connections.id, amazonSpAccounts.connectionId),
        eq(connections.organizationId, amazonSpAccounts.organizationId),
      ),
    )
    .where(
      and(
        eq(connections.status, 'active'),
        inArray(amazonSpReportRequests.status, OPEN),
        lte(amazonSpReportRequests.nextPollAt, now),
      ),
    )
    .orderBy(connections.id);
}

/** Konten der Connection, deren Bestellungen geladen werden: alle außer entfernten (auch ausgeblendete). */
export async function listSpOrderSyncAccounts(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string },
) {
  return db
    .select({
      id: amazonSpAccounts.id,
      organizationId: amazonSpAccounts.organizationId,
      marketplaceId: amazonSpAccounts.marketplaceId,
      timezone: amazonSpAccounts.timezone,
      ordersHistoryRequestedAt: amazonSpAccounts.ordersHistoryRequestedAt,
    })
    .from(amazonSpAccounts)
    .where(
      and(
        eq(amazonSpAccounts.organizationId, input.organizationId),
        eq(amazonSpAccounts.connectionId, input.connectionId),
        isNull(amazonSpAccounts.removedAt),
      ),
    )
    .orderBy(amazonSpAccounts.createdAt, amazonSpAccounts.id);
}

/**
 * Legt Aufträge an (`pending_request`, sofort fällig); ein gleicher offener Auftrag bleibt (Unique-Index).
 * `markHistory` merkt in derselben Transaktion, dass die Historie angefordert ist. Ergebnis: neu angelegte.
 */
export async function createSpReportRequests(
  db: DbOrTx,
  input: {
    organizationId: string;
    sellerAccountId: string;
    requests: Array<{ reportType: string; dataStart: Date; dataEnd: Date }>;
    markHistory: boolean;
    now: Date;
  },
): Promise<number> {
  return db.transaction(async (tx) => {
    const created = await tx
      .insert(amazonSpReportRequests)
      .values(
        input.requests.map((request) => ({
          ...request,
          organizationId: input.organizationId,
          sellerAccountId: input.sellerAccountId,
          nextPollAt: input.now,
        })),
      )
      .onConflictDoNothing({
        target: [
          amazonSpReportRequests.sellerAccountId,
          amazonSpReportRequests.reportType,
          amazonSpReportRequests.dataStart,
          amazonSpReportRequests.dataEnd,
        ],
        where: inArray(amazonSpReportRequests.status, OPEN),
      })
      .returning({ id: amazonSpReportRequests.id });
    if (input.markHistory) {
      await tx
        .update(amazonSpAccounts)
        .set({ ordersHistoryRequestedAt: input.now })
        .where(
          and(
            eq(amazonSpAccounts.organizationId, input.organizationId),
            eq(amazonSpAccounts.id, input.sellerAccountId),
          ),
        );
    }
    return created.length;
  });
}

/** Zeitpunkt des zuletzt angelegten Auftrags dieses Typs für das Konto, `null` ohne solchen. */
export async function lastSpReportRequestAt(
  db: DbOrTx,
  input: { sellerAccountId: string; reportType: string },
): Promise<Date | null> {
  const [row] = await db
    .select({ last: max(amazonSpReportRequests.createdAt) })
    .from(amazonSpReportRequests)
    .where(
      and(
        eq(amazonSpReportRequests.sellerAccountId, input.sellerAccountId),
        eq(amazonSpReportRequests.reportType, input.reportType),
      ),
    );
  return row?.last ?? null;
}

/** Fällige offene Aufträge der Konten an der Connection, älteste zuerst. */
export async function listDueSpReportRequests(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string; now: Date; limit: number },
): Promise<SpReportRequest[]> {
  const rows = await db
    .select({ request: amazonSpReportRequests })
    .from(amazonSpReportRequests)
    .innerJoin(amazonSpAccounts, onAccount)
    .where(
      and(
        eq(amazonSpReportRequests.organizationId, input.organizationId),
        eq(amazonSpAccounts.connectionId, input.connectionId),
        inArray(amazonSpReportRequests.status, OPEN),
        lte(amazonSpReportRequests.nextPollAt, input.now),
      ),
    )
    .orderBy(asc(amazonSpReportRequests.createdAt), asc(amazonSpReportRequests.id))
    .limit(input.limit);
  return rows.map((row) => row.request);
}

/** Frühester Termin offener Aufträge an der Connection, `null` ohne solche. */
export async function nextSpReportPollAt(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string },
): Promise<Date | null> {
  const [row] = await db
    .select({ next: min(amazonSpReportRequests.nextPollAt) })
    .from(amazonSpReportRequests)
    .innerJoin(amazonSpAccounts, onAccount)
    .where(
      and(
        eq(amazonSpReportRequests.organizationId, input.organizationId),
        eq(amazonSpAccounts.connectionId, input.connectionId),
        inArray(amazonSpReportRequests.status, OPEN),
      ),
    );
  return row?.next ?? null;
}

export async function updateSpReportRequest(
  db: DbOrTx,
  ref: { organizationId: string; id: string },
  patch: SpReportRequestPatch,
): Promise<SpReportRequest> {
  const [row] = await db.update(amazonSpReportRequests).set(patch).where(byRef(ref)).returning();
  if (!row) throw new Error('SP-Berichtsauftrag nicht gefunden.');
  return row;
}

/** Löscht abgeschlossene Aufträge (`imported`, `failed`), die vor `createdBefore` angelegt wurden. */
export async function deleteFinishedSpReportRequestsBefore(
  db: DbOrTx,
  createdBefore: Date,
): Promise<number> {
  const rows = await db
    .delete(amazonSpReportRequests)
    .where(
      and(
        inArray(amazonSpReportRequests.status, ['imported', 'failed']),
        lt(amazonSpReportRequests.createdAt, createdBefore),
      ),
    )
    .returning({ id: amazonSpReportRequests.id });
  return rows.length;
}

const UPSERT_COLUMNS = Object.entries(getTableColumns(amazonSpOrderItems)).filter(
  ([key]) =>
    !['organizationId', 'sellerAccountId', 'amazonOrderId', 'sku', 'createdAt'].includes(key),
);

/**
 * Schreibt Positionen per Upsert (je Bestellung und SKU) und berechnet die Tageswerte der betroffenen
 * Kaufdaten neu. Eine Position wird nur überschrieben, wenn die neue nicht älter ist (`last_updated_at`):
 * So spielt die Reihenfolge der Berichte (Historie nach Kaufdatum, rollierend nach Änderung) keine Rolle.
 * In der Transaktion des Aufrufers.
 */
export async function importSpOrderItems(
  tx: DbOrTx,
  input: { organizationId: string; sellerAccountId: string; items: SpOrderItemInput[] },
): Promise<void> {
  const { organizationId, sellerAccountId } = input;
  for (let i = 0; i < input.items.length; i += INSERT_CHUNK) {
    await tx
      .insert(amazonSpOrderItems)
      .values(
        input.items
          .slice(i, i + INSERT_CHUNK)
          .map((item) => ({ ...item, organizationId, sellerAccountId })),
      )
      .onConflictDoUpdate({
        target: [
          amazonSpOrderItems.sellerAccountId,
          amazonSpOrderItems.amazonOrderId,
          amazonSpOrderItems.sku,
        ],
        set: Object.fromEntries(
          UPSERT_COLUMNS.map(([key, column]) => [
            key,
            key === 'updatedAt' ? sql`now()` : sql.raw(`excluded."${column.name}"`),
          ]),
        ),
        where: sql`excluded.last_updated_at >= ${amazonSpOrderItems.lastUpdatedAt}`,
      });
  }

  const dates = [...new Set(input.items.map((item) => item.purchaseDate))];
  if (dates.length === 0) return;
  const account = and(
    eq(amazonSpDailySales.organizationId, organizationId),
    eq(amazonSpDailySales.sellerAccountId, sellerAccountId),
  );
  await tx.delete(amazonSpDailySales).where(and(account, inArray(amazonSpDailySales.date, dates)));

  const o = amazonSpOrderItems;
  const total = (column: typeof o.itemPrice, alias: string) =>
    sql<string>`coalesce(sum(${column}), 0)`.as(alias);
  await tx.insert(amazonSpDailySales).select(
    tx
      .select({
        organizationId: o.organizationId,
        sellerAccountId: o.sellerAccountId,
        date: o.purchaseDate,
        sku: o.sku,
        asin: max(o.asin).as('asin'),
        currency: max(o.currency).as('currency'),
        units: sql<number>`sum(${o.quantity})::int`.as('units'),
        orders: sql<number>`count(distinct ${o.amazonOrderId})::int`.as('orders'),
        unpricedUnits:
          sql<number>`coalesce(sum(${o.quantity}) filter (where ${o.itemPrice} is null), 0)::int`.as(
            'unpriced_units',
          ),
        itemPrice: total(o.itemPrice, 'item_price'),
        itemTax: total(o.itemTax, 'item_tax'),
        shippingPrice: total(o.shippingPrice, 'shipping_price'),
        shippingTax: total(o.shippingTax, 'shipping_tax'),
        giftWrapPrice: total(o.giftWrapPrice, 'gift_wrap_price'),
        giftWrapTax: total(o.giftWrapTax, 'gift_wrap_tax'),
        itemPromotionDiscount: total(o.itemPromotionDiscount, 'item_promotion_discount'),
        shipPromotionDiscount: total(o.shipPromotionDiscount, 'ship_promotion_discount'),
      })
      .from(o)
      .where(
        and(
          eq(o.organizationId, organizationId),
          eq(o.sellerAccountId, sellerAccountId),
          inArray(o.purchaseDate, dates),
          // Stornierte zählen nicht zum Umsatz (Status der Bestellung oder der Position).
          ne(o.orderStatus, 'Cancelled'),
          or(isNull(o.itemStatus), ne(o.itemStatus, 'Cancelled')),
        ),
      )
      .groupBy(o.organizationId, o.sellerAccountId, o.purchaseDate, o.sku),
  );
}
