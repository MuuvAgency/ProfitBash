import {
  AmazonAdsDownloadTooLargeError,
  AmazonAdsHttpError,
  AmazonAdsReauthRequiredError,
  decodeGzipJson,
} from '@profitbash/amazon-ads';
import {
  ConnectionReauthRequiredError,
  createAmazonExportBatch,
  createAmazonRequest,
  findAmazonRequest,
  listAmazonRequestBatch,
  listNewerImportedReportRanges,
  updateAmazonRequest,
  updateAmazonRequestBatch,
  type AmazonRequest,
  type AmazonRequestPatch,
  type AmazonRequestRef,
  type Db,
  type DbOrTx,
  type NewAmazonRequest,
} from '@profitbash/db';
import type { Logger } from '@profitbash/shared';
import type { z } from 'zod';
import { subtractDateRanges, type DateRange } from './date-ranges';

/**
 * Zustandsmaschine der asynchronen Amazon-Aufträge (Reports und Exports, Phase 1, 1.4):
 * `pending_request` → `requested` → `completed` → `imported`, oder `failed`. Der Zustand liegt in
 * `amazon_ads_report_requests`; jeder Schritt liest die Zeile frisch und schreibt das Ergebnis sofort,
 * damit ein Neustart an jeder Stelle nichts verliert. Amazon kommt über eine schmale Schnittstelle
 * (`AmazonRequestPort`, echte Umsetzung in 1.6); Jobs und Dispatcher (1.7) rufen `submitAmazonRequest`
 * und `advanceAmazonRequest`.
 *
 * Fehler der Connection (abgelehnter Refresh-Token, Drosselung mit oder ohne `Retry-After`) gehen
 * unverändert an den Job (`handleAmazonError`); der Auftrag bleibt dann, wie er war.
 */

// ---------------------------------------------------------------------------
// Schnittstelle zu Amazon
// ---------------------------------------------------------------------------

/** Antwort auf „anfordern“. `duplicate` = HTTP 425: eine identische Anfrage läuft noch. */
export type AmazonRequestSubmission =
  | { status: 'requested'; amazonRequestId: string }
  | { status: 'duplicate'; amazonRequestId: string | null };

/** Antwort auf „Status“, vereinheitlicht für Reports und Exports. */
export type AmazonRequestState =
  | { status: 'PENDING' | 'PROCESSING' }
  | { status: 'COMPLETED'; url: string | null }
  | { status: 'FAILURE'; failureReason: string | null }
  /** Amazon kennt die ID nicht (mehr). */
  | { status: 'NOT_FOUND' };

/** Antwort auf „laden“: der gzip-Body oder `expired` (signierte URL abgelaufen bzw. Datei weg). */
export type AmazonDownload =
  { status: 'ok'; body: AsyncIterable<Uint8Array> } | { status: 'expired' };

export interface AmazonRequestFile {
  request: AmazonRequest;
  /** Gültige Zeilen (Ausgabe von `rowSchema`). */
  rows: unknown[];
  invalidRowCount: number;
}

export type AmazonImportInput =
  | ({ kind: 'report'; ranges: DateRange[] } & AmazonRequestFile)
  | { kind: 'export'; batchId: string; files: AmazonRequestFile[] };

export interface AmazonRequestPort {
  request(request: AmazonRequest): Promise<AmazonRequestSubmission>;
  /** Nur für Aufträge mit `amazonRequestId`. */
  getStatus(request: AmazonRequest): Promise<AmazonRequestState>;
  download(request: AmazonRequest, url: string): Promise<AmazonDownload>;
  /** zod-Schema je Zeile der Datei (z. B. je Report-Typ). */
  rowSchema(request: AmazonRequest): z.ZodType;
  /**
   * Schreibt die Zeilen in der übergebenen Transaktion. Reports: nur die Tage in `ranges` ersetzen
   * (Regeln in 1.5). Exports: der ganze Batch auf einmal (Regeln in 1.7).
   */
  import(tx: DbOrTx, input: AmazonImportInput): Promise<void>;
}

