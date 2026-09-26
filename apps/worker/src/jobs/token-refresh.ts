import type { JobOutcome } from '../run-job';
import {
  handleAmazonError,
  loadConnection,
  type ConnectionJobData,
  type ConnectionJobDeps,
} from './connection-job';

/**
 * `token-refresh` für eine Connection: erzwingt einen Refresh bei LWA (am Cache vorbei). So fällt ein
 * widerrufener oder abgelaufener Refresh-Token auf, bevor ein Sync ihn braucht, und `last_refreshed_at`
 * zeigt den letzten erfolgreichen Refresh.
 */
export async function refreshConnectionToken(
  deps: ConnectionJobDeps,
  job: ConnectionJobData,
): Promise<JobOutcome> {
  const connection = await loadConnection(deps.db, job);
  deps.amazonAds.invalidateAccessToken(connection.id);
  try {
    await deps.amazonAds.getAccessToken(connection);
  } catch (err) {
    return handleAmazonError(deps, 'token-refresh', job, connection, err);
  }
  return { counters: { refreshed: 1 } };
}
