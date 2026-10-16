import {
  AmazonAdsDownloadTooLargeError,
  AmazonAdsHttpError,
  type ConnectionRef,
} from '@profitbash/amazon-ads';
import { parseOrdersReport, type AmazonSpClient } from '@profitbash/amazon-sp';
import {
  createSpReportRequests,
  importSpOrderItems,
  lastSpReportRequestAt,
  listDueSpReportRequests,
  listSpOrderSyncAccounts,
  nextSpReportPollAt,
  updateSpReportRequest,
  type SpReportRequest,
  type SpReportRequestPatch,
} from '@profitbash/db';
import { isConnectionError } from '../amazon-requests/state-machine';
import { JobFailure, type JobCounters, type JobOutcome } from '../run-job';
import {
  handleAmazonError,
  loadConnection,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionJobRun,
} from './connection-job';

/**
 * `sp-orders-sync` je SP-Connection (Phase 7, 7.3): plant die Berichte „Alle Bestellungen“ je Seller-Konto
 * (einmal 12 Monate Historie nach Kaufdatum, täglich die letzten 30 Tage nach Änderungsdatum), führt fällige
 * Aufträge einen Schritt weiter (anfordern → Status → Dokument laden → importieren) und plant sich zum
 * nächsten Termin neu ein. Zustände wie bei der Ads-API (1.4), aber eigene Tabelle: Seller-Konten statt
 * Profile, Text statt JSON, keine Exports. Die Reihenfolge der Berichte spielt keine Rolle, weil der Import
 * nur nicht ältere Positionen übernimmt (`importSpOrderItems`).
 */

export const SP_ORDERS_BY_UPDATE = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL';
export const SP_ORDERS_BY_DATE = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';

/** Grenzen je Lauf wie beim Poll der Ads-API; der Rest folgt im sofort eingeplanten nächsten Lauf. */
export const SP_ORDERS_LIMITS = { maxRequests: 20, maxDownloads: 5, timeBudgetMs: 5 * 60_000 };

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
/** Amazon erlaubt höchstens 30 Tage je Bericht. */
const WINDOW_MS = 30 * DAY_MS;
/** Historie beim ersten Lauf (F8). */
const HISTORY_MS = 365 * DAY_MS;
/** Das rollierende Fenster wird erst nach dieser Zeit neu angefordert (täglicher Lauf, Wiederholungen). */
const ROLLING_INTERVAL_MS = 20 * 60 * MINUTE_MS;
/** Abstand des Fensterendes zu „jetzt“ (Amazon lehnt Zeitpunkte in der Zukunft ab). */
const END_LAG_MS = 5 * MINUTE_MS;
const POLL_BACKOFF_MINUTES = [1, 2, 5, 10, 15];
const IMPORT_RETRY_MINUTES = 5;
const MAX_IMPORT_ATTEMPTS = 3;
const MAX_CONSECUTIVE_ERRORS = 10;
const MAX_REQUESTS = 3;
const MAX_REQUEST_AGE_MS = 4 * 60 * MINUTE_MS;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const MIN_DELAY_SECONDS = 5;
const MAX_FAILURE_REASON_LENGTH = 500;

type Counters = Record<
  'planned' | 'requested' | 'imported' | 'rows' | 'invalidRows' | 'failed',
  number
>;
type Account = Awaited<ReturnType<typeof listSpOrderSyncAccounts>>[number];

interface Context {
  deps: ConnectionJobDeps;
  client: AmazonSpClient;
  connection: ConnectionRef;
  run: ConnectionJobRun;
  now: () => Date;
  counters: Counters;
}