export interface AmazonRequestDeps {
  db: Db;
  logger: Logger;
  port: AmazonRequestPort;
  now: () => Date;
  /** Deckel für den entpackten Inhalt einer Datei. Standard `MAX_DOWNLOAD_BYTES`. */
  maxDownloadBytes?: number;
}

/** Zähler für `job_runs.counters` des aufrufenden Jobs. */
export type AmazonRequestCounters = Partial<
  Record<'requested' | 'reused' | 'imported' | 'rows' | 'superseded' | 'failed', number>
>;

export interface AmazonRequestResult {
  /** Stand der Zeile nach dem Schritt. */
  request: AmazonRequest;
  counters: AmazonRequestCounters;
}

// ---------------------------------------------------------------------------
// Regeln
// ---------------------------------------------------------------------------

/** Wartezeit bis zur nächsten Status-Abfrage, nach Zahl der bisherigen Abfragen (dann konstant). */
export const POLL_BACKOFF_MINUTES = [1, 2, 5, 10, 15] as const;
/** 425 ohne Report-ID: so lange warten, dann erneut anfordern. */
export const DUPLICATE_RETRY_MINUTES = 15;
/** Nach einem gescheiterten Import so viel später erneut laden. */
export const IMPORT_RETRY_MINUTES = 5;
export const MAX_IMPORT_ATTEMPTS = 3;
/**
 * Vorübergehende Fehler in Folge (5xx, Netzwerk), bis ein Auftrag scheitert. Mit dem Backoff sind das
 * rund 2 h ohne Antwort von Amazon. Bewusst kein Alter: Ein Auftrag, den nur wir lange nicht abgefragt
 * haben (Absturz, Deploy), scheitert nicht am ersten Fehler danach.
 */
export const MAX_CONSECUTIVE_ERRORS = 10;
/** So oft wird ein Report höchstens angefordert (erstes Anfordern plus Neu-Anfordern, wenn die Datei fehlt). */
export const MAX_REQUESTS = 3;
/** Amazon braucht bis zu 3 h; danach gilt ein Auftrag als verloren. */
export const MAX_REQUEST_AGE_MS = 4 * 60 * 60 * 1000;
/** Entpackte Größe je Datei. Schützt den Speicher, auch bei `WORKER_MODE=inline`. */
export const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;

const MINUTE_MS = 60 * 1000;
const MAX_FAILURE_REASON_LENGTH = 500;
/** So viele ungültige Zeilen je Datei werden einzeln geloggt. */
const MAX_INVALID_ROW_LOGS = 5;

const TOO_OLD_REASON = 'Amazon hat den Auftrag nicht innerhalb von 4 h fertiggestellt.';

// ---------------------------------------------------------------------------
// Einstiegspunkte
// ---------------------------------------------------------------------------

/** Ein Report-Auftrag (Exports laufen immer als Batch, siehe `submitAmazonExportBatch`). */
export type NewAmazonReportRequest = Omit<NewAmazonRequest, 'now' | 'kind' | 'batchId'> & {
  kind: 'report';
  batchId?: null;
};

/**
 * Legt einen Report-Auftrag an und fordert ihn bei Amazon an: erst die Zeile (`pending_request`),
 * dann der Aufruf, dann die ID. Ist schon ein gleicher Auftrag offen, bleibt es bei diesem (kein Aufruf).
 */
export async function submitAmazonRequest(
  deps: AmazonRequestDeps,
  input: NewAmazonReportRequest,
): Promise<AmazonRequestResult> {
  const { created, request } = await createAmazonRequest(deps.db, {
    ...input,
    batchId: null,
    now: deps.now(),
  });
  if (!created) return { request, counters: {} };
  return sendRequest(deps, request);
}

