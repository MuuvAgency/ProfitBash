import type { AmazonAdsClient } from '@profitbash/amazon-ads';
import { latestFxRateDate, type Db } from '@profitbash/db';
import type { EcbRate, FetchEcbRatesOptions } from '@profitbash/ecb';
import type { Logger } from '@profitbash/shared';
import { PgBoss, type Job } from 'pg-boss';
import {
  connectionJobDataSchema,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionQueue,
} from './jobs/connection-job';
import { pollAmazonRequests } from './jobs/amazon-requests-poll';
import { dispatchConnectionJobs } from './jobs/dispatch';
import { syncConnectionEntities } from './jobs/entities-sync';
import { syncFxRates } from './jobs/fx-rates-sync';
import { cleanupJobRuns } from './jobs/job-runs-cleanup';
import { syncConnectionProfiles } from './jobs/profiles-sync';
import { syncConnectionReports } from './jobs/reports-sync';
import { runConnectionJob, type ConnectionJobDefinition } from './jobs/run-connection-job';
import { refreshConnectionToken } from './jobs/token-refresh';
import {
  CLEANUP_QUEUE,
  createJobQueue,
  createQueues,
  DISPATCH_QUEUES,
  FX_RATES_QUEUE,
  logBossErrors,
  SCHEDULES,
  type JobQueue,
} from './queues';
import { createJobRunner, JobFailure, type JobRunnerDeps } from './run-job';

/**
 * Jobs je Connection. `lease: true` = Amazon-Datenjob: höchstens einer je Connection gleichzeitig,
 * über alle Queues hinweg (1.3).
 */
const CONNECTION_JOBS: Record<ConnectionQueue, ConnectionJobDefinition> = {
  'token-refresh': { run: refreshConnectionToken, lease: false },
  'profiles-sync': { run: syncConnectionProfiles, lease: true },
  'entities-sync': { run: syncConnectionEntities, lease: true },
  'reports-sync': { run: syncConnectionReports, lease: true },
  'amazon-requests-poll': { run: pollAmazonRequests, lease: true },
};

/** So lange wartet das Herunterfahren auf laufende Jobs. */
const STOP_TIMEOUT_MS = 30_000;

export interface StartWorkerOptions {
  /** Direkte Verbindung für pg-boss (`DATABASE_URL_DIRECT`), nie ein Transaction-Pooler. */
  connectionString: string;
  db: Db;
  amazonAds: AmazonAdsClient;
  logger: Logger;
  healthchecks?: JobRunnerDeps['healthchecks'];
  fetch?: typeof fetch;
  /** Nur für Tests kürzer als der pg-boss-Standard (2 s). */
  pollingIntervalSeconds?: number;
  /** Abruf der EZB-Kurse; Standard `fetchEcbRates`. Tests ersetzen ihn (kein Aufruf der echten EZB). */
  fetchFxRates?: (options: FetchEcbRatesOptions) => Promise<EcbRate[]>;
}

export interface Worker {
  jobs: JobQueue;
  /** Graceful Shutdown: nimmt keine neuen Jobs an und wartet auf laufende (höchstens 30 s). */
  stop(): Promise<void>;
}

/** Startet pg-boss mit allen Queues, Zeitplänen und Handlern. */
export async function startWorker(options: StartWorkerOptions): Promise<Worker> {
  const { db, logger } = options;
  const boss = new PgBoss({ connectionString: options.connectionString });
  logBossErrors(boss, logger);
  await boss.start();
  await createQueues(boss);
  const jobs = createJobQueue(boss);

  const runJob = createJobRunner({
    db,
    logger,
    ...(options.healthchecks && { healthchecks: options.healthchecks }),
    ...(options.fetch && { fetch: options.fetch }),
  });
  const connectionDeps: ConnectionJobDeps = {
    db,
    logger,
    amazonAds: options.amazonAds,
    scheduleRetry: ({ queue, job, startAfterSeconds }) =>
      jobs.enqueueConnectionJob(queue, job, { startAfterSeconds }),
    enqueue: (queue, job, enqueueOptions) => jobs.enqueueConnectionJob(queue, job, enqueueOptions),
  };
  const workOptions = {
    ...(options.pollingIntervalSeconds !== undefined && {
      pollingIntervalSeconds: options.pollingIntervalSeconds,
    }),
  };

  const connectionJobContext = {
    db,
    logger,
    runJob,
    deps: connectionDeps,
    defer: (queue: ConnectionQueue, job: ConnectionJobData, startAfterSeconds: number) =>
      jobs.enqueueConnectionJob(queue, job, { startAfterSeconds }),
  };

  for (const [queue, definition] of Object.entries(CONNECTION_JOBS) as Array<
    [ConnectionQueue, ConnectionJobDefinition]
  >) {
    await boss.work<unknown>(queue, workOptions, async (batch: Job<unknown>[]) => {
      for (const job of batch) {
        const parsed = connectionJobDataSchema.safeParse(job.data);
        if (!parsed.success) {
          await runJob(queue, { organizationId: null, scope: null }, () =>
            Promise.reject(new JobFailure('Ungültige Jobdaten.')),
          );
          continue;
        }
        await runConnectionJob(connectionJobContext, queue, definition, parsed.data);
      }
    });
  }

  for (const [queue, target] of Object.entries(DISPATCH_QUEUES) as Array<
    [keyof typeof DISPATCH_QUEUES, ConnectionQueue]
  >) {
    await boss.work(queue, workOptions, async () => {
      await runJob(target, { organizationId: null, scope: null }, () =>
        dispatchConnectionJobs(
          { db, enqueue: (name, job) => jobs.enqueueConnectionJob(name, job) },
          target,
        ),
      );
    });
  }

  await boss.work(CLEANUP_QUEUE, workOptions, async () => {
    await runJob(CLEANUP_QUEUE, { organizationId: null, scope: null }, () =>
      cleanupJobRuns({ db }),
    );
  });

  await boss.work(FX_RATES_QUEUE, workOptions, async () => {
    await runJob(FX_RATES_QUEUE, { organizationId: null, scope: null }, () =>
      syncFxRates({ db, ...(options.fetchFxRates && { fetchRates: options.fetchFxRates }) }),
    );
  });

  for (const schedule of SCHEDULES) {
    await boss.schedule(schedule.queue, schedule.cron, null, {
      ...('tz' in schedule && { tz: schedule.tz }),
    });
  }

  // Ohne Kurse (neue Datenbank) nicht bis zum nächsten Morgen warten; `stately` verhindert Doppel.
  if ((await latestFxRateDate(db)) === null) await boss.send(FX_RATES_QUEUE, null);

  logger({ level: 'info', msg: 'worker.started', queues: SCHEDULES.map((s) => s.queue) });
  return {
    jobs,
    async stop() {
      await boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS });
      logger({ level: 'info', msg: 'worker.stopped' });
    },
  };
}

/**
 * Nur Einplanen, ohne Jobs auszuführen (API bei `WORKER_MODE=separate`): keine Zeitpläne, keine
 * Wartung. Die übernimmt der Worker-Prozess.
 */
export async function startJobQueue(options: {
  connectionString: string;
  logger: Logger;
}): Promise<{ jobs: JobQueue; stop(): Promise<void> }> {
  const boss = new PgBoss({
    connectionString: options.connectionString,
    supervise: false,
    schedule: false,
  });
  logBossErrors(boss, options.logger);
  await boss.start();
  await createQueues(boss);
  return {
    jobs: createJobQueue(boss),
    stop: () => boss.stop({ graceful: true, timeout: STOP_TIMEOUT_MS }),
  };
}
