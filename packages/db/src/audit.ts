import { and, asc, desc, eq, gte, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from './client';
import { auditEvents, users } from './schema';

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

export interface AuditActor {
  id: string;
  name: string;
  email: string;
}

export interface AuditEventRow {
  id: string;
  createdAt: Date;
  action: string;
  /** `null`: kein Nutzer (Seed, Job) oder der Nutzer wurde gelöscht. */
  actor: AuditActor | null;
  target: Record<string, unknown>;
}

export interface ListAuditEventsInput {
  /** `null`: plattformweite Ereignisse ohne Organisation (nur für den Plattform-Admin, 6.4). */
  orgId: string | null;
  /** Einschließlich. */
  from?: Date | undefined;
  /** Ausschließlich. */
  to?: Date | undefined;
  actorUserId?: string | undefined;
  /** Teil der Aktion vor dem Punkt (`member` für `member.create`). */
  area?: string | undefined;
  /** ID des letzten Ereignisses der vorigen Seite. */
  cursor?: string | undefined;
  limit: number;
}

const SECRET_KEY = /token|password|secret/i;

/**
 * Zweites Netz für die Anzeige: Aufrufer von `recordAuditEvent` schreiben keine Secrets ins `target`; rutscht
 * doch eines hinein, verlässt es die DB hier nicht (Felder nach Namen, auch verschachtelt).
 */
function withoutSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutSecrets);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([key]) => !SECRET_KEY.test(key))
      .map(([key, inner]) => [key, withoutSecrets(inner)]),
  );
}

/** Bereich einer Aktion: der Teil vor dem ersten Punkt. */
const auditArea = sql<string>`split_part(${auditEvents.action}, '.', 1)`;

/**
 * Audit-Log der Organisation (6.1), neueste zuerst. Audit-Events sind keine Profildaten: Die Organisation
 * ist die Zugriffsregel (ADR 002, Verwaltung der Eigentümer-Org); die Route verlangt die Admin-Rolle.
 * Plattformweite Ereignisse (`organization_id` leer) gehören nicht dazu.
 */
export async function listAuditEvents(
  db: Db,
  input: ListAuditEventsInput,
): Promise<{ events: AuditEventRow[]; nextCursor: string | null }> {
  const inOrg =
    input.orgId === null
      ? isNull(auditEvents.organizationId)
      : eq(auditEvents.organizationId, input.orgId);
  const rows = await db
    .select({
      id: auditEvents.id,
      createdAt: auditEvents.createdAt,
      action: auditEvents.action,
      target: auditEvents.target,
      actorId: users.id,
      actorName: users.name,
      actorEmail: users.email,
    })
    .from(auditEvents)
    .leftJoin(users, eq(users.id, auditEvents.actorUserId))
    .where(
      and(
        inOrg,
        input.from && gte(auditEvents.createdAt, input.from),
        input.to && lt(auditEvents.createdAt, input.to),
        input.actorUserId !== undefined
          ? eq(auditEvents.actorUserId, input.actorUserId)
          : undefined,
        input.area !== undefined ? eq(auditArea, input.area) : undefined,
        // Der Cursor wird in der DB aufgelöst (volle Zeitauflösung) und gilt nur in derselben Organisation;
        // ein unbekannter Cursor liefert nichts.
        input.cursor !== undefined
          ? sql`(${auditEvents.createdAt}, ${auditEvents.id}) < (select c.created_at, c.id from audit_events c where c.id = ${input.cursor} and c.organization_id is not distinct from ${input.orgId})`
          : undefined,
      ),
    )
    .orderBy(desc(auditEvents.createdAt), desc(auditEvents.id))
    .limit(input.limit + 1);
  const events = rows.slice(0, input.limit).map(({ actorId, actorName, actorEmail, ...row }) => ({
    ...row,
    target: withoutSecrets(row.target) as Record<string, unknown>,
    actor:
      actorId !== null && actorName !== null && actorEmail !== null
        ? { id: actorId, name: actorName, email: actorEmail }
        : null,
  }));
  return { events, nextCursor: rows.length > input.limit ? (events.at(-1)?.id ?? null) : null };
}

/** Auswahl für die Filter des Audit-Logs: vorkommende Bereiche und Handelnde der Organisation. */
export async function listAuditEventFilters(
  db: Db,
  orgId: string,
): Promise<{ areas: string[]; actors: AuditActor[] }> {
  const inOrg = eq(auditEvents.organizationId, orgId);
  const [areas, actors] = await Promise.all([
    db.selectDistinct({ area: auditArea }).from(auditEvents).where(inOrg).orderBy(auditArea),
    db
      .selectDistinct({ id: users.id, name: users.name, email: users.email })
      .from(auditEvents)
      .innerJoin(users, eq(users.id, auditEvents.actorUserId))
      .where(inOrg)
      .orderBy(asc(users.name), asc(users.id)),
  ]);
  return { areas: areas.map((row) => row.area), actors };
}