/**
 * Legt die Exports eines Entity-Syncs (ein Profil, ein Ad-Typ) als Batch an (alle Zeilen in einer
 * Transaktion) und fordert sie nacheinander an. Scheitert einer endgültig, scheitert der Batch und die
 * übrigen werden nicht mehr angefordert. Ist für Profil und Ad-Typ noch ein Export offen, entsteht kein
 * neuer Batch (Ergebnis: die offenen Exports, keine Aufrufe). Bleiben Zeilen nach einem Fehler der
 * Connection auf `pending_request`, fordert sie der nächste Poll an.
 */
export async function submitAmazonExportBatch(
  deps: AmazonRequestDeps,
  input: {
    organizationId: string;
    profileId: string;
    adProduct: string;
    exportTypes: readonly string[];
  },
): Promise<{ requests: AmazonRequest[]; counters: AmazonRequestCounters }> {
  const { created, requests } = await createAmazonExportBatch(deps.db, {
    ...input,
    now: deps.now(),
  });
  if (!created) return { requests, counters: {} };

  const counters: AmazonRequestCounters = {};
  for (const request of requests) {
    const result = await sendRequest(deps, request);
    addCounters(counters, result.counters);
    if (result.request.status === 'failed') break;
  }
  const batch = await listAmazonRequestBatch(deps.db, {
    organizationId: input.organizationId,
    batchId: requireBatchId(requests[0]!),
  });
  return { requests: batch, counters };
}

/** Führt den nächsten Schritt eines Auftrags aus (je nach Zustand anfordern, abfragen, importieren). */
export async function advanceAmazonRequest(
  deps: AmazonRequestDeps,
  ref: AmazonRequestRef,
): Promise<AmazonRequestResult> {
  const request = await findAmazonRequest(deps.db, ref);
  if (!request) throw new Error('Amazon-Auftrag nicht gefunden.');
  switch (request.status) {
    case 'pending_request':
      return sendRequest(deps, request);
    case 'requested':
      return pollStatus(deps, request);
    case 'completed':
      return request.kind === 'report'
        ? fetchAndImportReport(deps, request, null)
        : importExportBatch(deps, request);
    case 'imported':
    case 'failed':
      return { request, counters: {} };
  }
}

// ---------------------------------------------------------------------------
// Anfordern
// ---------------------------------------------------------------------------

async function sendRequest(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
): Promise<AmazonRequestResult> {
  const now = deps.now();
  let submission: AmazonRequestSubmission;
  try {
    submission = await deps.port.request(request);
  } catch (error) {
    if (isConnectionError(error)) throw error;
    if (isPermanentHttpError(error)) {
      return failRequestOrBatch(
        deps,
        request,
        `Amazon hat die Anfrage abgelehnt: ${errorMessage(error)}`,
      );
    }
    return retryLater(deps, request, error);
  }

  if (submission.status === 'duplicate' && submission.amazonRequestId === null) {
    deps.logger({
      level: 'warn',
      msg: 'amazon_requests.duplicate_without_id',
      requestId: request.id,
      reportType: request.reportType,
    });
    if (isTooOld(request, now)) {
      return failRequestOrBatch(
        deps,
        request,
        'Amazon meldet seit über 4 h eine laufende identische Anfrage.',
      );
    }
    const updated = await update(deps, request, {
      errorCount: 0,
      nextPollAt: addMinutes(now, DUPLICATE_RETRY_MINUTES),
    });
    return { request: updated, counters: {} };
  }

  const updated = await update(deps, request, {
    status: 'requested',
    amazonRequestId: submission.amazonRequestId,
    // Bei 425 mit ID lief der übernommene Report schon etwas früher; für die Reihenfolge (neuere
    // Importe gewinnen) ist der Zeitpunkt damit höchstens etwas zu spät angesetzt.
    requestedAt: now,
    attempts: 0,
    errorCount: 0,
    requestCount: request.requestCount + 1,
    nextPollAt: addMinutes(now, POLL_BACKOFF_MINUTES[0]),
    failureReason: null,
  });
  return {
    request: updated,
    counters: submission.status === 'requested' ? { requested: 1 } : { reused: 1 },
  };
}

