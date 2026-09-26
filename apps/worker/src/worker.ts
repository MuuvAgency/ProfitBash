import type { AmazonAdsClient } from '@profitbash/amazon-ads';
import type { Db } from '@profitbash/db';
import type { Logger } from '@profitbash/shared';
import { PgBoss, type Job } from 'pg-boss';
import {
  connectionJobDataSchema,
  type ConnectionJobData,
  type ConnectionJobDeps,
  type ConnectionQueue,
} from './jobs/connection-job';
import { dispatchConnectionJobs } from './jobs/dispatch';
import { cleanupJobRuns } from './jobs/job-runs-cleanup';
import { syncConnectionProfiles } from './jobs/profiles-sync';
import { refreshConnectionToken } from './jobs/token-refresh';
import {
  CLEANUP_QUEUE,
  createJobQueue,
  createQueues,
  DISPATCH_QUEUES,
  logBossErrors,
  SCHEDULES,
  type JobQueue,
} from './queues';
import { createJobRunner, JobFailure, type JobOutcome, type JobRunnerDeps } from './run-job';

const CONNECTION_JOBS: Record<
  ConnectionQueue,
  (deps: ConnectionJobDeps, job: ConnectionJobData) => Promise<JobOutcome>
> = {
  'token-refresh': refreshConnectionToken,
  'profiles-sync': syncConnectionProfiles,
};

/** So lange wartet das Herunterfahren auf laufende Jobs. */
const STOP_TIMEOUT_MS = 30_000;

export interface StartWorkerOptions {
  /** Direkte Verbindung für pg-boss (`DATABASE_URL_DIRECT`), nie ein Transaction-Pooler. */
  connectionString: string;
  db: Db;
  amazonAds: Pick<AmazonAdsClient, 'listProfiles' | 'getAccessToken' | 'invalidateAccessToken'>;
  logger: Logger;
  healthchecks?: JobRunnerDeps['healthchecks'];
  fetch?: typeof fetch;
  /** Nur für Tests kürzer als der pg-boss-Standard (2 s). */
  pollingIntervalSeconds?: number;
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
  };
  const workOptions = {
    ...(options.pollingIntervalSeconds !== undefined && {
      pollingIntervalSeconds: options.pollingIntervalSeconds,
    }),
  };

  for (const [queue, run] of Object.entries(CONNECTION_JOBS) as Array<
    [ConnectionQueue, (typeof CONNECTION_JOBS)[ConnectionQueue]]
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
        const data = parsed.data;
        await runJob(queue, { organizationId: data.organizationId, scope: data.connectionId }, () =>
          run(connectionDeps, data),
        );
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

  for (const schedule of SCHEDULES) {
    await boss.schedule(schedule.queue, schedule.cron, null, {
      ...('tz' in schedule && { tz: schedule.tz }),
    });
  }

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