export async function syncSpOrders(
  deps: ConnectionJobDeps,
  job: ConnectionJobData,
  run: ConnectionJobRun,
): Promise<JobOutcome> {
  if (!deps.amazonSp) throw new JobFailure('Die SP-API ist im Worker nicht eingerichtet.');
  const connection = await loadConnection(deps.db, job);
  const now = () => deps.now?.() ?? new Date();
  const counters: Counters = {
    planned: 0,
    requested: 0,
    imported: 0,
    rows: 0,
    invalidRows: 0,
    failed: 0,
  };
  const ctx: Context = { deps, client: deps.amazonSp, connection, run, now, counters };
  const failures: string[] = [];

  const accounts = await listSpOrderSyncAccounts(deps.db, job);
  for (const account of accounts) counters.planned += await planReports(ctx, account);
  const byId = new Map(accounts.map((account) => [account.id, account]));

  const startedAt = now().getTime();
  const due = await listDueSpReportRequests(deps.db, {
    ...job,
    now: now(),
    limit: SP_ORDERS_LIMITS.maxRequests,
  });
  try {
    for (const request of due) {
      if (counters.imported >= SP_ORDERS_LIMITS.maxDownloads) break;
      if (now().getTime() - startedAt > SP_ORDERS_LIMITS.timeBudgetMs) break;
      const account = byId.get(request.sellerAccountId);
      // Entferntes Konto: offene Aufträge laufen ohne Import aus.
      if (!account) {
        await fail(ctx, request, 'Das Seller-Konto ist entfernt.');
        continue;
      }
      await run.extendLease();
      const result = await advance(ctx, request, account);
      if (result.status === 'failed' && result.failureReason) failures.push(result.failureReason);
    }
  } catch (err) {
    return handleAmazonError(deps, 'sp-orders-sync', job, connection, err, counters);
  }

  const next = await nextSpReportPollAt(deps.db, job);
  if (next !== null) {
    await deps.enqueue(
      'sp-orders-sync',
      { organizationId: job.organizationId, connectionId: job.connectionId },
      {
        startAfterSeconds: Math.max(
          MIN_DELAY_SECONDS,
          Math.ceil((next.getTime() - now().getTime()) / 1000),
        ),
      },
    );
  }
  if (failures.length > 0) {
    throw new JobFailure(
      `${failures.length} Bestellbericht(e) gescheitert: ${failures[0]}`,
      counters,
    );
  }
  return { counters };
}

/** Legt fällige Berichte des Kontos an: einmal die Historie, alle 20 h das rollierende Fenster. */
async function planReports(ctx: Context, account: Account): Promise<number> {
  const now = ctx.now();
  const end = now.getTime() - END_LAG_MS;
  const requests: Array<{ reportType: string; dataStart: Date; dataEnd: Date }> = [];
  const markHistory = account.ordersHistoryRequestedAt === null;
  if (markHistory) {
    // Bis zum Beginn des rollierenden Fensters, das die letzten 30 Tage abdeckt.
    for (let start = end - HISTORY_MS; start < end - WINDOW_MS; start += WINDOW_MS) {
      requests.push({
        reportType: SP_ORDERS_BY_DATE,
        dataStart: new Date(start),
        dataEnd: new Date(Math.min(start + WINDOW_MS, end - WINDOW_MS)),
      });
    }
  }
  const last = await lastSpReportRequestAt(ctx.deps.db, {
    sellerAccountId: account.id,
    reportType: SP_ORDERS_BY_UPDATE,
  });
  if (last === null || now.getTime() - last.getTime() >= ROLLING_INTERVAL_MS) {
    requests.push({
      reportType: SP_ORDERS_BY_UPDATE,
      dataStart: new Date(end - WINDOW_MS),
      dataEnd: new Date(end),
    });
  }
  if (requests.length === 0) return 0;
  // shortcut: Scheitert ein Stück der Historie endgültig, fehlt es (sichtbar im Sync-Status); ein
  // Nachholen einzelner Scheiben kommt, wenn es in der Praxis vorkommt.
  return createSpReportRequests(ctx.deps.db, {
    organizationId: account.organizationId,
    sellerAccountId: account.id,
    requests,
    markHistory,
    now,
  });
}

async function advance(ctx: Context, request: SpReportRequest, account: Account) {
  switch (request.status) {
    case 'pending_request':
      return sendRequest(ctx, request, account);
    case 'requested':
    case 'completed':
      return pollAndImport(ctx, request, account);
    default:
      return request;
  }
}