/**
 * Setzt einen Report zurück auf `pending_request` und fordert ihn sofort neu an, höchstens bis
 * `MAX_REQUESTS` Anforderungen (sonst forderte ein dauerhaft fehlender Download endlos neu an).
 */
async function requestAgain(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
): Promise<AmazonRequestResult> {
  if (request.requestCount >= MAX_REQUESTS) {
    return fail(
      deps,
      request,
      `Amazon liefert den Report nicht mehr; nach ${MAX_REQUESTS} Anforderungen aufgegeben.`,
    );
  }
  const reset = await update(deps, request, {
    status: 'pending_request',
    amazonRequestId: null,
    attempts: 0,
    importAttempts: 0,
    errorCount: 0,
    // Beginn des neuen Anforderns (für die 4-h-Regel, falls Amazon wieder mit 425 antwortet).
    requestedAt: deps.now(),
    completedAt: null,
    nextPollAt: deps.now(),
  });
  return sendRequest(deps, reset);
}

// ---------------------------------------------------------------------------
// Status
// ---------------------------------------------------------------------------

async function pollStatus(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
): Promise<AmazonRequestResult> {
  const now = deps.now();
  let state: AmazonRequestState;
  try {
    state = await deps.port.getStatus(request);
  } catch (error) {
    if (isConnectionError(error)) throw error;
    if (isPermanentHttpError(error)) {
      return failRequestOrBatch(
        deps,
        request,
        `Amazon hat die Status-Abfrage abgelehnt: ${errorMessage(error)}`,
      );
    }
    return retryLater(deps, request, error);
  }

  switch (state.status) {
    case 'PENDING':
    case 'PROCESSING': {
      if (isTooOld(request, now)) return failRequestOrBatch(deps, request, TOO_OLD_REASON);
      const attempts = request.attempts + 1;
      const updated = await update(deps, request, {
        attempts,
        errorCount: 0,
        nextPollAt: addMinutes(now, backoffMinutes(attempts)),
        failureReason: null,
      });
      return { request: updated, counters: {} };
    }
    case 'FAILURE':
      return failRequestOrBatch(
        deps,
        request,
        state.failureReason ?? 'Amazon meldet FAILURE ohne Grund.',
      );
    case 'NOT_FOUND':
      if (request.kind === 'export') {
        return failRequestOrBatch(deps, request, 'Amazon kennt den Export nicht mehr.');
      }
      return requestAgain(deps, request);
    case 'COMPLETED': {
      const completed = await update(deps, request, {
        status: 'completed',
        completedAt: now,
        attempts: request.attempts + 1,
        errorCount: 0,
        // Bleibt fällig, bis der Import gelaufen ist: Bricht er ab (Absturz, Drosselung), holt der
        // nächste Poll ihn nach. Exports, deren Batch noch nicht fertig ist, warten ohne Termin.
        nextPollAt: now,
        failureReason: null,
      });
      return completed.kind === 'report'
        ? fetchAndImportReport(deps, completed, state.url)
        : importExportBatch(deps, completed);
    }
  }
}

// ---------------------------------------------------------------------------
// Laden und Importieren
// ---------------------------------------------------------------------------

type FileResult =
  | { status: 'ok'; file: AmazonRequestFile }
  /** Amazon liefert die Datei nicht mehr (auch nach frischer Status-Abfrage). */
  | { status: 'gone' }
  | { status: 'too_large'; reason: string };

/**
 * Lädt die Datei eines fertigen Auftrags. `url` aus einer gerade gelaufenen Status-Abfrage, sonst
 * wird sie frisch geholt. Ist sie abgelaufen, genau eine weitere Status-Abfrage.
 */
