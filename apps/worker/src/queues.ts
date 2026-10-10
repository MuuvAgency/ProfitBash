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

/**
 * Cron-Auslöser, die für jede aktive Connection einen Job der Ziel-Queue einplanen
 * (`amazon-requests-poll-all` nur für Connections mit fälligen Aufträgen, `ad-changes-submit-all` nur für
 * Connections mit offenen Übermittlungen, siehe `jobs/dispatch.ts`).
 */
export const DISPATCH_QUEUES = {
  'token-refresh-all': 'token-refresh',
  'profiles-sync-all': 'profiles-sync',
  'entities-sync-all': 'entities-sync',
  'reports-sync-all': 'reports-sync',
  'amazon-requests-poll-all': 'amazon-requests-poll',
  'ad-changes-submit-all': 'ad-changes-submit',
} as const satisfies Record<string, ConnectionQueue>;

export const CLEANUP_QUEUE = 'job-runs-cleanup';
/** Benachrichtigungen (5.2a): keine Bulk-Datei seit 8 Tagen, Ablauf der Einwilligung, Aufräumen. Täglich. */
export const NOTIFICATIONS_CHECK_QUEUE = 'notifications-check';
/**
 * Datei-Import je Profil (1.11c), `singletonKey` = Profil-ID: höchstens ein wartender und ein laufender
 * Job je Profil. Ein Lauf arbeitet alle offenen Dateien des Profils ab; fällt ein Einplanen weg, weil schon
 * einer wartet, holt der wartende die neue Datei mit ab.
 */
export const FILE_IMPORT_QUEUE = 'file-import';
/** Auslöser alle 10 Min.: plant `file-import` für Profile mit wartenden oder hängenden Dateien ein (nach Absturz, Deploy). */
export const FILE_IMPORT_SWEEP_QUEUE = 'file-import-all';
/** EZB-Kurse, plattformweit (2.2). Die EZB veröffentlicht gegen 16:00; der Lauf holt den Vortag. */
export const FX_RATES_QUEUE = 'fx-rates-sync';
/** Nach einem Fehlschlag neuer Versuch nach einer Stunde, höchstens so oft (danach am nächsten Morgen). */
export const FX_RATES_RETRY_DELAY_SECONDS = 60 * 60;
export const FX_RATES_MAX_RETRIES = 3;

/**
 * Zeitpläne (F9): Profile um 05:00, Entities und Reports um 06:00 Berlin (die Lease der Connection
 * reiht sie nacheinander), die EZB-Kurse des Vortags ebenfalls um 06:00 (Dominik, 2026-09-28). Der
 * Poll plant sich selbst neu ein; der Auslöser alle 10 Min. holt nach Absturz oder Deploy auf.
 */
export const SCHEDULES = [
  { queue: 'token-refresh-all', cron: '0 * * * *' },
  { queue: 'profiles-sync-all', cron: '0 5 * * *', tz: 'Europe/Berlin' },
  { queue: 'entities-sync-all', cron: '0 6 * * *', tz: 'Europe/Berlin' },
  { queue: 'reports-sync-all', cron: '0 6 * * *', tz: 'Europe/Berlin' },
  { queue: 'amazon-requests-poll-all', cron: '*/10 * * * *' },
  // Holt offene Übermittlungen nach Absturz oder Deploy nach (3.3); sonst plant die API den Job direkt ein.
  { queue: 'ad-changes-submit-all', cron: '*/10 * * * *' },
  { queue: CLEANUP_QUEUE, cron: '30 3 * * *', tz: 'Europe/Berlin' },
  { queue: FX_RATES_QUEUE, cron: '0 6 * * *', tz: 'Europe/Berlin' },
  { queue: FILE_IMPORT_SWEEP_QUEUE, cron: '*/10 * * * *' },
  // Nach den Syncs am Morgen, vor dem Arbeitsbeginn.
  { queue: NOTIFICATIONS_CHECK_QUEUE, cron: '0 7 * * *', tz: 'Europe/Berlin' },
] as const;

