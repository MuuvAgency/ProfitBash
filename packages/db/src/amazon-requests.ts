import { randomUUID } from 'node:crypto';
import { and, asc, count, eq, gt, gte, inArray, isNotNull, lt, lte, min, sql } from 'drizzle-orm';
import type { DbOrTx } from './audit';
import { amazonAdsProfiles, amazonAdsReportRequests, connections } from './schema';

/**
 * Asynchrone Amazon-Aufträge (Reports, Exports; Phase 1, 1.4). Systemzugriff des Workers ohne
 * Nutzerkontext, an die Organisation gebunden. Die Zustandsmaschine liegt im Worker
 * (`apps/worker/src/amazon-requests`); hier nur Lesen und Schreiben der Zeilen.
 */

export type AmazonRequest = typeof amazonAdsReportRequests.$inferSelect;
export type AmazonRequestStatus = AmazonRequest['status'];
export type AmazonRequestKind = AmazonRequest['kind'];

/** Offene Aufträge (Gegenstück zum partiellen Unique-Index `amazon_ads_report_requests_open_uq`). */
export const OPEN_AMAZON_REQUEST_STATUSES = [
  'pending_request',
  'requested',
  'completed',
] as const satisfies readonly AmazonRequestStatus[];

export interface AmazonRequestRef {
  organizationId: string;
  id: string;
}

export interface NewAmazonRequest {
  organizationId: string;
  profileId: string;
  kind: AmazonRequestKind;
  adProduct: string;
  reportType: string;
  /** Nur Reports (`YYYY-MM-DD`). */
  startDate: string | null;
  endDate: string | null;
  /** Nur Exports. */
  batchId: string | null;
  now: Date;
}

export type AmazonRequestPatch = Partial<
  Pick<
    AmazonRequest,
    | 'amazonRequestId'
    | 'status'
    | 'attempts'
    | 'importAttempts'
    | 'errorCount'
    | 'requestCount'
    | 'nextPollAt'
    | 'requestedAt'
    | 'completedAt'
    | 'importedAt'
    | 'failureReason'
    | 'rowCount'
    | 'invalidRowCount'
  >
>;

const byRef = (ref: AmazonRequestRef) =>
  and(
    eq(amazonAdsReportRequests.id, ref.id),
    eq(amazonAdsReportRequests.organizationId, ref.organizationId),
  );

/**
 * Legt einen Auftrag als `pending_request` an (fällig sofort), **bevor** Amazon aufgerufen wird. Gibt
 * es schon einen offenen Auftrag mit demselben Schlüssel (Profil, Art, Ad-Typ, Typ, Zeitraum), bleibt
 * es bei diesem (`created: false`).
 */
export async function createAmazonRequest(
  db: DbOrTx,
  input: NewAmazonRequest,
): Promise<{ created: boolean; request: AmazonRequest }> {
  const { now, ...values } = input;
  const [row] = await db
    .insert(amazonAdsReportRequests)
    .values({
      ...values,
      status: 'pending_request',
      nextPollAt: now,
      createdAt: now,
      updatedAt: now,
    })
    // Ohne Ziel: greift beim partiellen Unique-Index der offenen Aufträge (die ID ist zufällig).
    .onConflictDoNothing()
    .returning();
  if (row) return { created: true, request: row };

  const [open] = await db
    .select()
    .from(amazonAdsReportRequests)
    .where(
      and(
        eq(amazonAdsReportRequests.organizationId, input.organizationId),
        eq(amazonAdsReportRequests.profileId, input.profileId),
        eq(amazonAdsReportRequests.kind, input.kind),
        eq(amazonAdsReportRequests.adProduct, input.adProduct),
        eq(amazonAdsReportRequests.reportType, input.reportType),
        sql`${amazonAdsReportRequests.startDate} is not distinct from ${input.startDate}::date`,
        sql`${amazonAdsReportRequests.endDate} is not distinct from ${input.endDate}::date`,
        inArray(amazonAdsReportRequests.status, OPEN_AMAZON_REQUEST_STATUSES),
      ),
    );
  // Zwischen beiden Abfragen abgeschlossen: selten, der Aufrufer versucht es im nächsten Lauf erneut.
  if (!open) throw new Error('Offener Amazon-Auftrag wurde zwischenzeitlich abgeschlossen.');
  return { created: false, request: open };
}