async function sendRequest(ctx: Context, request: SpReportRequest, account: Account) {
  try {
    const { reportId } = await ctx.client.createReport(
      ctx.connection,
      {
        reportType: request.reportType,
        marketplaceIds: [account.marketplaceId],
        dataStartTime: request.dataStart.toISOString(),
        dataEndTime: request.dataEnd.toISOString(),
      },
      { meter: ctx.run.meter },
    );
    ctx.counters.requested += 1;
    return update(ctx, request, {
      status: 'requested',
      amazonReportId: reportId,
      requestedAt: ctx.now(),
      requestCount: request.requestCount + 1,
      attempts: 0,
      errorCount: 0,
      nextPollAt: addMinutes(ctx.now(), POLL_BACKOFF_MINUTES[0]!),
      failureReason: null,
    });
  } catch (error) {
    return requestFailed(ctx, request, error, 'Amazon hat die Anfrage abgelehnt');
  }
}

async function pollAndImport(ctx: Context, request: SpReportRequest, account: Account) {
  const now = ctx.now();
  let state: Awaited<ReturnType<AmazonSpClient['getReport']>>;
  try {
    state = await ctx.client.getReport(
      ctx.connection,
      { reportId: request.amazonReportId! },
      { meter: ctx.run.meter },
    );
  } catch (error) {
    return requestFailed(ctx, request, error, 'Amazon hat die Status-Abfrage abgelehnt');
  }

  switch (state.status) {
    case 'IN_QUEUE':
    case 'IN_PROGRESS': {
      if (
        now.getTime() - (request.requestedAt ?? request.createdAt).getTime() >
        MAX_REQUEST_AGE_MS
      ) {
        return fail(ctx, request, 'Amazon hat den Bericht nicht innerhalb von 4 h fertiggestellt.');
      }
      const attempts = request.attempts + 1;
      return update(ctx, request, {
        attempts,
        errorCount: 0,
        nextPollAt: addMinutes(now, backoffMinutes(attempts)),
      });
    }
    case 'FATAL':
      return fail(ctx, request, 'Amazon meldet FATAL für den Bericht.');
    case 'CANCELLED':
      // Amazon meldet CANCELLED auch für einen Bericht ohne Daten.
      ctx.counters.imported += 1;
      return update(ctx, request, imported(now, 0, 0));
    case 'NOT_FOUND':
      return requestAgain(ctx, request, 'Amazon kennt den Bericht nicht mehr');
    case 'DONE':
      // Bleibt fällig, bis der Import gelaufen ist (Absturz, Drosselung).
      return importReport(
        ctx,
        await update(ctx, request, { status: 'completed', nextPollAt: now, errorCount: 0 }),
        account,
        state.reportDocumentId,
      );
  }
}

/** Dokument-URL unmittelbar vor dem Download holen (läuft nach 5 Minuten ab), bei `expired` genau einmal neu. */
async function importReport(
  ctx: Context,
  request: SpReportRequest,
  account: Account,
  reportDocumentId: string,
) {
  try {
    let file: Awaited<ReturnType<AmazonSpClient['downloadReportDocument']>> = { status: 'expired' };
    for (let attempt = 0; attempt < 2 && file.status === 'expired'; attempt += 1) {
      const document = await ctx.client.getReportDocument(
        ctx.connection,
        { reportDocumentId },
        { meter: ctx.run.meter },
      );
      file = await ctx.client.downloadReportDocument(document, { maxBytes: MAX_DOWNLOAD_BYTES });
    }
    if (file.status === 'expired')
      return requestAgain(ctx, request, 'Amazon liefert die Datei nicht');

    const { items, invalidRowCount } = parseOrdersReport(file.text, { timeZone: account.timezone });
    const result = await ctx.deps.db.transaction(async (tx) => {
      await importSpOrderItems(tx, {
        organizationId: account.organizationId,
        sellerAccountId: account.id,
        items,
      });
      return updateSpReportRequest(tx, request, imported(ctx.now(), items.length, invalidRowCount));
    });
    ctx.counters.imported += 1;
    ctx.counters.rows += items.length;
    ctx.counters.invalidRows += invalidRowCount;
    return result;
  } catch (error) {
    if (isConnectionError(error)) throw error;
    if (error instanceof AmazonAdsDownloadTooLargeError) {
      return fail(
        ctx,
        request,
        'Die Datei ist entpackt größer als 50 MB und wurde nicht importiert.',
      );
    }
    // shortcut: Auch vorübergehende Fehler beim Holen des Dokuments zählen als Importversuch (die
    // Ads-Maschine trennt das); bei drei Versuchen je Bericht fällt das bisher nicht ins Gewicht.
    const importAttempts = request.importAttempts + 1;
    const reason = `Import fehlgeschlagen: ${errorMessage(error)}`;
    if (importAttempts >= MAX_IMPORT_ATTEMPTS)
      return fail(ctx, request, reason, { importAttempts });
    return update(ctx, request, {
      importAttempts,
      nextPollAt: addMinutes(ctx.now(), IMPORT_RETRY_MINUTES),
      failureReason: sanitize(reason),
    });
  }
}