/** So lange darf ein Job laufen, bevor pg-boss ihn als abgelaufen führt. */
export const JOB_EXPIRE_SECONDS = 10 * 60;

const QUEUE_OPTIONS: Omit<Queue, 'name'> = {
  policy: 'stately',
  // Fehler behandelt runJob; neu geplant wird gezielt (Retry-After) oder im nächsten Zyklus.
  retryLimit: 0,
  expireInSeconds: JOB_EXPIRE_SECONDS,
};

const ALL_QUEUES = [
  ...CONNECTION_QUEUES,
  ...Object.keys(DISPATCH_QUEUES),
  CLEANUP_QUEUE,
  NOTIFICATIONS_CHECK_QUEUE,
  FX_RATES_QUEUE,
  FILE_IMPORT_QUEUE,
  FILE_IMPORT_SWEEP_QUEUE,
];

/**
 * Legt die Queues an bzw. gleicht bestehende an `QUEUE_OPTIONS` an (idempotent). API und Worker rufen
 * das beim Start auf. `createQueue` ist für bestehende Queues wirkungslos, deshalb `updateQueue`. Die
 * Policy lässt sich so nicht ändern (dann Queue neu anlegen).
 */
export async function createQueues(boss: PgBoss): Promise<void> {
  const { policy: _policy, ...updatable } = QUEUE_OPTIONS;
  for (const name of ALL_QUEUES) {
    if (await boss.getQueue(name)) await boss.updateQueue(name, updatable);
    else await boss.createQueue(name, QUEUE_OPTIONS);
  }
}

export interface ProfilesSyncJob {
  organizationId: string;
  connectionId: string;
  /** „Jetzt synchronisieren“: danach Entities und Reports (1.7). */
  chain?: boolean;
}

export interface EnqueueOptions {
  /**
   * Transaktion des Aufrufers: Der Job entsteht nur, wenn sie committet (z. B. zusammen mit dem
   * Audit-Event). Ohne Angabe eigene Anweisung.
   */
  tx?: DbOrTx;
}

export interface FileImportJob {
  organizationId: string;
  profileId: string;
}

export interface AdChangesSubmitJob {
  organizationId: string;
  connectionId: string;
}

/** Hintergrundjobs, die die API anstößt. */
export interface JobQueue {
  enqueueProfilesSync(job: ProfilesSyncJob, options?: EnqueueOptions): Promise<void>;
  /** Liefert `false`, wenn für das Profil schon ein Job wartet (der holt die Datei mit ab). */
  enqueueFileImport(job: FileImportJob, options?: EnqueueOptions): Promise<boolean>;
  /**
   * Übermittlungen von Änderungen über die API senden (3.3). Liefert `false`, wenn für die Connection schon ein
   * Job wartet (der holt alle offenen Übermittlungen ab).
   */
  enqueueAdChangesSubmit(job: AdChangesSubmitJob, options?: EnqueueOptions): Promise<boolean>;
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
    async enqueueFileImport(job, options = {}) {
      const id = await boss.send(
        FILE_IMPORT_QUEUE,
        { organizationId: job.organizationId, profileId: job.profileId },
        {
          singletonKey: job.profileId,
          ...(options.tx && { db: fromDrizzle(options.tx, sql) }),
        },
      );
      return id !== null;
    },
    enqueueAdChangesSubmit(job, options) {
      return enqueueConnectionJob(
        'ad-changes-submit',
        { organizationId: job.organizationId, connectionId: job.connectionId },
        options,
      );
    },
    async enqueueProfilesSync(job, options) {
      await enqueueConnectionJob(
        'profiles-sync',
        {
          organizationId: job.organizationId,
          connectionId: job.connectionId,
          ...(job.chain && { chain: true }),
        },
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
