import {
  countRunningExports,
  errorLogFields,
  listJobProfiles,
  type JobProfile,
} from '@profitbash/db';
import { createAmazonRequestPort } from '../amazon-requests/amazon-port';
import { createAmazonImport, type AmazonImport } from '../amazon-requests/import';
import {
  isConnectionError,
  type AmazonRequestCounters,
  type AmazonRequestDeps,
} from '../amazon-requests/state-machine';
import type { JobCounters } from '../run-job';
import type {
  ConnectionJobData,
  ConnectionJobDeps,
  ConnectionJobRun,
  ConnectionQueue,
  LoadedConnection,
} from './connection-job';

/**
 * Gemeinsamer Aufbau der Amazon-Datenjobs (`entities-sync`, `reports-sync`, `amazon-requests-poll`,
 * Phase 1, 1.7): Profile der Connection, Port und Zustandsmaschine mit der Uhr des Jobs.
 */

/**
 * Höchstens so viele Exports eines Typs laufen je Connection gleichzeitig bei Amazon (FAQ: 5 laufende
 * Exports je Endpunkt; ob je Profil, Konto oder App, klärt 1.10). Weitere warten auf `pending_request`.
 */
export const MAX_RUNNING_EXPORTS_PER_TYPE = 5;

/**
 * Laufzeit von `entities-sync` und `reports-sync`, bevor sie mit dem nächsten Profil in einem neuen
 * Lauf fortsetzen: deutlich unter dem Ablauf der Jobs in pg-boss (10 Min.). Bei gedrosseltem Budget
 * (0,2 Anfragen/s) braucht ein Profil sonst schnell Minuten.
 */
export const DATA_JOB_TIME_BUDGET_MS = 5 * 60_000;

export interface AmazonJobContext {
  /** Alle Profile der Connection, auch entfernte (deren offene Aufträge laufen aus). */
  profiles: JobProfile[];
  machine: AmazonRequestDeps;
  importer: AmazonImport;
  now: () => Date;
}

export async function createAmazonJobContext(
  deps: ConnectionJobDeps,
  connection: LoadedConnection,
  run: ConnectionJobRun,
): Promise<AmazonJobContext> {
  const now = deps.now ?? (() => new Date());
  const profiles = await listJobProfiles(deps.db, {
    organizationId: connection.organizationId,
    connectionId: connection.id,
  });
  const importer = createAmazonImport({ now, logger: deps.logger });
  const port = createAmazonRequestPort({
    client: deps.amazonAds,
    connection,
    amazonProfileIds: new Map(profiles.map((p) => [p.id, p.amazonProfileId])),
    meter: run.meter,
    logger: deps.logger,
    import: importer.import,
  });
  return { profiles, machine: { db: deps.db, logger: deps.logger, port, now }, importer, now };
}

/** Ist für diesen Export-Typ an der Connection noch Platz (`MAX_RUNNING_EXPORTS_PER_TYPE`)? */
export async function exportSlotFree(
  deps: ConnectionJobDeps,
  connection: LoadedConnection,
  exportType: string,
): Promise<boolean> {
  const running = await countRunningExports(deps.db, {
    organizationId: connection.organizationId,
    connectionId: connection.id,
    exportType,
  });
  return running < MAX_RUNNING_EXPORTS_PER_TYPE;
}

/** Addiert Zähler (Zustandsmaschine, Import) in die des Laufs. */
export function addCounters(
  target: JobCounters,
  source: AmazonRequestCounters | Record<string, number | undefined>,
): void {
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined) target[key] = (target[key] ?? 0) + value;
  }
}

/**
 * Arbeitet die Profile nacheinander ab (ab `job.resumeFromProfileId`). Nach `DATA_JOB_TIME_BUDGET_MS`
 * endet der Lauf vor dem nächsten Profil und plant denselben Job ab diesem Profil neu ein (Zähler
 * `continued`). Scheitert ein Profil nicht an der Connection, laufen die übrigen weiter (Zähler
 * `profileErrors`); Fehler der Connection gehen an den Aufrufer. `profiles` zählt die bearbeiteten.
 * Liefert `true`, wenn alle Profile bearbeitet sind.
 */
export async function forEachProfileWithinBudget(input: {
  deps: ConnectionJobDeps;
  queue: ConnectionQueue;
  job: ConnectionJobData;
  profiles: readonly JobProfile[];
  now: () => Date;
  counters: JobCounters;
  handle(profile: JobProfile): Promise<void>;
}): Promise<boolean> {
  const { deps, job, counters } = input;
  const resumeAt = input.profiles.findIndex((p) => p.id === job.resumeFromProfileId);
  const pending = input.profiles.slice(Math.max(resumeAt, 0));
  const startedAt = input.now().getTime();
  counters.profiles = 0;
  counters.profileErrors = 0;

  for (const [index, profile] of pending.entries()) {
    if (index > 0 && input.now().getTime() - startedAt > DATA_JOB_TIME_BUDGET_MS) {
      await deps.enqueue(input.queue, {
        organizationId: job.organizationId,
        connectionId: job.connectionId,
        ...(job.chain && { chain: true }),
        resumeFromProfileId: profile.id,
      });
      counters.continued = 1;
      return false;
    }
    counters.profiles += 1;
    try {
      await input.handle(profile);
    } catch (err) {
      if (isConnectionError(err)) throw err;
      counters.profileErrors += 1;
      deps.logger({
        level: 'warn',
        msg: 'amazon_data_job.profile_failed',
        job: input.queue,
        connectionId: job.connectionId,
        profileId: profile.id,
        ...errorLogFields(err),
      });
    }
  }
  return true;
}
