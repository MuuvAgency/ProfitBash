import { goalValues } from '@profitbash/engine';
import type { GoalMetric, GoalScopeRef } from '@profitbash/shared';
import { and, asc, eq, inArray } from 'drizzle-orm';
import { listVisibleClientsAndProfiles, visibleProfilesScope } from './access';
import { recordAuditEvent, type DbOrTx } from './audit';
import type { Db } from './client';
import { amazonAdsProfiles, goals, productGroups } from './schema';

/**
 * Ziele (`docs/tasks/phase-5.md` 5.3, F4): Ziel-ACoS bzw. -ROAS je Client, Profil oder Produktgruppe. Setzen und
 * löschen nur an sichtbaren Objekten (`visibleProfilesScope()`, ADR 002): Profil sichtbar, Produktgruppe an einem
 * sichtbaren Profil, Client mit mindestens einem sichtbaren Profil. Das Recht (`view` bzw. `write` im Feature
 * `goals`) prüft die API, die Eingaben `setGoalRequestSchema`.
 */

export class GoalError extends Error {
  constructor(
    public readonly code: 'NOT_FOUND',
    message: string,
  ) {
    super(message);
    this.name = 'GoalError';
  }
}

const notFound = () => new GoalError('NOT_FOUND', 'Ziel oder Ziel-Objekt nicht gefunden.');

export interface GoalAccessInput {
  userId: string;
  orgId: string;
}

export interface GoalRecord {
  id: string;
  metric: GoalMetric;
  /** Gesetzter Wert, exakt. */
  value: string;
  acos: string;
  roas: string;
  updatedAt: Date;
}

interface ProfileGoals {
  id: string;
  accountName: string;
  countryCode: string;
  goal: GoalRecord | null;
  productGroups: { id: string; name: string; goal: GoalRecord | null }[];
}

export interface GoalsOverviewRecord {
  clients: { id: string; name: string; goal: GoalRecord | null; profiles: ProfileGoals[] }[];
  unassignedProfiles: ProfileGoals[];
}

const SCOPE_COLUMN = {
  client: 'clientId',
  profile: 'profileId',
  productGroup: 'productGroupId',
} as const;

type GoalRow = typeof goals.$inferSelect;

function toRecord(row: GoalRow): GoalRecord {
  const metric = row.metric as GoalMetric;
  const values = goalValues(metric, row.value);
  return { id: row.id, metric, value: values[metric], ...values, updatedAt: row.updatedAt };
}

function scopeOf(row: GoalRow): GoalScopeRef {
  if (row.clientId) return { type: 'client', id: row.clientId };
  if (row.profileId) return { type: 'profile', id: row.profileId };
  return { type: 'productGroup', id: row.productGroupId! };
}

/** Sieht der Nutzer das Ziel-Objekt? `null` für Nicht-Mitglieder. */
async function canSeeScope(
  db: DbOrTx,
  access: GoalAccessInput,
  scope: GoalScopeRef,
): Promise<boolean | null> {
  const visible = await visibleProfilesScope(db as Db, access);
  if (visible === null) return null;
  const [row] =
    scope.type === 'productGroup'
      ? await db
          .select({ id: productGroups.id })
          .from(productGroups)
          .where(and(eq(productGroups.id, scope.id), inArray(productGroups.profileId, visible.ids)))
          .limit(1)
      : await db
          .select({ id: amazonAdsProfiles.id })
          .from(amazonAdsProfiles)
          .where(
            and(
              eq(
                scope.type === 'client' ? amazonAdsProfiles.clientId : amazonAdsProfiles.id,
                scope.id,
              ),
              inArray(amazonAdsProfiles.id, visible.ids),
            ),
          )
          .limit(1);
  return row !== undefined;
}

