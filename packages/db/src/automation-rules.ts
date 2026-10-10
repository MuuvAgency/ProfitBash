import {
  automationRulesSchema,
  DEFAULT_AUTOMATION_RULES,
  type AutomationRule,
} from '@profitbash/shared';
import { and, eq, inArray } from 'drizzle-orm';
import { getOrgRole } from './access';
import { recordAuditEvent } from './audit';
import { AutomationError, type AutomationAccessInput } from './automation';
import type { Db } from './client';
import { automationRules, clients } from './schema';
import { isUniqueViolation } from './structure-catalog';

/**
 * Regeln der Automatik (`docs/tasks/phase-5.md` 5.6a): eine geordnete Liste je Organisation, lesbar für alle
 * Mitglieder. Das Recht `write` im Feature `automations` prüft die API; die Liste ist schon mit
 * `automationRulesSchema` geprüft.
 */

export interface StoredAutomationRules {
  rules: AutomationRule[];
  version: number;
  updatedAt: Date | null;
}

const conflict = () =>
  new AutomationError(
    'VERSION_CONFLICT',
    'Die Regeln wurden inzwischen geändert. Bitte neu laden.',
  );

/**
 * Regeln der Organisation ohne Rechteprüfung (für den Lauf). Ohne Zeile die Startregeln (Version 0); eine Liste, die
 * nicht mehr zum Schema passt, fällt mit ihrer Version auf die Startregeln zurück. Regeln eines inzwischen gelöschten
 * Clients bleiben stehen und greifen nie.
 */
export async function loadAutomationRules(
  db: Pick<Db, 'select'>,
  orgId: string,
): Promise<StoredAutomationRules> {
  const [row] = await db
    .select()
    .from(automationRules)
    .where(eq(automationRules.organizationId, orgId));
  if (!row) return { rules: DEFAULT_AUTOMATION_RULES, version: 0, updatedAt: null };
  const parsed = automationRulesSchema.safeParse(row.rules);
  return {
    rules: parsed.success ? parsed.data : DEFAULT_AUTOMATION_RULES,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

/** `null` für Nicht-Mitglieder. */
export async function getAutomationRules(
  db: Db,
  access: AutomationAccessInput,
): Promise<StoredAutomationRules | null> {
  if ((await getOrgRole(db, access.userId, access.orgId)) === null) return null;
  return loadAutomationRules(db, access.orgId);
}

/**
 * Speichert die ganze Liste. `version` muss der gelesenen entsprechen (`VERSION_CONFLICT`), danach zählt sie hoch;
 * `UNKNOWN_CLIENT` für Regeln mit einem Client außerhalb der Organisation. Audit `automation_rules.update` mit
 * vorher und nachher. `null` für Nicht-Mitglieder.
 */
export async function saveAutomationRules(
  db: Db,
  input: AutomationAccessInput & { rules: AutomationRule[]; version: number },
): Promise<StoredAutomationRules | null> {
  if ((await getOrgRole(db, input.userId, input.orgId)) === null) return null;
  try {
    return await db.transaction(async (tx) => {
      const [current] = await tx
        .select({ version: automationRules.version })
        .from(automationRules)
        .where(eq(automationRules.organizationId, input.orgId))
        .for('update');
      if ((current?.version ?? 0) !== input.version) throw conflict();
      const clientIds = [...new Set(input.rules.flatMap((r) => (r.clientId ? [r.clientId] : [])))];
      if (clientIds.length > 0) {
        const known = await tx
          .select({ id: clients.id })
          .from(clients)
          .where(and(eq(clients.organizationId, input.orgId), inArray(clients.id, clientIds)));
        if (known.length !== clientIds.length) {
          throw new AutomationError('UNKNOWN_CLIENT', 'Eine Regel nennt einen unbekannten Client.');
        }
      }
      const before = await loadAutomationRules(tx, input.orgId);
      const version = input.version + 1;
      const updatedAt = new Date();
      const values = { rules: input.rules, version, updatedBy: input.userId, updatedAt };
      if (current) {
        await tx
          .update(automationRules)
          .set(values)
          .where(eq(automationRules.organizationId, input.orgId));
      } else {
        // Gleichzeitiges erstes Speichern: Die zweite Anfrage scheitert am Primärschlüssel (siehe unten).
        await tx.insert(automationRules).values({ organizationId: input.orgId, ...values });
      }
      await recordAuditEvent(tx, {
        organizationId: input.orgId,
        actorUserId: input.userId,
        action: 'automation_rules.update',
        target: {
          type: 'automation_rules',
          id: input.orgId,
          version,
          before: { version: before.version, rules: before.rules },
          after: input.rules,
        },
      });
      return { rules: input.rules, version, updatedAt };
    });
  } catch (error) {
    if (isUniqueViolation(error, 'automation_rules_pkey')) throw conflict();
    throw error;
  }
}