async function loadFile(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
  url: string | null,
): Promise<FileResult> {
  let currentUrl = url ?? (await freshUrl(deps, request));
  let download: AmazonDownload | null =
    currentUrl === null ? null : await deps.port.download(request, currentUrl);
  if (download?.status === 'expired' && url !== null) {
    currentUrl = await freshUrl(deps, request);
    download = currentUrl === null ? null : await deps.port.download(request, currentUrl);
  }
  if (download === null || download.status === 'expired') return { status: 'gone' };

  let content: unknown;
  try {
    content = await decodeGzipJson(download.body, {
      maxBytes: deps.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES,
      operation: `${request.kind}.download`,
    });
  } catch (error) {
    if (error instanceof AmazonAdsDownloadTooLargeError) {
      return {
        status: 'too_large',
        reason: `Die Datei ist entpackt größer als ${formatBytes(error.maxBytes)} und wurde nicht importiert.`,
      };
    }
    throw error;
  }
  if (!Array.isArray(content)) {
    throw new Error('Die Datei enthält keine Liste von Zeilen.');
  }
  return { status: 'ok', file: validateRows(deps, request, content) };
}

/**
 * Fehler der Status-Abfrage beim Laden: kein gescheiterter Import, sondern wie ein Fehler der
 * Status-Abfrage behandelt (später erneut bzw. bei 4xx endgültig).
 */
class StatusQueryError extends Error {
  constructor(public readonly original: unknown) {
    super(errorMessage(original));
    this.name = 'StatusQueryError';
  }
}

/** Frische Download-URL per Status-Abfrage; `null`, wenn Amazon keine (mehr) liefert. */
async function freshUrl(deps: AmazonRequestDeps, request: AmazonRequest): Promise<string | null> {
  let state: AmazonRequestState;
  try {
    state = await deps.port.getStatus(request);
  } catch (error) {
    if (isConnectionError(error)) throw error;
    throw new StatusQueryError(error);
  }
  return state.status === 'COMPLETED' ? state.url : null;
}

/** Fehler der Status-Abfrage beim Laden: bei 4xx endgültig, sonst später erneut. */
function statusQueryFailed(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
  error: StatusQueryError,
): Promise<AmazonRequestResult> {
  return isPermanentHttpError(error.original)
    ? failRequestOrBatch(deps, request, `Amazon hat die Status-Abfrage abgelehnt: ${error.message}`)
    : retryLater(deps, request, error.original);
}

function validateRows(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
  content: unknown[],
): AmazonRequestFile {
  const schema = deps.port.rowSchema(request);
  const rows: unknown[] = [];
  let invalidRowCount = 0;
  content.forEach((raw, index) => {
    const parsed = schema.safeParse(raw);
    if (parsed.success) {
      rows.push(parsed.data);
      return;
    }
    invalidRowCount += 1;
    if (invalidRowCount <= MAX_INVALID_ROW_LOGS) {
      // Nur Pfade und Codes, nie Werte (Kundendaten).
      deps.logger({
        level: 'warn',
        msg: 'amazon_requests.invalid_row',
        requestId: request.id,
        reportType: request.reportType,
        index,
        issues: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.map(String).join('.'),
          code: issue.code,
        })),
      });
    }
  });
  if (invalidRowCount > 0) {
    deps.logger({
      level: 'warn',
      msg: 'amazon_requests.invalid_rows',
      requestId: request.id,
      reportType: request.reportType,
      invalidRowCount,
    });
  }
  return { request, rows, invalidRowCount };
}

