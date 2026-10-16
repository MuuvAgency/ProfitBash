import {
  listActiveConnections,
  listActiveSpConnections,
  listConnectionsWithDueAmazonRequests,
  listConnectionsWithOpenAdChangeSubmissions,
  listSpConnectionsWithDueReports,
  type Db,
} from '@profitbash/db';
import { DISPATCH_QUEUES } from '../queues';
import type { JobOutcome } from '../run-job';
import type { ConnectionJobData, ConnectionQueue } from './connection-job';

/**
 * Plant für jede passende Connection einen eigenen Job der Ziel-Queue ein (Cron-Auslöser der Jobs je
 * Connection, `DISPATCH_QUEUES`). Je Connection ein Job, damit pg-boss sie über `singletonKey` =
 * Connection-ID nacheinander ausführt. `enqueue` liefert `false`, wenn für die Connection schon ein Job wartet.
 */
export async function dispatchConnectionJobs(
  deps: {
    db: Db;
    enqueue(queue: ConnectionQueue, job: ConnectionJobData): Promise<boolean>;
    now?: () => Date;
  },
  dispatcher: keyof typeof DISPATCH_QUEUES,
): Promise<JobOutcome> {
  const queue = DISPATCH_QUEUES[dispatcher];
  const now = deps.now?.() ?? new Date();
  // Der Poll läuft nur, wo Aufträge fällig sind (sonst ein leerer Lauf je Connection alle 10 Min.).
  // Ebenso das Übermitteln von Änderungen: nur, wo Übermittlungen offen sind (auch bei Connections, die neu
  // verbunden werden müssen: Der Job lässt die Übermittlungen dort scheitern, statt sie liegen zu lassen).
  // SP-Connections (7.3): täglich alle aktiven, alle 10 Min. nur die mit fälligen Berichten.
  const active =
    dispatcher === 'amazon-requests-poll-all'
      ? await listConnectionsWithDueAmazonRequests(deps.db, now)
      : dispatcher === 'ad-changes-submit-all'
        ? await listConnectionsWithOpenAdChangeSubmissions(deps.db)
        : dispatcher === 'sp-orders-sync-all'
          ? await listActiveSpConnections(deps.db)
          : dispatcher === 'sp-orders-poll-all'
            ? await listSpConnectionsWithDueReports(deps.db, now)
            : await listActiveConnections(deps.db);
  let queued = 0;
  for (const connection of active) {
    const sent = await deps.enqueue(queue, {
      organizationId: connection.organizationId,
      connectionId: connection.id,
    });
    if (sent) queued += 1;
  }
  return { counters: { connections: active.length, queued } };
}