/** Fehler beim Anfordern oder Abfragen: Connection-Fehler an den Job, 4xx endgültig, sonst später. */
async function requestFailed(
  ctx: Context,
  request: SpReportRequest,
  error: unknown,
  prefix: string,
) {
  if (isConnectionError(error)) throw error;
  if (
    error instanceof AmazonAdsHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  ) {
    const code = error.code ? ` (${error.code})` : '';
    return fail(ctx, request, `${prefix}${code}: ${errorMessage(error)}`);
  }
  const errorCount = request.errorCount + 1;
  if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
    return fail(ctx, request, `${errorCount} Fehler in Folge bei Amazon: ${errorMessage(error)}`);
  }
  return update(ctx, request, {
    errorCount,
    nextPollAt: addMinutes(ctx.now(), backoffMinutes(errorCount)),
    failureReason: sanitize(errorMessage(error)),
  });
}

/** Neu anfordern (höchstens `MAX_REQUESTS` Anforderungen je Auftrag). */
async function requestAgain(ctx: Context, request: SpReportRequest, reason: string) {
  if (request.requestCount >= MAX_REQUESTS) {
    return fail(ctx, request, `${reason}; nach ${MAX_REQUESTS} Anforderungen aufgegeben.`);
  }
  return update(ctx, request, {
    status: 'pending_request',
    amazonReportId: null,
    attempts: 0,
    importAttempts: 0,
    errorCount: 0,
    nextPollAt: ctx.now(),
  });
}

async function fail(
  ctx: Context,
  request: SpReportRequest,
  reason: string,
  extra: SpReportRequestPatch = {},
) {
  ctx.counters.failed += 1;
  ctx.deps.logger({
    level: 'warn',
    msg: 'sp_orders.report_failed',
    requestId: request.id,
    reportType: request.reportType,
  });
  return update(ctx, request, {
    ...extra,
    status: 'failed',
    nextPollAt: null,
    failureReason: sanitize(reason),
  });
}

const imported = (now: Date, rowCount: number, invalidRowCount: number): SpReportRequestPatch => ({
  status: 'imported',
  importedAt: now,
  rowCount,
  invalidRowCount,
  nextPollAt: null,
  failureReason: null,
});

const update = (ctx: Context, request: SpReportRequest, patch: SpReportRequestPatch) =>
  updateSpReportRequest(ctx.deps.db, request, patch);

const backoffMinutes = (attempts: number) =>
  POLL_BACKOFF_MINUTES[Math.min(attempts, POLL_BACKOFF_MINUTES.length - 1)]!;

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE_MS);

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Unbekannter Fehler.';

/** Ohne URLs (signierte Download-Links) und gekürzt. */
function sanitize(reason: string): string {
  const cleaned = reason.replace(/https?:\/\/\S+/g, '[URL]');
  return cleaned.length > MAX_FAILURE_REASON_LENGTH
    ? `${cleaned.slice(0, MAX_FAILURE_REASON_LENGTH - 2)} …`
    : cleaned;
}