async function fetchAndImportReport(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
  url: string | null,
): Promise<AmazonRequestResult> {
  // Vollständig überholt: kein Download nötig.
  if ((await uncoveredRanges(deps.db, request)).length === 0) {
    return markSuperseded(deps, deps.db, request);
  }

  try {
    const loaded = await loadFile(deps, request, url);
    if (loaded.status === 'gone') return requestAgain(deps, request);
    if (loaded.status === 'too_large') return fail(deps, request, loaded.reason);

    const { file } = loaded;
    return await deps.db.transaction(async (tx) => {
      // Erneut in der Transaktion: Ein neuerer Auftrag kann inzwischen importiert sein.
      const ranges = await uncoveredRanges(tx, request);
      if (ranges.length === 0) return markSuperseded(deps, tx, request);
      await deps.port.import(tx, { kind: 'report', ranges, ...file });
      const imported = await updateAmazonRequest(tx, request, {
        status: 'imported',
        importedAt: deps.now(),
        rowCount: file.rows.length,
        invalidRowCount: file.invalidRowCount,
        errorCount: 0,
        nextPollAt: null,
        failureReason: null,
      });
      return { request: imported, counters: { imported: 1, rows: file.rows.length } };
    });
  } catch (error) {
    if (isConnectionError(error)) throw error;
    if (error instanceof StatusQueryError) return statusQueryFailed(deps, request, error);
    return importFailed(deps, request, error);
  }
}

async function markSuperseded(
  deps: AmazonRequestDeps,
  db: DbOrTx,
  request: AmazonRequest,
): Promise<AmazonRequestResult> {
  const imported = await updateAmazonRequest(db, request, {
    status: 'imported',
    importedAt: deps.now(),
    rowCount: 0,
    invalidRowCount: 0,
    nextPollAt: null,
    failureReason: null,
  });
  return { request: imported, counters: { imported: 1, superseded: 1 } };
}

/** Tage des Reports, die kein später angeforderter, schon importierter Report abdeckt. */
async function uncoveredRanges(db: DbOrTx, request: AmazonRequest): Promise<DateRange[]> {
  if (!request.startDate || !request.endDate) throw new Error('Report ohne Zeitraum.');
  const newer = await listNewerImportedReportRanges(db, request);
  return subtractDateRanges({ startDate: request.startDate, endDate: request.endDate }, newer);
}

async function importFailed(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
  error: unknown,
): Promise<AmazonRequestResult> {
  const importAttempts = request.importAttempts + 1;
  const reason = `Import fehlgeschlagen: ${errorMessage(error)}`;
  deps.logger({
    level: 'warn',
    msg: 'amazon_requests.import_failed',
    requestId: request.id,
    reportType: request.reportType,
    importAttempts,
  });
  if (importAttempts >= MAX_IMPORT_ATTEMPTS) return fail(deps, request, reason, { importAttempts });
  const updated = await update(deps, request, {
    importAttempts,
    errorCount: 0,
    nextPollAt: addMinutes(deps.now(), IMPORT_RETRY_MINUTES),
    failureReason: sanitizeReason(reason),
  });
  return { request: updated, counters: {} };
}

// ---------------------------------------------------------------------------
// Exports je Batch
// ---------------------------------------------------------------------------

/**
 * Importiert einen Export-Batch, sobald alle seine Exports fertig sind, gemeinsam in einer
 * Transaktion. Einzelne Exports werden nie neu angefordert (sonst mischten sich Stände verschiedener
 * Zeitpunkte): Scheitert einer, scheitert der Batch; der nächste Entity-Sync startet einen neuen.
 */
