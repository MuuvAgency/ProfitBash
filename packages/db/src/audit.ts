import type { Db } from './client';
import { auditEvents } from './schema';

/** Datenbank oder laufende Transaktion (`db.transaction(async (tx) => …)`). */
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

export interface AuditEventInput {
  /** `null` für nutzer- oder plattformweite Aktionen. */
  organizationId: string | null;
  /** `null`, wenn kein angemeldeter Nutzer handelt (Seed, Jobs). */
  actorUserId: string | null;
  /** `<bereich>.<aktion>`, z. B. `settings.update`, `member.role_update`. */
  action: string;
  /** Betroffenes Objekt: `{ type, id, …Details }`. Nie Secrets oder Tokens. */
  target: { type: string; id: string; [key: string]: unknown };
}

/**
 * Schreibt ein Audit-Event. Jede schreibende Aktion erzeugt eines, möglichst in derselben
 * Transaktion wie die Änderung selbst.
 */
export async function recordAuditEvent(db: DbOrTx, event: AuditEventInput): Promise<void> {
  await db.insert(auditEvents).values(event);
}