/**
 * Legt alle Exports eines Entity-Syncs (ein Profil, ein Ad-Typ) in einer Transaktion als
 * `pending_request` mit gemeinsamer `batch_id` an. Ein Batch ist damit vollständig oder gar nicht da;
 * ein Absturz beim Anlegen hinterlässt keinen halben Batch. Ist für Profil und Ad-Typ noch ein Export
 * offen, entsteht kein neuer Batch (`created: false`, `requests` = die offenen Exports): Sonst mischten
 * sich Stände zweier Batches.
 */
export async function createAmazonExportBatch(
  db: DbOrTx,
  input: {
    organizationId: string;
    profileId: string;
    adProduct: string;
    exportTypes: readonly string[];
    now: Date;
  },
): Promise<{ created: boolean; requests: AmazonRequest[] }> {
  return db.transaction(async (tx) => {
    const open = await tx
      .select()
      .from(amazonAdsReportRequests)
      .where(
        and(
          eq(amazonAdsReportRequests.organizationId, input.organizationId),
          eq(amazonAdsReportRequests.profileId, input.profileId),
          eq(amazonAdsReportRequests.kind, 'export'),
          eq(amazonAdsReportRequests.adProduct, input.adProduct),
          inArray(amazonAdsReportRequests.status, OPEN_AMAZON_REQUEST_STATUSES),
        ),
      )
      .orderBy(asc(amazonAdsReportRequests.createdAt), asc(amazonAdsReportRequests.id));
    if (open.length > 0) return { created: false, requests: open };

    const batchId = randomUUID();
    const requests = await tx
      .insert(amazonAdsReportRequests)
      .values(
        input.exportTypes.map((reportType) => ({
          organizationId: input.organizationId,
          profileId: input.profileId,
          kind: 'export' as const,
          adProduct: input.adProduct,
          reportType,
          batchId,
          status: 'pending_request' as const,
          nextPollAt: input.now,
          createdAt: input.now,
          updatedAt: input.now,
        })),
      )
      .returning();
    return { created: true, requests };
  });
}

export async function findAmazonRequest(
  db: DbOrTx,
  ref: AmazonRequestRef,
): Promise<AmazonRequest | null> {
  const [row] = await db.select().from(amazonAdsReportRequests).where(byRef(ref));
  return row ?? null;
}

export async function updateAmazonRequest(
  db: DbOrTx,
  ref: AmazonRequestRef,
  patch: AmazonRequestPatch,
): Promise<AmazonRequest> {
  const [row] = await db.update(amazonAdsReportRequests).set(patch).where(byRef(ref)).returning();
  if (!row) throw new Error('Amazon-Auftrag nicht gefunden.');
  return row;
}

/** Ändert alle Aufträge eines Export-Batches. */
export async function updateAmazonRequestBatch(
  db: DbOrTx,
  ref: { organizationId: string; batchId: string },
  patch: AmazonRequestPatch,
): Promise<AmazonRequest[]> {
  return db
    .update(amazonAdsReportRequests)
    .set(patch)
    .where(
      and(
        eq(amazonAdsReportRequests.organizationId, ref.organizationId),
        eq(amazonAdsReportRequests.batchId, ref.batchId),
      ),
    )
    .returning();
}

/**
 * Fällige offene Aufträge der Profile, die aktuell an der Connection hängen, älteste zuerst. Aufträge
 * ohne `next_poll_at` (Exports, die auf ihren Batch warten) sind nie fällig.
 */
export async function listDueAmazonRequests(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string; now: Date; limit: number },
): Promise<AmazonRequest[]> {
  const rows = await db
    .select({ request: amazonAdsReportRequests })
    .from(amazonAdsReportRequests)
    .innerJoin(
      amazonAdsProfiles,
      and(
        eq(amazonAdsProfiles.id, amazonAdsReportRequests.profileId),
        eq(amazonAdsProfiles.organizationId, amazonAdsReportRequests.organizationId),
      ),
    )
    .where(
      and(
        eq(amazonAdsReportRequests.organizationId, input.organizationId),
        eq(amazonAdsProfiles.connectionId, input.connectionId),
        inArray(amazonAdsReportRequests.status, OPEN_AMAZON_REQUEST_STATUSES),
        isNotNull(amazonAdsReportRequests.nextPollAt),
        lte(amazonAdsReportRequests.nextPollAt, input.now),
      ),
    )
    .orderBy(asc(amazonAdsReportRequests.createdAt), asc(amazonAdsReportRequests.id))
    .limit(input.limit);
  return rows.map((row) => row.request);
}