async function importExportBatch(
  deps: AmazonRequestDeps,
  trigger: AmazonRequest,
): Promise<AmazonRequestResult> {
  const batchId = requireBatchId(trigger);
  const batch = await listAmazonRequestBatch(deps.db, {
    organizationId: trigger.organizationId,
    batchId,
  });
  if (!batch.every((request) => request.status === 'completed')) {
    // Der Import wartet auf die übrigen Exports; der zuletzt fertige stößt ihn an.
    const waiting = await update(deps, trigger, { nextPollAt: null });
    return { request: waiting, counters: {} };
  }

  try {
    const files: AmazonRequestFile[] = [];
    for (const request of batch) {
      const loaded = await loadFile(deps, request, null);
      if (loaded.status === 'gone') {
        return await failBatch(deps, request, 'Amazon liefert die Export-Datei nicht mehr.');
      }
      if (loaded.status === 'too_large') return await failBatch(deps, request, loaded.reason);
      files.push(loaded.file);
    }

    return await deps.db.transaction(async (tx) => {
      await deps.port.import(tx, { kind: 'export', batchId, files });
      const now = deps.now();
      const imported = await Promise.all(
        files.map((file) =>
          updateAmazonRequest(tx, file.request, {
            status: 'imported',
            importedAt: now,
            rowCount: file.rows.length,
            invalidRowCount: file.invalidRowCount,
            nextPollAt: null,
            failureReason: null,
          }),
        ),
      );
      const rows = files.reduce((sum, file) => sum + file.rows.length, 0);
      return {
        request: imported.find((request) => request.id === trigger.id) ?? trigger,
        counters: { imported: files.length, rows },
      };
    });
  } catch (error) {
    if (isConnectionError(error)) throw error;
    if (error instanceof StatusQueryError) return statusQueryFailed(deps, trigger, error);
    return batchImportFailed(deps, trigger, batch, error);
  }
}

/** Importversuche zählen je Batch; wieder fällig wird nur der auslösende Auftrag. */
async function batchImportFailed(
  deps: AmazonRequestDeps,
  trigger: AmazonRequest,
  batch: AmazonRequest[],
  error: unknown,
): Promise<AmazonRequestResult> {
  const importAttempts = Math.max(...batch.map((request) => request.importAttempts)) + 1;
  const reason = `Import fehlgeschlagen: ${errorMessage(error)}`;
  deps.logger({
    level: 'warn',
    msg: 'amazon_requests.import_failed',
    requestId: trigger.id,
    batchId: trigger.batchId,
    importAttempts,
  });
  const batchRef = { organizationId: trigger.organizationId, batchId: requireBatchId(trigger) };
  // Eine Transaktion: Ein Absturz dazwischen ließe sonst keinen fälligen Auftrag im Batch zurück.
  return deps.db.transaction(async (tx) => {
    if (importAttempts >= MAX_IMPORT_ATTEMPTS) {
      await updateAmazonRequestBatch(tx, batchRef, { importAttempts });
      return failBatch(deps, trigger, reason, tx);
    }
    await updateAmazonRequestBatch(tx, batchRef, {
      importAttempts,
      nextPollAt: null,
      failureReason: sanitizeReason(reason),
    });
    const updated = await updateAmazonRequest(tx, trigger, {
      nextPollAt: addMinutes(deps.now(), IMPORT_RETRY_MINUTES),
    });
    return { request: updated, counters: {} };
  });
}

/** Der Auftrag scheitert mit `reason`, die übrigen offenen Exports seines Batches mit Verweis darauf. */
async function failBatch(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
  reason: string,
  db: DbOrTx = deps.db,
): Promise<AmazonRequestResult> {
  const batchId = requireBatchId(request);
  return db.transaction(async (tx) => {
    const batch = await listAmazonRequestBatch(tx, {
      organizationId: request.organizationId,
      batchId,
    });
    const open = batch.filter((row) => row.status !== 'imported' && row.status !== 'failed');
    let failed: AmazonRequest = request;
    for (const row of open) {
      const updated = await updateAmazonRequest(tx, row, {
        status: 'failed',
        nextPollAt: null,
        failureReason: sanitizeReason(
          row.id === request.id
            ? reason
            : `Ein anderer Export des Batches ist gescheitert: ${reason}`,
        ),
      });
      if (row.id === request.id) failed = updated;
    }
    deps.logger({
      level: 'warn',
      msg: 'amazon_requests.failed',
      requestId: request.id,
      batchId,
      failedRequests: open.length,
    });
    return { request: failed, counters: { failed: open.length } };
  });
}

// ---------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------

function failRequestOrBatch(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
  reason: string,
): Promise<AmazonRequestResult> {
  return request.kind === 'export' ? failBatch(deps, request, reason) : fail(deps, request, reason);
}

