import {
  deleteExpiredOAuthNonces,
  deleteFinishedAmazonRequestsBefore,
  deleteJobRunsStartedBefore,
  failAbandonedJobRuns,
  type Db,
} from '@profitbash/db';
import type { JobOutcome } from '../run-job';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Aufbewahrung der Jobläufe. */
export const JOB_RUNS_RETENTION_DAYS = 90;
/** Aufbewahrung abgeschlossener Amazon-Aufträge (F5). Offene bleiben, bis sie abgeschlossen sind. */
export const AMAZON_REQUESTS_RETENTION_DAYS = 30;
/** Länger läuft kein Job; ein älterer Lauf auf `running` gehört zu einem beendeten Prozess. */
const ABANDONED_AFTER_MS = 6 * 60 * 60 * 1000;

/**
 * `job-runs-cleanup`: alte Jobläufe, hängengebliebene Läufe, abgelaufene OAuth-Nonces und
 * abgeschlossene Amazon-Aufträge.
 */
export async function cleanupJobRuns(deps: { db: Db; now?: () => Date }): Promise<JobOutcome> {
  const now = deps.now?.() ?? new Date();
  const deletedJobRuns = await deleteJobRunsStartedBefore(
    deps.db,
    new Date(now.getTime() - JOB_RUNS_RETENTION_DAYS * DAY_MS),
  );
  const abandonedJobRuns = await failAbandonedJobRuns(deps.db, {
    startedBefore: new Date(now.getTime() - ABANDONED_AFTER_MS),
    now,
    error: 'Abgebrochen: Der Worker wurde beendet, bevor der Lauf fertig war.',
  });
  const deletedOAuthNonces = await deleteExpiredOAuthNonces(deps.db, now);
  const deletedAmazonRequests = await deleteFinishedAmazonRequestsBefore(
    deps.db,
    new Date(now.getTime() - AMAZON_REQUESTS_RETENTION_DAYS * DAY_MS),
  );
  return {
    counters: { deletedJobRuns, abandonedJobRuns, deletedOAuthNonces, deletedAmazonRequests },
  };
}
