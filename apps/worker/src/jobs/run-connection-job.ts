import { randomUUID } from 'node:crypto';
import { createRequestMeter } from '@profitbash/amazon-ads';
import {
  acquireConnectionLease,
  errorLogFields,
  findJobConnection,
  releaseConnectionLease,
  type Db,
} from '@profitbash/db';
import type { Logger } from '@profitbash/shared';
import { JobFailure, type JobOutcome, type JobRunResult, type RunJob } from '../run-job';
import {
  CONNECTION_LEASE_SECONDS,
  CONNECTION_NOT_FOUND_MESSAGE,
  LEASE_DEFER_SECONDS,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionJobRun,
  type ConnectionQueue,
} from './connection-job';

export interface ConnectionJobDefinition {
  run(deps: ConnectionJobDeps, job: ConnectionJobData, run: ConnectionJobRun): Promise<JobOutcome>;
  /**
   * Amazon-Datenjob: läuft nur mit der Lease der Connection (höchstens ein Datenjob je Connection,
   * auch über Queues hinweg) und schreibt die Anfragezähler. `token-refresh` braucht sie nicht, der
   * Token-Store serialisiert LWA über die Zeilensperre.
   */
  lease: boolean;
}

export interface RunConnectionJobContext {
  db: Db;
  logger: Logger;
  runJob: RunJob;
  deps: ConnectionJobDeps;
  /** Plant denselben Job später erneut ein; `false`, wenn für die Connection schon einer wartet. */
  defer(
    queue: ConnectionQueue,
    job: ConnectionJobData,
    startAfterSeconds: number,
  ): Promise<boolean>;
}

export type ConnectionJobResult = JobRunResult | { status: 'deferred'; queued: boolean };

/**
 * Führt einen Job je Connection aus. Datenjobs nehmen vorher die Lease der Connection; ist sie belegt,
 * entsteht kein Lauf, sondern derselbe Job startet `LEASE_DEFER_SECONDS` später erneut (Zähler
 * `deferred` im späteren Lauf). Wartet schon ein Job der Queue auf die Connection (pg-boss `stately`),
 * fällt dieser weg: Der wartende erledigt dieselbe Arbeit.
 */
export async function runConnectionJob(
  context: RunConnectionJobContext,
  queue: ConnectionQueue,
  definition: ConnectionJobDefinition,
  job: ConnectionJobData,
): Promise<ConnectionJobResult> {
  const { db, logger, runJob, deps } = context;
  const scope = { organizationId: job.organizationId, scope: job.connectionId };
  const meter = createRequestMeter();

  if (!definition.lease) return runJob(queue, scope, () => definition.run(deps, job, { meter }));

  // Ohne Connection (gelöscht, fremde Organisation) gäbe die Lease nur einen FK-Fehler ohne Lauf.
  if (!(await findJobConnection(db, job))) {
    return runJob(queue, scope, () => Promise.reject(new JobFailure(CONNECTION_NOT_FOUND_MESSAGE)));
  }

  const runId = randomUUID();
  const leaseRef = {
    organizationId: job.organizationId,
    connectionId: job.connectionId,
    jobRunId: runId,
  };
  const lease = await acquireConnectionLease(db, {
    ...leaseRef,
    job: queue,
    ttlSeconds: CONNECTION_LEASE_SECONDS,
  });
  if (!lease.acquired) {
    const deferredCount = (job.deferredCount ?? 0) + 1;
    const queued = await context.defer(queue, { ...job, deferredCount }, LEASE_DEFER_SECONDS);
    logger({
      level: 'info',
      msg: 'job.deferred',
      job: queue,
      organizationId: job.organizationId,
      connectionId: job.connectionId,
      heldBy: lease.heldBy?.job ?? null,
      deferredCount,
      queued,
    });
    return { status: 'deferred', queued };
  }

  try {
    return await runJob(queue, scope, () => definition.run(deps, job, { meter }), {
      runId,
      counters: () => ({
        requests: meter.requests,
        throttled: meter.throttled,
        retries: meter.retries,
        deferred: job.deferredCount ?? 0,
      }),
    });
  } finally {
    // Scheitert die Freigabe (z. B. Datenbank weg), läuft die Lease von selbst ab.
    await releaseConnectionLease(db, leaseRef).catch((err: unknown) => {
      logger({
        level: 'warn',
        msg: 'job.lease_release_failed',
        job: queue,
        connectionId: job.connectionId,
        ...errorLogFields(err),
      });
    });
  }
}
