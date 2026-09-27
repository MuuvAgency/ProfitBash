import type { DbOrTx } from '@profitbash/db';
import { CONNECTION_JOB_NAMES, type Logger } from '@profitbash/shared';
import { errorLogFields } from '@profitbash/db';
import { sql } from 'drizzle-orm';
import { fromDrizzle, PgBoss, type Queue } from 'pg-boss';
import type { ConnectionJobData, ConnectionQueue } from './jobs/connection-job';

/**
 * Jobs je Connection. `stately`: je Connection höchstens ein wartender und ein laufender Job **je
 * Queue**. Über Queues hinweg serialisiert die Lease der Connection die Amazon-Datenjobs (1.3).
 */
export const CONNECTION_QUEUES: readonly ConnectionQueue[] = CONNECTION_JOB_NAMES;

/** Cron-Auslöser, die für jede aktive Connection einen Job der Ziel-Queue einplanen. */
export const DISPATCH_QUEUES = {
  'token-refresh-all': 'token-refresh',
  'profiles-sync-all': 'profiles-sync',
} as const satisfies Record<string, ConnectionQueue>;

export const CLEANUP_QUEUE = 'job-runs-cleanup';

export const SCHEDULES = [
  { queue: 'token-refresh-all', cron: '0 * * * *' },
  { queue: 'profiles-sync-all', cron: '0 5 * * *', tz: 'Europe/Berlin' },
  { queue: CLEANUP_QUEUE, cron: '30 3 * * *', tz: 'Europe/Berlin' },
] as const;

/** So lange darf ein Job laufen, bevor pg-boss ihn als abgelaufen führt. */
export const JOB_EXPIRE_SECONDS = 10 * 60;

const QUEUE_OPTIONS: Omit<Queue, 'name'> = {
  policy: 'stately',
  // Fehler behandelt runJob; neu geplant wird gezielt (Retry-After) oder im nächsten Zyklus.
  retryLimit: 0,
  expireInSeconds: JOB_EXPIRE_SECONDS,
};

const ALL_QUEUES = [...CONNECTION_QUEUES, ...Object.keys(DISPATCH_QUEUES), CLEANUP_QUEUE];

/**
 * Legt die Queues an (idempotent). API und Worker rufen das beim Start auf. Achtung: Für bestehende
 * Queues ist `createQueue` wirkungslos; geänderte `QUEUE_OPTIONS` brauchen `boss.updateQueue`
 * (die Policy lässt sich gar nicht ändern, dann Queue neu anlegen).
 */
export async function createQueues(boss: PgBoss): Promise<void> {
  for (const name of ALL_QUEUES) await boss.createQueue(name, QUEUE_OPTIONS);
}

export interface ProfilesSyncJob {
  organizationId: string;
  connectionId: string;
}

export interface EnqueueOptions {
  /**
   * Transaktion des Aufrufers: Der Job entsteht nur, wenn sie committet (z. B. zusammen mit dem
   * Audit-Event). Ohne Angabe eigene Anweisung.
   */
  tx?: DbOrTx;
}

/** Hintergrundjobs, die die API anstößt. */
export interface JobQueue {
  enqueueProfilesSync(job: ProfilesSyncJob, options?: EnqueueOptions): Promise<void>;
}

export interface ConnectionJobQueue extends JobQueue {
  /** Liefert `false`, wenn für die Connection schon ein Job wartet. */
  enqueueConnectionJob(
    queue: ConnectionQueue,
    job: ConnectionJobData,
    options?: EnqueueOptions & { startAfterSeconds?: number },
  ): Promise<boolean>;
}

export function createJobQueue(boss: PgBoss): ConnectionJobQueue {
  const enqueueConnectionJob: ConnectionJobQueue['enqueueConnectionJob'] = async (
    queue,
    job,
    options = {},
  ) => {
    const id = await boss.send(queue, job, {
      singletonKey: job.connectionId,
      ...(options.startAfterSeconds !== undefined && { startAfter: options.startAfterSeconds }),
      ...(options.tx && { db: fromDrizzle(options.tx, sql) }),
    });
    return id !== null;
  };
  return {
    enqueueConnectionJob,
    async enqueueProfilesSync(job, options) {
      await enqueueConnectionJob(
        'profiles-sync',
        { organizationId: job.organizationId, connectionId: job.connectionId },
        options,
      );
    },
  };
}

/** Meldet Fehler von pg-boss (z. B. verlorene Verbindung) im Log, statt den Prozess zu beenden. */
export function logBossErrors(boss: PgBoss, logger: Logger): void {
  boss.on('error', (error) => {
    logger({ level: 'error', msg: 'pgboss.error', ...errorLogFields(error) });
  });
}