/** Clients, Profile und Produktgruppen, die der Nutzer sieht, je mit eigenem Ziel. `null` für Nicht-Mitglieder. */
export async function getGoalsOverview(
  db: Db,
  access: GoalAccessInput,
): Promise<GoalsOverviewRecord | null> {
  if ((await visibleProfilesScope(db, access)) === null) return null;
  const { clients, profiles } = await listVisibleClientsAndProfiles(db, access);
  const profileIds = profiles.map((p) => p.id);
  const groups =
    profileIds.length === 0
      ? []
      : await db
          .select({
            id: productGroups.id,
            profileId: productGroups.profileId,
            name: productGroups.name,
          })
          .from(productGroups)
          .where(inArray(productGroups.profileId, profileIds))
          .orderBy(asc(productGroups.name), asc(productGroups.id));
  const rows = await db.select().from(goals).where(eq(goals.organizationId, access.orgId));
  const goalByScope = new Map(rows.map((row) => [scopeOf(row).id, toRecord(row)]));
  const goal = (id: string) => goalByScope.get(id) ?? null;

  const toProfile = (p: (typeof profiles)[number]): ProfileGoals => ({
    id: p.id,
    accountName: p.accountName,
    countryCode: p.countryCode,
    goal: goal(p.id),
    productGroups: groups
      .filter((g) => g.profileId === p.id)
      .map((g) => ({ id: g.id, name: g.name, goal: goal(g.id) })),
  });
  return {
    clients: clients.map((c) => ({
      id: c.id,
      name: c.name,
      goal: goal(c.id),
      profiles: profiles.filter((p) => p.clientId === c.id).map(toProfile),
    })),
    unassignedProfiles: profiles.filter((p) => p.clientId === null).map(toProfile),
  };
}

/** Setzt das Ziel eines Objekts (höchstens eines je Objekt). `null` für Nicht-Mitglieder, sonst `GoalError`. */
export async function setGoal(
  db: Db,
  input: GoalAccessInput & { scope: GoalScopeRef; metric: GoalMetric; value: string },
): Promise<GoalRecord | null> {
  return db.transaction(async (tx) => {
    const visible = await canSeeScope(tx, input, input.scope);
    if (visible === null) return null;
    if (!visible) throw notFound();
    const column = SCOPE_COLUMN[input.scope.type];
    const [before] = await tx.select().from(goals).where(eq(goals[column], input.scope.id));
    const [row] = await tx
      .insert(goals)
      .values({
        organizationId: input.orgId,
        [column]: input.scope.id,
        metric: input.metric,
        value: input.value,
        createdBy: input.userId,
        updatedBy: input.userId,
      })
      .onConflictDoUpdate({
        target: goals[column],
        set: { metric: input.metric, value: input.value, updatedBy: input.userId },
      })
      .returning();
    const record = toRecord(row!);
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'goal.set',
      target: {
        type: 'goal',
        id: record.id,
        scope: input.scope,
        before: before ? { metric: before.metric, value: toRecord(before).value } : null,
        after: { metric: record.metric, value: record.value },
      },
    });
    return record;
  });
}

/** Löscht ein Ziel. `null` für Nicht-Mitglieder, `GoalError` `NOT_FOUND` für fremde und unsichtbare. */
export async function deleteGoal(
  db: Db,
  input: GoalAccessInput & { id: string },
): Promise<true | null> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(goals)
      .where(and(eq(goals.id, input.id), eq(goals.organizationId, input.orgId)));
    const visible = await canSeeScope(
      tx,
      input,
      row ? scopeOf(row) : { type: 'profile', id: input.id },
    );
    if (visible === null) return null;
    if (!row || !visible) throw notFound();
    await tx.delete(goals).where(eq(goals.id, row.id));
    await recordAuditEvent(tx, {
      organizationId: input.orgId,
      actorUserId: input.userId,
      action: 'goal.delete',
      target: {
        type: 'goal',
        id: row.id,
        scope: scopeOf(row),
        before: { metric: row.metric, value: toRecord(row).value },
      },
    });
    return true;
  });
}
