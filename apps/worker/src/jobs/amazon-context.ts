import { countRunningExports, listJobProfiles, type JobProfile } from '@profitbash/db';
import { createAmazonRequestPort } from '../amazon-requests/amazon-port';
import { createAmazonImport, type AmazonImport } from '../amazon-requests/import';
import type { AmazonRequestCounters, AmazonRequestDeps } from '../amazon-requests/state-machine';
import type { JobCounters } from '../run-job';
import type { ConnectionJobDeps, ConnectionJobRun, LoadedConnection } from './connection-job';

/**
 * Gemeinsamer Aufbau der Amazon-Datenjobs (`entities-sync`, `reports-sync`, `amazon-requests-poll`,
 * Phase 1, 1.7): Profile der Connection, Port und Zustandsmaschine mit der Uhr des Jobs.
 */

/**
 * Höchstens so viele Exports eines Typs laufen je Connection gleichzeitig bei Amazon (FAQ: 5 laufende
 * Exports je Endpunkt; ob je Profil, Konto oder App, klärt 1.10). Weitere warten auf `pending_request`.
 */
export const MAX_RUNNING_EXPORTS_PER_TYPE = 5;

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
