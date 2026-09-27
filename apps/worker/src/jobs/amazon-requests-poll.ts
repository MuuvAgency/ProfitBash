import {
  listDueAmazonRequests,
  nextAmazonRequestPollAt,
  updateAmazonRequest,
} from '@profitbash/db';
import { advanceAmazonRequest } from '../amazon-requests/state-machine';
import type { JobCounters, JobOutcome } from '../run-job';
import {
  addCounters,
  createAmazonJobContext,
  exportSlotFree,
  MAX_RUNNING_EXPORTS_PER_TYPE,
} from './amazon-context';
import {
  handleAmazonError,
  loadConnection,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionJobRun,
} from './connection-job';

export { MAX_RUNNING_EXPORTS_PER_TYPE };

/**
 * Grenzen je Lauf: Der Job bleibt kurz (1.7), der Rest folgt im sofort eingeplanten nächsten Lauf.
 * `maxDownloads` begrenzt Dateien (bis 50 MB entpackt je Datei), `timeBudgetMs` die Laufzeit unter dem
 * Ablauf der Jobs in pg-boss (10 Min.).
 */
export const POLL_LIMITS = { maxRequests: 20, maxDownloads: 5, timeBudgetMs: 5 * 60_000 };
/** Frühester Neustart, wenn noch Arbeit fällig ist. */
export const POLL_MIN_DELAY_SECONDS = 5;
/** Ein Export ohne freien Platz wartet so lange. */
const EXPORT_WAIT_MS = 60_000;

/**
 * `amazon-requests-poll` je Connection (1.7): führt fällige Aufträge einen Schritt weiter (anfordern,
 * Status, laden und importieren, siehe Zustandsmaschine) und plant sich für den nächsten fälligen
 * Auftrag neu ein. Ein Fehler der Connection beendet den Lauf (`handleAmazonError`). Pingt keinen
 * Healthcheck (läuft oft und kurz); gescheiterte Aufträge zählt `reports-sync` (`failedSinceLastRun`).
 */
export async function pollAmazonRequests(
  deps: ConnectionJobDeps,
  job: ConnectionJobData,
  run: ConnectionJobRun,
): Promise<JobOutcome> {
  const connection = await loadConnection(deps.db, job);
  const context = await createAmazonJobContext(deps, connection, run);
  const { machine, importer, now } = context;
  const ref = { organizationId: connection.organizationId, connectionId: connection.id };
  const counters: JobCounters = {
    requested: 0,
    reused: 0,
    imported: 0,
    rows: 0,
    superseded: 0,
    failed: 0,
    exportsWaiting: 0,
  };

  const startedAt = now().getTime();
  const due = await listDueAmazonRequests(deps.db, {
    ...ref,
    now: now(),
    limit: POLL_LIMITS.maxRequests,
  });
  let downloads = 0;
  try {
    for (const request of due) {
      if (downloads >= POLL_LIMITS.maxDownloads) break;
      if (now().getTime() - startedAt > POLL_LIMITS.timeBudgetMs) break;

      if (
        request.kind === 'export' &&
        request.status === 'pending_request' &&
        !(await exportSlotFree(deps, connection, request.reportType))
      ) {
        await updateAmazonRequest(deps.db, request, {
          nextPollAt: new Date(now().getTime() + EXPORT_WAIT_MS),
        });
        counters.exportsWaiting = (counters.exportsWaiting ?? 0) + 1;
        continue;
      }

      await run.extendLease();
      importer.takeCounters();
      const result = await advanceAmazonRequest(machine, request);
      addCounters(counters, result.counters);
      if (result.request.status === 'imported') addCounters(counters, importer.takeCounters());
      downloads += (result.counters.imported ?? 0) - (result.counters.superseded ?? 0);
    }
  } catch (err) {
    return handleAmazonError(deps, 'amazon-requests-poll', job, connection, err);
  }

  await schedulePoll(deps, job, now());
  return { counters };
}

/**
 * Plant den nächsten Poll zum frühesten Termin offener Aufträge der Connection ein (nichts offen: kein
 * Poll). Wartet für die Connection schon einer, bleibt es bei ihm.
 */
export async function schedulePoll(
  deps: ConnectionJobDeps,
  job: ConnectionJobData,
  now: Date,
): Promise<void> {
  const next = await nextAmazonRequestPollAt(deps.db, job);
  if (next === null) return;
  const startAfterSeconds = Math.max(
    POLL_MIN_DELAY_SECONDS,
    Math.ceil((next.getTime() - now.getTime()) / 1000),
  );
  await deps.enqueue(
    'amazon-requests-poll',
    { organizationId: job.organizationId, connectionId: job.connectionId },
    { startAfterSeconds },
  );
}
