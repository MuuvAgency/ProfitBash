import { and, eq, like, lt } from 'drizzle-orm';
import type { DbOrTx } from './audit';
import { jobRuns, verifications } from './schema';

/**
 * Präfix der Nonces des Amazon-OAuth-Flows in `verifications` (die Tabelle teilt sich die App mit
 * better-auth; Einträge ohne dieses Präfix gehören better-auth).
 */
export const AMAZON_ADS_OAUTH_NONCE_PREFIX = 'amazon-ads-oauth:';

/** Löscht abgelaufene, nicht eingelöste Nonces des Amazon-OAuth-Flows. */
export async function deleteExpiredOAuthNonces(db: DbOrTx, now: Date): Promise<number> {
  const rows = await db
    .delete(verifications)
    .where(
      and(
        like(verifications.identifier, `${AMAZON_ADS_OAUTH_NONCE_PREFIX}%`),
        lt(verifications.expiresAt, now),
      ),
    )
    .returning({ id: verifications.id });
  return rows.length;
}

/** Löscht Jobläufe, die vor `startedBefore` begonnen haben. */
export async function deleteJobRunsStartedBefore(db: DbOrTx, startedBefore: Date): Promise<number> {
  const rows = await db
    .delete(jobRuns)
    .where(lt(jobRuns.startedAt, startedBefore))
    .returning({ id: jobRuns.id });
  return rows.length;
}

/**
 * Schließt Läufe ab, die seit `startedBefore` auf `running` stehen: Der Prozess wurde beendet, bevor
 * `runJob` den Lauf abschließen konnte.
 */
export async function failAbandonedJobRuns(
  db: DbOrTx,
  input: { startedBefore: Date; now: Date; error: string },
): Promise<number> {
  const rows = await db
    .update(jobRuns)
    .set({ status: 'failed', finishedAt: input.now, error: input.error })
    .where(and(eq(jobRuns.status, 'running'), lt(jobRuns.startedAt, input.startedBefore)))
    .returning({ id: jobRuns.id });
  return rows.length;
}
