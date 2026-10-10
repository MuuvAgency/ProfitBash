import {
  cleanupNotifications,
  notifyExpiringConsents,
  notifyStaleBulkFiles,
  type Db,
} from '@profitbash/db';
import type { JobOutcome } from '../run-job';

/**
 * `notifications-check` (5.2a), täglich und plattformweit: „keine Bulk-Datei seit 8 Tagen“, Ablauf der
 * Amazon-Einwilligung und Aufräumen alter Benachrichtigungen. Wiederholbar (Schlüssel gegen Dubletten).
 */
export async function checkNotifications(deps: { db: Db; now?: () => Date }): Promise<JobOutcome> {
  const now = deps.now?.() ?? new Date();
  // Erst aufräumen: Neue Meldungen tragen die Zeit der Datenbank, nicht `now`.
  const deletedNotifications = await cleanupNotifications(deps.db, { now });
  const staleBulkFiles = await notifyStaleBulkFiles(deps.db, { now });
  const expiringConsents = await notifyExpiringConsents(deps.db, { now });
  return { counters: { staleBulkFiles, expiringConsents, deletedNotifications } };
}
