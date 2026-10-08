import {
  listActiveConnections,
  listConnectionsWithDueAmazonRequests,
  listConnectionsWithOpenAdChangeSubmissions,
  type Db,
} from '@profitbash/db';
import type { JobOutcome } from '../run-job';
import type { ConnectionJobData, ConnectionQueue } from './connection-job';

/**
 * Plant für jede aktive Connection einen eigenen Job ein (Cron-Auslöser der Jobs je Connection;
 * `amazon-requests-poll` nur mit fälligen Aufträgen). Je Connection ein Job, damit pg-boss sie über `singletonKey` = Connection-ID
 * nacheinander ausführt. `enqueue` liefert `false`, wenn für die Connection schon ein Job wartet.
 */
export async function dispatchConnectionJobs(
  deps: {
    db: Db;
    enqueue(queue: ConnectionQueue, job: ConnectionJobData): Promise<boolean>;
    now?: () => Date;
  },
  queue: ConnectionQueue,
): Promise<JobOutcome> {
  // Der Poll läuft nur, wo Aufträge fällig sind (sonst ein leerer Lauf je Connection alle 10 Min.).
  // Ebenso das Übermitteln von Änderungen: nur, wo Übermittlungen offen sind (auch bei Connections, die neu
  // verbunden werden müssen: Der Job lässt die Übermittlungen dort scheitern, statt sie liegen zu lassen).
  const active =
    queue === 'amazon-requests-poll'
      ? await listConnectionsWithDueAmazonRequests(deps.db, deps.now?.() ?? new Date())
      : queue === 'ad-changes-submit'
        ? await listConnectionsWithOpenAdChangeSubmissions(deps.db)
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