/** Aufträge der Profile, die aktuell an der Connection hängen (Join für die folgenden Abfragen). */
const onConnectionProfiles = and(
  eq(amazonAdsProfiles.id, amazonAdsReportRequests.profileId),
  eq(amazonAdsProfiles.organizationId, amazonAdsReportRequests.organizationId),
);

/**
 * Frühester Termin (`next_poll_at`) der offenen Aufträge an der Connection, `null` ohne solche. Danach
 * plant sich der Poll neu ein.
 */
export async function nextAmazonRequestPollAt(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string },
): Promise<Date | null> {
  const [row] = await db
    .select({ next: min(amazonAdsReportRequests.nextPollAt) })
    .from(amazonAdsReportRequests)
    .innerJoin(amazonAdsProfiles, onConnectionProfiles)
    .where(
      and(
        eq(amazonAdsReportRequests.organizationId, input.organizationId),
        eq(amazonAdsProfiles.connectionId, input.connectionId),
        inArray(amazonAdsReportRequests.status, OPEN_AMAZON_REQUEST_STATUSES),
      ),
    );
  return row?.next ?? null;
}

/**
 * Aktive Connections aller Organisationen mit fälligen offenen Aufträgen (Cron-Auslöser des Polls,
 * holt nach Absturz oder Deploy auf). Plattformweiter Systemzugriff, nur für den Worker.
 */
export async function listConnectionsWithDueAmazonRequests(
  db: DbOrTx,
  now: Date,
): Promise<Array<{ id: string; organizationId: string }>> {
  return db
    .selectDistinct({ id: connections.id, organizationId: connections.organizationId })
    .from(amazonAdsReportRequests)
    .innerJoin(amazonAdsProfiles, onConnectionProfiles)
    .innerJoin(
      connections,
      and(
        eq(connections.id, amazonAdsProfiles.connectionId),
        eq(connections.organizationId, amazonAdsProfiles.organizationId),
      ),
    )
    .where(
      and(
        eq(connections.status, 'active'),
        inArray(amazonAdsReportRequests.status, OPEN_AMAZON_REQUEST_STATUSES),
        lte(amazonAdsReportRequests.nextPollAt, now),
      ),
    )
    .orderBy(connections.id);
}

/**
 * Bei Amazon laufende Exports eines Typs (`requested`) über alle Profile der Connection: Anzahl und
 * frühester Termin (`next_poll_at`), an dem einer davon fertig werden und einen Platz freigeben kann.
 */
export async function findRunningExports(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string; exportType: string },
): Promise<{ count: number; nextPollAt: Date | null }> {
  const [row] = await db
    .select({ count: count(), nextPollAt: min(amazonAdsReportRequests.nextPollAt) })
    .from(amazonAdsReportRequests)
    .innerJoin(amazonAdsProfiles, onConnectionProfiles)
    .where(
      and(
        eq(amazonAdsReportRequests.organizationId, input.organizationId),
        eq(amazonAdsProfiles.connectionId, input.connectionId),
        eq(amazonAdsReportRequests.kind, 'export'),
        eq(amazonAdsReportRequests.reportType, input.exportType),
        eq(amazonAdsReportRequests.status, 'requested'),
      ),
    );
  return { count: row?.count ?? 0, nextPollAt: row?.nextPollAt ?? null };
}

