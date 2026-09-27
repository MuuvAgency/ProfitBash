import { and, eq, sql } from 'drizzle-orm';
import type { DbOrTx } from './audit';
import { connectionJobLeases } from './schema';

/**
 * Lease je Connection für die Amazon-Datenjobs (Systemzugriff des Workers, Phase 1, 1.3). Genommen
 * per `INSERT … ON CONFLICT … WHERE expires_at < now()`: frei oder abgelaufen → neuer Halter.
 * Ablauf in Datenbankzeit, damit mehrere Prozesse (z. B. alter und neuer Container beim Deploy)
 * dieselbe Uhr sehen. Alle Zugriffe sind an Organisation und Connection gebunden.
 */

export interface ConnectionLeaseInput {
  organizationId: string;
  connectionId: string;
  /** `job_runs.id` des Laufs, der die Lease hält. */
  jobRunId: string;
}

export interface ConnectionLeaseHolder {
  job: string;
  jobRunId: string;
  expiresAt: Date;
}

export type AcquireConnectionLeaseResult =
  | { acquired: true }
  | {
      acquired: false;
      /** `null`, wenn der Halter die Lease zwischen den beiden Abfragen freigegeben hat. */
      heldBy: ConnectionLeaseHolder | null;
    };

const expiresIn = (ttlSeconds: number) => sql`now() + ${ttlSeconds}::integer * interval '1 second'`;

export async function acquireConnectionLease(
  db: DbOrTx,
  input: ConnectionLeaseInput & { job: string; ttlSeconds: number },
): Promise<AcquireConnectionLeaseResult> {
  const rows = await db
    .insert(connectionJobLeases)
    .values({
      connectionId: input.connectionId,
      organizationId: input.organizationId,
      job: input.job,
      jobRunId: input.jobRunId,
      acquiredAt: sql`now()`,
      expiresAt: expiresIn(input.ttlSeconds),
    })
    .onConflictDoUpdate({
      target: connectionJobLeases.connectionId,
      set: {
        job: sql`excluded.job`,
        jobRunId: sql`excluded.job_run_id`,
        acquiredAt: sql`excluded.acquired_at`,
        expiresAt: sql`excluded.expires_at`,
      },
      // Die Organisation muss passen: Eine abgelaufene Lease übernimmt nur, wer im Org-Kontext der
      // Connection arbeitet (für neue Zeilen erzwingt das der zusammengesetzte FK).
      setWhere: sql`${connectionJobLeases.expiresAt} < now() and ${connectionJobLeases.organizationId} = excluded.organization_id`,
    })
    .returning({ jobRunId: connectionJobLeases.jobRunId });
  if (rows.length > 0) return { acquired: true };

  const [holder] = await db
    .select({
      job: connectionJobLeases.job,
      jobRunId: connectionJobLeases.jobRunId,
      expiresAt: connectionJobLeases.expiresAt,
    })
    .from(connectionJobLeases)
    .where(leaseOf(input));
  return { acquired: false, heldBy: holder ?? null };
}

/** Verlängert die eigene Lease; `false`, wenn sie inzwischen ein anderer Lauf hält. */
export async function extendConnectionLease(
  db: DbOrTx,
  input: ConnectionLeaseInput & { ttlSeconds: number },
): Promise<boolean> {
  const rows = await db
    .update(connectionJobLeases)
    .set({ expiresAt: expiresIn(input.ttlSeconds) })
    .where(and(leaseOf(input), eq(connectionJobLeases.jobRunId, input.jobRunId)))
    .returning({ jobRunId: connectionJobLeases.jobRunId });
  return rows.length > 0;
}

/** Gibt die eigene Lease frei; die Lease eines anderen Laufs bleibt stehen. */
export async function releaseConnectionLease(
  db: DbOrTx,
  input: ConnectionLeaseInput,
): Promise<boolean> {
  const rows = await db
    .delete(connectionJobLeases)
    .where(and(leaseOf(input), eq(connectionJobLeases.jobRunId, input.jobRunId)))
    .returning({ jobRunId: connectionJobLeases.jobRunId });
  return rows.length > 0;
}

function leaseOf(input: { organizationId: string; connectionId: string }) {
  return and(
    eq(connectionJobLeases.connectionId, input.connectionId),
    eq(connectionJobLeases.organizationId, input.organizationId),
  );
}