async function fail(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
  reason: string,
  extra: AmazonRequestPatch = {},
): Promise<AmazonRequestResult> {
  const updated = await update(deps, request, {
    ...extra,
    status: 'failed',
    nextPollAt: null,
    failureReason: sanitizeReason(reason),
  });
  deps.logger({
    level: 'warn',
    msg: 'amazon_requests.failed',
    requestId: request.id,
    reportType: request.reportType,
  });
  return { request: updated, counters: { failed: 1 } };
}

/**
 * Vorübergehender Fehler beim Anfordern oder Abfragen: mit Backoff später erneut, nach
 * `MAX_CONSECUTIVE_ERRORS` Fehlern in Folge endgültig.
 */
async function retryLater(
  deps: AmazonRequestDeps,
  request: AmazonRequest,
  error: unknown,
): Promise<AmazonRequestResult> {
  const reason = errorMessage(error);
  const errorCount = request.errorCount + 1;
  if (errorCount >= MAX_CONSECUTIVE_ERRORS) {
    return failRequestOrBatch(
      deps,
      request,
      `${errorCount} Fehler in Folge bei Amazon. Letzter Fehler: ${reason}`,
    );
  }
  const updated = await update(deps, request, {
    attempts: request.attempts + 1,
    errorCount,
    nextPollAt: addMinutes(deps.now(), backoffMinutes(errorCount)),
    failureReason: sanitizeReason(reason),
  });
  return { request: updated, counters: {} };
}

function update(deps: AmazonRequestDeps, request: AmazonRequest, patch: AmazonRequestPatch) {
  return updateAmazonRequest(deps.db, request, patch);
}

/** Alter seit dem (letzten) Anfordern, vor dem ersten Anfordern seit dem Anlegen. */
function isTooOld(request: AmazonRequest, now: Date): boolean {
  const since = request.requestedAt ?? request.createdAt;
  return now.getTime() - since.getTime() > MAX_REQUEST_AGE_MS;
}

function backoffMinutes(attempts: number): number {
  return POLL_BACKOFF_MINUTES[Math.min(attempts, POLL_BACKOFF_MINUTES.length - 1)]!;
}

const addMinutes = (date: Date, minutes: number) => new Date(date.getTime() + minutes * MINUTE_MS);

function addCounters(target: AmazonRequestCounters, source: AmazonRequestCounters): void {
  for (const [key, value] of Object.entries(source) as Array<
    [keyof AmazonRequestCounters, number]
  >) {
    target[key] = (target[key] ?? 0) + value;
  }
}

function requireBatchId(request: AmazonRequest): string {
  if (!request.batchId) throw new Error('Export ohne Batch.');
  return request.batchId;
}

/** Fehler, die die ganze Connection betreffen: gehen an den Job, der Auftrag bleibt unverändert. */
function isConnectionError(error: unknown): boolean {
  if (error instanceof AmazonAdsReauthRequiredError) return true;
  if (error instanceof ConnectionReauthRequiredError) return true;
  return (
    error instanceof AmazonAdsHttpError && (error.status === 429 || error.retryAfterMs !== null)
  );
}

/** 4xx außer 408/425/429: Amazon lehnt die Anfrage selbst ab, eine Wiederholung ändert nichts. */
function isPermanentHttpError(error: unknown): boolean {
  return (
    error instanceof AmazonAdsHttpError &&
    error.status >= 400 &&
    error.status < 500 &&
    ![408, 425, 429].includes(error.status)
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unbekannter Fehler.';
}

/** Ohne URLs (signierte Download-Links) und gekürzt. */
function sanitizeReason(reason: string): string {
  const cleaned = reason.replace(/https?:\/\/\S+/g, '[URL]');
  return cleaned.length > MAX_FAILURE_REASON_LENGTH
    ? `${cleaned.slice(0, MAX_FAILURE_REASON_LENGTH - 2)} …`
    : cleaned;
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${bytes} Bytes`;
}