/** Zeiträume der Reports eines Profils, Ad-Typs und Report-Typs in den genannten Zuständen. */
export async function listReportRanges(
  db: DbOrTx,
  input: {
    organizationId: string;
    profileId: string;
    adProduct: string;
    reportType: string;
    statuses: readonly AmazonRequestStatus[];
  },
): Promise<Array<{ startDate: string; endDate: string }>> {
  const rows = await db
    .select({
      startDate: amazonAdsReportRequests.startDate,
      endDate: amazonAdsReportRequests.endDate,
    })
    .from(amazonAdsReportRequests)
    .where(
      and(
        eq(amazonAdsReportRequests.organizationId, input.organizationId),
        eq(amazonAdsReportRequests.profileId, input.profileId),
        eq(amazonAdsReportRequests.kind, 'report'),
        eq(amazonAdsReportRequests.adProduct, input.adProduct),
        eq(amazonAdsReportRequests.reportType, input.reportType),
        inArray(amazonAdsReportRequests.status, [...input.statuses]),
      ),
    )
    .orderBy(asc(amazonAdsReportRequests.startDate), asc(amazonAdsReportRequests.endDate));
  return rows.flatMap((row) =>
    row.startDate && row.endDate ? [{ startDate: row.startDate, endDate: row.endDate }] : [],
  );
}

/**
 * Aufträge (Reports und Exports) der Profile an der Connection, die seit `since` gescheitert sind
 * (`updated_at` der `failed`-Zeile).
 */
export async function countFailedAmazonRequestsSince(
  db: DbOrTx,
  input: { organizationId: string; connectionId: string; since: Date },
): Promise<number> {
  const [row] = await db
    .select({ failed: count() })
    .from(amazonAdsReportRequests)
    .innerJoin(amazonAdsProfiles, onConnectionProfiles)
    .where(
      and(
        eq(amazonAdsReportRequests.organizationId, input.organizationId),
        eq(amazonAdsProfiles.connectionId, input.connectionId),
        eq(amazonAdsReportRequests.status, 'failed'),
        gte(amazonAdsReportRequests.updatedAt, input.since),
      ),
    );
  return row?.failed ?? 0;
}

/** Alle Aufträge eines Export-Batches. */
export async function listAmazonRequestBatch(
  db: DbOrTx,
  input: { organizationId: string; batchId: string },
): Promise<AmazonRequest[]> {
  return db
    .select()
    .from(amazonAdsReportRequests)
    .where(
      and(
        eq(amazonAdsReportRequests.organizationId, input.organizationId),
        eq(amazonAdsReportRequests.batchId, input.batchId),
      ),
    )
    .orderBy(asc(amazonAdsReportRequests.createdAt), asc(amazonAdsReportRequests.id));
}

/**
 * Zeiträume der Reports mit demselben Profil, Ad-Typ und Report-Typ, die **später** angefordert und
 * schon importiert wurden. Ihre Tage darf ein älterer Auftrag nicht mehr überschreiben (1.4, Reihenfolge).
 */
export async function listNewerImportedReportRanges(
  db: DbOrTx,
  request: Pick<
    AmazonRequest,
    'organizationId' | 'profileId' | 'adProduct' | 'reportType' | 'requestedAt'
  >,
): Promise<Array<{ startDate: string; endDate: string }>> {
  if (!request.requestedAt) return [];
  const rows = await db
    .select({
      startDate: amazonAdsReportRequests.startDate,
      endDate: amazonAdsReportRequests.endDate,
    })
    .from(amazonAdsReportRequests)
    .where(
      and(
        eq(amazonAdsReportRequests.organizationId, request.organizationId),
        eq(amazonAdsReportRequests.profileId, request.profileId),
        eq(amazonAdsReportRequests.kind, 'report'),
        eq(amazonAdsReportRequests.adProduct, request.adProduct),
        eq(amazonAdsReportRequests.reportType, request.reportType),
        eq(amazonAdsReportRequests.status, 'imported'),
        gt(amazonAdsReportRequests.requestedAt, request.requestedAt),
      ),
    )
    .orderBy(asc(amazonAdsReportRequests.startDate));
  return rows.flatMap((row) =>
    row.startDate && row.endDate ? [{ startDate: row.startDate, endDate: row.endDate }] : [],
  );
}

/** Löscht abgeschlossene Aufträge (`imported`, `failed`), die vor `createdBefore` angelegt wurden (F5). */
export async function deleteFinishedAmazonRequestsBefore(
  db: DbOrTx,
  createdBefore: Date,
): Promise<number> {
  const rows = await db
    .delete(amazonAdsReportRequests)
    .where(
      and(
        inArray(amazonAdsReportRequests.status, ['imported', 'failed']),
        lt(amazonAdsReportRequests.createdAt, createdBefore),
      ),
    )
    .returning({ id: amazonAdsReportRequests.id });
  return rows.length;
}
